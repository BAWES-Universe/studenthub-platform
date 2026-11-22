/** Scoped calculation for the legacy staff Generate action. This is not access or persistence. */
import { payableFingerprint, planGeneration, type FinalizedRoot, type LineClaim, type Period } from "./generation.js";
import { valueGenerationPlan, type GenerationValuationPort, type ValuedGenerationBatch } from "./generation-valuation.js";
import type { PayableWorkSource } from "../../work/src/payable.js";

export interface StaffGenerationScope {
  readonly actorId: string;
  readonly transferId: string;
  readonly orgId: string;
  /** Inclusive Asia/Kuwait date strings; must equal the lock-held draft transfer period. */
  readonly period: Period;
}
export interface StaffGenerationInputs {
  readonly work: PayableWorkSource;
  readonly claims: readonly LineClaim[];
  readonly finalizedRoots: readonly FinalizedRoot[];
  readonly rates: GenerationValuationPort;
  /** Caller owns authority and snapshot freshness across all these inputs. */
  authorize(scope: StaffGenerationScope): Promise<boolean>;
}
export async function buildScopedStaffGeneration(
  sourceScope: StaffGenerationScope, inputs: StaffGenerationInputs,
): Promise<ValuedGenerationBatch> {
  const {actorId,transferId,orgId}=sourceScope;
  const period=Object.freeze({start:sourceScope.period.start,end:sourceScope.period.end});
  const scope=Object.freeze({actorId,transferId,orgId,period});
  if(!actorId||!transferId||!orgId)throw Error("invalid_staff_generation_scope");
  const claims=structuredClone(inputs.claims);
  const finalizedRoots=structuredClone(inputs.finalizedRoots);
  if(!await inputs.authorize(scope))throw Error("staff_generation_forbidden");
  const work:PayableWorkSource={
    payableInputs:async()=>{
      const rows=structuredClone(await inputs.work.payableInputs({orgId,period,includeSubtree:false}));
      if(rows.some(row=>row.orgId!==orgId))throw Error("payable_input_scope_mismatch");
      return rows;
    },
    lineage:async roots=>structuredClone(await inputs.work.lineage(roots)),
  };
  const plan=await planGeneration({period,work,claims,finalizedRoots,confirmations:{
    // Provenance for the explicit staff action on this input, never an employer confirmation record.
    confirm:async input=>({state:"confirmed",inputFingerprint:payableFingerprint(input),reference:"staff-explicit-range/v1"}),
  }});
  return valueGenerationPlan(plan,inputs.rates);
}
