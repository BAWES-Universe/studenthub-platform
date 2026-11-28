// M-5 staff time: the legacy internal staff's work sessions, daily stand-up and hours per day,
// read from the refreshed legacy copy and written through the work lane's import store.
//
// The work lane owns the mapping (packages/work/src/legacy-staff.ts) and the store
// (PostgresWorkImportStore, migrations 0505, 0506, 0508, 0509). This module adds what the work
// lane left to the importer:
//
// - the whole-table read: each table is counted before and after one fixed-column read, and the
//   three numbers must agree, so a truncated read or a copy that changed underneath is refused
//   (`m5.inputIncomplete`); the caller holds the refresh lock, as every mirror read does;
// - the staff to principal rule (`resolveStaff`): a legacy staff row maps to principal P only when
//   the row is not deleted, its address and P's current address have the same key under the one
//   rule (`principal_email_key`, migration 0658), the issuer verified P's address (a legacy import
//   never counts), P holds a staff or admin grant on the operator organization, and the match is
//   one to one both ways. Anything else is reported by legacy staff id with a reason, and every row
//   of that staff member is reported `no_staff`, never guessed. The address is compared inside one
//   query and never leaves it: no report, receipt or log carries it;
// - the plan (`planStaffWork`): mapper issues and unresolved staff, per table, by legacy reference;
// - the run (`runStaffWork`): questions, then sessions, then answers, then hours, in batches,
//   then the store's reconciliation per table with the refs the run reported and held.
//
// Reports and receipts carry legacy references, rule codes and counts only: no name, address,
// time or text. Nothing here sends a notice.

import type { LegacyReader } from "./twin/journey.js";
import {
  mapLegacyStaffHours, mapLegacyStaffSession, mapLegacyStandupAnswer, mapLegacyStandupQuestion,
  type StaffImportIssueCode,
} from "../../../packages/work/src/index.js";
import type {
  PostgresWorkImportStore, StaffImportReconciliation, StaffImportTable, WorkImportRefusal, WorkImportResult,
  WorkImportStaffHours, WorkImportStaffSession, WorkImportStandupAnswer, WorkImportStandupQuestion,
} from "@studenthub/db/work";

type Row = Readonly<Record<string, unknown>>;

/** Changes whenever what a run reads, resolves or writes changes. */
export const M5_STAFF_REVISION = "m5-staff-v1";

export const M5_STAFF_SOURCES = {
  staff: ["staff_id", "staff_email", "deleted", "hours_per_day"],
  staff_work_session: ["work_session_uuid", "staff_id", "total_minutes", "created_at", "updated_at"],
  daily_standup_question: ["question_uuid", "question", "created_at", "updated_at"],
  daily_standup_answer: ["answer_uuid", "staff_id", "question_uuid", "question", "answer", "created_at"],
} as const satisfies Record<string, readonly string[]>;
export type M5StaffTable = keyof typeof M5_STAFF_SOURCES;
export type M5StaffSources = Readonly<Record<M5StaffTable, readonly Row[]>>;

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
export function m5SourceSql(table: M5StaffTable): string {
  const columns = M5_STAFF_SOURCES[table];
  if (!NAME.test(table) || !columns.every((c) => NAME.test(c))) throw new Error("m5.badSourceName");
  return `SELECT JSON_OBJECT(${columns.map((c) => `'${c}', \`${c}\``).join(", ")}) FROM \`${table}\``;
}
const countSql = (table: M5StaffTable) => `SELECT JSON_OBJECT('n', COUNT(*)) FROM \`${table}\``;

export type M5InputCode = `m5.read.${M5StaffTable}` | "m5.inputIncomplete";
/** Thrown with a fixed code only: a reader error could carry values. */
export class M5InputError extends Error {
  constructor(readonly code: M5InputCode) { super(code); this.name = "M5InputError"; }
}

async function count(reader: LegacyReader, table: M5StaffTable): Promise<number> {
  let rows: readonly Row[];
  try { rows = await reader.rows(countSql(table), []); } catch { throw new M5InputError("m5.inputIncomplete"); }
  const n = rows.length === 1 ? Number(rows[0]!.n) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new M5InputError("m5.inputIncomplete");
  return n;
}

/** Reads the four tables whole; refuses unless each read is its whole table, unchanged during the read. */
export async function readM5StaffSources(reader: LegacyReader): Promise<M5StaffSources> {
  const out = {} as Record<M5StaffTable, readonly Row[]>;
  for (const table of Object.keys(M5_STAFF_SOURCES) as M5StaffTable[]) {
    const before = await count(reader, table);
    try { out[table] = await reader.rows(m5SourceSql(table), []); } catch { throw new M5InputError(`m5.read.${table}`); }
    const after = await count(reader, table);
    if (out[table].length !== before || after !== before) throw new M5InputError("m5.inputIncomplete");
  }
  return out;
}

