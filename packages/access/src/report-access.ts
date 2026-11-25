import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import type { HeldGrant } from "./grant-catalogue.js";

/**
 * Access lane: who may read StudentHub's own reports.
 *
 * Reports count across every company under the operator, so only a subtree
 * grant on an operator organization reaches them; a self-scoped grant there
 * reaches no company and gives nothing. No role is added: the existing
 * operator roles already say who should see what.
 *
 * - operations (statistics, team activity, the operations entry): operator
 *   staff and operator admins.
 * - finance (revenue and other money figures): operator finance and operator
 *   admins. Operator staff do not see money figures.
 *
 * The projection is pure. Callers read the viewer's grants from the store and
 * pass them in; anyone outside it gets the same not found as an unknown path.
 */
export interface ReportAccess {
  readonly operations: boolean;
  readonly finance: boolean;
}

const NONE: ReportAccess = Object.freeze({ operations: false, finance: false });

export function reportAccess(
  viewerGrants: readonly HeldGrant[],
  operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS,
): ReportAccess {
  const roles = new Set(viewerGrants
    .filter((grant) => grant.scope === "subtree" && operatorOrgIds.includes(grant.orgId))
    .map((grant) => grant.role));
  if (roles.size === 0) return NONE;
  const admin = roles.has("admin");
  return Object.freeze({ operations: admin || roles.has("staff"), finance: admin || roles.has("finance") });
}

/** Whether the viewer may read finance reports such as revenue. */
export function mayViewFinanceReports(
  viewerGrants: readonly HeldGrant[],
  operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS,
): boolean {
  return reportAccess(viewerGrants, operatorOrgIds).finance;
}
