// M-5 candidate working hours: legacy candidates' placements, work sessions and employer
// decisions, read from the refreshed legacy copy and written through the work lane's import store.
//
// The work lane owns the mapping (packages/work/src/legacy.ts: mapLegacyWorkingHour,
// mapLegacyFeedback, derivePlacements, reconcileDays) and the store (PostgresWorkImportStore,
// migrations 0500 to 0504). This module adds what the work lane left to the importer:
//
// - the whole-table read: each table is counted before and after one fixed-column read, and the
//   three numbers must agree (`m5.inputIncomplete`); the caller holds the refresh lock;
// - the person rule: a legacy candidate maps to a principal only through `legacy_account_links`,
//   the link the person made by signing in (or staff made), the key My profile already uses. An
//   unlinked candidate's rows are reported `no_person`; the importer creates no identities, and the
//   next run picks the person up once they link;
// - the store rule: a legacy store maps through the M-4 id map (`legacy_id_maps`, legacy table
//   `store`) to the platform store and its organization; a missing map is `no_store`;
// - placements: `derivePlacements` per person over every mapped session; the current store stays
//   open-ended only when it is where the person's hours end. Legacy keeps no assignment date, so a
//   current store with no hours as the latest stretch is reported (`current_store_unplaced`) and no
//   start date is made up;
// - the run: placements, then sessions, then decisions, in batches, then the store's
//   reconciliation per table with the refs the run reported and held.
//
// Reports and receipts carry legacy references, rule codes and counts only: no name, time or
// text. Nothing here sends a notice.

import type { LegacyReader } from "./twin/journey.js";
import {
  derivePlacements, mapLegacyFeedback, mapLegacyWorkingHour, type ImportIssueCode, type IsoDate,
} from "../../../packages/work/src/index.js";
import type {
  CandidateImportReconciliation, CandidateImportTable, PostgresWorkImportStore, WorkImportDecision, WorkImportPlacement,
  WorkImportRefusal, WorkImportResult, WorkImportSession,
} from "@studenthub/db/work";

type Row = Readonly<Record<string, unknown>>;

/** Changes whenever what a run reads, resolves or writes changes. */
export const M5_CANDIDATE_REVISION = "m5-candidate-v1";

export const M5_CANDIDATE_SOURCES = {
  candidate: ["candidate_id", "store_id", "deleted"],
  candidate_working_hour: ["candidate_working_hour_uuid", "candidate_id", "store_id", "date", "start_time", "end_time", "total_time",
    "start_location_lat", "start_location_long", "end_location_lat", "end_location_long", "note", "status", "via"],
  candidate_work_log_feedback: ["cwlf_uuid", "candidate_id", "store_id", "date", "candidate_working_hour_uuid", "status", "note", "reason",
    "is_public", "rating", "created_by", "created_at"],
  candidate_working_date: ["cwd_uuid", "candidate_id", "store_id", "date", "total_time", "total_approved", "total_pending", "total_rejected"],
} as const satisfies Record<string, readonly string[]>;
export type M5CandidateTable = keyof typeof M5_CANDIDATE_SOURCES;
export type M5CandidateSources = Readonly<Record<M5CandidateTable, readonly Row[]>>;

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
export function m5CandidateSourceSql(table: M5CandidateTable): string {
  const columns = M5_CANDIDATE_SOURCES[table];
  if (!NAME.test(table) || !columns.every((c) => NAME.test(c))) throw new Error("m5.badSourceName");
  return `SELECT JSON_OBJECT(${columns.map((c) => `'${c}', \`${c}\``).join(", ")}) FROM \`${table}\``;
}
const countSql = (table: M5CandidateTable) => `SELECT JSON_OBJECT('n', COUNT(*)) FROM \`${table}\``;

export type M5CandidateInputCode = `m5.read.${M5CandidateTable}` | "m5.inputIncomplete";
/** Thrown with a fixed code only: a reader error could carry values. */
export class M5CandidateInputError extends Error {
  constructor(readonly code: M5CandidateInputCode) { super(code); this.name = "M5CandidateInputError"; }
}