// --- Staff to principal ----------------------------------------------------------------------

/** Why a legacy staff row has no principal. */
export type StaffUnresolved = "badId" | "deleted" | "unresolved" | "ambiguous" | "notOperatorStaff";
export interface StaffResolution {
  /** Legacy staff id to principal id, one to one. */
  readonly principals: ReadonlyMap<string, string>;
  /** Legacy staff id to the reason it has none. */
  readonly unresolved: ReadonlyMap<string, StaffUnresolved>;
}

/** A legacy staff row as the resolution needs it: the id, whether legacy deleted it, the raw address. */
export interface StaffCandidate { readonly staffId: string; readonly deleted: boolean; readonly email: string | null }
/** Every principal one candidate's address matches, with whether it qualifies. */
export interface StaffMatch { readonly staffId: string; readonly principalId: string; readonly verified: boolean; readonly operatorStaff: boolean }
/** Runs the match query; the address goes in as a parameter and only ids come back. */
export type StaffMatcher = (candidates: readonly { readonly staffId: string; readonly email: string }[], operatorOrgId: string) => Promise<readonly StaffMatch[]>;

const STAFF_ID = /^[1-9][0-9]{0,18}$/;
const staffIdOf = (v: unknown): string | undefined => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return STAFF_ID.test(s) ? s : undefined;
};
/** Legacy soft delete: anything other than an explicit 0 (or false) counts as deleted, failing closed. */
const isDeleted = (v: unknown): boolean => !(v === 0 || v === "0" || v === false);

/** The staff rows' candidates, and the ids no candidate can come from (not a legacy id). */
export function staffCandidates(staff: readonly Row[]): { readonly candidates: readonly StaffCandidate[]; readonly badIds: number } {
  const candidates: StaffCandidate[] = [];
  let badIds = 0;
  for (const row of staff) {
    const id = staffIdOf(row.staff_id);
    if (!id) { badIds++; continue; }
    candidates.push({ staffId: id, deleted: isDeleted(row.deleted), email: typeof row.staff_email === "string" ? row.staff_email : null });
  }
  return { candidates, badIds };
}

/**
 * The SQL the matcher runs. `principal_email_key` is the one address rule (0658) on both sides;
 * the issuer's verification is the row keyed by the current address's key; the operator grant is
 * staff or admin on the operator organization. It returns ids and two flags only.
 */
export const STAFF_MATCH_SQL = `WITH k AS (
    SELECT x.staff_id, principal_email_key(x.email) AS email_key FROM jsonb_to_recordset($1::jsonb) AS x(staff_id text, email text))
  SELECT k.staff_id, p.id AS principal_id,
    EXISTS (SELECT 1 FROM principal_email_verifications v
      WHERE v.principal_id = p.id AND v.email = principal_email_key(p.email) AND v.verified AND v.source = 'oidc') AS verified,
    EXISTS (SELECT 1 FROM grants g WHERE g.principal_id = p.id AND g.org_id = $2 AND g.role IN ('staff', 'admin')) AS operator_staff
  FROM k JOIN principals p ON k.email_key IS NOT NULL AND principal_email_key(p.email) = k.email_key
  ORDER BY k.staff_id, p.id`;

/** Applies the rule to the candidates and the matcher's answer. */
export async function resolveStaff(candidates: readonly StaffCandidate[], match: StaffMatcher, operatorOrgId: string): Promise<StaffResolution> {
  const unresolved = new Map<string, StaffUnresolved>();
  const seen = new Set<string>();
  const live: { staffId: string; email: string }[] = [];
  for (const c of candidates) {
    // Two legacy rows with one id cannot be told apart: neither is resolved.
    if (seen.has(c.staffId)) { unresolved.set(c.staffId, "ambiguous"); continue; }
    seen.add(c.staffId);
    if (c.deleted) unresolved.set(c.staffId, "deleted");
    else if (c.email === null) unresolved.set(c.staffId, "unresolved");
    else live.push({ staffId: c.staffId, email: c.email });
  }
  const matches = live.length ? await match(live, operatorOrgId) : [];
  const byStaff = new Map<string, StaffMatch[]>();
  for (const m of matches) byStaff.set(m.staffId, [...(byStaff.get(m.staffId) ?? []), m]);
  const chosen = new Map<string, string>();
  for (const { staffId } of live) {
    if (unresolved.has(staffId)) continue;
    const verified = (byStaff.get(staffId) ?? []).filter((m) => m.verified);
    if (verified.length === 0) unresolved.set(staffId, "unresolved");
    else if (verified.length > 1) unresolved.set(staffId, "ambiguous");
    else if (!verified[0]!.operatorStaff) unresolved.set(staffId, "notOperatorStaff");
    else chosen.set(staffId, verified[0]!.principalId);
  }
  // One principal for two live legacy staff rows: whose hours are whose cannot be told, so neither.
  const owners = new Map<string, string[]>();
  for (const [staffId, principal] of chosen) owners.set(principal, [...(owners.get(principal) ?? []), staffId]);
  for (const ids of owners.values()) if (ids.length > 1) for (const id of ids) { chosen.delete(id); unresolved.set(id, "ambiguous"); }
  return { principals: chosen, unresolved };
}

