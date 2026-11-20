// M-4 catalogue mapping: legacy catalogue rows (read from the staging mirror) to platform
// catalogue items. Pure: no database, no clock. The store in @studenthub/db/import writes the
// result and keeps the id map. Issues carry legacy ids and rule codes only, never row text.

import { createHash } from "node:crypto";
import { catalogueSortKey, normalizeCatalogueInput } from "@studenthub/reference-catalogue";

/** The legacy tables M-4 reads for the catalogue, and the platform kind each becomes. */
export const LEGACY_CATALOGUE_TABLES = {
  country: "country",
  currency: "currency",
  bank: "bank",
  tag: "tag",
  brand: "brand",
  mall: "mall",
  university: "university",
  area: "area",
} as const;
export type LegacyCatalogueTable = keyof typeof LEGACY_CATALOGUE_TABLES;
export type CatalogueKind = (typeof LEGACY_CATALOGUE_TABLES)[LegacyCatalogueTable];

export interface CatalogueImportItem {
  readonly legacyTable: LegacyCatalogueTable;
  readonly legacyId: string;
  readonly type: CatalogueKind;
  readonly name: string;
  readonly normalizedName: string;
  readonly code: string | null;
  readonly status: "active" | "deleted";
  /** Legacy wall time read as Asia/Kuwait, as an ISO instant; null when legacy has none. */
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly currency: { readonly symbol: string; readonly decimalPlaces: number } | null;
  readonly bank: {
    readonly swiftCode: string;
    readonly ibanBankCode: string;
    readonly abkCode: string;
    readonly transferType: "local" | "international" | "within_bank";
  } | null;
  /** Set on a row merged into another active row of the same kind and name: that row's legacy id. */
  readonly mergedInto: string | null;
  /** sha256 of everything above except mergedInto's target timestamps; see catalogueDigest. */
  readonly digest: string;
}

export type CatalogueIssueRule =
  | "catalogue.badId" // no usable primary key; the row cannot be mapped or reconciled
  | "catalogue.duplicateId" // the same primary key twice in one table
  | "catalogue.invalidName" // empty, too long or control characters; not imported
  | "catalogue.invalidCode" // code dropped, item imported without it
  | "catalogue.bankDetailsInvalid" // bank imported, payment details not
  | "catalogue.currencyDetailsInvalid" // currency imported, details not
  | "catalogue.areaDetailsSkipped" // area imported; details need a governorate legacy does not hold
  | "catalogue.merged" // same kind and name as another active row; mapped to that row's item
  | "catalogue.nameConflict"; // same kind and name as another active row, but a different code or typed details; not imported

export interface CatalogueIssue {
  readonly rule: CatalogueIssueRule;
  readonly legacyTable: LegacyCatalogueTable;
  readonly legacyId: string;
  /** For catalogue.merged and catalogue.nameConflict: the legacy id of the row it shares a name with. */
  readonly target?: string;
  /** For field rules: the legacy column at fault. */
  readonly field?: string;
}

export interface CatalogueMapping {
  readonly items: readonly CatalogueImportItem[];
  readonly issues: readonly CatalogueIssue[];
}

type Row = Readonly<Record<string, unknown>>;

const BANK_TRANSFER: Readonly<Record<string, "local" | "international" | "within_bank">> = {
  LCL: "local",
  SWF: "international",
  TRF: "within_bank",
};

interface Columns {
  readonly id: string;
  readonly name: string;
  readonly code?: string;
  readonly deleted?: (row: Row) => boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

const COLUMNS: Readonly<Record<LegacyCatalogueTable, Columns>> = {
  country: { id: "country_id", name: "country_name_en" },
  currency: {
    id: "currency_id", name: "title", code: "code", updatedAt: "datetime",
    deleted: (row) => String(row.status) === "0",
  },
  bank: { id: "bank_id", name: "bank_name", deleted: (row) => truthy(row.deleted) },
  tag: { id: "tag_id", name: "tag", createdAt: "created_at", updatedAt: "updated_at" },
  brand: { id: "brand_uuid", name: "brand_name_en", createdAt: "brand_created_datetime", updatedAt: "brand_updated_datetime" },
  mall: { id: "mall_uuid", name: "mall_name_en", createdAt: "mall_created_datetime", updatedAt: "mall_updated_datetime" },
  university: {
    id: "university_id", name: "university_name_en", createdAt: "university_created_at", updatedAt: "university_updated_at",
    deleted: (row) => truthy(row.deleted),
  },
  area: { id: "area_uuid", name: "area_name_en", createdAt: "area_created_at", updatedAt: "area_updated_at" },
};

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

const LEGACY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function legacyId(value: unknown): string | null {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value.trim() : null;
  return text !== null && LEGACY_ID.test(text) ? text : null;
}

/**
 * Legacy datetimes are Asia/Kuwait wall time (UTC+3, no daylight saving) with no zone.
 * Returns the instant, or null for a missing or zero date.
 */
export function kuwaitInstant(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!match || match[1] === "0000") return null;
  const [, y, mo, d, h, mi, s] = match.map(Number) as [number, number, number, number, number, number, number];
  const utc = Date.UTC(y, mo - 1, d, h - 3, mi, s);
  const back = new Date(utc + 3 * 3_600_000);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return new Date(utc).toISOString();
}

/** Canonical sha256 of the mapped content (keys sorted), excluding the digest itself. */
export function catalogueDigest(item: Omit<CatalogueImportItem, "digest">): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(item))).digest("hex");
}

function compareLegacyIds(a: string, b: string): number {
  const numeric = /^[0-9]+$/;
  if (numeric.test(a) && numeric.test(b)) return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  return a < b ? -1 : a > b ? 1 : 0;
}

