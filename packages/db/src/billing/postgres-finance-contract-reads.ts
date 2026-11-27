import pg from "pg";
import { projectPayContract, type ContractTerms, type PayContract, type PayModel } from "@studenthub/pay-contracts";
import type { BankResultFileGate } from "./postgres-bank-result-store.js";
import { centralFinanceCompanies, type FinanceTransferDecision } from "./postgres-finance-transfer-reads.js";
import { NAME } from "./postgres-transfer-invoice-reads.js";

/**
 * StudentHub Finance's contracts (matrix A-17): the pay contracts of every company Finance settles. Read only.
 *
 * Access is the A-18 rule on both the list and one contract: the central finance gate, then the per-company
 * settle decision for each company with contracts; everyone else gets null, and a contract of a company outside
 * the reader's reads exactly like a missing one. Every contract leaves through `projectPayContract(…, "company")`,
 * the same projection the pay contracts API gives a company's finance users: the company's side of the terms,
 * never the candidate's rate or total or the transfer cost. Deleted contracts are not shown, as in that API.
 * Names (person, company, store, currency code) are the ones the Finance transfer pages already show. A store name
 * shows only when the store belongs to the contract's company; otherwise the stored key shows, as for an imported one.
 *
 * Each read runs in one REPEATABLE READ snapshot. Not READ ONLY: the production gate locks grants and
 * organizations FOR SHARE.
 */
export type FinanceContractStatus = "active" | "inactive";
export const FINANCE_CONTRACT_STATUSES: readonly FinanceContractStatus[] = Object.freeze(["active", "inactive"]);
export interface FinanceContractEntry {
  readonly personName: string; readonly companyName: string; readonly storeName: string; readonly currencyCode: string;
  /** The company projection of the contract (`projectPayContract`), and nothing else. */
  readonly contract: Readonly<Record<string, unknown>>;
}
export interface FinanceContractPage { readonly contracts: readonly FinanceContractEntry[]; readonly page: number; readonly more: boolean }

interface Row {
  id: string; candidate_principal_id: string; company_org_id: string; store_id: string; pay_model: PayModel;
  start_date: string; end_date: string | null; currency_id: string; transfer_cost: string; auto_generate: boolean;
  status: "active" | "inactive"; candidate_hourly_rate: string | null; company_hourly_rate: string | null;
  candidate_total: string | null; company_total: string | null; completion_percentage: number | null;
  salary_day: number | null; created_at: Date; updated_at: Date;
  personName: string; companyName: string; storeName: string; currencyCode: string;
}

const CANDIDATES = "SELECT DISTINCT company_org_id FROM pay_contracts WHERE status <> 'deleted'";
const SELECT = `SELECT c.id, c.candidate_principal_id, c.company_org_id, c.store_id, c.pay_model,
    to_char(c.start_date, 'YYYY-MM-DD') AS start_date, to_char(c.end_date, 'YYYY-MM-DD') AS end_date,
    c.currency_id::text AS currency_id, c.transfer_cost::text AS transfer_cost, c.auto_generate, c.status,
    c.candidate_hourly_rate::text AS candidate_hourly_rate, c.company_hourly_rate::text AS company_hourly_rate,
    c.candidate_total::text AS candidate_total, c.company_total::text AS company_total,
    c.completion_percentage, c.salary_day, c.created_at, c.updated_at,
    COALESCE(NULLIF(btrim(pp.display_name), ''), NULLIF(btrim(pr.display_name), ''), c.candidate_principal_id) AS "personName",
    ${NAME("o", "op")} AS "companyName", COALESCE(s.name, c.store_id) AS "storeName",
    COALESCE(NULLIF(btrim(cur.code), ''), cur.name, '') AS "currencyCode"
  FROM pay_contracts c JOIN principals pr ON pr.id = c.candidate_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = c.candidate_principal_id
    JOIN organizations o ON o.id = c.company_org_id LEFT JOIN organization_profiles op ON op.org_id = o.id
    LEFT JOIN organization_stores s ON s.id::text = c.store_id AND s.org_id = c.company_org_id LEFT JOIN catalogue_items cur ON cur.id = c.currency_id
  WHERE c.company_org_id = ANY($1::text[]) AND c.status <> 'deleted'`;