// --- Plan --------------------------------------------------------------------------------------

/** The legacy reference of each row per table, and what the plan reported instead of importing. */
export interface StaffWorkPlan {
  readonly questions: readonly WorkImportStandupQuestion[];
  readonly sessions: readonly WorkImportStaffSession[];
  readonly answers: readonly WorkImportStandupAnswer[];
  readonly hours: readonly WorkImportStaffHours[];
  /** Every legacy reference per platform table, for reconciliation. */
  readonly legacyRefs: Readonly<Record<StaffImportTable, readonly string[]>>;
  /** Per table, references the plan reported, with the rule; `minutes_mismatch` rows are imported too. */
  readonly issues: Readonly<Record<StaffImportTable, readonly { readonly legacyRef: string; readonly code: StaffImportIssueCode }[]>>;
}
const TABLES: readonly StaffImportTable[] = ["work_standup_questions", "work_staff_sessions", "work_standup_answers", "work_staff_hours_per_day"];
const iso = (d: Date) => d.toISOString();

/** Maps every row through the work lane's mapper, then puts the resolved principal on each staff row. */
export function planStaffWork(sources: M5StaffSources, resolution: StaffResolution): StaffWorkPlan {
  const issues = Object.fromEntries(TABLES.map((t) => [t, [] as { legacyRef: string; code: StaffImportIssueCode }[]])) as Record<StaffImportTable, { legacyRef: string; code: StaffImportIssueCode }[]>;
  const refs = Object.fromEntries(TABLES.map((t) => [t, [] as string[]])) as Record<StaffImportTable, string[]>;
  const questions: WorkImportStandupQuestion[] = [], sessions: WorkImportStaffSession[] = [], answers: WorkImportStandupAnswer[] = [], hours: WorkImportStaffHours[] = [];
  const principal = (staffId: string) => resolution.principals.get(staffId);

  for (const row of sources.daily_standup_question) {
    const ref = String(row.question_uuid);
    refs.work_standup_questions.push(ref);
    const m = mapLegacyStandupQuestion(row as never);
    for (const i of m.issues) issues.work_standup_questions.push({ legacyRef: ref, code: i.code });
    if (m.question) questions.push({ legacyRef: m.question.legacyRef, question: m.question.question, createdAt: iso(m.question.createdAt), updatedAt: iso(m.question.updatedAt) });
  }
  for (const row of sources.staff_work_session) {
    const ref = String(row.work_session_uuid);
    refs.work_staff_sessions.push(ref);
    const m = mapLegacyStaffSession(row as never);
    for (const i of m.issues) issues.work_staff_sessions.push({ legacyRef: ref, code: i.code });
    if (!m.session) continue;
    const p = principal(m.session.legacyStaffId);
    if (!p) { issues.work_staff_sessions.push({ legacyRef: ref, code: "no_staff" }); continue; }
    sessions.push({ legacyRef: m.session.legacyRef, staffPrincipalId: p, workDate: m.session.workDate, startedAt: iso(m.session.startedAt), endedAt: m.session.endedAt ? iso(m.session.endedAt) : null });
  }
  for (const row of sources.daily_standup_answer) {
    const ref = String(row.answer_uuid);
    refs.work_standup_answers.push(ref);
    const m = mapLegacyStandupAnswer(row as never);
    for (const i of m.issues) issues.work_standup_answers.push({ legacyRef: ref, code: i.code });
    if (!m.answer) continue;
    const p = principal(m.answer.legacyStaffId);
    if (!p) { issues.work_standup_answers.push({ legacyRef: ref, code: "no_staff" }); continue; }
    answers.push({ legacyRef: m.answer.legacyRef, staffPrincipalId: p, questionLegacyRef: m.answer.questionLegacyRef, question: m.answer.question,
      answer: m.answer.answer, workDate: m.answer.workDate, createdAt: iso(m.answer.createdAt) });
  }
  for (const row of sources.staff) {
    const m = mapLegacyStaffHours(row as never);
    const ref = m.hours?.legacyRef ?? `staff:${String(row.staff_id)}`;
    refs.work_staff_hours_per_day.push(ref);
    for (const i of m.issues) issues.work_staff_hours_per_day.push({ legacyRef: ref, code: i.code });
    if (!m.hours) continue;
    const p = principal(m.hours.legacyStaffId);
    // A deleted or unresolved staff row has no hours here: reported, like its sessions.
    if (!p) { issues.work_staff_hours_per_day.push({ legacyRef: ref, code: "no_staff" }); continue; }
    hours.push({ legacyRef: m.hours.legacyRef, staffPrincipalId: p, hours: m.hours.hours });
  }
  return { questions, sessions, answers, hours, legacyRefs: refs, issues };
}

