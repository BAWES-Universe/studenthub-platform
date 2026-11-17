import { PostgresAccessContactsStore, PostgresAccessGrantsStore, PostgresAccessInvitationsStore, PostgresAccessPausesStore, PostgresAccessStoreManagersStore } from "@studenthub/db/access";
import { createAccessGrantService, createAccountPauseService, createCompanyContactsService, createCompanyTeamService } from "../../../../packages/access/src/index.js";
import type { AccessPorts } from "../access/admin-access.js";
import type { CompanyTeamPorts } from "../access/company-team.js";
import type { CompanyContactsPorts } from "../access/company-contacts.js";
import type { StoreManagerPorts } from "../access/store-manager.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";

/**
 * Access lane A1: the admin Access pages and "Your access". Reads always;
 * writes only when SAFE_WRITE_SIGNING_KEY signs the single-use review token.
 * A2: the company Team page and invitations (no mail provider yet: the
 * inviting owner is shown the link once). A3: company contacts without access.
 * A4: a store manager's own stores. A6: staff pause and resume a person's
 * access (writes with the signing key, like A1); sign-in reads the pause.
 */
export function wireAccessLane(settings: WiringSettings, access: ReturnType<typeof wireAccess>["services"]): Wired<{
  readonly application: { readonly access: AccessPorts; readonly team: CompanyTeamPorts; readonly contacts: CompanyContactsPorts; readonly storeManager: StoreManagerPorts };
  readonly pauses: PostgresAccessPausesStore;
}> {
  const store = new PostgresAccessGrantsStore({ connectionString: settings.databaseUrl });
  const invitations = new PostgresAccessInvitationsStore({ connectionString: settings.databaseUrl });
  const contactStore = new PostgresAccessContactsStore({ connectionString: settings.databaseUrl });
  const contacts = createCompanyContactsService({ store: contactStore });
  const storeManagers = new PostgresAccessStoreManagersStore({ connectionString: settings.databaseUrl });
  const writes = settings.safeWriteKey ? createAccessGrantService({ store, secret: settings.safeWriteKey }) : undefined;
  const pauses = new PostgresAccessPausesStore({ connectionString: settings.databaseUrl });
  const pauseWrites = settings.safeWriteKey ? createAccountPauseService({ store: pauses }) : undefined;
  return {
    services: { application: {
      access: { sessions: access.loginStore.sessions, reads: store, ...(writes ? { writes } : {}), pauses: { reads: pauses, ...(pauseWrites ? { writes: pauseWrites } : {}) } },
      team: { sessions: access.loginStore.sessions, team: createCompanyTeamService({ store: invitations }), contacts },
      contacts: { sessions: access.loginStore.sessions, contacts },
      storeManager: { sessions: access.loginStore.sessions, stores: storeManagers },
    }, pauses },
    async close() { await Promise.all([store.close(), invitations.close(), contactStore.close(), storeManagers.close(), pauses.close()]); },
  };
}
