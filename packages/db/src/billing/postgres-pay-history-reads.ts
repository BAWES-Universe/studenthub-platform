import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * A candidate's own pay history (F4.9; legacy candidate `AccountController::actionSalary` and
 * `actionSalaryDetail`).
 *
 * A person sees only their own pay lines that have been paid out: the line is marked paid and its
 * transfer is distributing or complete, as legacy lists `paid = 1` lines of transfers in
 * SALARY_DISTRIBUTION_IN_PROGRESS or COMPLETE. Newest period first, ten to a page. Only the
 * candidate's side is read: the company total, the company rate, the transfer cost and the
 * calculation's result never leave this store. Another person's line, an unpaid line and a line of
 * a deleted transfer all answer null, so a reader cannot tell them apart.
 */
export const PAY_HISTORY_PAGE_SIZE = 10;
export const PAY_HISTORY_CALCULATION_VERSION = "studenthub.payroll.f2-preview.v1";

export interface PayHistoryEntry {
  readonly lineId: string;
  readonly companyName: string;
  readonly storeName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currencyCode: string;
  readonly total: string;
  readonly status: "paid";
}
export interface PayHistoryDetail extends PayHistoryEntry {
  /** Worked time and the candidate's own hourly rate, when the line was generated from an hourly contract; null otherwise. */
  readonly worked: { readonly hours: string; readonly minutes: number; readonly hourlyRate: string } | null;
}
export interface PayHistoryPage { readonly page: number; readonly pageCount: number; readonly total: number; readonly entries: readonly PayHistoryEntry[] }

const DECIMAL = /^[0-9]{1,9}(\.[0-9]{1,3})?$/;
const SELECT = `l.id AS "lineId", COALESCE(NULLIF(btrim(p.name_en), ''), o.name) AS "companyName", s.name AS "storeName",
  t.period_start::text AS "periodStart", t.period_end::text AS "periodEnd", l.currency_code AS "currencyCode", l.candidate_total::text AS total`;
const FROM = `FROM pay_transfer_lines l JOIN pay_transfers t ON t.id = l.transfer_id JOIN organization_stores s ON s.id = l.store_id
  JOIN organizations o ON o.id = t.company_id LEFT JOIN organization_profiles p ON p.org_id = t.company_id
  WHERE l.person_id = $1 AND l.paid AND NOT t.deleted AND t.status IN ('distributing', 'complete')`;
const ORDER = `ORDER BY t.period_end DESC, t.period_start DESC, l.id DESC`;

/** The candidate's side of an F2 calculation, or null when the line carries anything else. */
export function candidateWorked(calculation: unknown): PayHistoryDetail["worked"] {
  if (!calculation || typeof calculation !== "object") return null;
  const c = calculation as { version?: unknown; input?: { hours?: unknown; minutes?: unknown; rate?: { payModel?: unknown; candidateHourlyRate?: unknown } } };
  if (c.version !== PAY_HISTORY_CALCULATION_VERSION || !c.input || typeof c.input !== "object") return null;
  const { hours, minutes, rate } = c.input;
  if (!rate || typeof rate !== "object" || rate.payModel !== "hourly") return null;
  if (typeof hours !== "string" || !/^[0-9]{1,6}$/.test(hours) || !Number.isSafeInteger(minutes) || (minutes as number) < 0 || (minutes as number) > 59) return null;
  if (typeof rate.candidateHourlyRate !== "string" || !DECIMAL.test(rate.candidateHourlyRate)) return null;
  return { hours, minutes: minutes as number, hourlyRate: rate.candidateHourlyRate };
}

export class PostgresPayHistoryReads {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** One page (from 1) of the person's paid lines, newest first; a page past the end is empty. */
  async list(personId: string, page: number): Promise<PayHistoryPage> {
    if (!Number.isSafeInteger(page) || page < 1) throw new RangeError("invalid_page");
    const [count, rows] = await Promise.all([
      this.#pool.query<{ n: string }>(`SELECT count(*)::text AS n ${FROM}`, [personId]),
      this.#pool.query<PayHistoryEntry>(`SELECT ${SELECT} ${FROM} ${ORDER} LIMIT ${PAY_HISTORY_PAGE_SIZE} OFFSET $2`, [personId, (page - 1) * PAY_HISTORY_PAGE_SIZE]),
    ]);
    const total = Number(count.rows[0]?.n ?? 0);
    return { page, pageCount: Math.max(1, Math.ceil(total / PAY_HISTORY_PAGE_SIZE)), total, entries: rows.rows.map(row => ({ ...row, status: "paid" as const })) };
  }

  /** One of the person's paid lines, or null. */
  async detail(personId: string, lineId: string): Promise<PayHistoryDetail | null> {
    const row = (await this.#pool.query<PayHistoryEntry & { calculation: unknown }>(
      `SELECT ${SELECT}, l.calculation ${FROM} AND l.id = $2`, [personId, lineId])).rows[0];
    if (!row) return null;
    const { calculation, ...entry } = row;
    return { ...entry, status: "paid", worked: candidateWorked(calculation) };
  }
}
