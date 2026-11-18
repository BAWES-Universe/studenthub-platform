import type { AuthzStore } from "@studenthub/contracts";
import { PostgresStaffMessagesStore } from "@studenthub/db/comms";
import { StaffMessagesService } from "../../../../packages/comms/src/staff-messages.js";
import { hasOperatorStaffGrant } from "../wiring/profile.js";
import type { StaffMessagesHttpService } from "./staff-messages-http.js";

/** Staff messages as production composes them: StudentHub staff (operator staff or admin grant) send through the Postgres store. */
export function wireStaffMessages(options: { readonly connectionString: string; readonly authzStore: Pick<AuthzStore, "listGrantsForPrincipal"> }): { readonly http: StaffMessagesHttpService; close(): Promise<void> } {
  const store = new PostgresStaffMessagesStore({ connectionString: options.connectionString });
  const authority = { async isStaff(principalId: string) { return hasOperatorStaffGrant(await options.authzStore.listGrantsForPrincipal(principalId)); } };
  const service = new StaffMessagesService(store, authority);
  return { http: { isStaff: authority.isStaff, send: (sender, input) => service.send(sender, input) }, close: () => store.close() };
}
