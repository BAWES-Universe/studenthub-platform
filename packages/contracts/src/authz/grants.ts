import { ROLES, isRole, type Role } from "./roles.js";

/**
 * A RoleGrant is one row of `principal × org × role`, with an explicit scope.
 *
 * - scope "self": the role applies at `orgId` only.
 * - scope "subtree": the role applies at `orgId` AND every sub-company below
 *   it. This is how "parent MAY see sub invoices" style relationships are
 *   expressed: as an explicit, configurable grant — never a hardcoded rule
 *   that parents always outrank children.
 *
 * Operations on grants are many-at-once: a caller hands over the whole set of
 * (org, role) assignments it wants for a principal in one call.
 */
export const GRANT_SCOPES = ["self", "subtree"] as const;

export type GrantScope = (typeof GRANT_SCOPES)[number];

export interface RoleGrant {
  readonly id: string;
  readonly principalId: string;
  readonly orgId: string;
  readonly role: Role;
  readonly scope: GrantScope;
}

/**
 * A grant assignment as supplied by callers (possibly crossing a trust
 * boundary, so fields are validated at the store edge).
 */
export interface GrantEntry {
  readonly orgId: string;
  readonly role: string;
  readonly scope?: string;
}

/** Revocation targets identify a grant by (org, role); scope is irrelevant. */
export interface RevokeEntry {
  readonly orgId: string;
  readonly role: string;
}

export function isGrantScope(value: unknown): value is GrantScope {
  return value === "self" || value === "subtree";
}

export function normalizeGrantEntry(entry: GrantEntry): {
  readonly orgId: string;
  readonly role: Role;
  readonly scope: GrantScope;
} {
  const orgId = entry.orgId.trim();
  if (orgId.length === 0) throw new TypeError("grant orgId must be a non-empty string");
  if (!isRole(entry.role)) {
    throw new TypeError(`grant role must be one of ${JSON.stringify([...ROLES])}`);
  }
  const role = entry.role;
  let scope: GrantScope = "self";
  if (entry.scope !== undefined) {
    if (!isGrantScope(entry.scope)) throw new TypeError("grant scope must be 'self' or 'subtree'");
    scope = entry.scope;
  }
  return { orgId, role, scope };
}
