// Work lane import writes (M-5). The importer lane reads the legacy mirror,
// calls packages/work/src/legacy.ts to map rows and resolve ids, then calls
// these. Contract (same as tools/legacy-import runImport):
// - keyed by legacy_ref; a re-run with the same row writes nothing (unchanged);
// - a legacy_ref already held with different content is a conflict carrying
//   both digests, never overwritten; the one exception is an open-ended
//   placement whose end date legacy has since set (incremental sync), which is
//   applied and counted as updated;
// - a row the work rules refuse (overlap, mismatched placement) is reported
//   with a code and the batch goes on; each row runs in its own savepoint;
// - one transaction per batch.

import { createHash, randomUUID } from "node:crypto";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";
import { PoolOwner, guarded } from "./postgres-work-store.js";

type IsoDate = string;
export interface WorkImportResult {
  readonly inserted: number;
  readonly unchanged: number;
  readonly updated: number;
  readonly conflicts: readonly { readonly legacyRef: string; readonly existingDigest: string; readonly incomingDigest: string }[];
  readonly refused: readonly { readonly legacyRef: string; readonly code: WorkImportRefusal }[];
}
/** `unknown_digest`: the row was imported before digests were kept (0508), so it is held, never compared or overwritten. */
export type WorkImportRefusal = "overlap" | "no_placement" | "no_session" | "no_question" | "open_twice" | "invalid" | "unknown_digest";
export interface WorkImportPlacement {
  readonly legacyRef: string; readonly personId: string; readonly orgId: string; readonly storeId: string;
  readonly startDate: IsoDate; readonly endDate: IsoDate | null; readonly payContractId: string | null;
}
export interface WorkImportSession {
  readonly legacyRef: string; readonly placementLegacyRef: string; readonly workDate: IsoDate;
  readonly startedAt: string; readonly endedAt: string;
  readonly startLocation: { readonly latitude: number; readonly longitude: number } | null;
  readonly endLocation: { readonly latitude: number; readonly longitude: number } | null;
  readonly status: "pending" | "approved" | "rejected"; readonly flags: readonly "location_missing"[]; readonly note: string | null;
}
export interface WorkImportDecision {
  readonly legacyRef: string; readonly personId: string; readonly orgId: string; readonly storeId: string; readonly workDate: IsoDate;
  readonly scope: "session" | "day";
  /** The session a session-scope decision names; day decisions name the day's imported sessions. */
  readonly sessionLegacyRef: string | null;
  readonly outcome: "approved" | "rejected"; readonly reason: string | null; readonly note: string | null; readonly rating: number | null;
  readonly notePublic: boolean; readonly decidedBy: string | null; readonly legacyDecidedBy: string | null; readonly decidedAt: string | null;
}

/** Staff time (legacy `staff_work_session`); the staff id is already resolved to a principal. */
export interface WorkImportStaffSession {
  readonly legacyRef: string; readonly staffPrincipalId: string; readonly workDate: IsoDate;
  readonly startedAt: string; readonly endedAt: string | null;
}
export interface WorkImportStandupQuestion {
  readonly legacyRef: string; readonly question: string; readonly createdAt: string; readonly updatedAt: string;
}
export interface WorkImportStandupAnswer {
  readonly legacyRef: string; readonly staffPrincipalId: string; readonly questionLegacyRef: string;
  readonly question: string; readonly answer: string; readonly workDate: IsoDate; readonly createdAt: string;
}
/** A legacy staff record's hours per day (`staff.hours_per_day`); the staff id is already resolved to a principal. */
export interface WorkImportStaffHours {
  readonly legacyRef: string; readonly staffPrincipalId: string; readonly hours: number;
}
export type StaffImportTable = "work_staff_sessions" | "work_standup_questions" | "work_standup_answers" | "work_staff_hours_per_day";
/** Per-table reconciliation by legacy reference only: no names, times or text. */
export interface StaffImportReconciliation {
  readonly table: StaffImportTable;
  readonly legacy: number;
  readonly imported: number;
  /** Legacy refs with no imported row that the run did not report: real gaps. */
  readonly missing: readonly string[];
  /** Legacy refs with no imported row that the run reported or refused (explained). */
  readonly skipped: readonly string[];
  /** Imported rows whose ref the legacy list no longer holds. */
  readonly extra: readonly string[];
  /** ID coverage: legacy refs that have an imported row, whatever its content. */
  readonly covered: number;
  /**
   * Covered refs whose content is not accepted: the run held them (a digest
   * conflict or `unknown_digest`, passed as `heldRefs`), or the row's digest
   * is unknown here (imported before 0508), whatever the run passed.
   */
  readonly held: readonly string[];
  /** Covered refs whose content is accepted: `covered` minus `held`. */
  readonly verified: number;
  /** Every legacy ref imported and content-accepted, none skipped, missing or extra. */
  readonly clean: boolean;
}

