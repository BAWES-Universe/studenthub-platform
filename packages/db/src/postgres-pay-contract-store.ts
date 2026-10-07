import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";
import type {
  ContractTerms, FinanceReferenceResolver, FinanceReferenceType, PayContract, PayContractAudit,
  PayContractStore, PayContractTransaction, PayModel,
} from "@studenthub/pay-contracts";
import { organizationAuditRef, principalAuditRef, requestAuditRef } from "./authorization-audit.js";

interface ContractRow {
  id: string; candidate_principal_id: string; company_org_id: string; store_id: string; pay_model: PayModel;
  start_date: string; end_date: string | null; currency_id: string; transfer_cost: string; auto_generate: boolean;
  status: PayContract["status"]; candidate_hourly_rate: string | null; company_hourly_rate: string | null;
  candidate_total: string | null; company_total: string | null; completion_percentage: number | null;
  salary_day: number | null; created_at: Date; updated_at: Date; deleted_at: Date | null;
}

// Dates leave Postgres as text so no time zone can shift a calendar day; numerics arrive as exact strings.
const COLUMNS = `id, candidate_principal_id, company_org_id, store_id, pay_model,
  to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
  currency_id, transfer_cost::text AS transfer_cost, auto_generate, status,
  candidate_hourly_rate::text AS candidate_hourly_rate, company_hourly_rate::text AS company_hourly_rate,
  candidate_total::text AS candidate_total, company_total::text AS company_total,
  completion_percentage, salary_day, created_at, updated_at, deleted_at`;

function termsFromRow(row: ContractRow): ContractTerms {
  const need = <T>(value: T | null): T => {
    if (value === null) throw new Error(`pay contract ${row.id} is missing a ${row.pay_model} term`);
    return value;
  };
  switch (row.pay_model) {
    case "hourly":
      return Object.freeze({ payModel: "hourly", candidateHourlyRate: need(row.candidate_hourly_rate), companyHourlyRate: need(row.company_hourly_rate) });
    case "fixed_price":
      return Object.freeze({
        payModel: "fixed_price", candidateTotal: need(row.candidate_total), companyTotal: need(row.company_total),
        completionPercentage: need(row.completion_percentage),
      });
    case "monthly_salary":
      return Object.freeze({
        payModel: "monthly_salary", candidateTotal: need(row.candidate_total), companyTotal: need(row.company_total),
        salaryDay: need(row.salary_day),
      });
  }
}

function fromRow(row: ContractRow): PayContract {
  return Object.freeze({
    id: row.id, candidateId: row.candidate_principal_id, companyId: row.company_org_id, storeId: row.store_id,
    startDate: row.start_date, ...(row.end_date !== null ? { endDate: row.end_date } : {}),
    currencyId: row.currency_id, transferCost: row.transfer_cost, autoGenerate: row.auto_generate, status: row.status,
    terms: termsFromRow(row), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    ...(row.deleted_at ? { deletedAt: row.deleted_at.toISOString() } : {}),
  });
}

function termValues(terms: ContractTerms): readonly [string | null, string | null, string | null, string | null, number | null, number | null] {
  switch (terms.payModel) {
    case "hourly": return [terms.candidateHourlyRate, terms.companyHourlyRate, null, null, null, null];
    case "fixed_price": return [null, null, terms.candidateTotal, terms.companyTotal, terms.completionPercentage, null];
    case "monthly_salary": return [null, null, terms.candidateTotal, terms.companyTotal, null, terms.salaryDay];
  }
}

function values(contract: PayContract): unknown[] {
  return [
    contract.id, contract.candidateId, contract.companyId, contract.storeId, contract.terms.payModel,
    contract.startDate, contract.endDate ?? null, contract.currencyId, contract.transferCost, contract.autoGenerate,
    contract.status, ...termValues(contract.terms), contract.createdAt, contract.updatedAt, contract.deletedAt ?? null,
  ];
}

const INSERT_COLUMNS = `id, candidate_principal_id, company_org_id, store_id, pay_model, start_date, end_date,
  currency_id, transfer_cost, auto_generate, status, candidate_hourly_rate, company_hourly_rate,
  candidate_total, company_total, completion_percentage, salary_day, created_at, updated_at, deleted_at`;

/** SHU-182 store. Writers on one candidate-and-store pair are serialized; audit rows share the mutation's transaction. */
export class PostgresPayContractStore implements PayContractStore {
  readonly #pool: PgPool;
  readonly #ownsPool: boolean;

  constructor(poolOrConfig: PgPool | PoolConfig) {
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#ownsPool = !(poolOrConfig instanceof pg.Pool);
  }

