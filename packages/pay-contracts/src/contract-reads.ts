import type { ContractTerms, PayContract } from "./types.js";
import type { PayContractGrantRow } from "./contract-writes.js";

export type PayContractView = "full" | "company" | "candidate";

function covers(row: PayContractGrantRow, companyId: string, ancestors: readonly string[]): boolean {
  return row.org_id === companyId || (row.scope === "subtree" && ancestors.includes(row.org_id));
}

export function payContractReadAccess(rows: readonly PayContractGrantRow[], companyId: string, ancestors: readonly string[], operators: readonly string[]): "full" | "company" | null {
  if (operators.includes(companyId)) return null;
  if (rows.some((row) => (row.role === "staff" || row.role === "admin") && covers(row, companyId, ancestors))) return "full";
  if (rows.some((row) => (row.role === "org-owner" || row.role === "finance") && covers(row, companyId, ancestors))) return "company";
  return null;
}

type ProjectedPayContract = Readonly<Record<string, unknown>>;

function termsFor(terms: ContractTerms, view: PayContractView): Readonly<Record<string, unknown>> {
  if (terms.payModel === "hourly") return Object.freeze(view === "full"
    ? { payModel: "hourly", candidateHourlyRate: terms.candidateHourlyRate, companyHourlyRate: terms.companyHourlyRate }
    : view === "company" ? { payModel: "hourly", companyHourlyRate: terms.companyHourlyRate }
      : { payModel: "hourly", candidateHourlyRate: terms.candidateHourlyRate });
  if (terms.payModel === "fixed_price") return Object.freeze(view === "full"
    ? { payModel: "fixed_price", candidateTotal: terms.candidateTotal, companyTotal: terms.companyTotal, completionPercentage: terms.completionPercentage }
    : view === "company" ? { payModel: "fixed_price", companyTotal: terms.companyTotal, completionPercentage: terms.completionPercentage }
      : { payModel: "fixed_price", candidateTotal: terms.candidateTotal, completionPercentage: terms.completionPercentage });
  return Object.freeze(view === "full"
    ? { payModel: "monthly_salary", candidateTotal: terms.candidateTotal, companyTotal: terms.companyTotal, salaryDay: terms.salaryDay }
    : view === "company" ? { payModel: "monthly_salary", companyTotal: terms.companyTotal, salaryDay: terms.salaryDay }
      : { payModel: "monthly_salary", candidateTotal: terms.candidateTotal, salaryDay: terms.salaryDay });
}
const companyTerms = (terms: ContractTerms) => termsFor(terms, "company");
const candidateTerms = (terms: ContractTerms) => termsFor(terms, "candidate");

export function projectPayContract(contract: PayContract, view: PayContractView): ProjectedPayContract {
  if (view === "full") return Object.freeze({
    id: contract.id, candidateId: contract.candidateId, companyId: contract.companyId, storeId: contract.storeId,
    startDate: contract.startDate, ...(contract.endDate === undefined ? {} : { endDate: contract.endDate }),
    currencyId: contract.currencyId, transferCost: contract.transferCost, autoGenerate: contract.autoGenerate,
    status: contract.status, terms: termsFor(contract.terms, "full"), createdAt: contract.createdAt, updatedAt: contract.updatedAt,
  });
  if (view === "company") return Object.freeze({
    id: contract.id, candidateId: contract.candidateId, companyId: contract.companyId, storeId: contract.storeId,
    startDate: contract.startDate, ...(contract.endDate === undefined ? {} : { endDate: contract.endDate }),
    currencyId: contract.currencyId, autoGenerate: contract.autoGenerate, status: contract.status,
    terms: companyTerms(contract.terms), createdAt: contract.createdAt, updatedAt: contract.updatedAt,
  });
  return Object.freeze({
    id: contract.id, candidateId: contract.candidateId, companyId: contract.companyId, storeId: contract.storeId,
    startDate: contract.startDate, ...(contract.endDate === undefined ? {} : { endDate: contract.endDate }),
    currencyId: contract.currencyId, autoGenerate: contract.autoGenerate, status: contract.status,
    terms: candidateTerms(contract.terms), createdAt: contract.createdAt, updatedAt: contract.updatedAt,
  });
}

export function payContractListView(contracts: readonly PayContract[], view: PayContractView): readonly ProjectedPayContract[] {
  return Object.freeze(contracts.filter((contract) => contract.status !== "deleted")
    .sort((a, b) => b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id))
    .map((contract) => projectPayContract(contract, view)));
}
