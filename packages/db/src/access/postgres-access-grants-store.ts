import pg from "pg";
import { insertAuthorizationMutationAudit, resolveAuthorizationMutationContext } from "../authorization-audit.js";
import { organizationLive } from "../organization-liveness.js";

/**
 * Access lane A1 (migration 0400): the Postgres side of the admin Access page.
 *
 * Structural types only: the decision lives in packages/access and is handed
 * to `apply`, which runs it on what it read inside its own transaction.
 */

type Scope = "self" | "subtree";

export interface AccessGrantChange {
  readonly targetPrincipalId: string;
  readonly orgId: string;
  readonly role: string;
  readonly scope: Scope;
  readonly action: "grant" | "revoke";
  readonly reason: string;
}

export interface AccessGrantSnapshotRow {
  readonly callerGrants: readonly { readonly orgId: string; readonly role: string; readonly scope: string }[];
  readonly targetExists: boolean;
  readonly orgLive: boolean;
  readonly orgAncestors: readonly string[];
  readonly current: Scope | null;
  readonly adminCount: number;
  /** Every grant the target holds; `current` is taken from the same read when nothing is locked. */
  readonly targetGrants: readonly { readonly orgId: string; readonly role: string; readonly scope: string }[];
}

export type AccessGrantStoreDecision<R extends string = string> =
  | { readonly kind: "refused"; readonly reason: R }
  | { readonly kind: "unchanged" }
  | { readonly kind: "apply"; readonly before: Scope | null; readonly after: Scope | null };

export type AccessGrantApplyOutcome<R extends string = string> =
  | { readonly kind: "applied"; readonly before: Scope | null; readonly after: Scope | null }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: R | "token_already_used" | "state_changed" };

const ORG_LOCK_KEY = 5960;
const PRINCIPAL_LOCK_KEY = 5959; // the key PostgresAuthzStore takes per principal
const LOOKUP_LIMIT = 25;
const HISTORY_LIMIT = 50;