async function count(reader: LegacyReader, table: M5CandidateTable): Promise<number> {
  let rows: readonly Row[];
  try { rows = await reader.rows(countSql(table), []); } catch { throw new M5CandidateInputError("m5.inputIncomplete"); }
  const n = rows.length === 1 ? Number(rows[0]!.n) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new M5CandidateInputError("m5.inputIncomplete");
  return n;
}

/** Reads the four tables whole; refuses unless each read is its whole table, unchanged during the read. */
export async function readM5CandidateSources(reader: LegacyReader): Promise<M5CandidateSources> {
  const out = {} as Record<M5CandidateTable, readonly Row[]>;
  for (const table of Object.keys(M5_CANDIDATE_SOURCES) as M5CandidateTable[]) {
    const before = await count(reader, table);
    try { out[table] = await reader.rows(m5CandidateSourceSql(table), []); } catch { throw new M5CandidateInputError(`m5.read.${table}`); }
    const after = await count(reader, table);
    if (out[table].length !== before || after !== before) throw new M5CandidateInputError("m5.inputIncomplete");
  }
  return out;
}

// --- Lookups -----------------------------------------------------------------------------------

/** Legacy candidate id to the principal that linked it. Ids in, ids out. */
export type CandidateLinkLookup = (legacyCandidateIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
/** Legacy store id to the platform store and the organization that owns it. */
export interface MappedStore { readonly storeId: string; readonly orgId: string }
export type StoreLookup = (legacyStoreIds: readonly string[]) => Promise<ReadonlyMap<string, MappedStore>>;

/** One link per legacy candidate and one per principal (both unique in 0215). */
export const CANDIDATE_LINK_SQL = `SELECT legacy_candidate_id, principal_id FROM legacy_account_links
  WHERE legacy_candidate_id = ANY($1::text[]) ORDER BY legacy_candidate_id`;
/** The M-4 store map, joined to the store it names so the organization is the store's own. */
export const STORE_MAP_SQL = `SELECT m.legacy_id, s.id::text AS store_id, s.org_id FROM legacy_id_maps m
  JOIN organization_stores s ON s.id::text = m.platform_id
  WHERE m.legacy_table = 'store' AND m.legacy_id = ANY($1::text[]) ORDER BY m.legacy_id`;

const LEGACY_ID = /^[1-9][0-9]{0,18}$/;
const legacyId = (v: unknown): string | undefined => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return LEGACY_ID.test(s) ? s : undefined;
};
/** Legacy soft delete: anything other than an explicit 0 (or false) counts as deleted, failing closed. */
const isDeleted = (v: unknown): boolean => !(v === 0 || v === "0" || v === false);

/** Every legacy candidate and store id the plan will need to look up. */
export function candidateLookupIds(sources: M5CandidateSources): { readonly candidates: readonly string[]; readonly stores: readonly string[] } {
  const c = new Set<string>(), s = new Set<string>();
  for (const table of ["candidate", "candidate_working_hour", "candidate_work_log_feedback"] as const) {
    for (const row of sources[table]) {
      const cid = legacyId(row.candidate_id), sid = legacyId(row.store_id);
      if (cid) c.add(cid);
      if (sid) s.add(sid);
    }
  }
  return { candidates: [...c].sort(), stores: [...s].sort() };
}

// --- Plan --------------------------------------------------------------------------------------

/** What the importer reports instead of importing, on top of the mapper's own codes. */
export type CandidateWorkIssueCode = ImportIssueCode
  | "no_person" | "no_store" | "two_stores_one_day" | "pending_feedback" | "bad_ref" | "current_store_unplaced";
export interface CandidateWorkIssue { readonly legacyRef: string; readonly code: CandidateWorkIssueCode }

