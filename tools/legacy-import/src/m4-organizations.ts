// M-4 organizations: legacy `company` rows to platform organizations plus the approved
// company snapshot the organizations package reads (ApprovedOrganizationAdapter). Pure.
// Every snapshot value is normalized to exactly what the organizations package parses, so a
// bad legacy value becomes null with a reported issue instead of breaking an organization page.
// Issues carry legacy ids, rule codes and column names only.

import { createHash } from "node:crypto";

/** The legacy columns the organization projections read, plus the activity counters. */
export const COMPANY_SNAPSHOT_COLUMNS = [
  "company_name", "company_common_name_en", "company_common_name_ar", "company_description_en", "company_description_ar",
  "company_website", "company_email", "currency_code", "company_approved_to_hire", "company_hourly_rate",
  "company_bonus_commission", "company_status_override", "total_candidate", "is_request_updates_in_30_days", "no_of_active_requests",
] as const;
export type CompanySnapshotColumn = (typeof COMPANY_SNAPSHOT_COLUMNS)[number];
export type CompanySnapshot = Readonly<Record<CompanySnapshotColumn, string | number | boolean | null>>;

export interface OrganizationImportRow {
  readonly legacyId: string;
  readonly parentLegacyId: string | null;
  /** The registry name: the legal name, trimmed. */
  readonly name: string;
  readonly snapshot: CompanySnapshot;
  readonly digest: string;
}

export type OrganizationIssueRule =
  | "company.badId"
  | "company.duplicateId"
  | "company.noName" // no usable legal name; not imported
  | "company.missingParent" // parent id not among the imported companies; not imported (nor its children)
  | "company.parentCycle" // parent chain loops; not imported
  | "company.tooDeep" // a sub-company's own sub-company; the platform allows one level; not imported
  | "company.badValue"; // one snapshot column unusable; imported with that column null

export interface OrganizationIssue {
  readonly rule: OrganizationIssueRule;
  readonly legacyId: string;
  readonly field?: string;
}

type Row = Readonly<Record<string, unknown>>;
const TEXT_LIMITS: Partial<Record<CompanySnapshotColumn, number>> = {
  company_name: 255, company_common_name_en: 255, company_common_name_ar: 255, company_description_en: 10_000,
  company_description_ar: 10_000, company_website: 2_048, company_email: 255,
};

function legacyId(value: unknown): string | null {
  const text = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === "string" && /^[1-9][0-9]{0,17}$/.test(value.trim()) ? value.trim() : null;
  return text;
}

function parentId(value: unknown): string | null | "bad" {
  if (value === null || value === undefined || value === 0 || value === "0" || value === "") return null;
  return legacyId(value) ?? "bad";
}

type Normalized = { value: string | number | boolean | null; bad: boolean };
const ok = (value: string | number | boolean | null): Normalized => ({ value, bad: false });
const bad: Normalized = { value: null, bad: true };

function normalize(column: CompanySnapshotColumn, raw: unknown): Normalized {
  if (raw === null || raw === undefined) return ok(null);
  const limit = TEXT_LIMITS[column];
  if (limit !== undefined) {
    if (typeof raw !== "string") return bad;
    if (raw.trim() === "") return ok(null);
    return raw.length > limit ? bad : ok(raw);
  }
  switch (column) {
    case "currency_code": {
      if (typeof raw !== "string") return bad;
      const code = raw.trim().toUpperCase();
      return code === "" ? ok(null) : /^[A-Z]{3}$/.test(code) ? ok(code) : bad;
    }
    case "company_approved_to_hire": {
      if (raw === true || raw === 1 || raw === "1") return ok(1);
      if (raw === false || raw === 0 || raw === "0") return ok(0);
      return bad;
    }
    case "company_hourly_rate":
    case "company_bonus_commission": {
      const text = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? String(raw) : typeof raw === "string" ? raw.trim() : null;
      if (text === null) return bad;
      // MySQL DECIMAL arrives as a string with trailing zeros ("1.500"); keep the value, drop the padding.
      const match = /^(\d{1,10})(?:\.(\d{1,6})0*)?$/.exec(text) ?? /^(\d{1,10})\.(0+)$/.exec(text);
      if (!match) return bad;
      const fraction = (match[2] ?? "").replace(/0+$/, "");
      return ok(fraction ? `${match[1]}.${fraction}` : match[1]!);
    }
    case "company_status_override": {
      const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
      if (n === 0 || n === false) return ok(0);
      return n === 10 || n === 9 ? ok(n) : bad;
    }
    case "total_candidate":
    case "is_request_updates_in_30_days":
    case "no_of_active_requests": {
      const n = typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : typeof raw === "boolean" ? Number(raw) : raw;
      return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? ok(n) : bad;
    }
    default:
      return bad;
  }
}

