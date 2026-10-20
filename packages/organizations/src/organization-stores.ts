import { DEFAULT_OPERATOR_ORG_IDS } from "./organizations.js";

// SHU-165 O7a: an organization's stores. Its owners, staff and admin keep the
// list (the card widens legacy OR-20, which was staff-only); recruiters of the
// organization also read it (OR-19).
// The store-scoped manager grant (OR-21) waits on I4 (SHU-153).

export interface OrganizationStoreGrantRow { readonly org_id: string; readonly role: string; readonly scope: string }
export interface OrganizationStoreRow {
  readonly store_id: string;
  readonly org_id?: string;
  readonly name: string;
  readonly location: string | null;
  readonly status: string;
  readonly brand_id: string | null;
  readonly brand_name: string | null;
  readonly brand_status: string | null;
  readonly mall_id: string | null;
  readonly mall_name: string | null;
  readonly mall_status: string | null;
  readonly created_by_ref?: string;
  readonly updated_at?: Date | string;
}
export interface OrganizationStoreReference { readonly id: string; readonly name: string }
export interface OrganizationStoreView {
  readonly storeId: string;
  readonly name: string;
  readonly location: string | null;
  readonly brand: OrganizationStoreReference | null;
  readonly mall: OrganizationStoreReference | null;
}
export interface OrganizationStoreFields {
  readonly name: string;
  readonly location: string | null;
  readonly brandId: string | null;
  readonly mallId: string | null;
}

const WRITE_ROLES = ["staff", "admin", "org-owner"];
const READ_ROLES = ["staff", "admin", "org-owner", "recruiter"];
export const ORGANIZATION_STORE_NAME_MAX = 120;
export const ORGANIZATION_STORE_LOCATION_MAX = 500;

function covers(rows: readonly OrganizationStoreGrantRow[], roles: readonly string[], orgId: string, ancestors: readonly string[]): boolean {
  return rows.some((row) => roles.includes(row.role) && (row.org_id === orgId || (row.scope === "subtree" && ancestors.includes(row.org_id))));
}

/** Staff, admin or org-owner on the organization, or on an ancestor through a subtree grant. Operator organizations have no stores. */
export function organizationStoreWriteDecision(rows: readonly OrganizationStoreGrantRow[], orgId: string, ancestors: readonly string[], operators: readonly string[] = DEFAULT_OPERATOR_ORG_IDS): boolean {
  return !operators.includes(orgId) && covers(rows, WRITE_ROLES, orgId, ancestors);
}

/** Writers, plus the organization's recruiters (self or inherited through subtree). Finance and candidates read nothing. */
export function organizationStoreReadDecision(rows: readonly OrganizationStoreGrantRow[], orgId: string, ancestors: readonly string[], operators: readonly string[] = DEFAULT_OPERATOR_ORG_IDS): boolean {
  return !operators.includes(orgId) && covers(rows, READ_ROLES, orgId, ancestors);
}

export function isOrganizationStoreId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : undefined;
}

/**
 * Parses the editable fields of a store. Name is required; location, brand and
 * mall are optional and `null` clears them. Unknown keys are refused.
 */
export function parseOrganizationStoreFields(value: unknown): OrganizationStoreFields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["name", "location", "brandId", "mallId"].includes(key))) return undefined;
  const name = text(record.name, ORGANIZATION_STORE_NAME_MAX);
  if (name === undefined) return undefined;
  const location = record.location === undefined || record.location === null ? null : text(record.location, ORGANIZATION_STORE_LOCATION_MAX);
  if (location === undefined) return undefined;
  const reference = (v: unknown) => (v === undefined || v === null ? null : isOrganizationStoreId(v) ? v.toLowerCase() : undefined);
  const brandId = reference(record.brandId), mallId = reference(record.mallId);
  if (brandId === undefined || mallId === undefined) return undefined;
  return { name, location, brandId, mallId };
}

/** Active stores only, sorted by name then id; a removed brand or mall shows as none. Exposes exactly the view keys. */
export function organizationStoresView(rows: readonly OrganizationStoreRow[]): OrganizationStoreView[] {
  return rows
    .filter((row) => row.status === "active")
    .sort((a, b) => a.name.localeCompare(b.name) || a.store_id.localeCompare(b.store_id))
    .map((row) => ({
      storeId: row.store_id,
      name: row.name,
      location: row.location,
      brand: row.brand_id !== null && row.brand_name !== null && row.brand_status === "active" ? { id: row.brand_id, name: row.brand_name } : null,
      mall: row.mall_id !== null && row.mall_name !== null && row.mall_status === "active" ? { id: row.mall_id, name: row.mall_name } : null,
    }));
}
