import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * Revenue's Postgres side (contract P-4, screen A-31). Read-only over the pay lane's
 * `pay_transfers` and `pay_transfer_lines`: nothing is stored or incremented, so every figure is
 * one live query and cannot drift from the lines. Amounts stay `numeric` and are returned as exact
 * text with three decimals and no integer ceiling. Both views come from one snapshot. Deleted transfers are never counted.
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

/** Exact scale-3 numeric text with no integer ceiling: "0.000", "-2.500", "1234567890123456789.001". */
const money = (expr: string) => `round(${expr}, 3)::text`;
const BY_STATUS = `SELECT currency_code AS currency, status, count(*)::int AS transfers, sum(lines)::int AS lines,
    ${money("sum(company_total)")} AS company, ${money("sum(candidate_total)")} AS candidate, ${money("sum(company_total - candidate_total)")} AS profit
  FROM (${PER_TRANSFER}) x GROUP BY currency_code, status ORDER BY currency_code, array_position($1::text[], status)`;
const BY_MONTH = `SELECT currency_code AS currency, to_char(period_end, 'YYYY-MM') AS month, count(*)::int AS transfers,
    ${money("sum(company_total)")} AS company, ${money("sum(candidate_total)")} AS candidate, ${money("sum(company_total - candidate_total)")} AS profit,
    ${money("COALESCE(sum(company_total) FILTER (WHERE status IN ('payment_sent','distributing','complete')), 0)")} AS received
  FROM (${PER_TRANSFER}) x
  WHERE status NOT IN ('draft','cancelled') AND to_char(period_end, 'YYYY-MM') BETWEEN $1 AND $2
  GROUP BY currency_code, month ORDER BY currency_code, month`;

export class PostgresRevenueStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /**
   * The reconciliation and the months in [first, last] from one read-only repeatable-read snapshot,
   * so a transfer that changes status while the page is read is counted the same way in both.
   */
  async read(first: string, last: string): Promise<{ readonly byStatus: readonly RevenueStatusRow[]; readonly byMonth: readonly RevenueMonthRow[] }> {
    if (!MONTH.test(first) || !MONTH.test(last) || first > last) throw new RangeError("invalid month range");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const s = await client.query<{ currency: string; status: Status; transfers: number; lines: number; company: string; candidate: string; profit: string }>(BY_STATUS, [STATUSES]);
      const m = await client.query<{ currency: string; month: string; transfers: number; company: string; candidate: string; profit: string; received: string }>(BY_MONTH, [first, last]);
      await client.query("COMMIT");
      return {
        byStatus: s.rows.map(x => ({ currency: x.currency, status: x.status, transfers: x.transfers, lines: x.lines, companyTotal: x.company, candidateTotal: x.candidate, grossProfit: x.profit })),
        byMonth: m.rows.map(x => ({ currency: x.currency, month: x.month, transfers: x.transfers, companyTotal: x.company, candidateTotal: x.candidate, grossProfit: x.profit, received: x.received })),
      };
    } catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; } finally { client.release(); }
  }
}
