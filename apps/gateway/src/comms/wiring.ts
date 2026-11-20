import pg from "pg";
import type { AuthzStore } from "@studenthub/contracts";
import { PostgresStaffMessagesStore } from "@studenthub/db/comms";
import { PostgresEmailOutboxStore } from "@studenthub/db/notifications";
import { PostgresIdCardsStore, PostgresMorningSummaryStore } from "@studenthub/db/reports";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { IdCardsService, IdCardVerifier, MorningSummaryService, type IdCardPhotoSource } from "../../../../packages/reports/src/index.js";
import { openPersonalPhotoSourceFromEnv } from "../../../../packages/private-documents/src/personal-photo-source.js";
import { StaffMessagesService } from "../../../../packages/comms/src/staff-messages.js";
import { hasOperatorStaffGrant } from "../wiring/profile.js";
import type { StaffMessagesHttpService } from "./staff-messages-http.js";

/**
 * The ID card verification key: ID_CARD_VERIFY_KEY, canonical base64 for 32 bytes. Unset means
 * cards print without a QR code and the public check page shows every link as not found.
 */
export function idCardVerifyKey(env: NodeJS.ProcessEnv): Buffer | undefined {
  const raw = env.ID_CARD_VERIFY_KEY;
  if (raw === undefined) return undefined;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) throw new Error("ID_CARD_VERIFY_KEY must be canonical base64 for 32 bytes");
  return key;
}

/** Staff messages, the per-person email delivery log, the morning summary page and ID cards as production composes them: StudentHub staff (operator staff or admin grant) only, except a person's own ID card. */
export function wireStaffMessages(options: { readonly connectionString: string; readonly authzStore: Pick<AuthzStore, "listGrantsForPrincipal">; readonly env?: NodeJS.ProcessEnv; readonly idCardVerifyKey?: Buffer }): { readonly http: StaffMessagesHttpService; close(): Promise<void> } {
  // One pool for every store here; none owns it, so close ends it once.
  const pool = new pg.Pool({ connectionString: options.connectionString });
  const store = new PostgresStaffMessagesStore({ pool });
  const emails = new PostgresEmailOutboxStore({ pool, operatorOrgIds: DEFAULT_OPERATOR_ORG_IDS });
  const authority = { async isStaff(principalId: string) { return hasOperatorStaffGrant(await options.authzStore.listGrantsForPrincipal(principalId)); } };
  const service = new StaffMessagesService(store, authority);
  const summary = new MorningSummaryService(new PostgresMorningSummaryStore({ pool, operatorOrgIds: DEFAULT_OPERATOR_ORG_IDS }), authority);
  // ID card photos come from the same document storage as civil ID reads, opened on first print; each read is audited as id_card_render in staff_person_views.
  const cards = new PostgresIdCardsStore({ pool }), audit = { recordView: cards.recordPhotoRender.bind(cards) };
  let opened: ReturnType<typeof openPersonalPhotoSourceFromEnv> | undefined;
  const env = options.env;
  const photos: IdCardPhotoSource | undefined = env && { async read(personId, viewerId) {
    // A failed open (storage briefly down) is forgotten so the next print tries again; this print falls back to no photo.
    const attempt = opened ??= openPersonalPhotoSourceFromEnv(audit, env);
    const source = await attempt.catch(error => { if (opened === attempt) opened = undefined; throw error; });
    return source ? source.source.read(personId, viewerId) : null;
  } };
  const idCards = new IdCardsService(cards, authority, undefined, photos,
    options.idCardVerifyKey ? new IdCardVerifier(options.idCardVerifyKey) : undefined);
  return { http: { isStaff: authority.isStaff, send: (sender, input) => service.send(sender, input),
    deliveryLog: (person, offset, limit) => emails.deliveryLog(person, offset, limit),
    morningSummary: { today: viewer => summary.today(viewer), subscribe: (viewer, on) => summary.subscribe(viewer, on) },
    idCards: { isStaff: authority.isStaff, list: (viewer, view, name, page) => idCards.list(viewer, view, name, page), write: (viewer, action, people) => idCards.write(viewer, action, people), own: person => idCards.own(person),
      ownPdf: (person, origin) => idCards.ownPdf(person, origin), staffPdf: (viewer, people, origin) => idCards.staffPdf(viewer, people, origin), check: token => idCards.check(token) } }, close: async () => { await (await opened?.catch(() => undefined))?.close(); await pool.end(); } };
}
