import pg from "pg";
import type { AuthzStore } from "@studenthub/contracts";
import { PostgresStaffMessagesStore } from "@studenthub/db/comms";
import { PostgresEmailOutboxStore } from "@studenthub/db/notifications";
import { StaffMessagesService } from "../../../../packages/comms/src/staff-messages.js";
import { hasOperatorStaffGrant } from "../wiring/profile.js";
import type { StaffMessagesHttpService } from "./staff-messages-http.js";

/** Staff messages and the per-person email delivery log as production composes them: StudentHub staff (operator staff or admin grant) only. */
export function wireStaffMessages(options: { readonly connectionString: string; readonly authzStore: Pick<AuthzStore, "listGrantsForPrincipal"> }): { readonly http: StaffMessagesHttpService; close(): Promise<void> } {
  // One pool for both stores; neither owns it, so close ends it once.
  const pool = new pg.Pool({ connectionString: options.connectionString });
  const store = new PostgresStaffMessagesStore({ pool });
  const emails = new PostgresEmailOutboxStore({ pool });
  const authority = { async isStaff(principalId: string) { return hasOperatorStaffGrant(await options.authzStore.listGrantsForPrincipal(principalId)); } };
  const service = new StaffMessagesService(store, authority);
  return { http: { isStaff: authority.isStaff, send: (sender, input) => service.send(sender, input),
    deliveryLog: (person, offset, limit) => emails.deliveryLog(person, offset, limit) }, close: () => pool.end() };
}
