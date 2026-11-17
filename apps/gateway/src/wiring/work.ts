import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  PostgresWorkAppealStore, PostgresWorkDecisionStore, PostgresWorkHoursViewStore, PostgresWorkPlacementStore, PostgresWorkSessionStore,
  type WorkDecisionHooks,
} from "@studenthub/db/work";
import {
  AppealService, DecisionService, HoursViews, NO_MANAGED_STORES, PlacementService, SessionService, WorkScope,
  type GrantsPort, type ManagedStoresPort,
} from "../../../../packages/work/src/index.js";
import type { WorkHttpServices } from "../work/http.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";

type Access = ReturnType<typeof wireAccess>["services"];

export interface WorkWiringPorts {
  /** Store managers (access lane A4); none until that lane lands. */
  readonly managedStores?: ManagedStoresPort;
  /** Decision notices to the person (comms lane); none until that lane lands. */
  readonly notices?: WorkDecisionHooks;
}

/**
 * Work and hours (W-1 to W-7). Off unless the safe-write signing key is set,
 * like every other gateway write, so a deployment without it serves 503 and
 * legacy stays the writer for hours until cutover.
 */
export function wireWork(settings: WiringSettings, access: Access, ports: WorkWiringPorts = {}): Wired<{ readonly work?: WorkHttpServices }> {
  if (!settings.safeWriteKey) return { services: {}, async close() {} };
  const pool = new pg.Pool({ connectionString: settings.databaseUrl });
  const grants: GrantsPort = access.authzStore;
  const managed = ports.managedStores ?? NO_MANAGED_STORES;
  const placementStore = new PostgresWorkPlacementStore(pool);
  const sessionStore = new PostgresWorkSessionStore(pool);
  const decisionStore = new PostgresWorkDecisionStore(pool, ports.notices ?? {});
  const viewStore = new PostgresWorkHoursViewStore(pool);
  const appealStore = new PostgresWorkAppealStore(pool, ports.notices ?? {});
  const scope = new WorkScope(grants, managed, (orgId) => viewStore.organizationAncestors(orgId));
  const newId = () => randomUUID();
  const work: WorkHttpServices = {
    personFor: async (sessionId) => (await access.loginStore.sessions.get(sessionId))?.personId,
    placements: new PlacementService({ store: placementStore, grants, newId }),
    sessions: new SessionService({ store: sessionStore, newId }),
    decisions: new DecisionService({ store: decisionStore, grants, managedStores: managed, newId }),
    views: new HoursViews(viewStore, scope, (actorId) => managed.managedStores(actorId)),
    appeals: new AppealService({ store: appealStore, scope, newId }),
    storeNames: (ids) => viewStore.storeNames(ids),
  };
  return {
    services: { work },
    async close() { await pool.end(); },
  };
}
