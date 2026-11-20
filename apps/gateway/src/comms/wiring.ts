import { createHmac } from "node:crypto";
import pg from "pg";
import type { AuthzStore } from "@studenthub/contracts";
import { PostgresStaffMessagesStore } from "@studenthub/db/comms";
import { PostgresEmailOutboxStore } from "@studenthub/db/notifications";
import { PostgresIdCardsStore, PostgresMorningSummaryStore } from "@studenthub/db/reports";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { IdCardsService, IdCardVerifier, MorningSummaryService, type IdCardPhotoSource, type IdCardPublicPhotoSource } from "../../../../packages/reports/src/index.js";
import { openPersonalPhotoSourceFromEnv } from "../../../../packages/private-documents/src/personal-photo-source.js";
import { StaffMessagesService } from "../../../../packages/comms/src/staff-messages.js";
import { blockListOf, parseTrustedProxies } from "../../../../packages/access/src/index.js";
import { hasOperatorStaffGrant } from "../wiring/profile.js";
import { publicCheckLimit } from "../reports/id-cards-http.js";
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
export function wireStaffMessages(options: { readonly connectionString: string; readonly authzStore: Pick<AuthzStore, "listGrantsForPrincipal">; readonly env?: NodeJS.ProcessEnv; readonly idCardVerifyKey?: Buffer; readonly warn?: (line: string) => void }): { readonly http: StaffMessagesHttpService; close(): Promise<void> } {
  // One pool for every store here; none owns it, so close ends it once.
  const pool = new pg.Pool({ connectionString: options.connectionString });
  const store = new PostgresStaffMessagesStore({ pool });
  const emails = new PostgresEmailOutboxStore({ pool, operatorOrgIds: DEFAULT_OPERATOR_ORG_IDS });
  const authority = { async isStaff(principalId: string) { return hasOperatorStaffGrant(await options.authzStore.listGrantsForPrincipal(principalId)); } };
  const service = new StaffMessagesService(store, authority);
  const summary = new MorningSummaryService(new PostgresMorningSummaryStore({ pool, operatorOrgIds: DEFAULT_OPERATOR_ORG_IDS }), authority);
  // ID card photos come from the same document storage as civil ID reads, opened on first print; each read is audited as id_card_render in staff_person_views.
  const cards = new PostgresIdCardsStore({ pool }), audit = { recordView: cards.recordPhotoRender.bind(cards) }, publicAudit = { recordPublicView: cards.recordPublicPhotoView.bind(cards) };
  let opened: ReturnType<typeof openPersonalPhotoSourceFromEnv> | undefined;
  const env = options.env;
  // Behind a load balancer without GATEWAY_TRUSTED_PROXIES every visitor would share the balancer's count on the public check.
  if (options.idCardVerifyKey && env && !env.GATEWAY_TRUSTED_PROXIES?.trim())
    (options.warn ?? (line => console.warn(line)))(JSON.stringify({ event: "id_card_verify_no_trusted_proxies", detail: "ID_CARD_VERIFY_KEY is set but GATEWAY_TRUSTED_PROXIES is empty: the public card check counts by socket address, so behind a proxy every visitor shares one limit" }));
  // A failed open (storage briefly down) is forgotten so the next read tries again; that read falls back to no photo.
  const open = async () => {
    const attempt = opened ??= openPersonalPhotoSourceFromEnv(audit, env, publicAudit);
    return attempt.catch(error => { if (opened === attempt) opened = undefined; throw error; });
  };
  const photos: IdCardPhotoSource | undefined = env && { async read(personId, viewerId) {
    return (await open())?.source.read(personId, viewerId) ?? null;
  } };
  // The public page's photo comes from the same storage; each read is recorded in id_card_public_views with the hashed client address.
  const publicPhotos: IdCardPublicPhotoSource | undefined = env && options.idCardVerifyKey && { async read(personId, view) {
    return (await open())?.publicSource?.read(personId, view) ?? null;
  } };
  const idCards = new IdCardsService(cards, authority, undefined, photos,
    options.idCardVerifyKey ? new IdCardVerifier(options.idCardVerifyKey) : undefined, publicPhotos);
  return { http: { isStaff: authority.isStaff, send: (sender, input) => service.send(sender, input),
    deliveryLog: (person, offset, limit) => emails.deliveryLog(person, offset, limit),
    morningSummary: { today: viewer => summary.today(viewer), subscribe: (viewer, on) => summary.subscribe(viewer, on) },
    idCards: { isStaff: authority.isStaff, list: (viewer, view, name, page) => idCards.list(viewer, view, name, page), write: (viewer, action, people) => idCards.write(viewer, action, people), own: person => idCards.own(person),
      ownPdf: (person, origin) => idCards.ownPdf(person, origin), staffPdf: (viewer, people, origin) => idCards.staffPdf(viewer, people, origin), check: token => idCards.check(token), publicPhoto: (token, key, client) => idCards.publicPhoto(token, key, client),
      // The public check is limited per client address, read behind the same trusted proxies as the abuse gate.
      publicLimit: options.idCardVerifyKey && env ? publicCheckLimit({ trustedProxies: blockListOf(parseTrustedProxies(env.GATEWAY_TRUSTED_PROXIES)),
        // A key derived from the verification key, so the recorded client hash is the same across gateway processes and restarts.
        key: createHmac("sha256", options.idCardVerifyKey).update("studenthub.id-card.client.v1").digest() }) : undefined } }, close: async () => { await (await opened?.catch(() => undefined))?.close(); await pool.end(); } };
}
