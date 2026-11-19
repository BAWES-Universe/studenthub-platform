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
  /** Decision notices to the person (comms lane); not wired until that lane lands, so the switch can't be turned on yet. */
  readonly notices?: WorkDecisionHooks;
}

/**
 * Work and hours (W-1 to W-7). Needs both the cutover switch and the safe-write
 * signing key; otherwise nothing is built and /api/work and the /work screens
 * answer 503, so legacy stays the only writer of hours until cutover. Store
 * managers come from the access lane (A4); turning the switch on also needs the
 * comms lane's notice hooks, which are not wired yet, so it stops startup until then.
 */
export function wireWork(settings: WiringSettings, access: Access, ports: WorkWiringPorts = {}): Wired<{ readonly work?: WorkHttpServices }> {
  if (ports.enabled !== true || !settings.safeWriteKey) return { services: {}, async close() {} };
  // Without these ports store managers could not act and people would get no
  // decision notices, so turning the lane on before they are wired stops startup.
  if (typeof ports.notices?.onDecided !== "function" || typeof ports.notices.onUndone !== "function") {
    throw new Error("WORK_LANE_ENABLED=true needs the comms lane's decision notice hooks (onDecided and onUndone), which are not wired yet; keep the switch off until they are");
  }
  const pool = new pg.Pool({ connectionString: settings.databaseUrl });
  const grants: GrantsPort = access.authzStore;
  // Store managers come from the access lane (A4) on the work pool unless a port is given.
  const managed: ManagedStoresPort = ports.managedStores ?? new PostgresAccessStoreManagersStore({ pool });
  const placementStore = new PostgresWorkPlacementStore(pool);
  const sessionStore = new PostgresWorkSessionStore(pool);
  const decisionStore = new PostgresWorkDecisionStore(pool, ports.notices ?? {});
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
