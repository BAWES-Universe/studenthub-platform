import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * Revenue's Postgres side (contract P-4, screen A-31). Read-only over the pay lane's
 * `pay_transfers` and `pay_transfer_lines`: nothing is stored or incremented, so every figure is
 * one live query and cannot drift from the lines. Amounts stay `numeric` and are returned as text
 * with three decimals. Deleted transfers are never counted.
 *
 * The row types mirror `RevenueStore` in `packages/reports` structurally (db does not depend on reports).
 */
const STATUSES = ["draft", "locked", "payment_sent", "distributing", "complete", "cancelled"] as const;
type Status = typeof STATUSES[number];
export interface RevenueStatusRow { readonly currency: string; readonly status: Status; readonly transfers: number; readonly lines: number; readonly companyTotal: string; readonly candidateTotal: string; readonly grossProfit: string }
export interface RevenueMonthRow { readonly currency: string; readonly month: string; readonly transfers: number; readonly companyTotal: string; readonly candidateTotal: string; readonly grossProfit: string; readonly received: string }
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// Sums per transfer first, so a transfer counts once however many lines it has.
const PER_TRANSFER = `SELECT t.id, t.currency_code, t.status, t.period_end, count(l.id)::int AS lines,
    COALESCE(sum(l.company_total), 0) AS company_total, COALESCE(sum(l.candidate_total), 0) AS candidate_total
  FROM pay_transfers t LEFT JOIN pay_transfer_lines l ON l.transfer_id = t.id AND l.currency_code = t.currency_code
  WHERE NOT t.deleted GROUP BY t.id`;

export class PostgresRevenueStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  async byStatus(): Promise<readonly RevenueStatusRow[]> {
    const r = await this.#pool.query<{ currency: string; status: Status; transfers: number; lines: number; company: string; candidate: string; profit: string }>(
      `SELECT currency_code AS currency, status, count(*)::int AS transfers, sum(lines)::int AS lines,
              to_char(sum(company_total), 'FM999999999999990.000') AS company, to_char(sum(candidate_total), 'FM999999999999990.000') AS candidate,
              to_char(sum(company_total - candidate_total), 'FM999999999999990.000') AS profit
         FROM (${PER_TRANSFER}) x GROUP BY currency_code, status ORDER BY currency_code, array_position($1::text[], status)`, [STATUSES]);
    return r.rows.map(x => ({ currency: x.currency, status: x.status, transfers: x.transfers, lines: x.lines, companyTotal: x.company, candidateTotal: x.candidate, grossProfit: x.profit }));
  }

  async byMonth(first: string, last: string): Promise<readonly RevenueMonthRow[]> {
    if (!MONTH.test(first) || !MONTH.test(last) || first > last) throw new RangeError("invalid month range");
    const r = await this.#pool.query<{ currency: string; month: string; transfers: number; company: string; candidate: string; profit: string; received: string }>(
      `SELECT currency_code AS currency, to_char(period_end, 'YYYY-MM') AS month, count(*)::int AS transfers,
              to_char(sum(company_total), 'FM999999999999990.000') AS company, to_char(sum(candidate_total), 'FM999999999999990.000') AS candidate,
              to_char(sum(company_total - candidate_total), 'FM999999999999990.000') AS profit,
              to_char(COALESCE(sum(company_total) FILTER (WHERE status IN ('payment_sent','distributing','complete')), 0), 'FM999999999999990.000') AS received
         FROM (${PER_TRANSFER}) x
        WHERE status NOT IN ('draft','cancelled') AND to_char(period_end, 'YYYY-MM') BETWEEN $1 AND $2
        GROUP BY currency_code, month ORDER BY currency_code, month`, [first, last]);
    return r.rows.map(x => ({ currency: x.currency, month: x.month, transfers: x.transfers, companyTotal: x.company, candidateTotal: x.candidate, grossProfit: x.profit, received: x.received }));
  }
}
