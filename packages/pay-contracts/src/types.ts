export const PAY_MODELS = ["hourly", "fixed_price", "monthly_salary"] as const;
export type PayModel = typeof PAY_MODELS[number];

/** Exact decimal string with at most three places, as legacy `decimal(12,3)`; never a float. */
export type DecimalString = string;
/** Calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

export interface HourlyTerms {
  readonly payModel: "hourly";
  readonly candidateHourlyRate: DecimalString;
  readonly companyHourlyRate: DecimalString;
}

export interface FixedPriceTerms {
  readonly payModel: "fixed_price";
  readonly candidateTotal: DecimalString;
  readonly companyTotal: DecimalString;
  /** Whole percent, 0–100 (legacy `completion_percentage tinyint(3)`). */
  readonly completionPercentage: number;
}

export interface MonthlySalaryTerms {
  readonly payModel: "monthly_salary";
  readonly candidateTotal: DecimalString;
  readonly companyTotal: DecimalString;
  /** Day of the month salary falls due, 1–31 (legacy `salary_day`). */
  readonly salaryDay: number;
}

export type ContractTerms = HourlyTerms | FixedPriceTerms | MonthlySalaryTerms;

export type ContractStatus = "active" | "inactive" | "deleted";

/**
 * One contract aggregate (legacy `contract` plus its per-model detail table).
 * The candidate, company and store a contract binds never change after creation.
 */
export interface PayContract {
  readonly id: string;
  readonly candidateId: string;
  readonly companyId: string;
  readonly storeId: string;
  readonly startDate: IsoDate;
  /** Absent for an open-ended contract. */
  readonly endDate?: IsoDate;
  /** SHU-166 catalogue currency id. */
  readonly currencyId: string;
  readonly transferCost: DecimalString;
  /** Monthly salary only: the weekly job may generate its payout (FI-04). */
  readonly autoGenerate: boolean;
  readonly status: ContractStatus;
  readonly terms: ContractTerms;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export const PAY_CONTRACT_AUDIT_OPERATIONS = [
  "pay_contract.create",
  "pay_contract.update",
  "pay_contract.remove",
] as const;
export type PayContractAuditOperation = typeof PAY_CONTRACT_AUDIT_OPERATIONS[number];

/**
 * Closed audit shape: the pay model and how many non-deleted contracts the
 * candidate holds at that store before and after. Never a rate or an amount.
 */
export interface PayContractAudit {
  readonly operation: PayContractAuditOperation;
  readonly actorId: string;
  readonly candidateId: string;
  readonly companyId: string;
  readonly payModel: PayModel;
  readonly countBefore: number;
  readonly countAfter: number;
}

export interface PayContractTransaction {
  /** Serializes writers on one candidate-and-store pair, then lists its contracts, deleted included. */
  lockPair(candidateId: string, storeId: string): Promise<readonly PayContract[]>;
  find(id: string): Promise<PayContract | undefined>;
  insert(contract: PayContract): Promise<void>;
  replace(contract: PayContract): Promise<void>;
  audit(entry: PayContractAudit): Promise<void>;
}

export interface PayContractStore {
  get(id: string): Promise<PayContract | undefined>;
  listForCandidate(candidateId: string): Promise<readonly PayContract[]>;
  /** Mutation and audit commit or fail together. */
  transaction<T>(work: (tx: PayContractTransaction) => Promise<T>): Promise<T>;
}

export type FinanceReferenceType = "currency" | "bank";

/** Read port onto the SHU-166 reference catalogue. */
export interface FinanceReferenceResolver {
  resolve(type: FinanceReferenceType, id: string): Promise<{ readonly status: "active" | "deleted" } | undefined>;
}
