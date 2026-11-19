import pg from "pg";
import type { AuthzStore } from "@studenthub/contracts";
import { PostgresStaffMessagesStore } from "@studenthub/db/comms";
import { PostgresEmailOutboxStore } from "@studenthub/db/notifications";
import { PostgresMorningSummaryStore } from "@studenthub/db/reports";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { MorningSummaryService } from "../../../../packages/reports/src/index.js";
import { StaffMessagesService } from "../../../../packages/comms/src/staff-messages.js";
import { hasOperatorStaffGrant } from "../wiring/profile.js";
import type { StaffMessagesHttpService } from "./staff-messages-http.js";

/** Staff messages, the per-person email delivery log and the morning summary page as production composes them: StudentHub staff (operator staff or admin grant) only. */
export function wireStaffMessages(options: { readonly connectionString: string; readonly authzStore: Pick<AuthzStore, "listGrantsForPrincipal"> }): { readonly http: StaffMessagesHttpService; close(): Promise<void> } {
  // One pool for every store here; none owns it, so close ends it once.
  const pool = new pg.Pool({ connectionString: options.connectionString });
  const store = new PostgresStaffMessagesStore({ pool });
  const emails = new PostgresEmailOutboxStore({ pool, operatorOrgIds: DEFAULT_OPERATOR_ORG_IDS });
  const authority = { async isStaff(principalId: string) { return hasOperatorStaffGrant(await options.authzStore.listGrantsForPrincipal(principalId)); } };
  const service = new StaffMessagesService(store, authority);
  const summary = new MorningSummaryService(new PostgresMorningSummaryStore({ pool, operatorOrgIds: DEFAULT_OPERATOR_ORG_IDS }), authority);
  return { http: { isStaff: authority.isStaff, send: (sender, input) => service.send(sender, input),
    deliveryLog: (person, offset, limit) => emails.deliveryLog(person, offset, limit),
    morningSummary: { today: viewer => summary.today(viewer), subscribe: (viewer, on) => summary.subscribe(viewer, on) } }, close: () => pool.end() };
}