function likePrefix(value: string): string {
  return `${value.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export class PostgresAccessGrantsStore {
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

  // --- Writes ---------------------------------------------------------------

  async snapshot(callerId: string, change: AccessGrantChange): Promise<AccessGrantSnapshotRow> {
    return this.#snapshot(this.#pool, callerId, change, false);
  }

  /**
   * One transaction: lock, re-read, decide, then change the grants row, write
   * the authorization_mutation_audit row and the access_grant_events row.
   * Any failure rolls back all three.
   */
  async apply<R extends string>(input: {
    readonly callerId: string;
    readonly request: AccessGrantChange;
    readonly tokenId: string;
    readonly expectedBefore: Scope | null;
    readonly decide: (snapshot: AccessGrantSnapshotRow) => AccessGrantStoreDecision<R>;
    readonly requestId?: string;
    /** The review token's deadline (epoch milliseconds), checked again once the locks are held. */
    readonly expiresAt?: number;
    readonly now?: () => number;
  }): Promise<AccessGrantApplyOutcome<R | "token_expired">> {
    const { callerId, request } = input;
    const audit = resolveAuthorizationMutationContext({ actorPrincipalId: callerId, ...(input.requestId ? { requestId: input.requestId } : {}) });
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      // The organization tree first (the lock every reparent holds, so the
      // ancestry read below can't go stale), then the organization, then both
      // principals in a fixed order, so two confirms that touch each other's
      // grants serialize instead of deadlocking on grant rows.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('studenthub:organizations:tree'))");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`access:org:${request.orgId}`, ORG_LOCK_KEY]);
      for (const principal of [...new Set([request.targetPrincipalId, callerId])].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [principal, PRINCIPAL_LOCK_KEY]);
      }
      const used = await client.query("SELECT 1 FROM access_grant_events WHERE token_id = $1", [input.tokenId]);
      if (used.rowCount) {
        await client.query("ROLLBACK");
        return { kind: "refused", reason: "token_already_used" };
      }
      const snapshot = await this.#snapshot(client, callerId, request, true);
      // Checked after every lock, advisory and row, is held: the snapshot's row
      // locks can wait past the deadline too.
      if (input.expiresAt !== undefined && (input.now ?? Date.now)() >= input.expiresAt) {
        await client.query("ROLLBACK");
        return { kind: "refused", reason: "token_expired" };
      }
      if (snapshot.current !== input.expectedBefore) {
        await client.query("ROLLBACK");
        return { kind: "refused", reason: "state_changed" };
      }
      const decision = input.decide(snapshot);
      if (decision.kind !== "apply") {
        await client.query("ROLLBACK");
        return decision;
      }
      // A grant to a paused person would sit outside the pause's record and
      // survive it; the pause holds this principal's lock, so this read is final.
      if (decision.after !== null && (await client.query(
        "SELECT 1 FROM account_pauses WHERE principal_id = $1 AND resumed_at IS NULL", [request.targetPrincipalId])).rowCount) {
        await client.query("ROLLBACK");
        return { kind: "refused", reason: "state_changed" };
      }
      const before = await grantSummary(client, request.targetPrincipalId);
      if (decision.after === null) {
        await client.query("DELETE FROM grants WHERE principal_id = $1 AND org_id = $2 AND role = $3",
          [request.targetPrincipalId, request.orgId, request.role]);
      } else {
        await client.query(
          `INSERT INTO grants (principal_id, org_id, role, scope) VALUES ($1, $2, $3, $4)
           ON CONFLICT (principal_id, org_id, role) DO UPDATE SET scope = EXCLUDED.scope`,
          [request.targetPrincipalId, request.orgId, request.role, decision.after]);
      }
      await insertAuthorizationMutationAudit(client, {
        context: audit,
        operation: decision.after === null ? "grants.revoke" : "grants.grant",
        targetPrincipalId: request.targetPrincipalId,
        targetOrgIds: [request.orgId],
        before,
        after: await grantSummary(client, request.targetPrincipalId),
      });
      await client.query(
        `INSERT INTO access_grant_events
           (target_principal_id, org_id, role, scope, action, actor_principal_id, reason, token_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [request.targetPrincipalId, request.orgId, request.role, decision.after ?? decision.before ?? request.scope,
          decision.after === null ? "revoke" : "grant", callerId, request.reason, input.tokenId]);
      await client.query("COMMIT");
      return { kind: "applied", before: decision.before, after: decision.after };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      if ((error as { code?: string }).code === "23505" &&
        String((error as { constraint?: string }).constraint ?? "").includes("token_id")) {
        return { kind: "refused", reason: "token_already_used" };
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async #snapshot(db: pg.Pool | pg.PoolClient, callerId: string, change: AccessGrantChange, lock: boolean): Promise<AccessGrantSnapshotRow> {
    const callerGrants = await db.query<{ org_id: string; role: string; scope: string }>(
      `SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY id${lock ? " FOR SHARE" : ""}`, [callerId]);
    const target = await db.query("SELECT 1 FROM principals WHERE id = $1", [change.targetPrincipalId]);
    const live = await organizationLive(db, change.orgId, lock);
    const ancestors = live ? await ancestorsOf(db, [change.orgId]) : new Map<string, string[]>();
    const held = await db.query<{ org_id: string; role: string; scope: Scope }>(
      "SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY id", [change.targetPrincipalId]);
    // A preview takes `current` from the same read as the target's grants, so the
    // review page's effect and the token's `before` describe one state. Apply
    // locks the row and re-reads it.
    const current = lock
      ? (await db.query<{ scope: Scope }>(
        "SELECT scope FROM grants WHERE principal_id = $1 AND org_id = $2 AND role = $3 FOR UPDATE",
        [change.targetPrincipalId, change.orgId, change.role])).rows[0]?.scope ?? null
      : held.rows.find((row) => row.org_id === change.orgId && row.role === change.role)?.scope ?? null;
    const admins = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM grants WHERE org_id = $1 AND role = 'admin'", [change.orgId]);
    return Object.freeze({
      callerGrants: Object.freeze(callerGrants.rows.map((row) => Object.freeze({ orgId: row.org_id, role: row.role, scope: row.scope }))),
      targetExists: Boolean(target.rowCount),
      orgLive: live,
      orgAncestors: Object.freeze(ancestors.get(change.orgId) ?? []),
      current,
      targetGrants: Object.freeze(held.rows.map((row) => Object.freeze({ orgId: row.org_id, role: row.role, scope: row.scope }))),
      adminCount: admins.rows[0]?.n ?? 0,
    });
  }

  // --- Reads ------------------------------------------------------------------

  async callerGrants(callerId: string): Promise<readonly { orgId: string; role: string; scope: string }[]> {
    const { rows } = await this.#pool.query<{ org_id: string; role: string; scope: string }>(
      "SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY id", [callerId]);
    return rows.map((row) => ({ orgId: row.org_id, role: row.role, scope: row.scope }));
  }

  async findPeople(query: { readonly kind: "email" | "name"; readonly value: string }): Promise<readonly { principalId: string; displayName: string | null; email: string | null }[]> {
    const { rows } = query.kind === "email"
      ? await this.#pool.query<{ id: string; display_name: string | null; email: string | null }>(
        "SELECT id, display_name, email FROM principals WHERE lower(email) = lower($1) ORDER BY id LIMIT $2",
        [query.value, LOOKUP_LIMIT])
      : await this.#pool.query<{ id: string; display_name: string | null; email: string | null }>(
        `SELECT id, display_name, email FROM principals WHERE lower(display_name) LIKE $1 ESCAPE '\\'
         ORDER BY lower(display_name), id LIMIT $2`,
        [likePrefix(query.value), LOOKUP_LIMIT]);
    return rows.map((row) => ({ principalId: row.id, displayName: row.display_name, email: row.email }));
  }

  async person(principalId: string): Promise<{ principalId: string; displayName: string | null; email: string | null } | null> {
    const { rows } = await this.#pool.query<{ id: string; display_name: string | null; email: string | null }>(
      "SELECT id, display_name, email FROM principals WHERE id = $1", [principalId]);
    const row = rows[0];
    return row ? { principalId: row.id, displayName: row.display_name, email: row.email } : null;
  }

  async grants(principalId: string): Promise<readonly {
    orgId: string; orgName: string; role: string; scope: Scope;
    grantedBy: { principalId: string; displayName: string | null } | null; grantedAt: string | null; reason: string | null;
  }[]> {
    // The latest event per grant is trusted only when it is a grant: a grant
    // re-created outside this page after a revoke shows as unknown, never as
    // the earlier granter.
    const { rows } = await this.#pool.query<{
      org_id: string; org_name: string; role: string; scope: Scope;
      action: string | null; actor_id: string | null; actor_name: string | null; occurred_at: Date | null; reason: string | null;
    }>(
      `SELECT g.org_id, o.name AS org_name, g.role, g.scope,
              e.action, e.actor_principal_id AS actor_id, a.display_name AS actor_name, e.occurred_at, e.reason
       FROM grants g
       JOIN organizations o ON o.id = g.org_id
       LEFT JOIN LATERAL (
         SELECT action, actor_principal_id, occurred_at, reason FROM access_grant_events ev
         WHERE ev.target_principal_id = g.principal_id AND ev.org_id = g.org_id AND ev.role = g.role
         ORDER BY ev.occurred_at DESC, ev.id DESC LIMIT 1
       ) e ON true
       LEFT JOIN principals a ON a.id = e.actor_principal_id
       WHERE g.principal_id = $1
       ORDER BY lower(o.name), g.org_id, g.role`,
      [principalId]);
    return rows.map((row) => {
      const known = row.action === "grant" && row.actor_id !== null;
      return {
        orgId: row.org_id, orgName: row.org_name, role: row.role, scope: row.scope,
        grantedBy: known ? { principalId: row.actor_id!, displayName: row.actor_name } : null,
        grantedAt: known ? iso(row.occurred_at) : null,
        reason: known ? row.reason : null,
      };
    });
  }

  async history(principalId: string): Promise<readonly {
    orgId: string; orgName: string; role: string; scope: Scope; action: "grant" | "revoke";
    actor: { principalId: string; displayName: string | null }; reason: string; occurredAt: string;
  }[]> {
    const { rows } = await this.#pool.query<{
      org_id: string; org_name: string | null; role: string; scope: Scope; action: "grant" | "revoke";
      actor_principal_id: string; actor_name: string | null; reason: string; occurred_at: Date;
    }>(
      `SELECT e.org_id, o.name AS org_name, e.role, e.scope, e.action, e.actor_principal_id,
              a.display_name AS actor_name, e.reason, e.occurred_at
       FROM access_grant_events e
       LEFT JOIN organizations o ON o.id = e.org_id
       LEFT JOIN principals a ON a.id = e.actor_principal_id
       WHERE e.target_principal_id = $1
       ORDER BY e.occurred_at DESC, e.id DESC LIMIT $2`,
      [principalId, HISTORY_LIMIT]);
    return rows.map((row) => ({
      orgId: row.org_id, orgName: row.org_name ?? row.org_id, role: row.role, scope: row.scope, action: row.action,
      actor: { principalId: row.actor_principal_id, displayName: row.actor_name },
      reason: row.reason, occurredAt: iso(row.occurred_at)!,
    }));
  }

  async findOrganizations(query: string): Promise<readonly { orgId: string; name: string; ancestors: readonly string[] }[]> {
    const { rows } = await this.#pool.query<{ id: string; name: string }>(
      `SELECT o.id, o.name FROM organizations o
       WHERE lower(o.name) LIKE $1 ESCAPE '\\'
         AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = o.id)
       ORDER BY lower(o.name), o.id LIMIT $2`,
      [likePrefix(query.trim()), LOOKUP_LIMIT]);
    const ancestors = await ancestorsOf(this.#pool, rows.map((row) => row.id));
    return rows.map((row) => ({ orgId: row.id, name: row.name, ancestors: ancestors.get(row.id) ?? [] }));
  }

  async organization(orgId: string): Promise<{ orgId: string; name: string; ancestors: readonly string[] } | null> {
    const { rows } = await this.#pool.query<{ id: string; name: string }>(
      `SELECT o.id, o.name FROM organizations o
       WHERE o.id = $1 AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = o.id)`, [orgId]);
    const row = rows[0];
    if (!row) return null;
    const ancestors = await ancestorsOf(this.#pool, [row.id]);
    return { orgId: row.id, name: row.name, ancestors: ancestors.get(row.id) ?? [] };
  }

  async organizations(orgIds: readonly string[]): Promise<readonly { orgId: string; name: string; ancestors: readonly string[] }[]> {
    if (orgIds.length === 0) return [];
    const { rows } = await this.#pool.query<{ id: string; name: string }>(
      `SELECT o.id, o.name FROM organizations o
       WHERE o.id = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = o.id)
       ORDER BY o.id`, [[...orgIds]]);
    const ancestors = await ancestorsOf(this.#pool, rows.map((row) => row.id));
    return rows.map((row) => ({ orgId: row.id, name: row.name, ancestors: ancestors.get(row.id) ?? [] }));
  }

  async ownGrants(principalId: string): Promise<readonly { orgId: string; orgName: string; role: string; scope: Scope }[]> {
    const { rows } = await this.#pool.query<{ org_id: string; org_name: string; role: string; scope: Scope }>(
      `SELECT g.org_id, o.name AS org_name, g.role, g.scope FROM grants g
       JOIN organizations o ON o.id = g.org_id
       WHERE g.principal_id = $1 ORDER BY lower(o.name), g.org_id, g.role`, [principalId]);
    return rows.map((row) => ({ orgId: row.org_id, orgName: row.org_name, role: row.role, scope: row.scope }));
  }
}

