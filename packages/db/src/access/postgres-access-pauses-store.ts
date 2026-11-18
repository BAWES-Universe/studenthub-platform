import { randomUUID } from "node:crypto";
import pg from "pg";
import { insertAuthorizationMutationAudit, resolveAuthorizationMutationContext } from "../authorization-audit.js";
import { grantSummary } from "./postgres-access-grants-store.js";

/**
 * Access lane A6 (migration 0405): pausing and resuming a person's access.
 *
 * Structural types only: the decision lives in packages/access and is handed
 * to `apply`, which runs it on what it read under the locks.
 */

type Grant = { readonly orgId: string; readonly role: string; readonly scope: string };
type StoreGrant = { readonly orgId: string; readonly storeId: string };

export interface AccountPauseSnapshotRow {
  readonly callerGrants: readonly Grant[];
  readonly targetExists: boolean;
  /** The held grants, or the suspended ones while paused. */
  readonly targetGrants: readonly Grant[];
  readonly paused: boolean;
}

export type AccountPauseOutcome<R extends string = string> =
  | { readonly kind: "paused"; readonly grants: number; readonly storeGrants: number }
  | { readonly kind: "resumed"; readonly restored: number; readonly leftOut: number }
  | { readonly kind: "refused"; readonly reason: R };

interface PauseApplyInput<R extends string> {
  readonly callerId: string;
  readonly request: { readonly targetPrincipalId: string; readonly action: "pause" | "resume"; readonly reason: string };
  readonly decide: (snapshot: AccountPauseSnapshotRow) => { readonly kind: "apply" } | { readonly kind: "refused"; readonly reason: R };
  readonly requestId?: string;
}

const RETRY = Symbol("retry");
const ORG_LOCK_KEY = 5960;
const PRINCIPAL_LOCK_KEY = 5959;

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

