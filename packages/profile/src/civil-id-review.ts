import { randomUUID } from "node:crypto";
import type { CivilIdCountry, InMemoryCivilIdStore } from "./civil-id.js";
import type { InMemoryCivilIdOcrStore } from "./civil-id-ocr.js";

export type StaffViewKind = "civil_id_page" | "civil_id_image_issue" | "civil_id_image_deliver" | "person_page" | "person_document_issue" | "person_document_deliver";
export interface StaffView { viewerPrincipalId: string; subjectPrincipalId: string; kind: StaffViewKind; documentType?: "personal-photo" | "resume" | "civil-id-front" | "civil-id-back"; documentVersion?: string }
export interface CivilIdPendingRow { principalId: string; name: string | null; country: CivilIdCountry | null; numberCiphertext: Buffer | null; expiry: string | null; updatedAt: string; reading: "read" | "unreadable" | "failed" | null }
export type CivilIdReviewState = { state: "waiting" } | { state: "checked" } | { state: "rejected"; reason: string } | null;
export type CivilIdDecideResult = { ok: true } | { ok: false; reason: "already_decided" | "stale_revision" | "not_waiting" | "own_civil_id" };
export interface CivilIdReviewStore {
  listPending(input: { page: number; excludePrincipalId: string }): Promise<{ rows: CivilIdPendingRow[]; total: number }>;
  countPending(input: { excludePrincipalId: string }): Promise<number>;
  readForDecision(subjectPrincipalId: string): Promise<(CivilIdPendingRow & { revision: number; needsReview: boolean }) | null>;
  decide(input: { subjectPrincipalId: string; reviewerPrincipalId: string; decision: "confirmed" | "rejected"; reason: string | null; civilRevision: number; frontVersion: string | null; backVersion: string | null; confirmRef: string }): Promise<CivilIdDecideResult>;
  stateFor(principalId: string): Promise<CivilIdReviewState>;
  recordView(view: StaffView): Promise<void>;
}
export const CIVIL_ID_REVIEW_PAGE_SIZE = 25;

type Decision = { id: string; subjectPrincipalId: string; reviewerPrincipalId: string; decision: "confirmed" | "rejected"; reason: string | null; civilRevision: number; frontVersion: string | null; backVersion: string | null; confirmRef: string; decidedAt: string };
export class InMemoryCivilIdReviewStore implements CivilIdReviewStore {
  readonly decisions: Decision[] = []; readonly views: StaffView[] = []; failViews = false;
  readonly #civilStore: InMemoryCivilIdStore; readonly #ocrStore?: InMemoryCivilIdOcrStore; readonly #names: (id: string) => string | null;
  constructor(options: { civilStore: InMemoryCivilIdStore; ocrStore?: InMemoryCivilIdOcrStore; names?: (principalId: string) => string | null }) { this.#civilStore=options.civilStore;this.#ocrStore=options.ocrStore;this.#names=options.names??(()=>null); }
  #pending(id: string) { const r=this.#civilStore.rows.get(id);return !!r?.needsReview&&!r.releasedAt; }
  #row(id: string): CivilIdPendingRow | null { const r=this.#civilStore.rows.get(id);if(!r)return null;const job=[...(this.#ocrStore?.jobs??[])].reverse().find(j=>j.principalId===id&&j.side==="front"&&!j.supersededAt);const reading=job&&["read","unreadable","failed"].includes(job.status)?job.status as "read"|"unreadable"|"failed":null;return {principalId:id,name:this.#names(id),country:r.country,numberCiphertext:this.#civilStore.sealed.get(id)?.ciphertext??null,expiry:r.expiry,updatedAt:r.updatedAt,reading}; }
  async listPending(input:{page:number;excludePrincipalId:string}) { const all=[...this.#civilStore.rows.keys()].filter(id=>id!==input.excludePrincipalId&&this.#pending(id)).sort((a,b)=>{const x=this.#civilStore.rows.get(a)!,y=this.#civilStore.rows.get(b)!;return y.updatedAt.localeCompare(x.updatedAt)||a.localeCompare(b);});const start=(input.page-1)*CIVIL_ID_REVIEW_PAGE_SIZE;return {rows:all.slice(start,start+CIVIL_ID_REVIEW_PAGE_SIZE).map(id=>this.#row(id)!),total:all.length}; }
  async countPending(input:{excludePrincipalId:string}) { return [...this.#civilStore.rows.keys()].filter(id=>id!==input.excludePrincipalId&&this.#pending(id)).length; }
  async readForDecision(id:string) { const r=this.#civilStore.rows.get(id),row=this.#row(id);return r&&row?{...row,revision:r.revision,needsReview:r.needsReview}:null; }
  async decide(input:Parameters<CivilIdReviewStore["decide"]>[0]):Promise<CivilIdDecideResult> { if(this.decisions.some(d=>d.confirmRef===input.confirmRef))return {ok:false,reason:"already_decided"};if(input.subjectPrincipalId===input.reviewerPrincipalId)return {ok:false,reason:"own_civil_id"};const row=this.#civilStore.rows.get(input.subjectPrincipalId);if(!row?.needsReview||!!row.releasedAt)return {ok:false,reason:"not_waiting"};if(row.revision!==input.civilRevision)return {ok:false,reason:"stale_revision"};this.decisions.push({id:randomUUID(),...input,decidedAt:new Date().toISOString()});this.#civilStore.rows.set(input.subjectPrincipalId,{...row,needsReview:false});return {ok:true}; }
  async stateFor(id:string):Promise<CivilIdReviewState> { const row=this.#civilStore.rows.get(id);if(!row||row.releasedAt)return null;if(row.needsReview)return {state:"waiting"};const d=[...this.decisions].reverse().find(x=>x.subjectPrincipalId===id&&x.civilRevision===row.revision);return !d?null:d.decision==="confirmed"?{state:"checked"}:{state:"rejected",reason:d.reason!}; }
  async recordView(view:StaffView) { if(this.failViews)throw new Error("staff view write failed");this.views.push({...view}); }
}
