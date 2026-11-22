// M-4 stores and brand links: legacy `brand` company links to platform organization brands, and
// legacy `store` rows to platform organization stores (migration 0202). Pure.
// Every brand in legacy belongs to one company (brand.company_id, required); the platform keeps
// that as organization_brands, one organization per brand item. A store names its company, and
// optionally a brand and a mall; legacy lets a store name only a brand of its own company, and so
// does the platform. Values are normalized to what the stores table accepts; a store that cannot
// be stored as legacy shows it is reported and left out, never trimmed to fit.
// Issues carry legacy ids, rule codes and column names only.

import { createHash } from "node:crypto";
import { kuwaitInstant } from "./m4-catalogue.js";

export interface BrandLinkImportRow {
  /** The legacy brand_uuid: the catalogue id map's key for the brand item. */
  readonly brandLegacyId: string;
  readonly companyLegacyId: string;
  readonly digest: string;
}

export interface StoreImportRow {
  readonly legacyId: string;
  readonly companyLegacyId: string;
  readonly name: string;
  readonly location: string | null;
  readonly brandLegacyId: string | null;
  readonly mallLegacyId: string | null;
  readonly status: "active" | "deleted";
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly digest: string;
}

export type StoreIssueRule =
  | "brand.badId"
  | "brand.duplicateId"
  | "brand.noCompany" // no usable company_id; no link
  | "store.badId"
  | "store.duplicateId"
  | "store.noCompany" // no usable company_id; not imported
  | "store.badName" // blank, or longer than the platform's 120; not imported
  | "store.badLocation" // longer than the platform's 500; imported without a location
  | "store.badReference" // brand_uuid or mall_uuid unusable; imported without it
  | "store.unknownBrand" // the brand is not among the legacy brands; imported without it
  | "store.brandOtherCompany"; // the brand belongs to another company; imported without it

export interface StoreIssue {
  readonly rule: StoreIssueRule;
  readonly legacyTable: "brand" | "store";
  readonly legacyId: string;
  readonly field?: string;
}

type Row = Readonly<Record<string, unknown>>;

const UUID_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function integerId(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && /^[1-9][0-9]{0,17}$/.test(value.trim()) ? value.trim() : null;
}

/** A catalogue reference: null when absent, "bad" when present but unusable. */
function reference(value: unknown): string | null | "bad" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "bad";
  const text = value.trim();
  if (text === "") return null;
  return UUID_ID.test(text) ? text : "bad";
}

function digestOf(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

const byId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Maps legacy brand rows to company links. The first row of each brand id decides it; a later row
 * with the same id is a duplicate and never linked.
 */
export function mapLegacyBrandLinks(rows: readonly Row[]): { readonly links: readonly BrandLinkImportRow[]; readonly issues: readonly StoreIssue[] } {
  const issues: StoreIssue[] = [];
  const seen = new Set<string>();
  const links: BrandLinkImportRow[] = [];
  for (const row of rows) {
    const id = reference(row.brand_uuid);
    if (id === null || id === "bad") { issues.push({ rule: "brand.badId", legacyTable: "brand", legacyId: "?" }); continue; }
    if (seen.has(id)) { issues.push({ rule: "brand.duplicateId", legacyTable: "brand", legacyId: id }); continue; }
    seen.add(id);
    const company = integerId(row.company_id);
    if (company === null) { issues.push({ rule: "brand.noCompany", legacyTable: "brand", legacyId: id, field: "company_id" }); continue; }
    const draft = { brandLegacyId: id, companyLegacyId: company };
    links.push(Object.freeze({ ...draft, digest: digestOf(draft) }));
  }
  links.sort((a, b) => (a.brandLegacyId < b.brandLegacyId ? -1 : a.brandLegacyId > b.brandLegacyId ? 1 : 0));
  return Object.freeze({ links: Object.freeze(links), issues: Object.freeze(issues) });
}

/**
 * Maps legacy store rows. `brands` are the legacy brand rows, used only to check that a store's
 * brand is its own company's (legacy's store form offers only those). A store deleted in legacy
 * (`deleted = 1`) imports as removed, so later work and assignment history can still name it.
 * `store_status` is not read: legacy sets it to 10 on every store and never reads it.
 */
export function mapLegacyStores(rows: readonly Row[], brands: readonly Row[]): { readonly stores: readonly StoreImportRow[]; readonly issues: readonly StoreIssue[] } {
  const issues: StoreIssue[] = [];
  const brandCompany = new Map<string, string | null>();
  for (const brand of brands) {
    const id = reference(brand.brand_uuid);
    if (id === null || id === "bad" || brandCompany.has(id)) continue;
    brandCompany.set(id, integerId(brand.company_id));
  }
  const seen = new Set<string>();
  const stores: StoreImportRow[] = [];
  for (const row of rows) {
    const id = integerId(row.store_id);
    if (id === null) { issues.push({ rule: "store.badId", legacyTable: "store", legacyId: "?" }); continue; }
    if (seen.has(id)) { issues.push({ rule: "store.duplicateId", legacyTable: "store", legacyId: id }); continue; }
    seen.add(id);
    const company = integerId(row.company_id);
    if (company === null) { issues.push({ rule: "store.noCompany", legacyTable: "store", legacyId: id, field: "company_id" }); continue; }
    const name = typeof row.store_name === "string" ? row.store_name.trim() : "";
    if (name === "" || [...name].length > 120) { issues.push({ rule: "store.badName", legacyTable: "store", legacyId: id, field: "store_name" }); continue; }

    let location: string | null = typeof row.store_location === "string" ? row.store_location.trim() : null;
    if (location === "") location = null;
    if (row.store_location !== null && row.store_location !== undefined && typeof row.store_location !== "string") {
      issues.push({ rule: "store.badLocation", legacyTable: "store", legacyId: id, field: "store_location" });
    } else if (location !== null && [...location].length > 500) {
      issues.push({ rule: "store.badLocation", legacyTable: "store", legacyId: id, field: "store_location" });
      location = null;
    }

    let brand = reference(row.brand_uuid);
    if (brand === "bad") { issues.push({ rule: "store.badReference", legacyTable: "store", legacyId: id, field: "brand_uuid" }); brand = null; }
    if (brand !== null && !brandCompany.has(brand)) {
      issues.push({ rule: "store.unknownBrand", legacyTable: "store", legacyId: id, field: "brand_uuid" });
      brand = null;
    } else if (brand !== null && brandCompany.get(brand) !== company) {
      issues.push({ rule: "store.brandOtherCompany", legacyTable: "store", legacyId: id, field: "brand_uuid" });
      brand = null;
    }
    let mall = reference(row.mall_uuid);
    if (mall === "bad") { issues.push({ rule: "store.badReference", legacyTable: "store", legacyId: id, field: "mall_uuid" }); mall = null; }

    const deleted = row.deleted === true || row.deleted === 1 || row.deleted === "1";
    const createdAt = kuwaitInstant(row.store_created_at);
    const updatedAt = kuwaitInstant(row.store_updated_at);
    const draft = { legacyId: id, companyLegacyId: company, name, location, brandLegacyId: brand, mallLegacyId: mall,
      status: deleted ? "deleted" as const : "active" as const, createdAt, updatedAt };
    stores.push(Object.freeze({ ...draft, digest: digestOf(draft) }));
  }
  stores.sort((a, b) => byId(a.legacyId, b.legacyId));
  return Object.freeze({ stores: Object.freeze(stores), issues: Object.freeze(issues) });
}