export class PostgresAccessPausesStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: { readonly pool: pg.Pool } | { readonly connectionString: string }) {
    if ("pool" in options) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    } else {
      this.#pool = new pg.Pool({ connectionString: options.connectionString });
      this.#ownsPool = true;
    }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  /**
   * One transaction. Locks every organization the person holds a grant in
   * (sorted, before the principal, as every grant writer does), then the
   * principal; re-reads, decides, and applies with an audit row and one event
   * row per grant.
   */
  async apply<R extends string>(input: PauseApplyInput<R>): Promise<AccountPauseOutcome<R>> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const outcome = await this.#applyOnce(input);
      if (outcome !== RETRY) return outcome;
    }
    throw new Error("the person's grants kept changing during the pause");
  }

  async #applyOnce<R extends string>(input: PauseApplyInput<R>): Promise<AccountPauseOutcome<R> | typeof RETRY> {
    const { callerId, request } = input;
    const target = request.targetPrincipalId;
    const audit = resolveAuthorizationMutationContext({ actorPrincipalId: callerId, ...(input.requestId ? { requestId: input.requestId } : {}) });
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const live = await client.query<{ id: string; suspended_grants: Grant[]; suspended_stores: StoreGrant[] }>(
        "SELECT id, suspended_grants, suspended_stores FROM account_pauses WHERE principal_id = $1 AND resumed_at IS NULL", [target]);
      const orgs = new Set<string>();
      for (const row of (await client.query<{ org_id: string }>("SELECT org_id FROM grants WHERE principal_id = $1", [target])).rows) orgs.add(row.org_id);
      for (const grant of live.rows[0]?.suspended_grants ?? []) orgs.add(grant.orgId);
      for (const grant of live.rows[0]?.suspended_stores ?? []) orgs.add(grant.orgId);
      for (const orgId of [...orgs].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`access:org:${orgId}`, ORG_LOCK_KEY]);
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [target, PRINCIPAL_LOCK_KEY]);

      const callerGrants = await client.query<{ org_id: string; role: string; scope: string }>(
        "SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY id FOR SHARE", [callerId]);
      const exists = await client.query("SELECT 1 FROM principals WHERE id = $1", [target]);
      const pause = (await client.query<{ id: string; suspended_grants: Grant[]; suspended_stores: StoreGrant[] }>(
        "SELECT id, suspended_grants, suspended_stores FROM account_pauses WHERE principal_id = $1 AND resumed_at IS NULL FOR UPDATE", [target])).rows[0];
      const held = await client.query<{ org_id: string; role: string; scope: string }>(
        "SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY org_id, role FOR UPDATE", [target]);
      if (held.rows.some((row) => !orgs.has(row.org_id))
        || (pause && [...pause.suspended_grants, ...pause.suspended_stores].some((grant) => !orgs.has(grant.orgId)))) {
        // A grant appeared in an organization this transaction has not locked: start again.
        await client.query("ROLLBACK");
        return RETRY;
      }
      const decision = input.decide(Object.freeze({
        callerGrants: callerGrants.rows.map((row) => ({ orgId: row.org_id, role: row.role, scope: row.scope })),
        targetExists: Boolean(exists.rowCount),
        // A paused person holds no grants in normal operation, but any that
        // exist count too: the stronger of the two sets decides who may resume.
        targetGrants: [...(pause ? pause.suspended_grants : []), ...held.rows.map((row) => ({ orgId: row.org_id, role: row.role, scope: row.scope }))],
        paused: pause !== undefined,
      }));
      if (decision.kind !== "apply") {
        await client.query("ROLLBACK");
        return decision;
      }
      const before = await grantSummary(client, target);

      if (request.action === "pause") {
        const grants = held.rows.map((row) => ({ orgId: row.org_id, role: row.role, scope: row.scope }));
        const stores = (await client.query<{ org_id: string; store_id: string }>(
          `UPDATE store_manager_access SET revoked_at = clock_timestamp(), revoked_by = $2
            WHERE principal_id = $1 AND revoked_at IS NULL RETURNING org_id, store_id`, [target, callerId])).rows
          .map((row) => ({ orgId: row.org_id, storeId: row.store_id }));
        await client.query("DELETE FROM grants WHERE principal_id = $1", [target]);
        if (grants.length > 0) {
          await insertAuthorizationMutationAudit(client, {
            context: audit, operation: "grants.revoke", targetPrincipalId: target,
            targetOrgIds: grants.map((grant) => grant.orgId), before, after: await grantSummary(client, target),
          });
        }
        await this.#events(client, target, callerId, `Access paused: ${request.reason}`, "revoke", grants, stores);
        await client.query("DELETE FROM login_sessions WHERE person_id = $1", [target]);
        await client.query(
          `INSERT INTO account_pauses (id, principal_id, paused_by, reason, suspended_grants, suspended_stores)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
          [randomUUID(), target, callerId, request.reason, JSON.stringify(grants), JSON.stringify(stores)]);
        await client.query("COMMIT");
        return { kind: "paused", grants: grants.length, storeGrants: stores.length };
      }

      // Resume: give back what can still be given, in one read per kind.
      const suspended = pause!.suspended_grants;
      // Lock the organizations first, then read deletions in a separate
      // statement: under READ COMMITTED a statement whose row lock waited keeps
      // its old snapshot and could miss a deletion committed meanwhile.
      const lockedOrgs = (await client.query<{ id: string }>(
        "SELECT id FROM organizations WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE",
        [[...new Set([...suspended.map((grant) => grant.orgId), ...pause!.suspended_stores.map((grant) => grant.orgId)])]])).rows.map((row) => row.id);
      const deleted = new Set((await client.query<{ org_id: string }>(
        "SELECT org_id FROM organization_deletions WHERE org_id = ANY($1::text[])", [lockedOrgs])).rows.map((row) => row.org_id));
      const liveOrgs = new Set(lockedOrgs.filter((id) => !deleted.has(id)));
      // Only what was actually given back counts: a role the person was given
      // again during the pause (at any scope) is left as it is, and reported as left out.
      const grants: Grant[] = [];
      for (const grant of suspended.filter((item) => liveOrgs.has(item.orgId))) {
        const inserted = await client.query(
          `INSERT INTO grants (principal_id, org_id, role, scope) VALUES ($1, $2, $3, $4)
           ON CONFLICT (principal_id, org_id, role) DO NOTHING RETURNING 1`, [target, grant.orgId, grant.role, grant.scope]);
        if (inserted.rowCount) grants.push(grant);
      }
      const activeStores = new Set((await client.query<{ id: string }>(
        "SELECT id FROM organization_stores WHERE id = ANY($1::uuid[]) AND status = 'active' FOR SHARE",
        [pause!.suspended_stores.map((grant) => grant.storeId)])).rows.map((row) => row.id));
      const stores: StoreGrant[] = [];
      for (const grant of pause!.suspended_stores.filter((item) => liveOrgs.has(item.orgId) && activeStores.has(item.storeId))) {
        const inserted = await client.query(
          `INSERT INTO store_manager_access (id, org_id, store_id, principal_id, granted_by)
           SELECT $1, $2, $3, $4, $5
            WHERE NOT EXISTS (SELECT 1 FROM store_manager_access WHERE store_id = $3 AND principal_id = $4 AND revoked_at IS NULL)
           RETURNING 1`,
          [randomUUID(), grant.orgId, grant.storeId, target, callerId]);
        if (inserted.rowCount) stores.push(grant);
      }
      if (grants.length > 0) {
        await insertAuthorizationMutationAudit(client, {
          context: audit, operation: "grants.grant", targetPrincipalId: target,
          targetOrgIds: grants.map((grant) => grant.orgId), before, after: await grantSummary(client, target),
        });
      }
      await this.#events(client, target, callerId, `Access resumed: ${request.reason}`, "grant", grants, stores);
      await client.query(
        `UPDATE account_pauses SET resumed_at = clock_timestamp(), resumed_by = $2, resume_reason = $3, restored_grants = $4::jsonb WHERE id = $1`,
        [pause!.id, callerId, request.reason, JSON.stringify({ grants, stores })]);
      await client.query("COMMIT");
      const total = suspended.length + pause!.suspended_stores.length;
      return { kind: "resumed", restored: grants.length + stores.length, leftOut: total - grants.length - stores.length };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async #events(client: pg.PoolClient, target: string, actor: string, reason: string, action: "grant" | "revoke",
    grants: readonly Grant[], stores: readonly StoreGrant[]): Promise<void> {
    const text = [...reason].slice(0, 500).join("");
    if (grants.length > 0) {
      await client.query(
        `INSERT INTO access_grant_events (target_principal_id, org_id, role, scope, action, actor_principal_id, reason)
         SELECT $1, g."orgId", g.role, g.scope, $2, $3, $4
           FROM jsonb_to_recordset($5::jsonb) AS g("orgId" text, role text, scope text)`,
        [target, action, actor, text, JSON.stringify(grants)]);
    }
    if (stores.length > 0) {
      await client.query(
        `INSERT INTO access_grant_events (target_principal_id, org_id, role, scope, action, actor_principal_id, reason, store_id)
         SELECT $1, s."orgId", 'store-manager', 'store', $2, $3, $4, s."storeId"
           FROM jsonb_to_recordset($5::jsonb) AS s("orgId" text, "storeId" uuid)`,
        [target, action, actor, text, JSON.stringify(stores)]);
    }
  }

  async pause(principalId: string): Promise<{
    pausedAt: string; pausedBy: { principalId: string; displayName: string | null }; reason: string;
    grants: readonly Grant[]; storeGrants: readonly StoreGrant[];
  } | null> {
    const { rows } = await this.#pool.query<{
      paused_at: Date; paused_by: string; by_name: string | null; reason: string; suspended_grants: Grant[]; suspended_stores: StoreGrant[];
    }>(
      `SELECT p.paused_at, p.paused_by, a.display_name AS by_name, p.reason, p.suspended_grants, p.suspended_stores
         FROM account_pauses p LEFT JOIN principals a ON a.id = p.paused_by
        WHERE p.principal_id = $1 AND p.resumed_at IS NULL`, [principalId]);
    const row = rows[0];
    return row ? {
      pausedAt: iso(row.paused_at), pausedBy: { principalId: row.paused_by, displayName: row.by_name }, reason: row.reason,
      grants: row.suspended_grants, storeGrants: row.suspended_stores,
    } : null;
  }

  /** Which of these people are paused, in one read (for employer views to hide them). */
  async paused(principalIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (principalIds.length === 0) return new Set();
    const { rows } = await this.#pool.query<{ principal_id: string }>(
      "SELECT principal_id FROM account_pauses WHERE principal_id = ANY($1::text[]) AND resumed_at IS NULL", [[...new Set(principalIds)]]);
    return new Set(rows.map((row) => row.principal_id));
  }
}
