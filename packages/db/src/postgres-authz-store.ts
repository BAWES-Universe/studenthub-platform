/**
 * Postgres-backed AuthzStore (SHU-55).
 *
 * Implements the EXACT interfaces from @studenthub/contracts
 * (GrantsStore & OrganizationStore & PrincipalStore) so enforcement code in
 * packages/contracts/src/authz/context.ts and apps/gateway keeps resolving
 * contexts without knowing whether the store is in-memory or Postgres.
 *
 * Contract invariants that the in-memory store enforces in code are enforced
 * HERE at the database (see migrations/0001):
 *
 *  1. WIDEST SCOPE WINS is one upsert. grantMany merges per (org, role):
 *     'self' -> 'subtree' upgrades the existing row in place (id preserved),
 *     never duplicates it — same observable behavior as InMemoryAuthzStore.
 *  2. PBUUID OWNERSHIP IS A PRIMARY KEY, not a pre-flight check. The
 *     in-memory store scans its index before mutating; that scan is TOCTOU —
 *     two concurrent registrations of the same pbuuid to different principals
 *     can both pass the scan, then whichever mutates second silently steals
 *     the mapping. Here, principal_pbuuids.pbuuid PRIMARY KEY serializes the
 *     writers: exactly one commits, the loser hits unique-violation 23505 and
 *     the whole registration transaction rolls back (CWE-863 class). The
 *     TypeError we throw is diagnostics; the constraint is the enforcement.
 *  3. STALE MAPPINGS ARE DELETED, not overwritten. registerPrincipal removes
 *     every pbuuid row the principal previously owned before inserting the
 *     current set, inside the SAME transaction, so a detached identity stops
 *     resolving atomically with the re-registration.
 *
 * Referential integrity deviations from the in-memory store (documented):
 * upsertOrganization requires the parent row to already exist (FK), and
 * grantMany requires the principal and org rows to exist. The in-memory
 * store tolerated orphans; the schema intentionally does not — callers seed
 * parents before children (bootstrap-admin does).
 */
import pg from "pg";
import type { PoolConfig, Pool as PgPool } from "pg";

import {
  GRANT_SCOPES,
  ROLES,
  type AuthzStore,
  type GrantEntry,
  type GrantScope,
  type Organization,
  type Principal,
  type RevokeEntry,
  type Role,
  type RoleGrant,
  isGrantScope,
  isRole,
  normalizeGrantEntry,
} from "@studenthub/contracts";

// --- Row shapes -----------------------------------------------------------------

interface OrgRow {
  id: string;
  name: string;
  parent_org_id: string | null;
}

interface PrincipalRow {
  id: string;
  display_name: string | null;
  email: string | null;
  /** Aggregated by array_agg over the pbuuid join. */
  pbuuids: string[];
}

interface GrantRow {
  id: string;
  principal_id: string;
  org_id: string;
  role: string;
  scope: string;
}

// --- Row mappers ----------------------------------------------------------------
// Outputs are frozen copies like InMemoryAuthzStore returns; the store never
// hands out a reference into a row buffer it could reuse.

function mapOrg(row: OrgRow): Organization {
  return Object.freeze(
    row.parent_org_id === null
      ? { id: row.id, name: row.name }
      : { id: row.id, name: row.name, parentOrgId: row.parent_org_id },
  );
}

function mapPrincipal(row: PrincipalRow): Principal {
  return Object.freeze({
    id: row.id,
    pbuuids: Object.freeze(row.pbuuids),
    displayName: row.display_name ?? undefined,
    email: row.email ?? undefined,
  });
}

function mapGrant(row: GrantRow): RoleGrant {
  // CHECK constraints guarantee role/scope validity; the isRole/isGrantScope
  // guards turn a corrupted row into a loud TypeError instead of a type lie
  // that flows into the resolver.
  if (!isRole(row.role) || !isGrantScope(row.scope)) {
    throw new TypeError(
      `corrupt grants row ${row.id}: role '${row.role}', scope '${row.scope}' ` +
        `(expected role in ${JSON.stringify([...ROLES])}, scope in ${JSON.stringify([...GRANT_SCOPES])})`,
    );
  }
  return Object.freeze({
    id: String(row.id),
    principalId: row.principal_id,
    orgId: row.org_id,
    role: row.role as Role,
    scope: row.scope as GrantScope,
  });
}

