import { PostgresAuthzStore, PostgresLoginStore } from "@studenthub/db/access";
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
