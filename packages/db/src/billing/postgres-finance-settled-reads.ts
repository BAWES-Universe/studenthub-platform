import pg from "pg";
import type { BankResultFileGate } from "./postgres-bank-result-store.js";
import { centralFinanceCompanies, type FinanceTransferDecision } from "./postgres-finance-transfer-reads.js";
import { ENTRY, FROM, MOVEMENTS, type TransferInvoiceListEntry } from "./postgres-transfer-invoice-reads.js";

/**
 * StudentHub Finance's settled view (matrix A-20, F4): every company's transfer invoices and each company's
 * balance, across all the companies Finance settles. Read only.
 *
 * The documents are exactly the ones each company's own invoices page and statement show (`FROM` and
 * `MOVEMENTS` of the transfer invoice reads), so a balance here always equals that company's statement
 * closing balance over all time. Access is the A-18 rule: the central finance gate, then the per-company
 * settle decision for each company with invoices; everyone else gets null.
 *
 * Each read runs in one REPEATABLE READ snapshot, so the balances and the invoice page agree. Not READ ONLY:
 * the production gate locks grants and organizations FOR SHARE.
 */
export type FinanceSettledStatus = "unpaid" | "paid" | "credited";
export const FINANCE_SETTLED_STATUSES: readonly FinanceSettledStatus[] = Object.freeze(["unpaid", "paid", "credited"]);
/** One company's documents in one currency, all time: invoiced, paid and credited, and what is still owed. */
export interface FinanceSettledBalance {
  readonly orgId: string; readonly companyName: string; readonly currencyCode: string;
  readonly invoiced: string; readonly paid: string; readonly credited: string; readonly outstanding: string;
}
export interface FinanceSettledPage {
  readonly balances: readonly FinanceSettledBalance[];
  readonly invoices: readonly TransferInvoiceListEntry[];
  readonly page: number;
  readonly more: boolean;
  /**
   * Companies on this page that have been deleted. Their balances and invoices stay (Finance must still see what
   * they owe), but their own invoices page is closed, so the page names them as deleted without a link.
   */
  readonly deletedOrgIds: readonly string[];
}

/** A credit note settles an invoice whatever its payment status, so credited comes first. */
const STATUS_FILTER = `($2::text IS NULL OR ($2 = 'credited' AND c.credit_number IS NOT NULL)
  OR (c.credit_number IS NULL AND i.status = $2))`;
const SNAPSHOT = "BEGIN ISOLATION LEVEL REPEATABLE READ";

export class PostgresFinanceSettledReads {
  readonly #pool: pg.Pool;
  readonly #gate: BankResultFileGate;
  readonly #decision: FinanceTransferDecision;
  constructor(pool: pg.Pool, gate: BankResultFileGate, decision: FinanceTransferDecision) {
    this.#pool = pool; this.#gate = gate; this.#decision = decision;
  }

  /**
   * Every visible company's balance per currency, by company name, and one page of their invoices, newest
   * first, optionally of one status; `more` when an older page exists. Null when the reader is not central finance.
   */
  async settled(principalId: string, filter: { readonly status?: FinanceSettledStatus; readonly page?: number } = {}, size = 100): Promise<FinanceSettledPage | null> {
    const page = filter.page ?? 1;
    if (!principalId?.trim() || !Number.isSafeInteger(page) || page < 1) return null;
    if (filter.status !== undefined && !FINANCE_SETTLED_STATUSES.includes(filter.status)) return null;
    const limit = Math.min(Math.max(1, size), 500);
    return this.#snapshot(async (client) => {
      const companies = await centralFinanceCompanies(client, this.#gate, this.#decision, principalId, "SELECT DISTINCT org_id FROM transfer_invoice");
      if (!companies) return null;
      const balances = (await client.query<FinanceSettledBalance>(`${MOVEMENTS}
        SELECT org_id AS "orgId", min(company) AS "companyName", currency_code AS "currencyCode",
          COALESCE(sum(amount) FILTER (WHERE kind = 'invoice'), 0)::numeric(40,3)::text AS invoiced,
          COALESCE(-sum(amount) FILTER (WHERE kind = 'payment'), 0)::numeric(40,3)::text AS paid,
          COALESCE(-sum(amount) FILTER (WHERE kind = 'credit'), 0)::numeric(40,3)::text AS credited,
          sum(amount)::numeric(40,3)::text AS outstanding
        FROM moves GROUP BY org_id, currency_code ORDER BY "companyName", "orgId", "currencyCode"`, [companies])).rows;
      const rows = (await client.query<TransferInvoiceListEntry>(`SELECT ${ENTRY} ${FROM} AND ${STATUS_FILTER}
        ORDER BY i.invoice_date DESC, i.issued_at DESC, i.invoice_number DESC LIMIT $3 OFFSET $4`,
        [companies, filter.status ?? null, limit + 1, (page - 1) * limit])).rows;
      const more = rows.length > limit;
      rows.length = Math.min(rows.length, limit);
      const shown = [...new Set([...balances.map((b) => b.orgId), ...rows.map((r) => r.orgId)])];
      const deletedOrgIds = shown.length ? (await client.query<{ org_id: string }>(
        "SELECT org_id FROM organization_deletions WHERE org_id = ANY($1::text[]) ORDER BY org_id", [shown])).rows.map((r) => r.org_id) : [];
      return { balances, invoices: rows, page, more, deletedOrgIds };
    });
  }

  async #snapshot<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query(SNAPSHOT);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
}
