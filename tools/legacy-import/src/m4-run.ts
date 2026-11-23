// M-4 end to end: reads the refreshed legacy copy, maps every M-4 table, and (in write mode)
// imports them in dependency order: catalogues, companies, brand links, stores, contacts. Each
// step uses its own import store, so the M-4 contract holds per step (id map, digest conflicts,
// savepoints, batch lock). The report carries table names, legacy ids, rule codes, counts and
// digests only: no names, emails, phones or other legacy values. Read-only against legacy.

import { LEGACY_CATALOGUE_TABLES, mapLegacyCatalogue, type LegacyCatalogueTable } from "./m4-catalogue.js";
import { COMPANY_SNAPSHOT_COLUMNS, mapLegacyCompanies } from "./m4-organizations.js";
import { mapLegacyBrandLinks, mapLegacyStores } from "./m4-stores.js";
import { mapLegacyContacts } from "./m4-contacts.js";
import type { LegacyReader } from "./twin/journey.js";

type Row = Readonly<Record<string, unknown>>;

/** Every legacy table and column M-4 reads. A column outside this list is never selected. */
export const M4_SOURCES = {
  country: ["country_id", "country_name_en"],
  currency: ["currency_id", "title", "code", "currency_symbol", "decimal_place", "status", "datetime"],
  bank: ["bank_id", "bank_name", "bank_swift_code", "bank_iban_code", "bank_code_abk", "bank_transfer_type", "deleted"],
  tag: ["tag_id", "tag", "created_at", "updated_at"],
  brand: ["brand_uuid", "company_id", "brand_name_en", "brand_created_datetime", "brand_updated_datetime"],
  mall: ["mall_uuid", "mall_name_en", "mall_created_datetime", "mall_updated_datetime"],
  university: ["university_id", "university_name_en", "university_created_at", "university_updated_at", "deleted"],
  area: ["area_uuid", "area_name_en", "area_created_at", "area_updated_at"],
  company: ["company_id", "parent_company_id", "deleted", ...COMPANY_SNAPSHOT_COLUMNS],
  store: ["store_id", "company_id", "brand_uuid", "mall_uuid", "store_name", "store_location", "store_created_at", "store_updated_at", "deleted"],
  contact: ["contact_uuid", "contact_name", "contact_email", "deleted"],
  company_contact: ["company_contact_uuid", "contact_uuid", "company_id", "contact_position", "allow_access", "created_at", "updated_at"],
  contact_email: ["email_uuid", "contact_uuid", "email_address", "email_created_datetime"],
  contact_phone: ["phone_uuid", "contact_uuid", "phone_number", "phone_created_datetime"],
} as const satisfies Record<string, readonly string[]>;
export type M4Table = keyof typeof M4_SOURCES;
export type M4Sources = Readonly<Record<M4Table, readonly Row[]>>;

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** One read-only statement per table: a JSON object of the listed columns per row. */
export function sourceSql(table: M4Table): string {
  const columns = M4_SOURCES[table];
  if (!NAME.test(table) || !columns.every((c) => NAME.test(c))) throw new Error("m4.badSourceName");
  return `SELECT JSON_OBJECT(${columns.map((c) => `'${c}', \`${c}\``).join(", ")}) FROM \`${table}\``;
}

export async function readM4Sources(reader: LegacyReader): Promise<M4Sources> {
  const out = {} as Record<M4Table, readonly Row[]>;
  for (const table of Object.keys(M4_SOURCES) as M4Table[]) {
    try {
      out[table] = await reader.rows(sourceSql(table), []);
    } catch {
      // A fixed code naming the table; the reader's own error text never reaches the report.
      throw new Error(`m4.read.${table}`);
    }
  }
  return out;
}

const CATALOGUE_TABLES = Object.keys(LEGACY_CATALOGUE_TABLES) as LegacyCatalogueTable[];

/** Every mapping, pure. */
export function planM4(sources: M4Sources) {
  const catalogue = CATALOGUE_TABLES.map((table) => ({ table, ...mapLegacyCatalogue(table, sources[table]) }));
  const companies = mapLegacyCompanies(sources.company);
  const brandLinks = mapLegacyBrandLinks(sources.brand);
  const stores = mapLegacyStores(sources.store, sources.brand);
  const contacts = mapLegacyContacts(sources.company_contact, sources.contact, sources.contact_email, sources.contact_phone);
  return { catalogue, companies, brandLinks, stores, contacts };
}
export type M4Plan = ReturnType<typeof planM4>;

/** What each import store returns, reduced to what the report keeps. */
export interface StepWrite {
  readonly inserted: number;
  readonly merged?: number;
  readonly adopted?: number;
  readonly unchanged: number;
  readonly conflicts: readonly { readonly legacyId: string }[];
  readonly refused: readonly { readonly legacyId: string; readonly code: string }[];
}

