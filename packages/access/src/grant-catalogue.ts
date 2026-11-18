import { isGrantScope, isRole, type GrantScope, type Role } from "@studenthub/contracts";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";

/**
 * Access lane A1: which roles a caller may give or take away, and where.
 *
 * Grants never come from holding a role: an admin may give "admin" on the
 * operator organization because the catalogue says admins may, not because
 * they hold it. A candidate, recruiter, finance or org-owner grant gives its
 * holder nothing to grant here (company owners invite through A2 instead).
 *
 * The catalogue is pure. Callers read the caller's grants and the target
 * organization's ancestors from the store, inside the write's transaction for
 * a write, and pass them in.
 */

export interface HeldGrant {
  readonly orgId: string;
  readonly role: string;
  readonly scope: string;
}

export interface GrantOption {
  readonly role: Role;
  readonly scopes: readonly GrantScope[];
}

/** Roles an operator admin may give on an operator organization. */
export const OPERATOR_GRANTABLE_ROLES: readonly Role[] = Object.freeze(["staff", "admin", "finance"]);
/** Roles operator staff or admins may give on a company. */
export const COMPANY_GRANTABLE_ROLES: readonly Role[] = Object.freeze(["org-owner", "recruiter", "finance"]);

/**
 * True when `grant` applies at `targetOrgId`: a grant on the organization
 * itself, or a subtree grant on one of its ancestors. `ancestors` lists the
 * target's ancestors only (never the target), in any order.
 */
export function grantCovers(grant: HeldGrant, targetOrgId: string, ancestors: readonly string[]): boolean {
  if (!isRole(grant.role) || !isGrantScope(grant.scope)) return false;
  if (grant.orgId === targetOrgId) return true;
  return grant.scope === "subtree" && ancestors.includes(grant.orgId);
}

export function isOperatorOrg(orgId: string, operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS): boolean {
  return operatorOrgIds.includes(orgId);
}

/**
 * Whether a caller may open the Access pages at all: an admin grant on an
 * operator organization, or a staff grant there at subtree scope (a
 * self-scoped staff grant reaches no company, so it could change nothing). What they may change is still decided per
 * organization by `grantCatalogue`.
 */
export function mayOpenAccessAdmin(
  callerGrants: readonly HeldGrant[],
  operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS,
): boolean {
  return callerGrants.some((grant) => operatorOrgIds.includes(grant.orgId) &&
    (grant.role === "admin" ? isGrantScope(grant.scope) : grant.role === "staff" && grant.scope === "subtree"));
}

/**
 * The roles and scopes `callerGrants` allow the caller to give or take away
 * at `targetOrgId`. Empty means nothing.
 *
 * - On an operator organization: only an admin whose grant covers it, for
 *   staff, admin and finance, at self or subtree scope.
 * - On any other organization: an admin or staff member whose grant covers
 *   it, for org-owner, recruiter and finance; subtree scope only when an
 *   admin grant covers it.
 * - The candidate role is never offered.
 */
export function grantCatalogue(input: {
  readonly callerGrants: readonly HeldGrant[];
  readonly targetOrgId: string;
  readonly targetAncestors: readonly string[];
  readonly operatorOrgIds?: readonly string[];
}): readonly GrantOption[] {
  const operatorOrgIds = input.operatorOrgIds ?? DEFAULT_OPERATOR_ORG_IDS;
  const covering = input.callerGrants.filter((grant) =>
    grantCovers(grant, input.targetOrgId, input.targetAncestors));
  const admin = covering.some((grant) => grant.role === "admin");
  const staff = covering.some((grant) => grant.role === "staff");
  if (isOperatorOrg(input.targetOrgId, operatorOrgIds)) {
    if (!admin) return Object.freeze([]);
    return Object.freeze(OPERATOR_GRANTABLE_ROLES.map((role) =>
      Object.freeze({ role, scopes: Object.freeze(["self", "subtree"] as GrantScope[]) })));
  }
  if (!admin && !staff) return Object.freeze([]);
  const scopes: readonly GrantScope[] = Object.freeze(admin ? ["self", "subtree"] : ["self"]);
  return Object.freeze(COMPANY_GRANTABLE_ROLES.map((role) => Object.freeze({ role, scopes })));
}

/** Whether the catalogue allows `role` at `scope`. */
export function catalogueAllows(options: readonly GrantOption[], role: string, scope: string): boolean {
  return options.some((option) => option.role === role && (option.scopes as readonly string[]).includes(scope));
}
