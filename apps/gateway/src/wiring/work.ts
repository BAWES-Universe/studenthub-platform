import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  PostgresWorkAppealStore, PostgresWorkDecisionStore, PostgresWorkHoursViewStore, PostgresWorkPlacementStore, PostgresWorkSessionStore,
  type WorkDecisionHooks,
} from "@studenthub/db/work";
import {
  AppealService, DecisionService, HoursViews, PlacementService, SessionService, WorkScope,
  type GrantsPort, type ManagedStoresPort,
} from "../../../../packages/work/src/index.js";
import { PostgresAccessStoreManagersStore } from "@studenthub/db/access";
import { recordWorkSessionDecision, retractWorkSessionDecision } from "@studenthub/db/comms";
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
  /** Store managers; defaults to the access lane's `PostgresAccessStoreManagersStore` (A4). */
  readonly managedStores?: ManagedStoresPort;
  /** Decision notices to the person; defaults to the comms lane's feed producers (`@studenthub/db/comms`). */
  readonly notices?: WorkDecisionHooks;
}

/**
 * Work and hours (W-1 to W-7). Needs both the cutover switch and the safe-write
 * signing key; otherwise nothing is built and /api/work and the /work screens
 * answer 503, so legacy stays the only writer of hours until cutover. Store
 * managers come from the access lane (A4) and decision notices from the comms lane's
 * feed producers, each on the work pool unless a port is given.
 */
export function wireWork(settings: WiringSettings, access: Access, ports: WorkWiringPorts = {}): Wired<{ readonly work?: WorkHttpServices }> {
  if (ports.enabled !== true || !settings.safeWriteKey) return { services: {}, async close() {} };
  // A notice port must both record and withdraw, or the feed would keep decisions that no longer stand.
  const notices: WorkDecisionHooks = ports.notices ?? { onDecided: recordWorkSessionDecision, onUndone: retractWorkSessionDecision };
  if (typeof notices.onDecided !== "function" || typeof notices.onUndone !== "function") {
    throw new Error("WORK_LANE_ENABLED=true needs decision notice hooks with both onDecided and onUndone");
  }
  const pool = new pg.Pool({ connectionString: settings.databaseUrl });
  const grants: GrantsPort = access.authzStore;
  // Store managers come from the access lane (A4) on the work pool unless a port is given.
  const managed: ManagedStoresPort = ports.managedStores ?? new PostgresAccessStoreManagersStore({ pool });
  const placementStore = new PostgresWorkPlacementStore(pool);
  const sessionStore = new PostgresWorkSessionStore(pool);
  const decisionStore = new PostgresWorkDecisionStore(pool, notices);
  const viewStore = new PostgresWorkHoursViewStore(pool);
  const appealStore = new PostgresWorkAppealStore(pool);
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