export interface CandidateWorkPlan {
  readonly placements: readonly WorkImportPlacement[];
  readonly sessions: readonly WorkImportSession[];
  readonly decisions: readonly WorkImportDecision[];
  /** Every legacy reference per platform table, for reconciliation; placements are the derived set. */
  readonly legacyRefs: Readonly<Record<CandidateImportTable, readonly string[]>>;
  /** Per table, references the plan reported, with the rule; some mapper codes are imported too. */
  readonly issues: Readonly<Record<CandidateImportTable, readonly CandidateWorkIssue[]>>;
  /** Legacy candidates whose current store could not be placed, by `candidate:<id>`. */
  readonly unplaced: readonly string[];
  /** Linked candidates (by legacy id) the plan imported anything for. */
  readonly people: number;
}
const TABLES: readonly CandidateImportTable[] = ["work_assignments", "work_sessions", "work_decisions"];
/** The id of a derived placement: stable while the stretch starts on the same day. */
export const placementRef = (legacyCandidateId: string, legacyStoreId: string, startDate: IsoDate) => `place:${legacyCandidateId}:${legacyStoreId}:${startDate}`;
const LEGACY_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** Maps every row through the work lane's mapper, then puts the linked person and mapped store on it. */
export function planCandidateWork(sources: M5CandidateSources, links: ReadonlyMap<string, string>, stores: ReadonlyMap<string, MappedStore>): CandidateWorkPlan {
  const issues = Object.fromEntries(TABLES.map((t) => [t, [] as CandidateWorkIssue[]])) as Record<CandidateImportTable, CandidateWorkIssue[]>;
  const refs = Object.fromEntries(TABLES.map((t) => [t, [] as string[]])) as Record<CandidateImportTable, string[]>;

  // Sessions first: they decide the placements.
  type Mapped = NonNullable<ReturnType<typeof mapLegacyWorkingHour>["session"]>;
  const byPerson = new Map<string, Mapped[]>();
  for (const row of sources.candidate_working_hour) {
    const raw = String(row.candidate_working_hour_uuid ?? "");
    const ref = `cwh:${raw}`;
    if (!LEGACY_REF.test(ref)) { issues.work_sessions.push({ legacyRef: "cwh:?", code: "bad_ref" }); continue; }
    refs.work_sessions.push(ref);
    const m = mapLegacyWorkingHour({ ...row, appeal_uuid: null } as never);
    for (const i of m.issues) issues.work_sessions.push({ legacyRef: ref, code: i.code });
    if (!m.session) continue;
    const cid = legacyId(m.session.legacyCandidateId), sid = legacyId(m.session.legacyStoreId);
    if (!cid || !links.has(cid)) { issues.work_sessions.push({ legacyRef: ref, code: "no_person" }); continue; }
    if (!sid || !stores.has(sid)) { issues.work_sessions.push({ legacyRef: ref, code: "no_store" }); continue; }
    byPerson.set(cid, [...(byPerson.get(cid) ?? []), m.session]);
  }

  const current = new Map<string, string>();
  for (const row of sources.candidate) {
    const cid = legacyId(row.candidate_id), sid = legacyId(row.store_id);
    if (cid && sid && !isDeleted(row.deleted)) current.set(cid, sid);
  }

  const placements: WorkImportPlacement[] = [], sessions: WorkImportSession[] = [], unplaced: string[] = [];
  const people = new Set<string>();
  for (const cid of [...new Set([...byPerson.keys(), ...[...current.keys()].filter((c) => links.has(c))])].sort()) {
    const mine = (byPerson.get(cid) ?? []).slice().sort((a, b) => a.workDate.localeCompare(b.workDate) || a.legacyRef.localeCompare(b.legacyRef));
    const personId = links.get(cid)!;
    const days = mine.map((s) => ({ legacyStoreId: s.legacyStoreId, workDate: s.workDate }));
    const base = derivePlacements(cid, days, null);
    // The current store stays open only where the person's hours end; legacy has no start date otherwise.
    const cur = current.get(cid);
    const tail = base[base.length - 1];
    let derived = base;
    if (cur !== undefined) {
      if (tail && tail.legacyStoreId === cur && stores.has(cur)) derived = derivePlacements(cid, days, { legacyStoreId: cur, since: tail.startDate });
      else unplaced.push(`candidate:${cid}`);
    }
    for (const p of derived) {
      const store = stores.get(p.legacyStoreId)!;
      const ref = placementRef(cid, p.legacyStoreId, p.startDate);
      refs.work_assignments.push(ref);
      placements.push({ legacyRef: ref, personId, orgId: store.orgId, storeId: store.storeId, startDate: p.startDate, endDate: p.endDate, payContractId: null });
    }
    for (const s of mine) {
      const p = derived.find((x) => x.legacyStoreId === s.legacyStoreId && x.startDate <= s.workDate && (x.endDate === null || s.workDate <= x.endDate));
      // Two stores on one day: the earlier stretch keeps the day, and this row is reported.
      if (!p) { issues.work_sessions.push({ legacyRef: s.legacyRef, code: "two_stores_one_day" }); continue; }
      sessions.push({
        legacyRef: s.legacyRef, placementLegacyRef: placementRef(cid, p.legacyStoreId, p.startDate), workDate: s.workDate,
        startedAt: s.startedAt.toISOString(), endedAt: s.endedAt.toISOString(), startLocation: s.startLocation, endLocation: s.endLocation,
        status: s.status, flags: [...s.flags], note: s.note,
      });
    }
    if (derived.length) people.add(cid);
  }

  const decisions: WorkImportDecision[] = [];
  for (const row of sources.candidate_work_log_feedback) {
    const ref = `cwlf:${String(row.cwlf_uuid ?? "")}`;
    if (!LEGACY_REF.test(ref)) { issues.work_decisions.push({ legacyRef: "cwlf:?", code: "bad_ref" }); continue; }
    refs.work_decisions.push(ref);
    const m = mapLegacyFeedback(row as never);
    for (const i of m.issues) issues.work_decisions.push({ legacyRef: ref, code: i.code });
    if (!m.decision) {
      // A pending feedback row is not a decision: explained, not imported.
      if (!m.issues.length) issues.work_decisions.push({ legacyRef: ref, code: "pending_feedback" });
      continue;
    }
    const d = m.decision;
    const cid = legacyId(d.legacyCandidateId), sid = legacyId(d.legacyStoreId);
    if (!cid || !links.has(cid)) { issues.work_decisions.push({ legacyRef: ref, code: "no_person" }); continue; }
    const store = sid ? stores.get(sid) : undefined;
    if (!store) { issues.work_decisions.push({ legacyRef: ref, code: "no_store" }); continue; }
    decisions.push({
      legacyRef: d.legacyRef, personId: links.get(cid)!, orgId: store.orgId, storeId: store.storeId, workDate: d.workDate, scope: d.scope,
      sessionLegacyRef: d.legacySessionRef, outcome: d.outcome, reason: d.reason, note: d.note, rating: d.rating, notePublic: d.notePublic,
      decidedBy: null, legacyDecidedBy: d.legacyDecidedBy, decidedAt: d.decidedAt ? d.decidedAt.toISOString() : null,
    });
  }
  for (const t of TABLES) refs[t].sort();
  return { placements, sessions, decisions, legacyRefs: refs, issues, unplaced: unplaced.sort(), people: people.size };
}