function digestOf(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/**
 * Maps legacy companies. The first row of each legacy id decides it; a later row with the same
 * id is reported as a duplicate and never imported, even when the first was refused.
 * The result is ordered parents before children, so a batch can
 * resolve each parent through the id map. A company whose parent is missing or in a loop is
 * reported and left out, and so are its descendants.
 */
export function mapLegacyCompanies(rows: readonly Row[]): { readonly organizations: readonly OrganizationImportRow[]; readonly issues: readonly OrganizationIssue[] } {
  const issues: OrganizationIssue[] = [];
  const drafts = new Map<string, Omit<OrganizationImportRow, "digest">>();
  // Every parsed id, kept or not: a repeat of an id whose first row was refused is still a duplicate.
  const seenIds = new Set<string>();
  for (const row of rows) {
    const id = legacyId(row.company_id);
    if (id === null) { issues.push({ rule: "company.badId", legacyId: "?" }); continue; }
    if (seenIds.has(id)) { issues.push({ rule: "company.duplicateId", legacyId: id }); continue; }
    seenIds.add(id);
    const parent = parentId(row.parent_company_id);
    if (parent === "bad") { issues.push({ rule: "company.missingParent", legacyId: id, field: "parent_company_id" }); continue; }
    const snapshot = {} as Record<CompanySnapshotColumn, string | number | boolean | null>;
    for (const column of COMPANY_SNAPSHOT_COLUMNS) {
      const normalized = normalize(column, row[column]);
      if (normalized.bad) issues.push({ rule: "company.badValue", legacyId: id, field: column });
      snapshot[column] = normalized.value;
    }
    const name = typeof snapshot.company_name === "string" ? snapshot.company_name.trim() : "";
    if (name === "") { issues.push({ rule: "company.noName", legacyId: id, field: "company_name" }); continue; }
    drafts.set(id, { legacyId: id, parentLegacyId: parent, name, snapshot: Object.freeze(snapshot) });
  }

  // Walk each chain to its root: a chain that leaves the imported set or loops drops the row.
  const depth = new Map<string, number>();
  for (const id of drafts.keys()) {
    const seen: string[] = [];
    let at: string | null = id;
    let outcome: "root" | OrganizationIssueRule = "root";
    while (at !== null) {
      if (seen.includes(at)) { outcome = "company.parentCycle"; break; }
      seen.push(at);
      const draft = drafts.get(at);
      if (draft === undefined) { outcome = "company.missingParent"; break; }
      at = draft.parentLegacyId;
    }
    if (outcome === "root" && seen.length > 2) outcome = "company.tooDeep";
    if (outcome === "root") depth.set(id, seen.length - 1);
    else issues.push(outcome === "company.missingParent"
      ? { rule: outcome, legacyId: id, field: "parent_company_id" } : { rule: outcome, legacyId: id });
  }
  const byId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  const ordered = [...depth.keys()]
    .sort((a, b) => depth.get(a)! - depth.get(b)! || byId(a, b))
    .map((id) => { const draft = drafts.get(id)!; return Object.freeze({ ...draft, digest: digestOf(draft) }); });
  return Object.freeze({ organizations: Object.freeze(ordered), issues: Object.freeze(issues) });
}