// --- Run ---------------------------------------------------------------------------------------

/** How many rows go to the store in one transaction. */
export const M5_STAFF_BATCH = 500;

export interface StaffTableCounts {
  readonly legacy: number;
  readonly inserted: number; readonly unchanged: number; readonly updated: number;
  readonly conflicts: number;
  readonly refused: Readonly<Partial<Record<WorkImportRefusal, number>>>;
  readonly issues: Readonly<Partial<Record<StaffImportIssueCode, number>>>;
  readonly imported: number; readonly covered: number; readonly verified: number;
  readonly missing: number; readonly skipped: number; readonly extra: number; readonly held: number;
  readonly clean: boolean;
}
export interface StaffWorkOutcome {
  readonly tables: Readonly<Record<StaffImportTable, StaffTableCounts>>;
  /** Legacy refs per table and rule, for the private report only. */
  readonly refs: Readonly<Record<StaffImportTable, {
    readonly issues: Readonly<Partial<Record<StaffImportIssueCode, readonly string[]>>>;
    readonly refused: Readonly<Partial<Record<WorkImportRefusal, readonly string[]>>>;
    readonly conflicts: readonly string[];
    readonly missing: readonly string[]; readonly skipped: readonly string[]; readonly extra: readonly string[]; readonly held: readonly string[];
  }>>;
  /** Every table strictly clean: nothing skipped, missing, extra or held. */
  readonly clean: boolean;
  /**
   * Nothing unexplained: no table has a missing, extra or held row. Rows the run reported (a
   * deleted or unresolved staff member, a mapper rule) are skipped and counted, not unexplained.
   */
  readonly complete: boolean;
}

type ImportStore = Pick<PostgresWorkImportStore, "importStandupQuestions" | "importStaffSessions" | "importStandupAnswers" | "importStaffHours" | "reconcileStaffImport">;

async function batched<R>(rows: readonly R[], write: (rows: readonly R[]) => Promise<WorkImportResult>): Promise<WorkImportResult> {
  let inserted = 0, unchanged = 0, updated = 0;
  const conflicts: WorkImportResult["conflicts"][number][] = [], refused: WorkImportResult["refused"][number][] = [];
  for (let i = 0; i < rows.length; i += M5_STAFF_BATCH) {
    const r = await write(rows.slice(i, i + M5_STAFF_BATCH));
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
  for (const k of Object.keys(g) as K[]) g[k]!.sort();
  return g;
};

/** Writes the plan in dependency order, then reconciles every table. */
export async function runStaffWork(store: ImportStore, plan: StaffWorkPlan): Promise<StaffWorkOutcome> {
  const results: Record<StaffImportTable, WorkImportResult> = {
    work_standup_questions: await batched(plan.questions, (r) => store.importStandupQuestions(r)),
    work_staff_sessions: await batched(plan.sessions, (r) => store.importStaffSessions(r)),
    work_standup_answers: await batched(plan.answers, (r) => store.importStandupAnswers(r)),
    work_staff_hours_per_day: await batched(plan.hours, (r) => store.importStaffHours(r)),
  };
  const tables = {} as Record<StaffImportTable, StaffTableCounts>;
  const refs = {} as Record<StaffImportTable, StaffWorkOutcome["refs"][StaffImportTable]>;
  for (const table of TABLES) {
    const r = results[table];
    const reported = [...plan.issues[table].map((i) => i.legacyRef), ...r.refused.map((x) => x.legacyRef)];
    const held = [...r.conflicts.map((c) => c.legacyRef), ...r.refused.filter((x) => x.code === "unknown_digest").map((x) => x.legacyRef)];
    const rec: StaffImportReconciliation = await store.reconcileStaffImport(table, plan.legacyRefs[table], reported, held);
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
