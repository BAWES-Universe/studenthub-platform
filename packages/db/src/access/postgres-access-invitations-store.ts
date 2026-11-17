import { randomUUID } from "node:crypto";
import pg from "pg";
import { insertAuthorizationMutationAudit, resolveAuthorizationMutationContext } from "../authorization-audit.js";
import { organizationLive } from "../organization-liveness.js";
import { ancestorsOf, grantSummary } from "./postgres-access-grants-store.js";

/**
 * Access lane A2 (migration 0401): company invitations and the Team page.
 *
 * Decisions live in packages/access and are passed in; every write runs them
 * on what it read inside its own transaction. Locks are taken organization
 * first, then principal, the same order as the Access page's writes.
 */

type Scope = "self" | "subtree";
type Held = { readonly orgId: string; readonly role: string; readonly scope: string };
type Refused<R extends string> = { readonly kind: "refused"; readonly reason: R };

const ORG_LOCK_KEY = 5960;
const PRINCIPAL_LOCK_KEY = 5959;

export interface TeamMemberRow {
  readonly principalId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: string;
  readonly scope: Scope;
}

export interface PendingInvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly scope: Scope;
  readonly invitedBy: { readonly principalId: string; readonly displayName: string | null };
  readonly expiresAt: string;
}

export class PostgresAccessInvitationsStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: { readonly pool: pg.Pool } | { readonly connectionString: string }) {
    if ("pool" in options) { this.#pool = options.pool; this.#ownsPool = false; }
    else { this.#pool = new pg.Pool({ connectionString: options.connectionString }); this.#ownsPool = true; }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  async #transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async #grantsOf(db: pg.Pool | pg.PoolClient, principalId: string, lock: boolean): Promise<Held[]> {
    const { rows } = await db.query<{ org_id: string; role: string; scope: string }>(
      `SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY id${lock ? " FOR SHARE" : ""}`, [principalId]);
    return rows.map((row) => ({ orgId: row.org_id, role: row.role, scope: row.scope }));
  }

  // --- Reads ------------------------------------------------------------------

  /** The caller's grants and the company (live, with ancestors), for the page's access decision. */
  async context(callerId: string, orgId: string): Promise<{
    readonly callerGrants: readonly Held[];
    readonly organization: null | { readonly orgId: string; readonly name: string; readonly ancestors: readonly string[] };
  }> {
    const [callerGrants, org] = await Promise.all([
      this.#grantsOf(this.#pool, callerId, false),
      this.#pool.query<{ id: string; name: string }>(
        `SELECT o.id, o.name FROM organizations o
         WHERE o.id = $1 AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = o.id)`, [orgId]),
    ]);
    const row = org.rows[0];
    if (!row) return { callerGrants, organization: null };
    const ancestors = await ancestorsOf(this.#pool, [row.id]);
    return { callerGrants, organization: { orgId: row.id, name: row.name, ancestors: ancestors.get(row.id) ?? [] } };
  }

  /** People holding a grant directly on the company, and its pending invitations: two queries. */
  async team(orgId: string, now: Date): Promise<{ readonly members: readonly TeamMemberRow[]; readonly invitations: readonly PendingInvitationRow[] }> {
    const [members, invitations] = await Promise.all([
      this.#pool.query<{ principal_id: string; display_name: string | null; email: string | null; role: string; scope: Scope }>(
        `SELECT g.principal_id, p.display_name, p.email, g.role, g.scope
         FROM grants g JOIN principals p ON p.id = g.principal_id
         WHERE g.org_id = $1
         ORDER BY lower(coalesce(p.display_name, p.email, g.principal_id)), g.principal_id, g.role`, [orgId]),
      this.#pool.query<{ id: string; invited_email_normalized: string; role: string; scope: Scope; invited_by: string; inviter_name: string | null; expires_at: Date }>(
        `SELECT i.id, i.invited_email_normalized, i.role, i.scope, i.invited_by, p.display_name AS inviter_name, i.expires_at
         FROM company_invitations i LEFT JOIN principals p ON p.id = i.invited_by
         WHERE i.org_id = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > $2
         ORDER BY i.created_at DESC, i.id`, [orgId, now]),
    ]);
    return {
      members: members.rows.map((row) => ({ principalId: row.principal_id, displayName: row.display_name, email: row.email, role: row.role, scope: row.scope })),
      invitations: invitations.rows.map((row) => ({
        id: row.id, email: row.invited_email_normalized, role: row.role, scope: row.scope,
        invitedBy: { principalId: row.invited_by, displayName: row.inviter_name }, expiresAt: row.expires_at.toISOString(),
      })),
    };
  }

  /** What the invitation page may show: company name and role, never the address. */
  async invitation(tokenHash: string, now: Date): Promise<null | { readonly orgId: string; readonly orgName: string; readonly role: string; readonly scope: Scope }> {
    const { rows } = await this.#pool.query<{ org_id: string; name: string; role: string; scope: Scope }>(
      `SELECT i.org_id, o.name, i.role, i.scope FROM company_invitations i JOIN organizations o ON o.id = i.org_id
       WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > $2
         AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = i.org_id)`, [tokenHash, now]);
    const row = rows[0];
    return row ? { orgId: row.org_id, orgName: row.name, role: row.role, scope: row.scope } : null;
  }

  // --- Writes -----------------------------------------------------------------

  async invite<R extends string>(input: {
    readonly callerId: string; readonly orgId: string; readonly email: string; readonly role: string; readonly scope: Scope;
    readonly tokenHash: string; readonly now: Date; readonly ttlMs: number;
    readonly decide: (snapshot: { callerGrants: readonly Held[]; orgLive: boolean; orgAncestors: readonly string[]; pendingCount: number; duplicatePending: boolean }) => { readonly kind: "ok" } | Refused<R>;
  }): Promise<{ readonly kind: "invited"; readonly id: string; readonly expiresAt: string } | Refused<R>> {
    return this.#transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`access:org:${input.orgId}`, ORG_LOCK_KEY]);
      // An expired pending invitation for the same key gives way to the new one.
      await client.query(
        `UPDATE company_invitations SET revoked_at = $5, revoked_by = $6
         WHERE org_id = $1 AND role = $2 AND invited_email_normalized = $3 AND used_at IS NULL AND revoked_at IS NULL AND expires_at <= $4`,
        [input.orgId, input.role, input.email, input.now, input.now, input.callerId]);
      const callerGrants = await this.#grantsOf(client, input.callerId, true);
      const orgLive = await organizationLive(client, input.orgId, true);
      const ancestors = orgLive ? (await ancestorsOf(client, [input.orgId])).get(input.orgId) ?? [] : [];
      const pending = await client.query<{ n: number; duplicate: boolean }>(
        `SELECT count(*)::int AS n, bool_or(role = $2 AND invited_email_normalized = $3) AS duplicate
         FROM company_invitations WHERE org_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $4`,
        [input.orgId, input.role, input.email, input.now]);
      const decision = input.decide({ callerGrants, orgLive, orgAncestors: ancestors, pendingCount: pending.rows[0]?.n ?? 0, duplicatePending: pending.rows[0]?.duplicate === true });
      if (decision.kind === "refused") return decision;
      const id = randomUUID();
      const expiresAt = new Date(input.now.getTime() + input.ttlMs);
      await client.query(
        `INSERT INTO company_invitations (id, org_id, role, scope, invited_email_normalized, token_hash, invited_by, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, input.orgId, input.role, input.scope, input.email, input.tokenHash, input.callerId, input.now, expiresAt]);
      return { kind: "invited", id, expiresAt: expiresAt.toISOString() };
    });
  }

  async revokeInvitation<R extends string>(input: {
    readonly callerId: string; readonly orgId: string; readonly invitationId: string; readonly now: Date;
    readonly decide: (snapshot: { callerGrants: readonly Held[]; orgAncestors: readonly string[] }) => { readonly kind: "ok" } | Refused<R>;
  }): Promise<{ readonly kind: "revoked" } | Refused<R | "not_found">> {
    return this.#transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`access:org:${input.orgId}`, ORG_LOCK_KEY]);
      const callerGrants = await this.#grantsOf(client, input.callerId, true);
      const ancestors = (await ancestorsOf(client, [input.orgId])).get(input.orgId) ?? [];
      const decision = input.decide({ callerGrants, orgAncestors: ancestors });
      if (decision.kind === "refused") return decision;
      const changed = await client.query(
        `UPDATE company_invitations SET revoked_at = $3, revoked_by = $4
         WHERE id = $1 AND org_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
        [input.invitationId, input.orgId, input.now, input.callerId]);
      return changed.rowCount ? { kind: "revoked" } : { kind: "refused", reason: "not_found" };
    });
  }

  /**
   * Accepts in one transaction: locks the invitation row, reads the
   * principal's current email and the inviter's current grants, decides,
   * marks the invitation used, then writes the grant, the audit row (the
   * inviter as actor) and the event row. Dead links all answer "invalid".
   */
  async accept(input: {
    readonly tokenHash: string; readonly principalId: string; readonly now: Date; readonly reason: string;
    readonly decide: (snapshot: {
      invitation: null | { orgId: string; role: string; scope: Scope; email: string; invitedBy: string; expiresAt: Date; usedAt: Date | null; revokedAt: Date | null };
      now: Date; orgLive: boolean; orgAncestors: readonly string[]; principalEmail: string | null; inviterGrants: readonly Held[];
    }) => { readonly kind: "accept" } | { readonly kind: "invalid" } | { readonly kind: "wrong_address" };
  }): Promise<{ readonly kind: "accepted" | "already_held"; readonly orgId: string; readonly role: string; readonly scope: Scope } | { readonly kind: "invalid" } | { readonly kind: "wrong_address" }> {
    return this.#transaction(async (client) => {
      const found = await client.query<{ id: string; org_id: string }>(
        "SELECT id, org_id FROM company_invitations WHERE token_hash = $1", [input.tokenHash]);
      const head = found.rows[0];
      if (!head) return { kind: "invalid" };
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`access:org:${head.org_id}`, ORG_LOCK_KEY]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [input.principalId, PRINCIPAL_LOCK_KEY]);
      const locked = await client.query<{ org_id: string; role: string; scope: Scope; invited_email_normalized: string; invited_by: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null }>(
        `SELECT org_id, role, scope, invited_email_normalized, invited_by, expires_at, used_at, revoked_at
         FROM company_invitations WHERE id = $1 FOR UPDATE`, [head.id]);
      const row = locked.rows[0]!;
      const orgLive = await organizationLive(client, row.org_id, true);
      const ancestors = orgLive ? (await ancestorsOf(client, [row.org_id])).get(row.org_id) ?? [] : [];
      const principal = await client.query<{ email: string | null }>("SELECT email FROM principals WHERE id = $1 FOR SHARE", [input.principalId]);
      if (!principal.rowCount) return { kind: "invalid" };
      const inviterGrants = await this.#grantsOf(client, row.invited_by, true);
      const decision = input.decide({
        invitation: { orgId: row.org_id, role: row.role, scope: row.scope, email: row.invited_email_normalized, invitedBy: row.invited_by, expiresAt: row.expires_at, usedAt: row.used_at, revokedAt: row.revoked_at },
        now: input.now, orgLive, orgAncestors: ancestors, principalEmail: principal.rows[0]!.email, inviterGrants,
      });
      if (decision.kind !== "accept") return decision;
      const used = await client.query(
        `UPDATE company_invitations SET used_at = $2, used_by = $3
         WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $2 RETURNING id`,
        [head.id, input.now, input.principalId]);
      if (!used.rowCount) return { kind: "invalid" };
      const current = await client.query<{ scope: Scope }>(
        "SELECT scope FROM grants WHERE principal_id = $1 AND org_id = $2 AND role = $3 FOR UPDATE", [input.principalId, row.org_id, row.role]);
      const held = current.rows[0]?.scope ?? null;
      if (held === row.scope || held === "subtree") return { kind: "already_held", orgId: row.org_id, role: row.role, scope: held };
      const before = await grantSummary(client, input.principalId);
      await client.query(
        `INSERT INTO grants (principal_id, org_id, role, scope) VALUES ($1, $2, $3, $4)
         ON CONFLICT (principal_id, org_id, role) DO UPDATE SET scope = EXCLUDED.scope`,
        [input.principalId, row.org_id, row.role, row.scope]);
      await insertAuthorizationMutationAudit(client, {
        context: resolveAuthorizationMutationContext({ actorPrincipalId: row.invited_by }),
        operation: "grants.grant", targetPrincipalId: input.principalId, targetOrgIds: [row.org_id],
        before, after: await grantSummary(client, input.principalId),
      });
      await client.query(
        `INSERT INTO access_grant_events (target_principal_id, org_id, role, scope, action, actor_principal_id, reason)
         VALUES ($1, $2, $3, $4, 'grant', $5, $6)`,
        [input.principalId, row.org_id, row.role, row.scope, row.invited_by, input.reason]);
      return { kind: "accepted", orgId: row.org_id, role: row.role, scope: row.scope };
    });
  }

  /** An owner removes a member's grants held directly on this company, under the company lock. */
  async removeMember<R extends string>(input: {
    readonly callerId: string; readonly orgId: string; readonly targetId: string; readonly reason: string;
    readonly decide: (snapshot: { callerGrants: readonly Held[]; orgLive: boolean; orgAncestors: readonly string[]; targetGrants: readonly { role: string; scope: Scope }[]; ownerCount: number }) =>
      { readonly kind: "remove"; readonly roles: readonly string[] } | Refused<R>;
  }): Promise<{ readonly kind: "removed"; readonly roles: readonly string[] } | Refused<R>> {
    return this.#transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`access:org:${input.orgId}`, ORG_LOCK_KEY]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [input.targetId, PRINCIPAL_LOCK_KEY]);
      const callerGrants = await this.#grantsOf(client, input.callerId, true);
      const orgLive = await organizationLive(client, input.orgId, true);
      const ancestors = orgLive ? (await ancestorsOf(client, [input.orgId])).get(input.orgId) ?? [] : [];
      const target = await client.query<{ role: string; scope: Scope }>(
        "SELECT role, scope FROM grants WHERE principal_id = $1 AND org_id = $2 ORDER BY role FOR UPDATE", [input.targetId, input.orgId]);
      const owners = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM grants WHERE org_id = $1 AND role = 'org-owner'", [input.orgId]);
      const decision = input.decide({ callerGrants, orgLive, orgAncestors: ancestors, targetGrants: target.rows, ownerCount: owners.rows[0]?.n ?? 0 });
      if (decision.kind === "refused") return decision;
      const before = await grantSummary(client, input.targetId);
      await client.query("DELETE FROM grants WHERE principal_id = $1 AND org_id = $2", [input.targetId, input.orgId]);
      await insertAuthorizationMutationAudit(client, {
        context: resolveAuthorizationMutationContext({ actorPrincipalId: input.callerId }),
        operation: "grants.revoke", targetPrincipalId: input.targetId, targetOrgIds: [input.orgId],
        before, after: await grantSummary(client, input.targetId),
      });
      for (const grant of target.rows) {
        await client.query(
          `INSERT INTO access_grant_events (target_principal_id, org_id, role, scope, action, actor_principal_id, reason)
           VALUES ($1, $2, $3, $4, 'revoke', $5, $6)`,
          [input.targetId, input.orgId, grant.role, grant.scope, input.callerId, input.reason]);
      }
      return { kind: "removed", roles: target.rows.map((grant) => grant.role) };
    });
  }
}