/** sha256 of canonical JSON (keys sorted at every level). */
export function workImportDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** The legacy_ref rule every work table checks. */
const LEGACY_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const isOverlap = (e: unknown) => (e as { code?: string }).code === "23P01";
const isUnique = (e: unknown) => (e as { code?: string }).code === "23505";
// 22021: text Postgres can't store (a NUL); the row is refused, the batch goes on.
const isRuleRefusal = (e: unknown) => ["23514", "23503", "22021"].includes((e as { code?: string }).code ?? "");

class Tally {
  inserted = 0; unchanged = 0; updated = 0;
  conflicts: { legacyRef: string; existingDigest: string; incomingDigest: string }[] = [];
  refused: { legacyRef: string; code: WorkImportRefusal }[] = [];
  result(): WorkImportResult {
    return Object.freeze({ inserted: this.inserted, unchanged: this.unchanged, updated: this.updated, conflicts: Object.freeze(this.conflicts), refused: Object.freeze(this.refused) });
  }
}

const STAFF_IMPORT_TABLES: readonly StaffImportTable[] = ["work_staff_sessions", "work_standup_questions", "work_standup_answers", "work_staff_hours_per_day"];

export class PostgresWorkImportStore {
  readonly #db: PoolOwner;
  constructor(poolOrConfig: PgPool | PoolConfig) { this.#db = new PoolOwner(poolOrConfig); }
  async close(): Promise<void> { await this.#db.close(); }

  async importPlacements(rows: readonly WorkImportPlacement[]): Promise<WorkImportResult> {
    return this.#batch("work_assignments", rows, async (client, row, tally) => {
      const digest = workImportDigest({ ...row, endDate: null });
      const { rows: held } = await client.query<{ id: string; legacy_digest: string; end_date: string | null }>(
        "SELECT id, legacy_digest, to_char(end_date,'YYYY-MM-DD') AS end_date FROM work_assignments WHERE legacy_ref = $1 FOR UPDATE", [row.legacyRef]);
      const existing = held[0];
      if (existing) {
        if (existing.legacy_digest !== digest) { tally.conflicts.push({ legacyRef: row.legacyRef, existingDigest: existing.legacy_digest, incomingDigest: digest }); return; }
        if (existing.end_date === row.endDate) { tally.unchanged++; return; }
        // Only closing an open-ended placement is an update; reopening or moving an end date is a conflict.
        if (existing.end_date !== null || row.endDate === null) {
          tally.conflicts.push({ legacyRef: row.legacyRef, existingDigest: workImportDigest({ ...row, endDate: existing.end_date }), incomingDigest: workImportDigest(row) });
          return;
        }
        await guarded(client, () => client.query("UPDATE work_assignments SET end_date = $2::date WHERE id = $1", [existing.id, row.endDate]));
        tally.updated++;
        return;
      }
      await guarded(client, () => client.query(`INSERT INTO work_assignments(id, person_principal_id, org_id, store_id, pay_contract_id, contract_resolution,
        start_date, end_date, source, legacy_ref, legacy_digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::date,$8::date,'import',$9,$10)`,
      [randomUUID(), row.personId, row.orgId, row.storeId, row.payContractId,
        JSON.stringify({ version: "studenthub.pay-rate-resolution.v1", steps: ["imported_from_legacy"], matchedContractIds: row.payContractId ? [row.payContractId] : [], contractId: row.payContractId }),
        row.startDate, row.endDate, row.legacyRef, digest]));
      tally.inserted++;
    });
  }

