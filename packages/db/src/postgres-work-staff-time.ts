// Internal staff time (work lane): StudentHub's own staff clock in and out.
// Implements the work package's StaffTimeStore port by shape.

import type { Pool as PgPool, PoolConfig } from "pg";
import { PoolOwner } from "./postgres-work-store.js";

export interface WorkStaffSessionRecord {
  readonly id: string;
  readonly staffId: string;
  readonly workDate: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly minutes: number | null;
  readonly source: "timer" | "import";
}
export interface WorkStaffDayRecord {
  readonly staffId: string;
  readonly workDate: string;
  readonly minutes: number;
  readonly sessions: number;
  readonly open: boolean;
  readonly firstStart: string;
  readonly lastEnd: string | null;
}

const COLUMNS = `id, staff_principal_id, to_char(work_date,'YYYY-MM-DD') AS work_date, started_at, ended_at, minutes, source`;
interface Row { id: string; staff_principal_id: string; work_date: string; started_at: Date; ended_at: Date | null; minutes: number | null; source: "timer" | "import" }
const fromRow = (r: Row): WorkStaffSessionRecord => Object.freeze({
  id: r.id, staffId: r.staff_principal_id, workDate: r.work_date, startedAt: r.started_at.toISOString(), endedAt: r.ended_at?.toISOString() ?? null, minutes: r.minutes, source: r.source,
});

/** The operator organizations whose staff and admins time their day (as in the work package). */
const OPERATOR_ORG_IDS = ["root"];

export class PostgresWorkStaffTimeStore {
  readonly #db: PoolOwner;
  constructor(poolOrConfig: PgPool | PoolConfig) { this.#db = new PoolOwner(poolOrConfig); }
  async close(): Promise<void> { await this.#db.close(); }

  async openSession(staffId: string, workDate: string): Promise<WorkStaffSessionRecord | undefined> {
    const { rows } = await this.#db.pool.query<Row>(`SELECT ${COLUMNS} FROM work_staff_sessions WHERE staff_principal_id = $1 AND work_date = $2::date AND ended_at IS NULL`, [staffId, workDate]);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async insertOpen(s: { id: string; staffId: string; workDate: string; startedAt: Date }): Promise<"inserted" | "exists"> {
    const { rowCount } = await this.#db.pool.query(`INSERT INTO work_staff_sessions(id, staff_principal_id, work_date, started_at, source) VALUES($1,$2,$3::date,$4,'timer')
      ON CONFLICT (staff_principal_id, work_date) WHERE ended_at IS NULL DO NOTHING`, [s.id, s.staffId, s.workDate, s.startedAt]);
    return rowCount === 1 ? "inserted" : "exists";
  }

  async end(id: string, endedAt: Date): Promise<WorkStaffSessionRecord | undefined> {
    // An end before the start (a clock step back) is written as the start: zero minutes, never negative.
    const { rows } = await this.#db.pool.query<Row>(`UPDATE work_staff_sessions SET ended_at = greatest($2::timestamptz, started_at) WHERE id = $1 AND ended_at IS NULL RETURNING ${COLUMNS}`, [id, endedAt]);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async sessionsOn(staffId: string, workDate: string): Promise<readonly WorkStaffSessionRecord[]> {
    const { rows } = await this.#db.pool.query<Row>(`SELECT ${COLUMNS} FROM work_staff_sessions WHERE staff_principal_id = $1 AND work_date = $2::date ORDER BY started_at, id`, [staffId, workDate]);
    return Object.freeze(rows.map(fromRow));
  }

  async days(filter: { range: { from: string; to: string }; staffId?: string; after?: { workDate: string; staffId: string }; limit: number }): Promise<readonly WorkStaffDayRecord[]> {
    const { rows } = await this.#db.pool.query<{ staff_principal_id: string; work_date: string; minutes: number; sessions: number; open: boolean; first_start: Date; last_end: Date | null }>(
      `SELECT staff_principal_id, to_char(work_date,'YYYY-MM-DD') AS work_date, coalesce(sum(minutes), 0)::integer AS minutes, count(*)::integer AS sessions,
         bool_or(ended_at IS NULL) AS open, min(started_at) AS first_start, max(ended_at) AS last_end
       FROM work_staff_sessions
       WHERE work_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR staff_principal_id = $3)
       GROUP BY staff_principal_id, work_date
       HAVING $4::date IS NULL OR (work_date < $4::date OR (work_date = $4::date AND staff_principal_id > $5::text))
       ORDER BY work_date DESC, staff_principal_id LIMIT $6`,
      [filter.range.from, filter.range.to, filter.staffId ?? null, filter.after?.workDate ?? null, filter.after?.staffId ?? null, filter.limit]);
    return Object.freeze(rows.map((r) => Object.freeze({ staffId: r.staff_principal_id, workDate: r.work_date, minutes: r.minutes, sessions: r.sessions, open: r.open,
      firstStart: r.first_start.toISOString(), lastEnd: r.last_end?.toISOString() ?? null })));
  }

  async operatorStaff(): Promise<readonly string[]> {
    const { rows } = await this.#db.pool.query<{ principal_id: string }>(
      "SELECT DISTINCT principal_id FROM grants WHERE role IN ('staff','admin') AND scope = 'subtree' AND org_id = ANY($1::text[]) ORDER BY principal_id", [OPERATOR_ORG_IDS]);
    return Object.freeze(rows.map((r) => r.principal_id));
  }

  async staffWithSessionOn(workDate: string): Promise<ReadonlySet<string>> {
    const { rows } = await this.#db.pool.query<{ staff_principal_id: string }>("SELECT DISTINCT staff_principal_id FROM work_staff_sessions WHERE work_date = $1::date", [workDate]);
    return new Set(rows.map((r) => r.staff_principal_id));
  }
}
