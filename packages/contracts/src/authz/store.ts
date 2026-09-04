import type { Organization } from "./organization.js";
import type { Principal } from "./principal.js";
import { normalizeGrantEntry, type GrantEntry, type RevokeEntry, type RoleGrant } from "./grants.js";

/**
 * The persistence seam. The resolver and the gateway middleware depend ONLY on
 * these interfaces, so the in-memory implementation below can later be swapped
 * for Postgres/Redis without touching enforcement code.
 */

/** Read/write access to role grants, keyed by principal. */
export interface GrantsStore {
  listGrantsForPrincipal(principalId: string): Promise<readonly RoleGrant[]>;
  /** Many-at-once: grant the whole set of (org, role) assignments. Merges with existing rows (widest scope wins). */
  grantMany(principalId: string, entries: readonly GrantEntry[]): Promise<void>;
  /** Many-at-once revocation. Unknown targets are ignored. */
  revokeMany(principalId: string, entries: readonly RevokeEntry[]): Promise<void>;
  clearGrantsForPrincipal(principalId: string): Promise<void>;
}

/** Read access to the organization tree. */
export interface OrganizationStore {
  listOrganizations(): Promise<readonly Organization[]>;
  getOrganization(orgId: string): Promise<Organization | undefined>;
  upsertOrganization(org: Organization): Promise<void>;
}

/** Principal directory: maps humans and their pbuuids. */
export interface PrincipalStore {
  listPrincipals(): Promise<readonly Principal[]>;
  getPrincipal(principalId: string): Promise<Principal | undefined>;
  registerPrincipal(principal: Principal): Promise<void>;
  /** Server-side lookup of the human that owns a pbuuid. */
  findPrincipalByPbuuid(pbuuid: string): Promise<Principal | undefined>;
}

export type AuthzStore = GrantsStore & OrganizationStore & PrincipalStore;

export interface InMemoryAuthzSeed {
  readonly organizations?: readonly Organization[];
  readonly principals?: readonly Principal[];
}

/**
 * Reference in-memory implementation of the full store. Persistence is a
 * later step (SHU-49 explicitly leaves storage out of scope); tests and local
 * dev run against this.
 */
export class InMemoryAuthzStore implements AuthzStore {
  readonly #organizations = new Map<string, Organization>();
  readonly #principals = new Map<string, Principal>();
  readonly #pbuuidIndex = new Map<string, string>();
  readonly #grantsByPrincipal = new Map<string, RoleGrant[]>();
  #nextGrantId = 1;

  constructor(seed: InMemoryAuthzSeed = {}) {
    for (const org of seed.organizations ?? []) {
      this.#assertNoCycles(org.id, seed.organizations ?? []);
      this.#organizations.set(org.id, org);
    }
    for (const principal of seed.principals ?? []) this.#registerPrincipal(principal);
  }