export async function grantSummary(client: pg.PoolClient, principalId: string): Promise<Readonly<Record<string, number>>> {
  const { rows } = await client.query<{ total: number; self_count: number; subtree_count: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE scope = 'self')::int AS self_count,
            count(*) FILTER (WHERE scope = 'subtree')::int AS subtree_count
     FROM grants WHERE principal_id = $1`, [principalId]);
  const row = rows[0] ?? { total: 0, self_count: 0, subtree_count: 0 };
  return Object.freeze({ grantCount: row.total, selfCount: row.self_count, subtreeCount: row.subtree_count });
}

/** Ancestors of each organization (never the organization itself), in one query. */
export async function ancestorsOf(db: pg.Pool | pg.PoolClient, orgIds: readonly string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (orgIds.length === 0) return result;
  const { rows } = await db.query<{ origin: string; ancestors: string[] }>(
    `WITH RECURSIVE up(origin, id, parent, depth, path) AS (
       SELECT o.id, o.id, o.parent_org_id, 0, ARRAY[o.id] FROM organizations o WHERE o.id = ANY($1::text[])
       UNION ALL
       SELECT up.origin, p.id, p.parent_org_id, up.depth + 1, up.path || p.id
       FROM up JOIN organizations p ON p.id = up.parent
       WHERE NOT p.id = ANY(up.path)
     )
     SELECT origin, COALESCE(array_agg(id ORDER BY depth) FILTER (WHERE depth > 0), '{}') AS ancestors
     FROM up GROUP BY origin`,
    [[...orgIds]]);
  for (const row of rows) result.set(row.origin, row.ancestors);
  return result;
}
