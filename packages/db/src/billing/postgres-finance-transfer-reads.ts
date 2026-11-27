import pg from "pg";
import type { BankResultFileGate } from "./postgres-bank-result-store.js";
import { TRANSFER, TRANSFERS, type CompanyTransferEntry, type CompanyTransferStatus } from "./postgres-transfer-invoice-reads.js";

/**
 * StudentHub Finance's view of the salary transfers of every company it settles (matrix A-18; legacy admin
 * `TransferController::actionList` and `actionView`). Read only.
 *
 * Only a reader who passes the central finance gate (the same one as the bank result pages) sees anything,
 * and then only the transfers of companies the per-company `decision` admits: the same rule that lets them
 * settle a transfer from a bank result file. Everything else, a company's own finance users included, is null,
 * and a transfer they may not see reads exactly like a missing one.
 *
 * Each read runs in one REPEATABLE READ snapshot, so the list's counts and totals and a transfer's lines come
 * from one moment. Not READ ONLY: the production gate locks grants and organizations FOR SHARE.
 */
export type FinanceTransferDecision = (grants: readonly { org_id: string; role: string; scope: string }[], orgId: string, ancestors: readonly string[]) => boolean;
export const FINANCE_TRANSFER_STATUSES: readonly CompanyTransferStatus[] = Object.freeze(["draft", "locked", "payment_sent", "distributing", "complete", "cancelled"]);
export interface FinanceTransferPage { readonly transfers: readonly CompanyTransferEntry[]; readonly page: number; readonly more: boolean }
export interface FinanceTransferLine {
  readonly lineId: string; readonly personId: string; readonly personName: string; readonly storeName: string;
  readonly candidateTotal: string; readonly companyTotal: string; readonly paid: boolean;
}
/** `candidateTotal` is what every line pays its person; `paidTotal` and `paidCount` are only the lines already marked paid. */
export interface FinanceTransferDetail extends CompanyTransferEntry {
  readonly candidateTotal: string; readonly paidTotal: string; readonly paidCount: number; readonly lines: readonly FinanceTransferLine[];
}

const TRANSFER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SNAPSHOT = "BEGIN ISOLATION LEVEL REPEATABLE READ";

export class PostgresFinanceTransferReads {
  readonly #pool: pg.Pool;
  readonly #gate: BankResultFileGate;
  readonly #decision: FinanceTransferDecision;
  constructor(pool: pg.Pool, gate: BankResultFileGate, decision: FinanceTransferDecision) {
    this.#pool = pool; this.#gate = gate; this.#decision = decision;
  }

  /** One page of transfers, newest period first, optionally of one status; `more` when an older page exists. */
  async list(principalId: string, filter: { status?: CompanyTransferStatus; page?: number } = {}, size = 100): Promise<FinanceTransferPage | null> {
    const page = filter.page ?? 1;
    if (!principalId?.trim() || !Number.isSafeInteger(page) || page < 1) return null;
    if (filter.status !== undefined && !FINANCE_TRANSFER_STATUSES.includes(filter.status)) return null;
    const limit = Math.min(Math.max(1, size), 500);
    return this.#snapshot(async (client) => {
      const companies = await this.#companies(client, principalId);
      if (!companies) return null;
      const rows = (await client.query<CompanyTransferEntry>(`SELECT ${TRANSFER} ${TRANSFERS} AND ($2::text IS NULL OR t.status = $2)
        ORDER BY t.period_end DESC, t.period_start DESC, t.id DESC LIMIT $3 OFFSET $4`, [companies, filter.status ?? null, limit + 1, (page - 1) * limit])).rows;
      const more = rows.length > limit; rows.length = Math.min(rows.length, limit);
      return { transfers: rows, page, more };
    });
  }

  /** One transfer with each line's person, store, both amounts and paid flag; null when missing or not the reader's to see. */
  async transfer(principalId: string, transferId: string): Promise<FinanceTransferDetail | null> {
    if (!principalId?.trim() || !TRANSFER_ID.test(transferId)) return null;
    return this.#snapshot(async (client) => {
      const companies = await this.#companies(client, principalId);
      if (!companies) return null;
      const t = (await client.query<CompanyTransferEntry>(`SELECT ${TRANSFER} ${TRANSFERS} AND t.id = $2`, [companies, transferId])).rows[0];
      if (!t) return null;
      const lines = (await client.query<FinanceTransferLine>(
        `SELECT l.id AS "lineId", l.person_id AS "personId",
           COALESCE(NULLIF(btrim(pp.display_name), ''), NULLIF(btrim(pr.display_name), ''), l.person_id) AS "personName",
           s.name AS "storeName", l.candidate_total::text AS "candidateTotal", l.company_total::text AS "companyTotal", l.paid
         FROM pay_transfer_lines l JOIN principals pr ON pr.id = l.person_id LEFT JOIN person_profiles pp ON pp.principal_id = l.person_id
           JOIN organization_stores s ON s.id = l.store_id
         WHERE l.transfer_id = $1 ORDER BY "personName", l.id`, [t.transferId])).rows;
      const totals = (await client.query<{ candidateTotal: string; paidTotal: string; paidCount: number }>(
        `SELECT COALESCE(sum(candidate_total), 0)::numeric(40,3)::text AS "candidateTotal",
           COALESCE(sum(candidate_total) FILTER (WHERE paid), 0)::numeric(40,3)::text AS "paidTotal",
           count(*) FILTER (WHERE paid)::int AS "paidCount"
         FROM pay_transfer_lines WHERE transfer_id = $1`, [t.transferId])).rows[0]!;
      return { ...t, candidateTotal: totals.candidateTotal, paidTotal: totals.paidTotal, paidCount: totals.paidCount, lines };
    });
  }

  /** The companies with transfers that the reader may see, or null when the reader is not central finance. */
  async #companies(client: pg.PoolClient, principalId: string): Promise<string[] | null> {
    if (!await this.#gate(client, principalId)) return null;
    const grants = (await client.query<{ org_id: string; role: string; scope: string }>(
      "SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY org_id, role, scope", [principalId])).rows;
    // Each company with transfers, with its ancestors nearest first; the depth guard keeps a malformed parent loop finite.
    const chains = (await client.query<{ company: string; ancestors: string[] }>(`WITH RECURSIVE chain(company, id, parent_org_id, depth) AS (
        SELECT o.id, o.id, o.parent_org_id, 0 FROM organizations o WHERE o.id IN (SELECT DISTINCT company_id FROM pay_transfers WHERE NOT deleted)
        UNION ALL SELECT c.company, o.id, o.parent_org_id, c.depth + 1 FROM organizations o JOIN chain c ON o.id = c.parent_org_id WHERE c.depth < 64)
      SELECT company, COALESCE(array_agg(id ORDER BY depth) FILTER (WHERE depth > 0), ARRAY[]::text[]) AS ancestors FROM chain GROUP BY company ORDER BY company`)).rows;
    return chains.filter((c) => this.#decision(grants, c.company, c.ancestors)).map((c) => c.company);
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
