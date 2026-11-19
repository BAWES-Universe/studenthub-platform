/** F2 atomic-generation protocol. No database adapter is supplied here.
 * Only a transaction-scoped rebuild may supply lines; callers send identities,
 * never trusted monetary values. This service does not finalize a transfer.
 */
import type { PayLineDraft } from "./pay-lines.js";
import type { ValuedGenerationBatch } from "./generation-valuation.js";
export interface GenerationCommand {
  readonly actorId: string; readonly transferId: string; readonly expectedVersion: number;
  readonly batchKey: string; readonly expectedRevision: string;
}
export interface GenerationReceipt {
  readonly transferId: string; readonly batchKey: string; readonly revision: string;
  readonly resultingVersion: number; readonly lineIds: readonly string[];
}
export interface GenerationIdentity {
  readonly personId: string; readonly contractId: string;
  readonly periodStart: string; readonly periodEnd: string; readonly candidateKey: string;
  readonly lineageRoots: readonly string[];
}
export interface GenerationTransaction {
  /** Authorize current actor and lock target BEFORE reading any replay receipt.
   * Keep authorization/target locks stable through transaction completion.
   */
  authorizeAndLock(actorId: string, transferId: string): Promise<void>;
  receipt(transferId: string, batchKey: string): Promise<GenerationReceipt | undefined>;
  /** Lock/read authoritative Work/rate/confirmation/claim/recognized snapshots and
   * run F2+F1 again, retaining consistency locks until commit. Missing confirmation
   * stays blocked. Never rebuild from the caller's old preview or old stored amounts.
   */
  rebuild(transferId: string, batchKey: string): Promise<ValuedGenerationBatch>;
  /** Reserve ALL identities against generated AND manual claims, plus lineage roots
   * across periods. False or error must abort the transaction, including partial locks/writes.
   */
  reserve(transferId: string, identities: readonly GenerationIdentity[]): Promise<boolean>;
  /** F1-compatible draft append inside THIS transaction: check current draft status,
   * version, currency/company/assignment, audit; no inner commit or separate connection.
   */
  appendDraft(actorId: string, transferId: string, expectedVersion: number, lines: readonly PayLineDraft[]): Promise<number>;
  saveReceipt(receipt: GenerationReceipt): Promise<void>;
}
export interface GenerationTransactionStore {
  /** Single atomic boundary for locks, claims, lines, audit and receipt. Throw => rollback ALL.
   * Must serialize conflicting claims and same batch retries; durable uniqueness required.
   */
  transaction<T>(work: (tx: GenerationTransaction) => Promise<T>): Promise<T>;
}
function identities(lines: readonly PayLineDraft[]): GenerationIdentity[] {
  const result:GenerationIdentity[]=[],seen=new Set<string>();
  for(const line of lines){
    const {candidateKey,contractId,period,provenance}=line.calculation;
    const p=period as {start?:unknown;end?:unknown}|undefined;
    const roots=(provenance as {roots?:unknown}|undefined)?.roots ?? [];
    if(typeof candidateKey!=="string"||!candidateKey||typeof contractId!=="string"||!contractId||typeof p?.start!=="string"||typeof p.end!=="string"
      ||!Array.isArray(roots)||roots.some(r=>typeof r!=="string"||!r))throw Error("generation_provenance_missing");
    const key=JSON.stringify([line.personId,contractId,p.start,p.end]);
    if(seen.has(key))throw Error("duplicate_generation_identity");seen.add(key);
    result.push({personId:line.personId,contractId,periodStart:p.start,periodEnd:p.end,candidateKey,lineageRoots:roots as string[]});
  }
  return result;
}
export async function commitGeneration(store: GenerationTransactionStore, command: GenerationCommand): Promise<{readonly kind:"committed"|"replayed";readonly receipt:GenerationReceipt}> {
  if(!command.actorId||!command.transferId||!command.batchKey||!command.expectedRevision||!Number.isSafeInteger(command.expectedVersion)||command.expectedVersion<0)throw Error("invalid_generation_command");
  return store.transaction(async tx=>{
    await tx.authorizeAndLock(command.actorId,command.transferId);
    const old=await tx.receipt(command.transferId,command.batchKey);
    if(old){
      if(old.transferId!==command.transferId||old.batchKey!==command.batchKey||old.revision!==command.expectedRevision)throw Error("generation_retry_conflict");
      return {kind:"replayed",receipt:old};
    }
    const fresh=await tx.rebuild(command.transferId,command.batchKey);
    if(fresh.kind!=="preview-only"||fresh.key!==command.batchKey||fresh.revision!==command.expectedRevision)throw Error("generation_snapshot_changed");
    // Adjustments use a separate Finance path; never partially commit a mixed plan.
    if(fresh.blocked.length||fresh.adjustmentReviews.length||!fresh.lines.length)throw Error("generation_not_ready");
    if(!await tx.reserve(command.transferId,identities(fresh.lines)))throw Error("generation_claim_conflict");
    const resultingVersion=await tx.appendDraft(command.actorId,command.transferId,command.expectedVersion,fresh.lines);
    const receipt:GenerationReceipt={transferId:command.transferId,batchKey:command.batchKey,revision:fresh.revision,resultingVersion,lineIds:fresh.lines.map(l=>l.id)};
    await tx.saveReceipt(receipt);
    return {kind:"committed",receipt};
  });
}
