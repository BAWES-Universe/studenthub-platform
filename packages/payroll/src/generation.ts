/** F2 read-only candidate planning. This module cannot create/finalize transfers.
 * F1 owns valuation/legacy rounding; F3 owns atomic reservation and persistence.
 */
import { createHash } from "node:crypto";
import type { PayableInput, PayableLineage, PayableWorkSource } from "../../work/src/payable.js";

export interface Period { readonly start: string; readonly end: string }
export interface LineClaim { readonly personId: string; readonly contractId: string | null; readonly period: Period }
export interface FinalizedRoot {
  readonly rootId: string;
  readonly personId: string;
  /** Reference to immutable original result plus all finalized adjustments. */
  readonly recognizedRevision: string;
}
export interface HourlyCandidate extends LineClaim {
  readonly kind: "hourly"; readonly key: string; readonly orgId: string;
  readonly inputs: readonly PayableInput[];
  readonly confirmationReferences: readonly string[];
}
export interface MonthlyContract {
  readonly id: string; readonly personId: string; readonly orgId: string;
  readonly parentOrgId: string | null; readonly currency: string;
  readonly active: boolean; readonly personActive: boolean; readonly autoGenerate: boolean;
  readonly startDate: string | null; readonly endDate: string | null;
  /** Immutable rate snapshot supplied by F1, not an amount invented by F2. */
  readonly rateRevision: string;
}
export interface MonthlyCandidate extends LineClaim {
  readonly kind: "monthly-weekly"; readonly key: string; readonly orgId: string;
  readonly currency: "KWD"; readonly payoutDivisor: 4; readonly rateRevision: string;
}
export type GenerationCandidate = HourlyCandidate | MonthlyCandidate;
export interface ConfirmationPort {
  /** Must attest ALL assignment-months in these exact inputs, including changedAt,
   * decisions, sessions and lineage. Invalidation must return blocked. No default approval.
   */
  confirm(input: PayableInput): Promise<{ readonly state: "confirmed"; readonly inputFingerprint: string; readonly reference: string } | { readonly state: "blocked" }>;
}
export interface GenerationPlan {
  readonly candidates: readonly GenerationCandidate[];
  readonly blocked: readonly { readonly key: string; readonly reason: string }[];
  /** Finance must value net delta against cumulative recognized value, including prior
   * finalized adjustments. Unknown roots are blocked, never interpreted as zero money.
   */
  readonly adjustmentReviews: readonly { readonly finalized: FinalizedRoot; readonly current: PayableLineage }[];
}
const date = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
function validatePeriod(p: Period): void {
  if (!date(p.start) || !date(p.end) || p.start > p.end) throw new RangeError("invalid period");
}
function claimKey(c: LineClaim): string { return JSON.stringify([c.personId,c.contractId,c.period.start,c.period.end]); }
const digest = (x: unknown): string => createHash("sha256").update(JSON.stringify(x)).digest("hex");
export function payableFingerprint(i: PayableInput): string {
  return digest([i.version,i.assignmentId,i.personId,i.orgId,i.storeId,i.payContractId,
    i.period.start,i.period.end,i.approvedSeconds,i.pendingSeconds,i.rejectedSeconds,i.openSessions,
    [...i.sessions].sort((a,b)=>a.sessionId.localeCompare(b.sessionId)).map(s=>[s.sessionId,s.workDate,s.durationSeconds,s.source,s.correctsSessionId,s.lineageRootId,s.decisionId,s.changedAt])]);
}
export function weeklyPeriod(today: string): Period {
  if (!date(today)) throw new RangeError("invalid Kuwait business date");
  return { start: new Date(Date.parse(today)-6*86400000).toISOString().slice(0,10), end: today };
}
function validateInput(i: PayableInput, period: Period): void {
  if (i.version !== "studenthub.work.payable-input.v1" || i.period.start !== period.start || i.period.end !== period.end) throw new Error("payable input scope mismatch");
  if ([i.approvedSeconds,i.pendingSeconds,i.rejectedSeconds,i.openSessions].some(n=>!Number.isSafeInteger(n)||n<0)) throw new Error("invalid payable counts");
  let total=0;
  for(const s of i.sessions){
    if(!s.sessionId || !s.lineageRootId || !Number.isSafeInteger(s.durationSeconds)||s.durationSeconds<0 || !date(s.workDate)||s.workDate<period.start||s.workDate>period.end || !Number.isFinite(Date.parse(s.changedAt))) throw new Error("invalid payable session");
    total+=s.durationSeconds;
  }
  if(!Number.isSafeInteger(total)||total!==i.approvedSeconds) throw new Error("payable sum mismatch");
}
export async function planGeneration(options: {
  readonly period: Period; readonly work: PayableWorkSource;
  readonly confirmations?: ConfirmationPort;
  /** Complete claims from ALL statuses and origins, including manual lines. */
  readonly claims: readonly LineClaim[];
  /** Complete historical paid roots, not restricted to the requested period. */
  readonly finalizedRoots: readonly FinalizedRoot[];
  readonly monthlyContracts?: readonly MonthlyContract[];
  readonly weeklyBusinessDate?: string;
}): Promise<GenerationPlan> {
  validatePeriod(options.period);
  const claims=new Set(options.claims.map(claimKey));
  const finalized=new Map<string,FinalizedRoot>();
  for(const row of options.finalizedRoots){if(finalized.has(row.rootId)||!row.rootId||!row.recognizedRevision)throw new Error("invalid finalized root ledger");finalized.set(row.rootId,row);}
  const inputs=await options.work.payableInputs({period:options.period});
  const roots=new Set<string>(), assignments=new Set<string>();
  for(const i of inputs){validateInput(i,options.period);if(assignments.has(i.assignmentId))throw new Error("duplicate payable assignment");assignments.add(i.assignmentId);for(const s of i.sessions){if(roots.has(s.lineageRootId))throw new Error("duplicate payable lineage");roots.add(s.lineageRootId);if(finalized.has(s.lineageRootId)&&finalized.get(s.lineageRootId)!.personId!==i.personId)throw new Error("finalized lineage owner mismatch");}}
  const candidates:GenerationCandidate[]=[],blocked: {key:string;reason:string}[]=[],adjustmentReviews: {finalized:FinalizedRoot;current:PayableLineage}[]=[];
  const resolved=await options.work.lineage([...finalized.keys()].sort());
  const resolvedRoots=new Set<string>();
  for(const current of resolved){
    const paid=finalized.get(current.rootId);if(!paid||resolvedRoots.has(current.rootId))throw new Error("invalid lineage response");resolvedRoots.add(current.rootId);
    adjustmentReviews.push({finalized:paid,current});
  }
  for(const root of finalized.keys())if(!resolvedRoots.has(root))blocked.push({key:root,reason:"finalized_lineage_unresolved"});
  const groups=new Map<string,PayableInput[]>();
  for(const i of inputs){if(!i.sessions.length)continue;const k=claimKey({personId:i.personId,contractId:i.payContractId,period:options.period});groups.set(k,[...(groups.get(k)??[]),i]);}
  for(const [k,group] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
    if(claims.has(k)){blocked.push({key:k,reason:"existing_line_including_manual"});continue;}
    if(group.some(i=>i.sessions.some(s=>finalized.has(s.lineageRootId)))){blocked.push({key:k,reason:"finalized_lineage_requires_adjustment"});continue;}
    if(new Set(group.map(i=>i.orgId)).size!==1){blocked.push({key:k,reason:"ambiguous_company"});continue;}
    if(!options.confirmations){blocked.push({key:k,reason:"month_confirmation_port_required"});continue;}
    const refs:string[]=[];let confirmed=true;
    for(const i of [...group].sort((a,b)=>a.assignmentId.localeCompare(b.assignmentId))){const c=await options.confirmations.confirm(i);if(c.state!=="confirmed"||c.inputFingerprint!==payableFingerprint(i)||!c.reference){confirmed=false;break;}refs.push(c.reference);}
    if(!confirmed){blocked.push({key:k,reason:"month_unconfirmed_or_changed"});continue;}
    const first=group[0]!;
    const sorted=[...group].sort((a,b)=>a.assignmentId.localeCompare(b.assignmentId));
    candidates.push({kind:"hourly",key:digest(["f2-hourly-v1",k]),personId:first.personId,contractId:first.payContractId,orgId:first.orgId,period:{...options.period},inputs:sorted,confirmationReferences:refs});claims.add(k);
  }
  if(options.monthlyContracts?.length){
    if(!options.weeklyBusinessDate)throw new Error("weekly business date required");
    const week=weeklyPeriod(options.weeklyBusinessDate);
    if(week.start!==options.period.start||week.end!==options.period.end)throw new Error("weekly period must be legacy rolling seven days");
    const seen=new Set<string>();
    for(const c of [...options.monthlyContracts].sort((a,b)=>a.id.localeCompare(b.id))){
      if(seen.has(c.id))throw new Error("duplicate monthly contract");seen.add(c.id);
      if((c.startDate!==null&&!date(c.startDate))||(c.endDate!==null&&!date(c.endDate))||!c.rateRevision)throw new Error("invalid monthly contract snapshot");
      if(!c.active||!c.personActive||!c.autoGenerate||(c.startDate!==null&&c.startDate>week.end)||(c.endDate!==null&&c.endDate<week.end))continue;
      const claim={personId:c.personId,contractId:c.id,period:week},k=claimKey(claim);
      if(claims.has(k)){blocked.push({key:k,reason:"existing_line_including_manual"});continue;}
      // Legacy hardcodes KWD: do not silently relabel a different currency.
      if(c.currency!=="KWD"){blocked.push({key:k,reason:"non_kwd_requires_legacy_valuation"});continue;}
      candidates.push({...claim,kind:"monthly-weekly",key:digest(["f2-weekly-v1",k]),orgId:c.parentOrgId??c.orgId,currency:"KWD",payoutDivisor:4,rateRevision:c.rateRevision});claims.add(k);
    }
  }
  return {candidates,blocked,adjustmentReviews};
}
