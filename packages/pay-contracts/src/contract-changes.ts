import { createHash } from "node:crypto";
import { createSafeWrite, type ConfirmRequest, type FieldPolicy, type PreviewRequest, type SafeWriteClock, type SafeWriteImplementation, type SafeWriteSecret, type SafeWriteStore } from "@studenthub/safe-write-contract";
import { normalizePayContractUpdate, overlaps, PayContractError, PayContracts, type NormalizedPayContractUpdate } from "./contracts.js";
import { payContractPrincipalRef } from "./contract-writes.js";
import type { FinanceReferenceResolver, PayContract, PayContractStore } from "./types.js";

export const PAY_CONTRACT_TERMS_FIELD = "pay_contract_terms" as const;
export const PAY_CONTRACT_REMOVAL_FIELD = "pay_contract_removal" as const;
export const PAY_CONTRACT_CHANGE_POLICY: FieldPolicy = Object.freeze({ allowed: Object.freeze([PAY_CONTRACT_TERMS_FIELD, PAY_CONTRACT_REMOVAL_FIELD]), maxValueLength: 1024 });
const ref = (domain:string,value:string) => createHash("sha256").update(`studenthub:${domain}:v1\0`).update(value).digest("hex");
export const payContractRecordRef = (id:string):string => ref("pay-contract-record",id);

export function payContractTermsValue(value: NormalizedPayContractUpdate): string {
  const terms = value.terms.payModel === "hourly"
    ? { candidateHourlyRate:value.terms.candidateHourlyRate,companyHourlyRate:value.terms.companyHourlyRate,payModel:value.terms.payModel }
    : value.terms.payModel === "fixed_price"
      ? { candidateTotal:value.terms.candidateTotal,companyTotal:value.terms.companyTotal,completionPercentage:value.terms.completionPercentage,payModel:value.terms.payModel }
      : { candidateTotal:value.terms.candidateTotal,companyTotal:value.terms.companyTotal,payModel:value.terms.payModel,salaryDay:value.terms.salaryDay };
  return JSON.stringify({autoGenerate:value.autoGenerate,currencyId:value.currencyId,...(value.endDate===undefined?{}:{endDate:value.endDate}),startDate:value.startDate,status:value.status,terms,transferCost:value.transferCost});
}
export function payContractEditableValue(contract:PayContract):string { return payContractTermsValue(normalizePayContractUpdate({autoGenerate:contract.autoGenerate,currencyId:contract.currencyId,...(contract.endDate===undefined?{}:{endDate:contract.endDate}),startDate:contract.startDate,status:contract.status,terms:contract.terms,transferCost:contract.transferCost})); }
export function payContractStateDecision(current:string|null,expected:string|null):boolean { return current===expected; }
export type PayContractChangeCheck=(contractId:string,field:string,value:string,before:string|null)=>Promise<boolean>;
export function payContractChangeCheck(input:{references:FinanceReferenceResolver;contracts:Pick<PayContractStore,"get"|"listForCandidate">}):PayContractChangeCheck {
  return async(contractId,field,value,before)=>{
    if(field===PAY_CONTRACT_REMOVAL_FIELD)return value==="removed"&&before!==null;
    if(field!==PAY_CONTRACT_TERMS_FIELD||before===null)return false;
    try {
      const normalized=normalizePayContractUpdate(JSON.parse(value) as unknown);
      if(payContractTermsValue(normalized)!==value)return false;
      const old=normalizePayContractUpdate(JSON.parse(before) as unknown);
      if(normalized.currencyId!==old.currencyId){const currency=await input.references.resolve("currency",normalized.currencyId);if(currency?.status!=="active")return false;}
      const contract=await input.contracts.get(contractId);if(!contract||contract.status==="deleted")return false;
      return !(await input.contracts.listForCandidate(contract.candidateId)).some(c=>c.storeId===contract.storeId&&c.status!=="deleted"&&c.id!==contract.id&&overlaps(c,normalized));
    } catch(error) { if(error instanceof PayContractError&&error.status===400||error instanceof SyntaxError)return false;throw error; }
  };
}
export const acceptAnyPayContractChangeValue:PayContractChangeCheck=async()=>true;
export function buildPayContractChangeWrite(input:{store:SafeWriteStore;secret:SafeWriteSecret;check:PayContractChangeCheck;contractId:string;policy?:FieldPolicy;clock?:SafeWriteClock;tokenLifetimeMs?:number}):SafeWriteImplementation {
  const implementation=createSafeWrite({store:input.store,secret:input.secret,policy:input.policy??PAY_CONTRACT_CHANGE_POLICY,...(input.clock?{clock:input.clock}:{}),...(input.tokenLifetimeMs===undefined?{}:{tokenLifetimeMs:input.tokenLifetimeMs})});
  const checked=async(request:PreviewRequest|ConfirmRequest)=>{if(typeof request.change?.field!=="string"||typeof request.change?.value!=="string")return "invalid";const owned=await input.store.ownedRecord(request.principalRef);if(owned!==request.change.personRef)return "delegate";const before=await input.store.readField(request.change.personRef,request.change.field);return await input.check(input.contractId,request.change.field,request.change.value,before)?"ok":"invalid";};
  return {preview:async r=>(await checked(r))==="invalid"?{ok:false,reason:"invalid_value"}:implementation.preview(r),confirm:async r=>(await checked(r))==="invalid"?{ok:false,reason:"invalid_value"}:implementation.confirm(r)};
}
export function payContractChanger(references:FinanceReferenceResolver){return async(store:PayContractStore,actorId:string,contractId:string,field:string,value:string):Promise<{ok:true}|{ok:false;reason:"state_changed"|"not_own_record"}>=>{try{const service=new PayContracts(store,references);if(field===PAY_CONTRACT_TERMS_FIELD)await service.update(actorId,contractId,JSON.parse(value));else if(field===PAY_CONTRACT_REMOVAL_FIELD)await service.remove(actorId,contractId);else throw new TypeError("unknown pay contract field");return{ok:true};}catch(error){if(error instanceof PayContractError){if(error.code==="not_found")return{ok:false,reason:"not_own_record"};if(error.code==="overlapping_contract"||error.code==="contract_changed"||error.status===400)return{ok:false,reason:"state_changed"};}throw error;}};}

export { payContractPrincipalRef };
