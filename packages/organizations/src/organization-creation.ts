import { DEFAULT_OPERATOR_ORG_IDS } from "./organizations.js";

export interface OrganizationCreationGrantRow { readonly org_id: string; readonly role: string; readonly scope: string }

export function organizationCreationDecision(rows: readonly OrganizationCreationGrantRow[], parentId: string, ancestors: readonly string[]): boolean {
  return rows.some((row) => (row.role === "staff" || row.role === "admin") && row.scope === "subtree" && (row.org_id === parentId || ancestors.includes(row.org_id)));
}

export function organizationCreationParentAllowed(parentId: string, parentOfParent: string | null, operators: readonly string[] = DEFAULT_OPERATOR_ORG_IDS): boolean {
  // An operator parent makes a company, and a top-level company parent makes a sub-company.
  return operators.includes(parentId) || parentOfParent === null || operators.includes(parentOfParent);
}

export const ORGANIZATION_NAME_MAX = 255;
export function parseOrganizationName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= ORGANIZATION_NAME_MAX && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : undefined;
}