  async close(): Promise<void> { if (this.#ownsPool) await this.#pool.end(); }

  async get(id: string): Promise<PayContract | undefined> {
    const { rows } = await this.#pool.query<ContractRow>(`SELECT ${COLUMNS} FROM pay_contracts WHERE id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async listForCandidate(candidateId: string): Promise<readonly PayContract[]> {
    const { rows } = await this.#pool.query<ContractRow>(
      `SELECT ${COLUMNS} FROM pay_contracts WHERE candidate_principal_id = $1 ORDER BY pay_contracts.start_date DESC, id`,
      [candidateId],
    );
    return rows.map(fromRow);
  }

  async transaction<T>(work: (tx: PayContractTransaction) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(transactionFor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function transactionFor(client: PoolClient): PayContractTransaction {
  return {
    async lockPair(candidateId: string, storeId: string) {
      // Concurrent creates for one pair queue here, so the overlap check always sees the other's row.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pay-contracts:${candidateId}:${storeId}`]);
      const { rows } = await client.query<ContractRow>(
        `SELECT ${COLUMNS} FROM pay_contracts WHERE candidate_principal_id = $1 AND store_id = $2 ORDER BY pay_contracts.start_date DESC, id`,
        [candidateId, storeId],
      );
      return rows.map(fromRow);
    },
    async find(id: string) {
      const { rows } = await client.query<ContractRow>(`SELECT ${COLUMNS} FROM pay_contracts WHERE id = $1 FOR UPDATE`, [id]);
      return rows[0] ? fromRow(rows[0]) : undefined;
    },
    async insert(contract: PayContract) {
      await client.query(
        `INSERT INTO pay_contracts (${INSERT_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        values(contract),
      );
    },
    async replace(contract: PayContract) {
      // Parties and store are fixed at creation; the WHERE clause refuses any attempt to move them.
      const result = await client.query(
        `UPDATE pay_contracts SET pay_model = $5, start_date = $6, end_date = $7, currency_id = $8, transfer_cost = $9, auto_generate = $10,
           status = $11, candidate_hourly_rate = $12, company_hourly_rate = $13, candidate_total = $14, company_total = $15,
           completion_percentage = $16, salary_day = $17, updated_at = $18, deleted_at = $19
         WHERE id = $1 AND candidate_principal_id = $2 AND company_org_id = $3 AND store_id = $4`,
        [
          contract.id, contract.candidateId, contract.companyId, contract.storeId, contract.terms.payModel,
          contract.startDate, contract.endDate ?? null, contract.currencyId, contract.transferCost, contract.autoGenerate,
          contract.status, ...termValues(contract.terms), contract.updatedAt, contract.deletedAt ?? null,
        ],
      );
      if (result.rowCount !== 1) throw new Error("pay contract not updated");
    },
    async audit(entry: PayContractAudit) {
      await client.query(
        `INSERT INTO authorization_mutation_audit
           (request_ref, actor_principal_ref, operation, target_principal_ref, target_org_refs, before_summary, after_summary)
         VALUES ($1, $2, $3, $4, ARRAY[$5]::text[], $6::jsonb, $7::jsonb)`,
        [
          requestAuditRef(`pay_contract_${randomUUID()}`), principalAuditRef(entry.actorId), entry.operation,
          principalAuditRef(entry.candidateId), organizationAuditRef(entry.companyId),
          JSON.stringify({ payModel: entry.payModel, contractCount: entry.countBefore }),
          JSON.stringify({ payModel: entry.payModel, contractCount: entry.countAfter }),
        ],
      );
    },
  };
}

/** Reads currency and bank rows of the SHU-166 catalogue; deleted rows still resolve, with their status. */
export class PostgresFinanceReferenceResolver implements FinanceReferenceResolver {
  readonly #pool: PgPool;
  readonly #ownsPool: boolean;

  constructor(poolOrConfig: PgPool | PoolConfig) {
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#ownsPool = !(poolOrConfig instanceof pg.Pool);
  }

  async close(): Promise<void> { if (this.#ownsPool) await this.#pool.end(); }

  async resolve(type: FinanceReferenceType, id: string): Promise<{ readonly status: "active" | "deleted" } | undefined> {
    const { rows } = await this.#pool.query<{ status: "active" | "deleted" }>(
      "SELECT status FROM catalogue_items WHERE catalogue_type = $1 AND id = $2::uuid",
      [type, id],
    );
    return rows[0] ? { status: rows[0].status } : undefined;
  }
}