function currencyDetails(row: Row): CatalogueImportItem["currency"] | "invalid" {
  const symbol = typeof row.currency_symbol === "string" ? row.currency_symbol.trim() : "";
  const places = Number(row.decimal_place);
  if (symbol.length < 1 || symbol.length > 8 || !Number.isInteger(places) || places < 0 || places > 4) return "invalid";
  return { symbol, decimalPlaces: places };
}

function bankDetails(row: Row): CatalogueImportItem["bank"] | "invalid" {
  const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").trim().toUpperCase();
  const swiftCode = text(row.bank_swift_code);
  const ibanBankCode = text(row.bank_iban_code);
  const abkCode = text(row.bank_code_abk);
  const transferType = BANK_TRANSFER[text(row.bank_transfer_type)];
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swiftCode) || !/^[A-Z0-9]{4}$/.test(ibanBankCode)
    || !/^(100|[1-9]?[0-9])$/.test(abkCode) || transferType === undefined) return "invalid";
  return { swiftCode, ibanBankCode, abkCode, transferType };
}

type TypedContent = Pick<CatalogueImportItem, "code" | "currency" | "bank">;

/** Same code and the same typed details; details present on one side only are not the same. */
export function sameTypedContent(a: TypedContent, b: TypedContent): boolean {
  const same = (x: object | null, y: object | null) => x === null || y === null ? x === y
    : JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());
  return a.code === b.code && same(a.currency, b.currency) && same(a.bank, b.bank);
}

/**
 * Maps one legacy catalogue table. Active rows of one kind whose names normalize the same are
 * merged: the lowest legacy id becomes the item and the others map to it (reported). A same-name
 * row whose code or typed details (currency, bank) differ from that row's, including details one
 * holds and the other lacks, is not merged and not imported: it is reported as a name conflict to
 * reconcile by hand. Deleted rows are imported as deleted items and never merged.
 */
export function mapLegacyCatalogue(table: LegacyCatalogueTable, rows: readonly Row[]): CatalogueMapping {
  const columns = COLUMNS[table];
  const type = LEGACY_CATALOGUE_TABLES[table];
  const issues: CatalogueIssue[] = [];
  const seen = new Set<string>();
  const drafts: Omit<CatalogueImportItem, "digest" | "mergedInto">[] = [];

  for (const row of rows) {
    const id = legacyId(row[columns.id]);
    if (id === null) { issues.push({ rule: "catalogue.badId", legacyTable: table, legacyId: "?" }); continue; }
    if (seen.has(id)) { issues.push({ rule: "catalogue.duplicateId", legacyTable: table, legacyId: id }); continue; }
    seen.add(id);

    let name: string;
    try {
      name = normalizeCatalogueInput({ name: typeof row[columns.name] === "string" ? row[columns.name] : "" }).name;
    } catch {
      issues.push({ rule: "catalogue.invalidName", legacyTable: table, legacyId: id, field: columns.name });
      continue;
    }

    let code: string | null = null;
    const rawCode = columns.code ? row[columns.code] : undefined;
    if (typeof rawCode === "string" && rawCode.trim() !== "") {
      try {
        code = normalizeCatalogueInput({ name, code: rawCode }).code ?? null;
      } catch {
        issues.push({ rule: "catalogue.invalidCode", legacyTable: table, legacyId: id, field: columns.code });
      }
    }

    let currency: CatalogueImportItem["currency"] = null;
    if (table === "currency") {
      const details = currencyDetails(row);
      if (details === "invalid") issues.push({ rule: "catalogue.currencyDetailsInvalid", legacyTable: table, legacyId: id });
      else currency = details;
    }
    let bank: CatalogueImportItem["bank"] = null;
    if (table === "bank") {
      const details = bankDetails(row);
      if (details === "invalid") issues.push({ rule: "catalogue.bankDetailsInvalid", legacyTable: table, legacyId: id });
      else bank = details;
    }
    if (table === "area") issues.push({ rule: "catalogue.areaDetailsSkipped", legacyTable: table, legacyId: id });

    const createdAt = columns.createdAt ? kuwaitInstant(row[columns.createdAt]) : null;
    const updatedAt = columns.updatedAt ? kuwaitInstant(row[columns.updatedAt]) : null;
    drafts.push({
      legacyTable: table, legacyId: id, type, name, normalizedName: catalogueSortKey(name), code,
      status: columns.deleted?.(row) ? "deleted" : "active",
      createdAt, updatedAt: updatedAt ?? createdAt, currency, bank,
    });
  }

  drafts.sort((a, b) => compareLegacyIds(a.legacyId, b.legacyId));
  const firstActive = new Map<string, (typeof drafts)[number]>();
  const items: CatalogueImportItem[] = [];
  for (const draft of drafts) {
    let mergedInto: string | null = null;
    if (draft.status === "active") {
      const target = firstActive.get(draft.normalizedName);
      if (target === undefined) firstActive.set(draft.normalizedName, draft);
      else if (!sameTypedContent(target, draft)) {
        issues.push({ rule: "catalogue.nameConflict", legacyTable: table, legacyId: draft.legacyId, target: target.legacyId });
        continue;
      } else {
        mergedInto = target.legacyId;
        issues.push({ rule: "catalogue.merged", legacyTable: table, legacyId: draft.legacyId, target: target.legacyId });
      }
    }
    const item = { ...draft, mergedInto };
    items.push(Object.freeze({ ...item, digest: catalogueDigest(item) }));
  }
  return Object.freeze({ items: Object.freeze(items), issues: Object.freeze(issues) });
}
