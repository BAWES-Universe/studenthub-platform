import { PostgresAccessAbuseStore, PostgresAccessContactsStore, PostgresAccessGrantsStore, PostgresAccessInvitationsStore, PostgresAccessPausesStore, PostgresAccessRegistrationsStore, PostgresAccessStaffViewsStore, PostgresAccessStoreManagersStore } from "@studenthub/db/access";
import { blockListOf, createAccessGrantService, createAccountPauseService, parseTrustedProxies, createCompanyContactsService, createCompanyRegistrationService, createCompanyTeamService } from "../../../../packages/access/src/index.js";
import type { AccessPorts } from "../access/admin-access.js";
import type { CompanyTeamPorts } from "../access/company-team.js";
import type { CompanyContactsPorts } from "../access/company-contacts.js";
import type { StoreManagerPorts } from "../access/store-manager.js";
import type { AbuseGatePorts } from "../access/abuse-gate.js";
import type { StaffViewPorts } from "../access/staff-view.js";
import type { CompanyRegistrationPorts } from "../access/company-registration.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";

/**
 * Access lane A1: the admin Access pages and "Your access". Reads always;
 * writes only when SAFE_WRITE_SIGNING_KEY signs the single-use review token.
 * A2: the company Team page and invitations (no mail provider yet: the
 * inviting owner is shown the link once). A3: company contacts without access.
 * A4: a store manager's own stores. A6: staff pause and resume a person's
 * access (writes with the signing key, like A1); sign-in reads the pause.
 * A8: the address block list and per-person limits; GATEWAY_TRUSTED_PROXIES
 * names the proxies whose forwarding headers are read. A9: staff view a
 * person's account read-only for 15 minutes. A7: "Register a company" and
 * the staff review queue.
 *
 * The signing key gates only the writes that use a signed review token (A1
 * grant changes and A6 pauses). A2, A3, A7 and A8 writes have no token: each
 * is a same-origin form post whose caller's right is read again inside the
 * write's transaction, so they run with or without the key.
 */
export function wireAccessLane(settings: WiringSettings, access: ReturnType<typeof wireAccess>["services"], env: NodeJS.ProcessEnv = {}): Wired<{
  readonly application: { readonly access: AccessPorts; readonly team: CompanyTeamPorts; readonly contacts: CompanyContactsPorts; readonly storeManager: StoreManagerPorts; readonly abuse: AbuseGatePorts; readonly staffView: StaffViewPorts; readonly registrations: CompanyRegistrationPorts };
  readonly pauses: PostgresAccessPausesStore;
}> {
  const store = new PostgresAccessGrantsStore({ connectionString: settings.databaseUrl });
  const invitations = new PostgresAccessInvitationsStore({ connectionString: settings.databaseUrl });
  const contactStore = new PostgresAccessContactsStore({ connectionString: settings.databaseUrl });
  const contacts = createCompanyContactsService({ store: contactStore });
  const storeManagers = new PostgresAccessStoreManagersStore({ connectionString: settings.databaseUrl });
  const writes = settings.safeWriteKey ? createAccessGrantService({ store, secret: settings.safeWriteKey }) : undefined;
  const pauses = new PostgresAccessPausesStore({ connectionString: settings.databaseUrl });
  const views = new PostgresAccessStaffViewsStore({ connectionString: settings.databaseUrl });
  const registrations = new PostgresAccessRegistrationsStore({ connectionString: settings.databaseUrl });
  const abuse = new PostgresAccessAbuseStore({ connectionString: settings.databaseUrl });
  const trustedProxies = blockListOf(parseTrustedProxies(env.GATEWAY_TRUSTED_PROXIES));
  const pauseWrites = settings.safeWriteKey ? createAccountPauseService({ store: pauses }) : undefined;
  return {
    services: { application: {
      access: { sessions: access.loginStore.sessions, reads: store, ...(writes ? { writes } : {}), pauses: { reads: pauses, ...(pauseWrites ? { writes: pauseWrites } : {}) }, views },
      team: { sessions: access.loginStore.sessions, team: createCompanyTeamService({ store: invitations }), contacts },
      contacts: { sessions: access.loginStore.sessions, contacts },
      storeManager: { sessions: access.loginStore.sessions, stores: storeManagers },
      abuse: { sessions: access.loginStore.sessions, store: abuse, reads: store, trustedProxies },
      staffView: { sessions: access.loginStore.sessions, reads: store, views },
      registrations: { sessions: access.loginStore.sessions, reads: store, registrations, service: createCompanyRegistrationService({ store: registrations }) },
    }, pauses },
    async close() { await Promise.all([store.close(), invitations.close(), contactStore.close(), storeManagers.close(), pauses.close(), abuse.close(), views.close(), registrations.close()]); },
  };
}