// --- Run ---------------------------------------------------------------------------------------

/** How many rows go to the store in one transaction. */
export const M5_CANDIDATE_BATCH = 500;

export interface CandidateTableCounts {
  readonly legacy: number;
  readonly inserted: number; readonly unchanged: number; readonly updated: number;
  readonly conflicts: number;
  readonly refused: Readonly<Partial<Record<WorkImportRefusal, number>>>;
  readonly issues: Readonly<Partial<Record<CandidateWorkIssueCode, number>>>;
  readonly imported: number; readonly covered: number; readonly verified: number;
  readonly missing: number; readonly skipped: number; readonly extra: number; readonly held: number;
  readonly clean: boolean;
}
export interface CandidateWorkOutcome {
  readonly tables: Readonly<Record<CandidateImportTable, CandidateTableCounts>>;
  /** Legacy refs per table and rule, for the private report only. */
  readonly refs: Readonly<Record<CandidateImportTable, {
    readonly issues: Readonly<Partial<Record<CandidateWorkIssueCode, readonly string[]>>>;
    readonly refused: Readonly<Partial<Record<WorkImportRefusal, readonly string[]>>>;
    readonly conflicts: readonly string[];
    readonly missing: readonly string[]; readonly skipped: readonly string[]; readonly extra: readonly string[]; readonly held: readonly string[];
  }>>;
  /** Every table strictly clean: nothing skipped, missing, extra or held. */
  readonly clean: boolean;
  /** Nothing unexplained: no table has a missing, extra or held row. */
  readonly complete: boolean;
}

