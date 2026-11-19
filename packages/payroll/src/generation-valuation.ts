/** F2 -> actual F1 calculator, preview only. No persistence or approval authority. */
import { createHash } from "node:crypto";
import { calculatePayLine, payLineTotals, type PayLineDraft } from "./pay-lines.js";
import type { RateResolution } from "../../pay-contracts/src/resolution.js";
import { payableFingerprint, type GenerationCandidate, type GenerationPlan } from "./generation.js";
export interface CandidateRateSnapshot {
  readonly personId: string; readonly contractId: string; readonly orgId: string;
  readonly storeId: string; readonly currencyCode: string; readonly revision: string;
  readonly rate: RateResolution;
  readonly bonus: string; readonly bonusCommissionPercent: string; readonly transferCost: string;
}
/** F1 resolves authoritative contract/rates and selected company (parent for weekly).
 * This port cannot confirm Work months or authorize persistence.
 */
export interface GenerationValuationPort { resolve(candidate: GenerationCandidate): Promise<CandidateRateSnapshot> }
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function lineId(key: string): string {
  const h=hash(["f2-draft-line-v1",key]);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export interface ValuedGenerationBatch {
  readonly kind: "preview-only";
  /** Stable identity of candidate set; revision changes with valuation/provenance. */
  readonly key: string; readonly revision: string;
  readonly lines: readonly PayLineDraft[];
  readonly totals: ReturnType<typeof payLineTotals>;
  readonly blocked: GenerationPlan["blocked"];
  readonly adjustmentReviews: GenerationPlan["adjustmentReviews"];
}
export async function valueGenerationPlan(plan: GenerationPlan, port: GenerationValuationPort): Promise<ValuedGenerationBatch> {
  const lines:PayLineDraft[]=[], blocked=[...plan.blocked];const seen=new Set<string>();
  const candidates=[...plan.candidates].sort((a,b)=>a.key.localeCompare(b.key));
  for(const c of candidates){
    if(seen.has(c.key))throw new Error("duplicate candidate key");seen.add(c.key);
    // This first boundary covers confirmed, contracted hourly work and salary/4.
    if(c.contractId===null){blocked.push({key:c.key,reason:"explicit_manual_valuation_required"});continue;}
    if(c.kind==="hourly"&&(c.confirmationReferences.length!==c.inputs.length||c.confirmationReferences.some(r=>!r))){blocked.push({key:c.key,reason:"confirmation_provenance_required"});continue;}
    if(c.kind==="hourly"&&new Set(c.inputs.map(i=>i.storeId)).size!==1){blocked.push({key:c.key,reason:"multi_store_valuation_required"});continue;}
    const snapshot=await port.resolve(c);
    if(snapshot.personId!==c.personId||snapshot.contractId!==c.contractId||snapshot.orgId!==c.orgId||!snapshot.revision||!snapshot.storeId
      ||snapshot.rate.source!=="contract"||snapshot.rate.contractId!==c.contractId)throw new Error("rate snapshot scope mismatch");
    if(c.kind==="hourly"&&(snapshot.rate.payModel!=="hourly"||c.inputs.some(i=>i.storeId!==snapshot.storeId)))throw new Error("hourly snapshot mismatch");
    if(c.kind==="monthly-weekly"&&(snapshot.rate.payModel!=="monthly_salary"||snapshot.revision!==c.rateRevision||snapshot.currencyCode!==c.currency))throw new Error("monthly snapshot mismatch");
    const seconds=c.kind==="hourly"?c.inputs.reduce((n,i)=>n+i.approvedSeconds,0):0;
    if(!Number.isSafeInteger(seconds)||seconds<0)throw new Error("invalid approved seconds");
    const calculationInput={rate:snapshot.rate,hours:String(Math.floor(seconds/3600)),minutes:Math.floor(seconds%3600/60),seconds:seconds%60,
      bonus:snapshot.bonus,bonusCommissionPercent:snapshot.bonusCommissionPercent,transferCost:snapshot.transferCost,payouts:c.kind==="monthly-weekly"?c.payoutDivisor:1};
    const result=calculatePayLine(calculationInput);
    if(result.kind==="empty"){blocked.push({key:c.key,reason:"legacy_calculator_empty"});continue;}
    const provenance=c.kind==="hourly"?{inputFingerprints:c.inputs.map(payableFingerprint),confirmationReferences:c.confirmationReferences,
      roots:c.inputs.flatMap(i=>i.sessions.map(s=>s.lineageRootId)).sort()}: {rateRevision:c.rateRevision,payoutDivisor:c.payoutDivisor};
    lines.push({id:lineId(c.key),personId:c.personId,storeId:snapshot.storeId,currencyCode:snapshot.currencyCode,
      candidateTotal:result.candidateTotal,companyTotal:result.companyTotal,note:"F2 generated preview",
      calculation:{version:"studenthub.payroll.f2-preview.v1",candidateKey:c.key,orgId:c.orgId,contractId:c.contractId,period:c.period,
        rateRevision:snapshot.revision,provenance,input:calculationInput,result}});
  }
  const totals=payLineTotals(lines);
  return {kind:"preview-only",key:hash(["f2-batch-v1",candidates.map(c=>c.key)]),revision:hash([lines,blocked,plan.adjustmentReviews]),lines,totals,blocked,adjustmentReviews:plan.adjustmentReviews};
}
