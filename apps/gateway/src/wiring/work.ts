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

/**
 * WORK_LANE_ENABLED: "true" turns the work lane on; unset or "false" keeps it
 * off; anything else stops startup. Legacy stays the only writer of hours until
 * cutover, so the lane is off by default even where the signing key is set.
 */
export function workLaneEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("WORK_LANE_ENABLED must be true or false");
}

export interface WorkWiringPorts {
  /** The cutover switch (WORK_LANE_ENABLED); off unless set. */
  readonly enabled?: boolean;
  /** Store managers (access lane A4); none until that lane lands. */
  readonly managedStores?: ManagedStoresPort;
  /** Decision notices to the person (comms lane); none until that lane lands. */
  readonly notices?: WorkDecisionHooks;
}

/**
 * Work and hours (W-1 to W-7). Needs both the cutover switch and the safe-write
 * signing key; otherwise nothing is built and /api/work and the /work screens
 * answer 503, so legacy stays the only writer of hours until cutover.
 */
export function wireWork(settings: WiringSettings, access: Access, ports: WorkWiringPorts = {}): Wired<{ readonly work?: WorkHttpServices }> {
  if (ports.enabled !== true || !settings.safeWriteKey) return { services: {}, async close() {} };
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
    placements: new PlacementService({ store: placementStore, grants, newId, managedStores: (actorId) => managed.managedStores(actorId) }),
    sessions: new SessionService({ store: sessionStore, newId }),
    decisions: new DecisionService({ store: decisionStore, grants, managedStores: managed, newId }),
    views: new HoursViews(viewStore, scope, (actorId) => managed.managedStores(actorId)),
    appeals: new AppealService({ store: appealStore, scope, newId }),
    storeNames: (ids) => viewStore.storeNames(ids),
    storeInfo: (id) => viewStore.storeInfo(id),
    personNames: (ids) => viewStore.personNames(ids),
    storesOf: (orgId) => viewStore.storesOf(orgId),
  };
  return {
    services: { work },
    async close() { await pool.end(); },
  };
}