  #assertNoCycles(startId: string, orgs: readonly Organization[]): void {
    const byId = new Map(orgs.map((o) => [o.id, o]));
    const seen = new Set<string>();
    let current = byId.get(startId);
    while (current !== undefined) {
      if (seen.has(current.id)) {
        throw new TypeError(`organization cycle detected at '${current.id}'`);
      }
      seen.add(current.id);
      current = current.parentOrgId === undefined ? undefined : byId.get(current.parentOrgId);
    }
  }

  /**
   * Register or replace a principal, keeping the pbuuid index exactly in sync.
   *
   * Two authorization bugs this closes (CodeRabbit, PR #13):
   *
   * 1. STALE MAPPINGS. Re-registering a principal with a pbuuid removed used to
   *    leave the old index entry behind, so `findPrincipalByPbuuid` kept
   *    resolving a revoked identity to a principal that still holds grants.
   *    Detaching an identity has to actually detach it.
   * 2. CROSS-PRINCIPAL THEFT. Registering a principal with a pbuuid owned by
   *    someone else used to silently reassign it. Under `sub_mode=user_email`
   *    a pbuuid IS an email address, so that is "claim another person's
   *    account by registering it".
   *
   * Validation runs to completion BEFORE any mutation, so a rejected
   * registration leaves the store untouched rather than half-applied.
   */
  #registerPrincipal(principal: Principal): void {
    for (const pbuuid of principal.pbuuids) {
      const owner = this.#pbuuidIndex.get(pbuuid);
      if (owner !== undefined && owner !== principal.id) {
        throw new TypeError(
          `pbuuid '${pbuuid}' is already owned by principal '${owner}'; ` +
            `detach it before registering it to '${principal.id}'`,
        );
      }
    }

    // Drop every mapping this principal previously owned, then re-add exactly
    // the current set — otherwise removed pbuuids keep resolving.
    for (const [pbuuid, owner] of this.#pbuuidIndex) {
      if (owner === principal.id) this.#pbuuidIndex.delete(pbuuid);
    }
    this.#principals.set(principal.id, principal);
    for (const pbuuid of principal.pbuuids) this.#pbuuidIndex.set(pbuuid, principal.id);
  }

  // --- OrganizationStore ---

  async listOrganizations(): Promise<readonly Organization[]> {
    return [...this.#organizations.values()];
  }

  async getOrganization(orgId: string): Promise<Organization | undefined> {
    return this.#organizations.get(orgId);
  }

  async upsertOrganization(org: Organization): Promise<void> {
    const siblings = [...this.#organizations.values()].filter((o) => o.id !== org.id);
    this.#assertNoCycles(org.id, [...siblings, org]);
    this.#organizations.set(org.id, org);
  }

  // --- PrincipalStore ---

  async listPrincipals(): Promise<readonly Principal[]> {
    return [...this.#principals.values()];
  }

  async getPrincipal(principalId: string): Promise<Principal | undefined> {
    return this.#principals.get(principalId);
  }

  async registerPrincipal(principal: Principal): Promise<void> {
    this.#registerPrincipal(principal);
  }

  async findPrincipalByPbuuid(pbuuid: string): Promise<Principal | undefined> {
    const principalId = this.#pbuuidIndex.get(pbuuid);
    return principalId === undefined ? undefined : this.#principals.get(principalId);
  }

  // --- GrantsStore ---

  async listGrantsForPrincipal(principalId: string): Promise<readonly RoleGrant[]> {
    return Object.freeze([...(this.#grantsByPrincipal.get(principalId) ?? [])]);
  }

  async grantMany(principalId: string, entries: readonly GrantEntry[]): Promise<void> {
    const rows = this.#grantsByPrincipal.get(principalId) ?? [];
    const byKey = new Map(rows.map((row) => [`${row.orgId}\u0000${row.role}`, row]));

    for (const raw of entries) {
      const { orgId, role, scope } = normalizeGrantEntry(raw);
      const key = `${orgId}\u0000${role}`;
      const existing = byKey.get(key);
      if (existing !== undefined) {
        // Idempotent merge: subtree is strictly wider than self. Rows are
        // frozen, so an upgrade replaces the row rather than mutating it.
        if (scope === "subtree" && existing.scope !== "subtree") {
          const upgraded: RoleGrant = Object.freeze({ ...existing, scope: "subtree" });
          rows[rows.indexOf(existing)] = upgraded;
          byKey.set(key, upgraded);
        }
        continue;
      }
      const row: RoleGrant = Object.freeze({
        id: `grant-${this.#nextGrantId++}`,
        principalId,
        orgId,
        role,
        scope,
      });
      byKey.set(key, row);
      rows.push(row);
    }

    this.#grantsByPrincipal.set(principalId, rows);
  }

  async revokeMany(principalId: string, entries: readonly RevokeEntry[]): Promise<void> {
    const rows = this.#grantsByPrincipal.get(principalId);
    if (rows === undefined) return;
    const targets = new Set(entries.map((e) => `${e.orgId}\u0000${e.role}`));
    const remaining = rows.filter((row) => !targets.has(`${row.orgId}\u0000${row.role}`));
    if (remaining.length === 0) this.#grantsByPrincipal.delete(principalId);
    else this.#grantsByPrincipal.set(principalId, remaining);
  }

  async clearGrantsForPrincipal(principalId: string): Promise<void> {
    this.#grantsByPrincipal.delete(principalId);
  }
}
