import { createHash } from "node:crypto";
import {
  createSafeWrite, type ConfirmRequest, type FieldPolicy, type PreviewRequest, type SafeWriteClock,
  type SafeWriteImplementation, type SafeWriteSecret, type SafeWriteStore,
} from "@studenthub/safe-write-contract";
import { normalizePayContractCreate, overlaps, PayContractError, PayContracts, type NormalizedPayContractCreate } from "./contracts.js";
import type { FinanceReferenceResolver, PayContractStore } from "./types.js";

export const PAY_CONTRACT_CREATE_FIELD = "pay_contract" as const;
export const PAY_CONTRACT_CREATE_POLICY: FieldPolicy = Object.freeze({ allowed: Object.freeze([PAY_CONTRACT_CREATE_FIELD]), maxValueLength: 1024 });

export function payContractCreateValue(value: NormalizedPayContractCreate): string {
  const terms = value.terms.payModel === "hourly"
    ? { candidateHourlyRate: value.terms.candidateHourlyRate, companyHourlyRate: value.terms.companyHourlyRate, payModel: value.terms.payModel }
    : value.terms.payModel === "fixed_price"
      ? { candidateTotal: value.terms.candidateTotal, companyTotal: value.terms.companyTotal, completionPercentage: value.terms.completionPercentage, payModel: value.terms.payModel }
      : { candidateTotal: value.terms.candidateTotal, companyTotal: value.terms.companyTotal, payModel: value.terms.payModel, salaryDay: value.terms.salaryDay };
  return JSON.stringify({
    autoGenerate: value.autoGenerate, candidateId: value.candidateId, companyId: value.companyId, currencyId: value.currencyId,
    ...(value.endDate === undefined ? {} : { endDate: value.endDate }), startDate: value.startDate, status: value.status,
    storeId: value.storeId, terms, transferCost: value.transferCost,
  });
}

function parse(value: string): NormalizedPayContractCreate {
  return normalizePayContractCreate(JSON.parse(value) as unknown);
}
function ref(domain: string, value: string): string { return createHash("sha256").update(`studenthub:${domain}:v1\0`).update(value).digest("hex"); }
export const payContractCompanyRecordRef = (id: string): string => ref("pay-contract-company-record", id);
export const payContractPrincipalRef = (id: string): string => ref("pay-contract-principal", id);

export interface PayContractGrantRow { readonly org_id: string; readonly role: string; readonly scope: string }
export function payContractWriteDecision(rows: readonly PayContractGrantRow[], companyId: string, ancestors: readonly string[], operators: readonly string[]): boolean {
  return !operators.includes(companyId) && rows.some((row) => (row.role === "staff" || row.role === "admin")
    && (row.org_id === companyId || (row.scope === "subtree" && ancestors.includes(row.org_id))));
}

export type PayContractCreateCheck = (companyId: string, value: string) => Promise<boolean>;
export function payContractCreateCheck(input: {
  references: FinanceReferenceResolver; contracts: Pick<PayContractStore, "listForCandidate">; candidates: { isCandidate(id: string): Promise<boolean> };
}): PayContractCreateCheck {
  return async (companyId, value) => {
    let normalized: NormalizedPayContractCreate;
    try { normalized = parse(value); }
    catch (error) {
      if (error instanceof PayContractError && error.status === 400 || error instanceof SyntaxError) return false;
      throw error;
    }
    if (payContractCreateValue(normalized) !== value || normalized.companyId !== companyId) return false;
    const currency = await input.references.resolve("currency", normalized.currencyId);
    if (currency?.status !== "active" || !await input.candidates.isCandidate(normalized.candidateId)) return false;
    const contracts = await input.contracts.listForCandidate(normalized.candidateId);
    return !contracts.some((contract) => contract.storeId === normalized.storeId && contract.status !== "deleted" && overlaps(contract, normalized));
  };
}
export const acceptAnyPayContractCreateValue: PayContractCreateCheck = async () => true;

export function buildPayContractCreateWrite(input: { store: SafeWriteStore; secret: SafeWriteSecret; check: PayContractCreateCheck; companyId: string; policy?: FieldPolicy; clock?: SafeWriteClock; tokenLifetimeMs?: number }): SafeWriteImplementation {
  const implementation = createSafeWrite({ store: input.store, secret: input.secret, policy: input.policy ?? PAY_CONTRACT_CREATE_POLICY,
    ...(input.clock ? { clock: input.clock } : {}), ...(input.tokenLifetimeMs === undefined ? {} : { tokenLifetimeMs: input.tokenLifetimeMs }) });
  const checked = async (request: PreviewRequest | ConfirmRequest) => {
    if (typeof request.change?.value !== "string") return "invalid" as const;
    const owned = await input.store.ownedRecord(request.principalRef);
    // Let the contract preserve its own validation/refusal ordering when the
    // record is not owned. It will still return not_own_record for a valid
    // request, without invoking the domain check and leaking domain facts.
    if (owned !== request.change.personRef) return "delegate" as const;
    return await input.check(input.companyId, request.change.value) ? "ok" as const : "invalid" as const;
  };
  return {
    preview: async (request) => { const verdict=await checked(request);return verdict==="invalid"?{ok:false,reason:"invalid_value"}:implementation.preview(request); },
    confirm: async (request) => { const verdict=await checked(request);return verdict==="invalid"?{ok:false,reason:"invalid_value"}:implementation.confirm(request); },
  };
}

export function payContractCreator(references: FinanceReferenceResolver) {
  return async (store: PayContractStore, actorId: string, companyId: string, value: string): Promise<{ok:true}|{ok:false;reason:"state_changed"}> => {
    const parsed = parse(value);
    if (parsed.companyId !== companyId) throw new TypeError("pay contract company mismatch");
    try { await new PayContracts(store, references).create(actorId, parsed); return { ok: true }; }
    catch (error) {
      if (error instanceof PayContractError && (error.code === "overlapping_contract" || error.status === 400)) return { ok: false, reason: "state_changed" };
      throw error;
    }
  };
}
