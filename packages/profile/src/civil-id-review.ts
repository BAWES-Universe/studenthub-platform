import { randomUUID } from "node:crypto";
import type { CivilIdCountry, InMemoryCivilIdStore } from "./civil-id.js";
import type { InMemoryCivilIdOcrStore } from "./civil-id-ocr.js";

export type StaffViewKind = "civil_id_page" | "civil_id_image_issue" | "civil_id_image_deliver" | "person_page" | "person_document_issue" | "person_document_deliver";
export interface StaffView { viewerPrincipalId:string; subjectPrincipalId:string; kind:StaffViewKind; documentType?:"personal-photo"|"resume"|"civil-id-front"|"civil-id-back"; documentVersion?:string }
export interface CivilIdPendingRow { principalId:string; name:string|null; country:CivilIdCountry|null; numberCiphertext:Buffer|null; expiry:string|null; updatedAt:string; reading:"read"|"unreadable"|"failed"|null }
export type CivilIdReviewState={state:"waiting"}|{state:"checked"}|{state:"rejected";reason:string}|null;
export type CivilIdDecideResult={ok:true}|{ok:false;reason:"already_decided"|"stale_revision"|"not_waiting"|"own_civil_id"};
export interface CivilIdReviewStore {
 listPending(input:{page:number;excludePrincipalId:string}):Promise<{rows:CivilIdPendingRow[];total:number}>;
 countPending(input:{excludePrincipalId:string}):Promise<number>;
 readForDecision(subjectPrincipalId:string):Promise<(CivilIdPendingRow&{revision:number;needsReview:boolean})|null>;
 decide(input:{subjectPrincipalId:string;reviewerPrincipalId:string;decision:"confirmed"|"rejected";reason:string|null;civilRevision:number;frontVersion:string|null;backVersion:string|null;confirmRef:string}):Promise<CivilIdDecideResult>;
 stateFor(principalId:string):Promise<CivilIdReviewState>;
 recordView(view:StaffView):Promise<void>;
}
export const CIVIL_ID_REVIEW_PAGE_SIZE=25;
type Decision={id:string;subjectPrincipalId:string;reviewerPrincipalId:string;decision:"confirmed"|"rejected";reason:string|null;civilRevision:number;frontVersion:string|null;backVersion:string|null;confirmRef:string;decidedAt:string};
export class InMemoryCivilIdReviewStore implements CivilIdReviewStore {
 readonly decisions:Decision[]=[];readonly views:StaffView[]=[];failViews=false;
 readonly #civil:InMemoryCivilIdStore;readonly #ocr?:InMemoryCivilIdOcrStore;readonly #names:(id:string)=>string|null;
 constructor(o:{civilStore:InMemoryCivilIdStore;ocrStore?:InMemoryCivilIdOcrStore;names?:(principalId:string)=>string|null}){this.#civil=o.civilStore;this.#ocr=o.ocrStore;this.#names=o.names??(()=>null);}
 #reading(id:string){const j=[...(this.#ocr?.jobs??[])].filter(x=>x.principalId===id&&x.side==="front"&&!x.supersededAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];return j&&["read","unreadable","failed"].includes(j.status)?j.status as "read"|"unreadable"|"failed":null;}
 #pending(id:string):CivilIdPendingRow|null{const r=this.#civil.rows.get(id);if(!r||!r.needsReview||r.releasedAt)return null;return {principalId:id,name:this.#names(id),country:r.country,numberCiphertext:this.#civil.sealed.get(id)?.ciphertext??null,expiry:r.expiry,updatedAt:r.updatedAt,reading:this.#reading(id)};}
 async listPending({page,excludePrincipalId}:{page:number;excludePrincipalId:string}){const all=[...this.#civil.rows.keys()].filter(id=>id!==excludePrincipalId).map(id=>this.#pending(id)).filter((x):x is CivilIdPendingRow=>!!x).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.principalId.localeCompare(b.principalId));const start=(Math.max(1,page)-1)*CIVIL_ID_REVIEW_PAGE_SIZE;return {rows:all.slice(start,start+CIVIL_ID_REVIEW_PAGE_SIZE),total:all.length};}
 async countPending({excludePrincipalId}:{excludePrincipalId:string}){return (await this.listPending({page:1,excludePrincipalId})).total;}
 async readForDecision(id:string){const r=this.#civil.rows.get(id);if(!r||r.releasedAt)return null;const p: CivilIdPendingRow={principalId:id,name:this.#names(id),country:r.country,numberCiphertext:this.#civil.sealed.get(id)?.ciphertext??null,expiry:r.expiry,updatedAt:r.updatedAt,reading:this.#reading(id)};return {...p,revision:r.revision,needsReview:r.needsReview};}
 async decide(i:Parameters<CivilIdReviewStore["decide"]>[0]):Promise<CivilIdDecideResult>{if(this.decisions.some(d=>d.confirmRef===i.confirmRef))return {ok:false,reason:"already_decided"};if(i.reviewerPrincipalId===i.subjectPrincipalId)return {ok:false,reason:"own_civil_id"};const r=this.#civil.rows.get(i.subjectPrincipalId);if(!r?.needsReview||r.releasedAt)return {ok:false,reason:"not_waiting"};if(r.revision!==i.civilRevision)return {ok:false,reason:"stale_revision"};this.decisions.push({...i,id:randomUUID(),decidedAt:new Date().toISOString()});this.#civil.rows.set(i.subjectPrincipalId,{...r,needsReview:false});return {ok:true};}
 async stateFor(id:string):Promise<CivilIdReviewState>{const r=this.#civil.rows.get(id);if(!r||r.releasedAt)return null;if(r.needsReview)return {state:"waiting"};const d=[...this.decisions].reverse().find(x=>x.subjectPrincipalId===id&&x.civilRevision===r.revision);return d?.decision==="confirmed"?{state:"checked"}:d?.decision==="rejected"?{state:"rejected",reason:d.reason!}:null;}
 async recordView(v:StaffView){if(this.failViews)throw new Error("staff view write failed");this.views.push({...v});}
}