type ImportStore = Pick<PostgresWorkImportStore, "importPlacements" | "importSessions" | "importDecisions" | "reconcileCandidateImport">;

async function batched<R>(rows: readonly R[], write: (rows: readonly R[]) => Promise<WorkImportResult>): Promise<WorkImportResult> {
  let inserted = 0, unchanged = 0, updated = 0;
  const conflicts: WorkImportResult["conflicts"][number][] = [], refused: WorkImportResult["refused"][number][] = [];
  for (let i = 0; i < rows.length; i += M5_CANDIDATE_BATCH) {
    const r = await write(rows.slice(i, i + M5_CANDIDATE_BATCH));
    inserted += r.inserted; unchanged += r.unchanged; updated += r.updated; conflicts.push(...r.conflicts); refused.push(...r.refused);
  }
  return { inserted, unchanged, updated, conflicts, refused };
}
const tally = <K extends string>(items: readonly { readonly code: K }[]) => {
  const n: Partial<Record<K, number>> = {};
  for (const { code } of items) n[code] = (n[code] ?? 0) + 1;
  return n;
};
const group = <K extends string>(items: readonly { readonly code: K; readonly legacyRef: string }[]) => {
  const g: Partial<Record<K, string[]>> = {};
  for (const { code, legacyRef } of items) (g[code] ??= []).push(legacyRef);
  for (const k of Object.keys(g) as K[]) g[k] = [...new Set(g[k]!)].sort();
  return g;
};

/** Writes the plan in dependency order, then reconciles every table. */
export async function runCandidateWork(store: ImportStore, plan: CandidateWorkPlan): Promise<CandidateWorkOutcome> {
  const results: Record<CandidateImportTable, WorkImportResult> = {
    work_assignments: await batched(plan.placements, (r) => store.importPlacements(r)),
    work_sessions: await batched(plan.sessions, (r) => store.importSessions(r)),
    work_decisions: await batched(plan.decisions, (r) => store.importDecisions(r)),
  };
  const tables = {} as Record<CandidateImportTable, CandidateTableCounts>;
  const refs = {} as Record<CandidateImportTable, CandidateWorkOutcome["refs"][CandidateImportTable]>;
  for (const table of TABLES) {
    const r = results[table];
    const reported = [...plan.issues[table].map((i) => i.legacyRef), ...r.refused.map((x) => x.legacyRef)];
    const held = [...r.conflicts.map((c) => c.legacyRef), ...r.refused.filter((x) => x.code === "unknown_digest").map((x) => x.legacyRef)];
    const rec: CandidateImportReconciliation = await store.reconcileCandidateImport(table, plan.legacyRefs[table], reported, held);
    tables[table] = {
      legacy: rec.legacy, inserted: r.inserted, unchanged: r.unchanged, updated: r.updated, conflicts: r.conflicts.length,
      refused: tally(r.refused), issues: tally(plan.issues[table]),
      imported: rec.imported, covered: rec.covered, verified: rec.verified,
      missing: rec.missing.length, skipped: rec.skipped.length, extra: rec.extra.length, held: rec.held.length, clean: rec.clean,
    };
    refs[table] = { issues: group(plan.issues[table]), refused: group(r.refused), conflicts: r.conflicts.map((c) => c.legacyRef).sort(),
      missing: rec.missing, skipped: rec.skipped, extra: rec.extra, held: rec.held };
  }
  return { tables, refs, clean: TABLES.every((t) => tables[t].clean),
    complete: TABLES.every((t) => tables[t].missing === 0 && tables[t].extra === 0 && tables[t].held === 0) };
}
