import { PostgresAccessGrantsStore, PostgresAuthzStore, PostgresLoginStore } from "@studenthub/db/access";
import { createAccessGrantService } from "../../../../packages/access/src/index.js";
import type { AccessPorts } from "../access/admin-access.js";
import type { Wired, WiringSettings } from "./context.js";

export function wireAccess(settings: WiringSettings): Wired<{
  readonly loginStore: PostgresLoginStore;
  readonly authzStore: PostgresAuthzStore;
}> {
  const loginStore = new PostgresLoginStore({ connectionString: settings.databaseUrl });
  const authzStore = new PostgresAuthzStore({ connectionString: settings.databaseUrl });
  return {
    services: { loginStore, authzStore },
    async close() { await Promise.all([loginStore.close(), authzStore.close()]); },
  };
}

/**
 * Access lane A1: the admin Access pages and "Your access". Reads always;
 * writes only when SAFE_WRITE_SIGNING_KEY signs the single-use review token.
 */
export function wireAccessLane(settings: WiringSettings, access: ReturnType<typeof wireAccess>["services"]): Wired<{
  readonly application: { readonly access: AccessPorts };
}> {
  const store = new PostgresAccessGrantsStore({ connectionString: settings.databaseUrl });
  const writes = settings.safeWriteKey ? createAccessGrantService({ store, secret: settings.safeWriteKey }) : undefined;
  return {
    services: { application: { access: { sessions: access.loginStore.sessions, reads: store, ...(writes ? { writes } : {}) } } },
    async close() { await store.close(); },
  };
}