/** The import stores, by step. Each writes one batch in its own transaction. */
export interface M4Writers {
  catalogue(table: LegacyCatalogueTable, items: M4Plan["catalogue"][number]["items"], now: string): Promise<StepWrite>;
  companies(rows: M4Plan["companies"]["organizations"]): Promise<StepWrite>;
  brandLinks(rows: M4Plan["brandLinks"]["links"]): Promise<StepWrite>;
  stores(rows: M4Plan["stores"]["stores"], now: string): Promise<StepWrite>;
  contacts(rows: M4Plan["contacts"]["contacts"], now: string): Promise<StepWrite>;
}

export interface M4Step {
  readonly step: string;
  /** Rows the legacy table holds. */
  readonly legacy: number;
  /** Rows the mapper produced for import. */
  readonly mapped: number;
  /** Issue counts by rule code. */
  readonly rules: Readonly<Record<string, number>>;
  /** Legacy ids by rule code, sorted; issues with no usable id are counted only. */
  readonly issueIds: Readonly<Record<string, readonly string[]>>;
  readonly write?: {
    readonly inserted: number;
    readonly merged: number;
    readonly adopted: number;
    readonly unchanged: number;
    readonly conflicts: readonly string[];
    readonly refused: Readonly<Record<string, readonly string[]>>;
  };
}

export interface M4Report {
  readonly schemaVersion: 1;
  readonly mode: "plan" | "write";
  readonly steps: readonly M4Step[];
  /** True when nothing was refused or in conflict at write time. Mapper issues are reported, not failures. */
  readonly ok: boolean;
}

const ID = /^(?:\?|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const RULE = /^[a-z_]+(?:\.[A-Za-z_]+)?$/;

function step(name: string, legacy: number, mapped: number, issues: readonly { readonly rule: string; readonly legacyId: string }[], write?: StepWrite): M4Step {
  const rules: Record<string, number> = {};
  const issueIds: Record<string, string[]> = {};
  for (const issue of issues) {
    if (!RULE.test(issue.rule) || !ID.test(issue.legacyId)) throw new Error("m4.report.unsafeIssue");
    rules[issue.rule] = (rules[issue.rule] ?? 0) + 1;
    if (issue.legacyId !== "?") (issueIds[issue.rule] ??= []).push(issue.legacyId);
  }
  for (const ids of Object.values(issueIds)) ids.sort();
  let written: M4Step["write"];
  if (write) {
    const refused: Record<string, string[]> = {};
    for (const r of write.refused) {
      if (!RULE.test(r.code) || !ID.test(r.legacyId)) throw new Error("m4.report.unsafeRefusal");
      (refused[r.code] ??= []).push(r.legacyId);
    }
    for (const ids of Object.values(refused)) ids.sort();
    const conflicts = write.conflicts.map((c) => c.legacyId);
    if (!conflicts.every((id) => ID.test(id))) throw new Error("m4.report.unsafeConflict");
    written = { inserted: write.inserted, merged: write.merged ?? 0, adopted: write.adopted ?? 0, unchanged: write.unchanged, conflicts: conflicts.sort(), refused };
  }
  return { step: name, legacy, mapped, rules, issueIds, ...(written ? { write: written } : {}) };
}

/**
 * Maps every table and, with writers, imports them in dependency order. Without writers it is a
 * plan: nothing is written anywhere. A writer that throws stops the run; the steps before it
 * stay committed (each is idempotent, so the next run carries on).
 */
export async function runM4(sources: M4Sources, writers: M4Writers | null, now: string): Promise<M4Report> {
  const plan = planM4(sources);
  const steps: M4Step[] = [];
  for (const c of plan.catalogue) {
    steps.push(step(`catalogue.${c.table}`, sources[c.table].length, c.items.length, c.issues, writers ? await writers.catalogue(c.table, c.items, now) : undefined));
  }
  steps.push(step("company", sources.company.length, plan.companies.organizations.length, plan.companies.issues,
    writers ? await writers.companies(plan.companies.organizations) : undefined));
  steps.push(step("brand_company", sources.brand.length, plan.brandLinks.links.length, plan.brandLinks.issues,
    writers ? await writers.brandLinks(plan.brandLinks.links) : undefined));
  steps.push(step("store", sources.store.length, plan.stores.stores.length, plan.stores.issues,
    writers ? await writers.stores(plan.stores.stores, now) : undefined));
  steps.push(step("company_contact", sources.company_contact.length, plan.contacts.contacts.length, plan.contacts.issues,
    writers ? await writers.contacts(plan.contacts.contacts, now) : undefined));
  const ok = steps.every((s) => !s.write || (s.write.conflicts.length === 0 && Object.keys(s.write.refused).length === 0));
  return { schemaVersion: 1, mode: writers ? "write" : "plan", steps, ok };
}

/** Re-checks a whole report before it is written: every id, rule and code has the safe shape. */
export function receiptSafe(report: M4Report): boolean {
  const ids = (list: readonly string[]) => list.every((id) => ID.test(id));
  return report.steps.every((s) => /^[a-z_.]+$/.test(s.step)
    && Object.keys(s.rules).every((r) => RULE.test(r))
    && Object.entries(s.issueIds).every(([r, list]) => RULE.test(r) && ids(list))
    && (!s.write || (ids(s.write.conflicts) && Object.entries(s.write.refused).every(([c, list]) => RULE.test(c) && ids(list)))));
}
