import type { GrantScope, Organization, Role, RoleGrant } from "@studenthub/contracts";
import { ancestorOrgIdsIncludingSelf } from "@studenthub/contracts";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";

export interface GrantCatalogueItem {
  readonly role: Role;
  readonly scopes: readonly GrantScope[];
}

/** Pure policy catalogue. It grants authority; it never infers it from the candidate role. */
export function grantCatalogue(
  callerGrants: readonly Pick<RoleGrant, "orgId" | "role" | "scope">[],
  targetOrganization: Pick<Organization, "id">,
  organizations: readonly Organization[] = [{id:targetOrganization.id,name:""}],
): readonly GrantCatalogueItem[] {
  const operator = (DEFAULT_OPERATOR_ORG_IDS as readonly string[]).includes(targetOrganization.id);
  const ancestors = new Set(ancestorOrgIdsIncludingSelf(organizations, targetOrganization.id));
  const covers = (grant: Pick<RoleGrant, "orgId" | "role" | "scope">) =>
    grant.orgId === targetOrganization.id || (grant.scope === "subtree" && ancestors.has(grant.orgId));
  const isAdmin = callerGrants.some((g) => g.role === "admin" && covers(g));
  const isStaff = callerGrants.some((g) => g.role === "staff" && covers(g));
  if (operator) {
    if (!isAdmin) return Object.freeze([]);
    return Object.freeze((["staff", "admin", "finance"] as const).map(role =>
      Object.freeze({ role, scopes: Object.freeze(["self", "subtree"] as GrantScope[]) })));
  }
  if (!isAdmin && !isStaff) return Object.freeze([]);
  const scopes: readonly GrantScope[] = isAdmin ? Object.freeze(["self", "subtree"]) : Object.freeze(["self"]);
  return Object.freeze((["org-owner", "recruiter", "finance"] as const).map(role => Object.freeze({ role, scopes })));
}

export const accessGrantCatalogue = grantCatalogue;

export function catalogueAllows(items: readonly GrantCatalogueItem[], role: Role, scope: GrantScope): boolean {
  return items.some(item => item.role === role && item.scopes.includes(scope));
}