  async importSessions(rows: readonly WorkImportSession[]): Promise<WorkImportResult> {
    return this.#batch("work_sessions", rows, async (client, row, tally) => {
      const digest = workImportDigest(row);
      const { rows: held } = await client.query<{ legacy_digest: string }>("SELECT legacy_digest FROM work_sessions WHERE legacy_ref = $1", [row.legacyRef]);
      if (held[0]) { this.#same(tally, row.legacyRef, held[0].legacy_digest, digest); return; }
      const { rows: placement } = await client.query<{ id: string; person_principal_id: string; org_id: string; store_id: string }>(
        "SELECT id, person_principal_id, org_id, store_id FROM work_assignments WHERE legacy_ref = $1", [row.placementLegacyRef]);
      const a = placement[0];
      if (!a) { tally.refused.push({ legacyRef: row.legacyRef, code: "no_placement" }); return; }
      await guarded(client, () => client.query(`INSERT INTO work_sessions(id, assignment_id, person_principal_id, org_id, store_id, work_date, started_at, ended_at,
        start_latitude, start_longitude, end_latitude, end_longitude, source, status, flags, note, legacy_ref, legacy_digest)
        VALUES($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,'import',$13,$14::text[],$15,$16,$17)`,
      [randomUUID(), a.id, a.person_principal_id, a.org_id, a.store_id, row.workDate, row.startedAt, row.endedAt,
        row.startLocation?.latitude ?? null, row.startLocation?.longitude ?? null, row.endLocation?.latitude ?? null, row.endLocation?.longitude ?? null,
        row.status, [...row.flags], row.note, row.legacyRef, digest]));
      tally.inserted++;
    });
  }

  /**
   * Imported decisions, then each decided imported session links to the
   * latest decision naming it with its own legacy status.
   */
  async importDecisions(rows: readonly WorkImportDecision[]): Promise<WorkImportResult> {
    const result = await this.#batch("work_decisions", rows, async (client, row, tally) => {
      const digest = workImportDigest(row);
      const { rows: held } = await client.query<{ legacy_digest: string }>("SELECT legacy_digest FROM work_decisions WHERE legacy_ref = $1", [row.legacyRef]);
      if (held[0]) { this.#same(tally, row.legacyRef, held[0].legacy_digest, digest); return; }
      // The decision's company must own its store, or a day decision could name another company's sessions.
      const { rows: owned } = await client.query("SELECT 1 FROM organization_stores WHERE id = $1::uuid AND org_id = $2", [row.storeId, row.orgId]);
      if (owned.length === 0) { tally.refused.push({ legacyRef: row.legacyRef, code: "invalid" }); return; }
      const { rows: sessions } = row.scope === "session"
        // The session must belong to the decision's own person, company, store and day, or the relink could hand it to someone else.
        ? await client.query<{ id: string }>(`SELECT id FROM work_sessions WHERE legacy_ref = $1 AND person_principal_id = $2 AND org_id = $3 AND store_id = $4
            AND work_date = $5::date`, [row.sessionLegacyRef, row.personId, row.orgId, row.storeId, row.workDate])
        : await client.query<{ id: string }>(`SELECT id FROM work_sessions WHERE source = 'import' AND person_principal_id = $1 AND org_id = $4 AND store_id = $2
            AND work_date = $3::date AND deleted_at IS NULL ORDER BY started_at, id`, [row.personId, row.storeId, row.workDate, row.orgId]);
      if (row.scope === "session" && sessions.length === 0) { tally.refused.push({ legacyRef: row.legacyRef, code: "no_session" }); return; }
      await guarded(client, () => client.query(`INSERT INTO work_decisions(id, org_id, store_id, person_principal_id, work_date, scope, outcome, session_ids, reason, note, rating,
        note_public, decided_by, decided_at, legacy_ref, legacy_digest, legacy_decided_by)
        VALUES($1,$2,$3,$4,$5::date,$6,$7,$8::uuid[],$9,$10,$11,$12,$13,coalesce($14::timestamptz, clock_timestamp()),$15,$16,$17)`,
      [randomUUID(), row.orgId, row.storeId, row.personId, row.workDate, row.scope, row.outcome, sessions.map((s) => s.id), row.reason, row.note, row.rating,
        row.notePublic, row.decidedBy, row.decidedAt, row.legacyRef, digest, row.legacyDecidedBy]));
      tally.inserted++;
    }, async (client) => {
      await client.query(`WITH pick AS (
          SELECT DISTINCT ON (s.id) s.id AS session_id, d.id AS decision_id FROM work_sessions s
          JOIN work_decisions d ON s.id = ANY(d.session_ids) AND d.outcome = s.status AND d.legacy_ref IS NOT NULL
            -- Only a decision on the session's own day: one stored for another company, store or person is never linked.
            AND d.org_id = s.org_id AND d.store_id = s.store_id AND d.person_principal_id = s.person_principal_id AND d.work_date = s.work_date
          -- Only sessions in force: a replaced original keeps its history and is never relinked.
          WHERE s.source = 'import' AND s.status <> 'pending' AND s.deleted_at IS NULL AND work_session_in_force(s.id)
          ORDER BY s.id, d.decided_at DESC, d.id DESC)
        UPDATE work_sessions s SET decision_id = p.decision_id FROM pick p WHERE s.id = p.session_id AND s.decision_id IS DISTINCT FROM p.decision_id
          AND (s.decision_id IS NULL OR EXISTS (SELECT 1 FROM work_decisions cur WHERE cur.id = s.decision_id AND cur.legacy_ref IS NOT NULL))`);
    });
    return result;
  }

  /**
   * Staff sessions. The digest leaves the end out, so a session imported open
   * and since ended in legacy is written once (counted as updated); any other
   * change of the end is a conflict. A second open session on one day is
   * refused as `open_twice` (one open session per staff member and day).
   */
  async importStaffSessions(rows: readonly WorkImportStaffSession[]): Promise<WorkImportResult> {
    // Ends first: legacy may have closed an imported open session and opened another the same day.
    const ordered = [...rows.filter((r) => r.endedAt !== null), ...rows.filter((r) => r.endedAt === null)];
    // Each staff member's day is locked with the refs, in the same global order, so two batches opening
    // sessions on the same days wait for each other and the second sees open_twice instead of deadlocking.
    const days = rows.map((r) => `day ${r.staffPrincipalId} ${r.workDate}`);
    return this.#batch("work_staff_sessions", ordered, async (client, row, tally) => {
      const digest = workImportDigest({ ...row, endedAt: null });
      const { rows: held } = await client.query<{ id: string; legacy_digest: string | null; ended_at: Date | null }>(
        "SELECT id, legacy_digest, ended_at FROM work_staff_sessions WHERE legacy_ref = $1 FOR UPDATE", [row.legacyRef]);
      const existing = held[0];
      const end = row.endedAt === null ? null : new Date(row.endedAt).toISOString();
      if (existing) {
        if (existing.legacy_digest === null) { tally.refused.push({ legacyRef: row.legacyRef, code: "unknown_digest" }); return; }
        const heldEnd = existing.ended_at?.toISOString() ?? null;
        if (existing.legacy_digest !== digest) { tally.conflicts.push({ legacyRef: row.legacyRef, existingDigest: existing.legacy_digest, incomingDigest: digest }); return; }
        // Same session, different end: only ending an open one is applied.
        if (heldEnd !== null && heldEnd !== end) {
          tally.conflicts.push({ legacyRef: row.legacyRef, existingDigest: workImportDigest({ ...row, endedAt: heldEnd }), incomingDigest: workImportDigest({ ...row, endedAt: end }) });
          return;
        }
        if (heldEnd === end) { tally.unchanged++; return; }
        await guarded(client, () => client.query("UPDATE work_staff_sessions SET ended_at = $2 WHERE id = $1", [existing.id, end]));
        tally.updated++;
        return;
      }
      try {
        await guarded(client, () => client.query(`INSERT INTO work_staff_sessions(id, staff_principal_id, work_date, started_at, ended_at, source, legacy_ref, legacy_digest)
          VALUES($1,$2,$3::date,$4,$5,'import',$6,$7)`, [randomUUID(), row.staffPrincipalId, row.workDate, row.startedAt, end, row.legacyRef, digest]));
      } catch (error) {
        if (isUnique(error) && end === null) { tally.refused.push({ legacyRef: row.legacyRef, code: "open_twice" }); return; }
        throw error;
      }
      tally.inserted++;
    }, undefined, days);
  }

  /** Stand-up questions, imported as asked (not retired). Run before their answers. */
  async importStandupQuestions(rows: readonly WorkImportStandupQuestion[]): Promise<WorkImportResult> {
    return this.#batch("work_standup_questions", rows, async (client, row, tally) => {
      const digest = workImportDigest(row);
      const { rows: held } = await client.query<{ legacy_digest: string | null; question: string; created_at: Date; updated_at: Date; retired_at: Date | null }>(
        "SELECT legacy_digest, question, created_at, updated_at, retired_at FROM work_standup_questions WHERE legacy_ref = $1", [row.legacyRef]);
      const stored = held[0];
      if (stored?.legacy_digest === null) { tally.refused.push({ legacyRef: row.legacyRef, code: "unknown_digest" }); return; }
      if (stored) {
        if (stored.legacy_digest !== digest) { this.#same(tally, row.legacyRef, stored.legacy_digest, digest); return; }
        // Imported questions stay editable and retirable here, so the frozen digest alone can't say the
        // row still reads as legacy: the stored content is compared too, and a row edited or retired
        // since is a conflict (reported with the digest of what is stored now), never counted unchanged.
        const same = stored.question === row.question && stored.retired_at === null
          && stored.created_at.getTime() === new Date(row.createdAt).getTime() && stored.updated_at.getTime() === new Date(row.updatedAt).getTime();
        if (same) { tally.unchanged++; return; }
        const now = { legacyRef: row.legacyRef, question: stored.question, createdAt: stored.created_at.toISOString(), updatedAt: stored.updated_at.toISOString(),
          ...(stored.retired_at ? { retiredAt: stored.retired_at.toISOString() } : {}) };
        tally.conflicts.push({ legacyRef: row.legacyRef, existingDigest: workImportDigest(now), incomingDigest: digest });
        return;
      }
      await guarded(client, () => client.query(`INSERT INTO work_standup_questions(id, question, created_at, updated_at, legacy_ref, legacy_digest)
        VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), row.question, row.createdAt, row.updatedAt, row.legacyRef, digest]));
      tally.inserted++;
    });
  }

  /**
   * Stand-up answers. An answer names its question by legacy ref; one whose
   * question was not imported is refused as `no_question`. Repeats on a day
   * are kept (the once-a-day rule covers answers given here only).
   */
  async importStandupAnswers(rows: readonly WorkImportStandupAnswer[]): Promise<WorkImportResult> {
    return this.#batch("work_standup_answers", rows, async (client, row, tally) => {
      const digest = workImportDigest(row);
      const { rows: held } = await client.query<{ legacy_digest: string | null }>("SELECT legacy_digest FROM work_standup_answers WHERE legacy_ref = $1", [row.legacyRef]);
      if (held[0]?.legacy_digest === null) { tally.refused.push({ legacyRef: row.legacyRef, code: "unknown_digest" }); return; }
      if (held[0]) { this.#same(tally, row.legacyRef, held[0].legacy_digest, digest); return; }
      const { rows: question } = await client.query<{ id: string }>("SELECT id FROM work_standup_questions WHERE legacy_ref = $1", [row.questionLegacyRef]);
      if (!question[0]) { tally.refused.push({ legacyRef: row.legacyRef, code: "no_question" }); return; }
      await guarded(client, () => client.query(`INSERT INTO work_standup_answers(id, staff_principal_id, question_id, question, answer, work_date, source, legacy_ref, legacy_digest, created_at)
        VALUES($1,$2,$3,$4,$5,$6::date,'import',$7,$8,date_trunc('milliseconds', $9::timestamptz))`,
      [randomUUID(), row.staffPrincipalId, question[0].id, row.question, row.answer, row.workDate, row.legacyRef, digest, row.createdAt]));
      tally.inserted++;
    });
  }

  /**
   * Staff hours per day, one row per principal. The number stays editable
   * here, so a replay compares the stored hours, not only the digest: a row
   * changed since (here or in legacy) is a conflict, never overwritten. A
   * principal that already holds hours under another legacy ref (two legacy
   * staff records resolved to one person) is refused as `invalid`.
   */
  async importStaffHours(rows: readonly WorkImportStaffHours[]): Promise<WorkImportResult> {
    // The principal is locked with the refs, so two batches naming one person under different refs wait for each other.
    const people = rows.map((r) => `staff ${r.staffPrincipalId}`);
    return this.#batch("work_staff_hours_per_day", rows, async (client, row, tally) => {
      const digest = workImportDigest(row);
      // A row with a legacy ref always carries its digest here (0509 checks it on insert).
      const { rows: held } = await client.query<{ legacy_digest: string; staff_principal_id: string; hours: number }>(
        "SELECT legacy_digest, staff_principal_id, hours FROM work_staff_hours_per_day WHERE legacy_ref = $1", [row.legacyRef]);
      const stored = held[0];
      if (stored) {
        if (stored.legacy_digest !== digest) { this.#same(tally, row.legacyRef, stored.legacy_digest, digest); return; }
        if (stored.hours === row.hours) { tally.unchanged++; return; }
        const now = { legacyRef: row.legacyRef, staffPrincipalId: stored.staff_principal_id, hours: stored.hours };
        tally.conflicts.push({ legacyRef: row.legacyRef, existingDigest: workImportDigest(now), incomingDigest: digest });
        return;
      }
      if (!Number.isInteger(row.hours) || row.hours < 0 || row.hours > 24) { tally.refused.push({ legacyRef: row.legacyRef, code: "invalid" }); return; }
      const { rows: taken } = await client.query("SELECT 1 FROM work_staff_hours_per_day WHERE staff_principal_id = $1", [row.staffPrincipalId]);
      if (taken.length > 0) { tally.refused.push({ legacyRef: row.legacyRef, code: "invalid" }); return; }
      await guarded(client, () => client.query(`INSERT INTO work_staff_hours_per_day(staff_principal_id, hours, legacy_ref, legacy_digest)
        VALUES($1,$2,$3,$4)`, [row.staffPrincipalId, row.hours, row.legacyRef, digest]));
      tally.inserted++;
    }, undefined, people);
  }

  /**
   * Reconciliation for one table: the legacy refs the importer read against
   * the rows imported here, by legacy ref only. `reportedRefs` are the rows
   * the run reported or refused (mapper issues, `refused`), so a skipped row
   * reads as explained and only an unexplained one as missing. ID coverage
   * and content are kept apart: `heldRefs` are the rows the run held on
   * content (`conflicts`, and `unknown_digest` refusals); a covered row that
   * is held never counts as verified, and the table is clean only when
   * nothing is held, skipped, missing or extra.
   */
  async reconcileStaffImport(table: StaffImportTable, legacyRefs: readonly string[], reportedRefs: readonly string[] = [], heldRefs: readonly string[] = []): Promise<StaffImportReconciliation> {
    if (!STAFF_IMPORT_TABLES.includes(table)) throw new TypeError("unknown staff import table");
    const { rows } = await this.#db.pool.query<{ legacy_ref: string; unknown: boolean }>(
      `SELECT legacy_ref, legacy_digest IS NULL AS unknown FROM ${table} WHERE legacy_ref IS NOT NULL ORDER BY legacy_ref`);
    const here = new Set(rows.map((r) => r.legacy_ref));
    const unknown = new Set(rows.filter((r) => r.unknown).map((r) => r.legacy_ref));
    const there = new Set(legacyRefs), reported = new Set(reportedRefs), heldByRun = new Set(heldRefs);
    const absent = [...there].filter((r) => !here.has(r)).sort();
    const covered = [...there].filter((r) => here.has(r)).sort();
    const held = covered.filter((r) => heldByRun.has(r) || unknown.has(r));
    const missing = absent.filter((r) => !reported.has(r)), skipped = absent.filter((r) => reported.has(r));
    const extra = [...here].filter((r) => !there.has(r)).sort();
    return Object.freeze({
      table, legacy: there.size, imported: here.size,
      missing: Object.freeze(missing), skipped: Object.freeze(skipped), extra: Object.freeze(extra),
      covered: covered.length, held: Object.freeze(held), verified: covered.length - held.length,
      clean: held.length === 0 && absent.length === 0 && extra.length === 0,
    });
  }

  #same(tally: Tally, legacyRef: string, existing: string, incoming: string): void {
    if (existing === incoming) tally.unchanged++; else tally.conflicts.push({ legacyRef, existingDigest: existing, incomingDigest: incoming });
  }

  async #batch<R extends { readonly legacyRef: string }>(table: string, rows: readonly R[], each: (client: PoolClient, row: R, tally: Tally) => Promise<void>,
    after?: (client: PoolClient) => Promise<void>, extraLocks: readonly string[] = []): Promise<WorkImportResult> {
    // A ref the tables could never hold (the legacy_ref rule; a NUL can't even be sent) is refused
    // before any query touches it.
    const refused = rows.filter((r) => !LEGACY_REF.test(r.legacyRef));
    rows = rows.filter((r) => LEGACY_REF.test(r.legacyRef));
    return this.#db.transaction(async (client) => {
      // Two batches naming the same legacy_ref would both miss it on lookup and one insert would fail,
      // rolling back its whole batch. Lock every ref of the batch first, in one global order (so two
      // batches can't deadlock); a second batch then waits and finds the row as unchanged or a conflict.
      await client.query(`SELECT pg_advisory_xact_lock(k) FROM (SELECT DISTINCT hashtextextended($1 || ':' || r, 0) AS k FROM unnest($2::text[]) r) t ORDER BY k`,
        // Extra keys contain a space, which no legacy_ref may, so they never share a lock with a ref.
        [table, [...rows.map((r) => r.legacyRef), ...extraLocks]]);
      const tally = new Tally();
      for (const row of refused) tally.refused.push({ legacyRef: row.legacyRef, code: "invalid" });
      for (const row of rows) {
        // Each row runs under its own savepoint: a refused row (even one whose lookup failed outside
        // `guarded`) is rolled back alone, so the transaction is never left aborted for later rows or
        // the commit, and the tally only counts what is written.
        await client.query("SAVEPOINT work_import_row");
        try {
          await each(client, row, tally);
          await client.query("RELEASE SAVEPOINT work_import_row");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT work_import_row");
          await client.query("RELEASE SAVEPOINT work_import_row");
          if (isOverlap(error)) tally.refused.push({ legacyRef: row.legacyRef, code: "overlap" });
          else if (isRuleRefusal(error)) tally.refused.push({ legacyRef: row.legacyRef, code: "invalid" });
          else throw error;
        }
      }
      if (after) await after(client);
      return tally.result();
    });
  }
}