const ORDER = "ORDER BY c.start_date DESC, c.id";
const CONTRACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SNAPSHOT = "BEGIN ISOLATION LEVEL REPEATABLE READ";

function terms(row: Row): ContractTerms {
  const need = <T>(value: T | null): T => { if (value === null) throw new Error(`pay contract ${row.id} is missing a ${row.pay_model} term`); return value; };
  if (row.pay_model === "hourly") return { payModel: "hourly", candidateHourlyRate: need(row.candidate_hourly_rate), companyHourlyRate: need(row.company_hourly_rate) };
  if (row.pay_model === "fixed_price") return { payModel: "fixed_price", candidateTotal: need(row.candidate_total), companyTotal: need(row.company_total), completionPercentage: need(row.completion_percentage) };
  return { payModel: "monthly_salary", candidateTotal: need(row.candidate_total), companyTotal: need(row.company_total), salaryDay: need(row.salary_day) };
}

function entry(row: Row): FinanceContractEntry {
  const contract: PayContract = {
    id: row.id, candidateId: row.candidate_principal_id, companyId: row.company_org_id, storeId: row.store_id,
    startDate: row.start_date, ...(row.end_date === null ? {} : { endDate: row.end_date }), currencyId: row.currency_id,
    transferCost: row.transfer_cost, autoGenerate: row.auto_generate, status: row.status, terms: terms(row),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
  return Object.freeze({ personName: row.personName, companyName: row.companyName, storeName: row.storeName, currencyCode: row.currencyCode,
    contract: projectPayContract(contract, "company") });
}

export class PostgresFinanceContractReads {
  readonly #pool: pg.Pool;
  readonly #gate: BankResultFileGate;
  readonly #decision: FinanceTransferDecision;
  constructor(pool: pg.Pool, gate: BankResultFileGate, decision: FinanceTransferDecision) {
    this.#pool = pool; this.#gate = gate; this.#decision = decision;
  }

  /** One page of contracts, latest start first, optionally of one status; `more` when an older page exists. */
  async list(principalId: string, filter: { readonly status?: FinanceContractStatus; readonly page?: number } = {}, size = 100): Promise<FinanceContractPage | null> {
    const page = filter.page ?? 1;
    if (!principalId?.trim() || !Number.isSafeInteger(page) || page < 1) return null;
    if (filter.status !== undefined && !FINANCE_CONTRACT_STATUSES.includes(filter.status)) return null;
    const limit = Math.min(Math.max(1, size), 500);
    return this.#snapshot(async (client) => {
      const companies = await centralFinanceCompanies(client, this.#gate, this.#decision, principalId, CANDIDATES);
      if (!companies) return null;
      const rows = (await client.query<Row>(`${SELECT} AND ($2::text IS NULL OR c.status = $2) ${ORDER} LIMIT $3 OFFSET $4`,
        [companies, filter.status ?? null, limit + 1, (page - 1) * limit])).rows;
      const more = rows.length > limit;
      rows.length = Math.min(rows.length, limit);
      return { contracts: rows.map(entry), page, more };
    });
  }

  /** One contract; null when missing, deleted, malformed or of a company outside the reader's. */
  async contract(principalId: string, contractId: string): Promise<FinanceContractEntry | null> {
    if (!principalId?.trim() || !CONTRACT_ID.test(contractId)) return null;
    return this.#snapshot(async (client) => {
      const companies = await centralFinanceCompanies(client, this.#gate, this.#decision, principalId, CANDIDATES);
      if (!companies) return null;
      const row = (await client.query<Row>(`${SELECT} AND c.id = $2::uuid`, [companies, contractId])).rows[0];
      return row ? entry(row) : null;
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