const PRINCIPAL_SELECT = `
  SELECT p.id, p.display_name, p.email,
         COALESCE(array_agg(pb.pbuuid) FILTER (WHERE pb.pbuuid IS NOT NULL), '{}') AS pbuuids
  FROM principals p
  LEFT JOIN principal_pbuuids pb ON pb.principal_id = p.id
`;

function isUniqueViolation(
  error: unknown,
): error is { readonly code: string; readonly constraint?: string; readonly detail?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

export class PostgresAuthzStore implements AuthzStore {
  readonly #pool: PgPool;
  /** close() ends the pool only when WE created it (caller-owned pools stay open). */
  readonly #ownsPool: boolean;

  constructor(poolOrConfig: PgPool | PoolConfig) {
    if (poolOrConfig instanceof pg.Pool) {
      this.#pool = poolOrConfig;
      this.#ownsPool = false;
    } else {
      this.#pool = new pg.Pool(poolOrConfig);
      this.#ownsPool = true;
    }
  }

  /** Tear down the pool. No-op for pools the caller injected. */
  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  // --- OrganizationStore ---------------------------------------------------------

  async listOrganizations(): Promise<readonly Organization[]> {
    const { rows } = await this.#pool.query<OrgRow>(
      "SELECT id, name, parent_org_id FROM organizations ORDER BY id",
    );
    return Object.freeze(rows.map(mapOrg));
  }

  async getOrganization(orgId: string): Promise<Organization | undefined> {
    const { rows } = await this.#pool.query<OrgRow>(
      "SELECT id, name, parent_org_id FROM organizations WHERE id = $1",
      [orgId],
    );
    return rows[0] === undefined ? undefined : mapOrg(rows[0]);
  }

  async upsertOrganization(org: Organization): Promise<void> {
    // ON CONFLICT (id) makes this both an insert and a rename/reparent update.
    // NULL parent_org_id (root) is written as SQL NULL; a parent that does not
    // exist yet is rejected by the FK — seed parents before children.
    await this.#pool.query(
      `INSERT INTO organizations (id, name, parent_org_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_org_id = EXCLUDED.parent_org_id`,
      [org.id, org.name, org.parentOrgId ?? null],
    );
  }

  // --- PrincipalStore ------------------------------------------------------------

  async listPrincipals(): Promise<readonly Principal[]> {
    const { rows } = await this.#pool.query<PrincipalRow>(
      `${PRINCIPAL_SELECT} GROUP BY p.id ORDER BY p.id`,
    );
    return Object.freeze(rows.map(mapPrincipal));
  }

  async getPrincipal(principalId: string): Promise<Principal | undefined> {
    const { rows } = await this.#pool.query<PrincipalRow>(
      `${PRINCIPAL_SELECT} WHERE p.id = $1 GROUP BY p.id`,
      [principalId],
    );
    return rows[0] === undefined ? undefined : mapPrincipal(rows[0]);
  }

  async findPrincipalByPbuuid(pbuuid: string): Promise<Principal | undefined> {
    // Look the owner up first, THEN aggregate that principal's full pbuuid
    // set. Filtering the JOIN by pbuuid before aggregation would return a
    // principal carrying only the matched pbuuid, not all of its identities.
    const { rows } = await this.#pool.query<{ principal_id: string }>(
      "SELECT principal_id FROM principal_pbuuids WHERE pbuuid = $1",
      [pbuuid],
    );
    const principalId = rows[0]?.principal_id;
    return principalId === undefined ? undefined : this.getPrincipal(principalId);
  }

  /**
   * Register or replace a principal in ONE transaction:
   *   upsert the principal row,
   *   delete every pbuuid row it used to own (stale-mapping removal),
   *   insert the current set (deduped defensively; createPrincipal already
   *   dedupes, but the store must not corrupt itself on a hand-built object).
   *
   * A pbuuid owned by ANOTHER principal makes the insert fail with 23505 on
   * the pbuuid primary key; we roll back the whole transaction (so a rejected
   * registration leaves zero trace, matching the in-memory validation-first
   * behavior) and re-raise as a TypeError naming the current owner.
   */
  async registerPrincipal(principal: Principal): Promise<void> {
    const claimed = [...new Set(principal.pbuuids)];
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO principals (id, display_name, email)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email`,
        [principal.id, principal.displayName ?? null, principal.email ?? null],
      );
      await client.query("DELETE FROM principal_pbuuids WHERE principal_id = $1", [
        principal.id,
      ]);
      for (const pbuuid of claimed) {
        await client.query(
          "INSERT INTO principal_pbuuids (principal_id, pbuuid) VALUES ($1, $2)",
          [principal.id, pbuuid],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        // The only unique constraint this transaction can hit while inserting
        // is the pbuuid primary key. Identify the conflicting pbuuid and its
        // current owner for the error message. The lookup runs AFTER the
        // rollback (the transaction is aborted) and is best-effort
        // diagnostics only — enforcement already happened in the constraint.
        const ownerRows = await client.query<{ pbuuid: string; owner_id: string }>(
          `SELECT pb.pbuuid, p.id AS owner_id
           FROM principal_pbuuids pb
           JOIN principals p ON p.id = pb.principal_id
           WHERE pb.pbuuid = ANY($1)`,
          [claimed],
        );
        const conflict = ownerRows.rows.find((row) => row.owner_id !== principal.id);
        if (conflict !== undefined) {
          throw new TypeError(
            `pbuuid '${conflict.pbuuid}' is already owned by principal '${conflict.owner_id}'; ` +
              `detach it before registering it to '${principal.id}'`,
          );
        }
        throw new TypeError(
          `pbuuid registration conflict for principal '${principal.id}': ` +
            "one of the claimed pbuuids is owned by another principal",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // --- GrantsStore ---------------------------------------------------------------

  async listGrantsForPrincipal(principalId: string): Promise<readonly RoleGrant[]> {
    const { rows } = await this.#pool.query<GrantRow>(
      "SELECT id, principal_id, org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY id",
      [principalId],
    );
    return Object.freeze(rows.map(mapGrant));
  }

  /**
   * Many-at-once grant, merged per (org, role) with widest scope winning.
   * All entries are normalized (validated) BEFORE the first SQL statement, so
   * an invalid entry rejects the whole call with no partial application —
   * then the entire set lands as ONE upsert statement, which is atomic.
   *
   * ON CONFLICT (principal_id, org_id, role) turns the re-grant of an
   * existing row into a scope upgrade in place: the row id is preserved and
   * 'subtree' (the wider scope) is never narrowed back to 'self'.
   */
  async grantMany(principalId: string, entries: readonly GrantEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const normalized = entries.map(normalizeGrantEntry);

    const params: unknown[] = [principalId];
    const tuples: string[] = [];
    let next = 1; // $1 is principal_id, repeated in every tuple
    for (const entry of normalized) {
      tuples.push(`($1, $${next + 1}, $${next + 2}, $${next + 3})`);
      params.push(entry.orgId, entry.role, entry.scope);
      next += 3;
    }

    await this.#pool.query(
      `INSERT INTO grants (principal_id, org_id, role, scope)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (principal_id, org_id, role) DO UPDATE SET
         scope = CASE
           WHEN grants.scope = 'subtree' OR EXCLUDED.scope = 'subtree' THEN 'subtree'
           ELSE grants.scope
         END`,
      params,
    );
  }

  async revokeMany(principalId: string, entries: readonly RevokeEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const params: unknown[] = [principalId];
    const tuples: string[] = [];
    let next = 1;
    for (const entry of entries) {
      tuples.push(`($${next + 1}, $${next + 2})`);
      params.push(entry.orgId, entry.role);
      next += 2;
    }
    // Row matches on (org_id, role); scope is deliberately ignored, exactly
    // like the in-memory revokeMany. Unknown targets simply delete nothing.
    await this.#pool.query(
      `DELETE FROM grants
       WHERE principal_id = $1 AND (org_id, role) IN (${tuples.join(", ")})`,
      params,
    );
  }

  async clearGrantsForPrincipal(principalId: string): Promise<void> {
    await this.#pool.query("DELETE FROM grants WHERE principal_id = $1", [principalId]);
  }
}
