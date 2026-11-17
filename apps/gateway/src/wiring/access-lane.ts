import { PostgresAccessGrantsStore, PostgresAccessInvitationsStore } from "@studenthub/db/access";
import { createAccessGrantService, createCompanyTeamService } from "../../../../packages/access/src/index.js";
import type { AccessPorts } from "../access/admin-access.js";
import type { CompanyTeamPorts } from "../access/company-team.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";

/**
 * Access lane A1: the admin Access pages and "Your access". Reads always;
 * writes only when SAFE_WRITE_SIGNING_KEY signs the single-use review token.
 * A2: the company Team page and invitations (no mail provider yet: the
 * inviting owner is shown the link once).
 */
export function wireAccessLane(settings: WiringSettings, access: ReturnType<typeof wireAccess>["services"]): Wired<{
  readonly application: { readonly access: AccessPorts; readonly team: CompanyTeamPorts };
}> {
  const store = new PostgresAccessGrantsStore({ connectionString: settings.databaseUrl });
  const invitations = new PostgresAccessInvitationsStore({ connectionString: settings.databaseUrl });
  const writes = settings.safeWriteKey ? createAccessGrantService({ store, secret: settings.safeWriteKey }) : undefined;
  return {
    services: { application: {
      access: { sessions: access.loginStore.sessions, reads: store, ...(writes ? { writes } : {}) },
      team: { sessions: access.loginStore.sessions, team: createCompanyTeamService({ store: invitations }) },
    } },
    async close() { await Promise.all([store.close(), invitations.close()]); },
  };
}
