import pg from "pg";
import { randomUUID } from "node:crypto";
import { databaseUrl } from "./connection.js";
type CivilIdPendingRow={principalId:string;name:string|null;country:"KW"|"BH"|null;numberCiphertext:Buffer|null;expiry:string|null;updatedAt:string;reading:"read"|"unreadable"|"failed"|null};
type CivilIdDecideResult={ok:true}|{ok:false;reason:"already_decided"|"stale_revision"|"not_waiting"|"own_civil_id"};
type CivilIdReviewState={state:"waiting"}|{state:"checked"}|{state:"rejected";reason:string}|null;
type StaffViewKind="civil_id_page"|"civil_id_image_issue"|"civil_id_image_deliver"|"person_page"|"person_document_issue"|"person_document_deliver";
type StaffView={viewerPrincipalId:string;subjectPrincipalId:string;kind:StaffViewKind;documentType?:"personal-photo"|"resume"|"civil-id-front"|"civil-id-back";documentVersion?:string};
type DecideInput={subjectPrincipalId:string;reviewerPrincipalId:string;decision:"confirmed"|"rejected";reason:string|null;civilRevision:number;frontVersion:string|null;backVersion:string|null;confirmRef:string};

type PendingDb={principal_id:string|null;name:string|null;country:"KW"|"BH"|null;number_ciphertext:Buffer|null;expiry:string|null;updated_at:string|null;reading:"read"|"unreadable"|"failed"|null;total:string};
const pending=(r:PendingDb):CivilIdPendingRow=>({principalId:r.principal_id!,name:r.name,country:r.country,numberCiphertext:r.number_ciphertext,expiry:r.expiry,updatedAt:r.updated_at!,reading:r.reading});
export class PostgresCivilIdReviewStore {
 readonly #pool:pg.Pool;readonly #owns:boolean;
 constructor(o:{connectionString?:string;pool?:pg.Pool}={}){this.#owns=!o.pool;this.#pool=o.pool??new pg.Pool({connectionString:o.connectionString??databaseUrl()});}
 async close(){if(this.#owns)await this.#pool.end();}
 async listPending({page,excludePrincipalId}:{page:number;excludePrincipalId:string}){const {rows}=await this.#pool.query<PendingDb>(`WITH queue AS (
 SELECT c.principal_id::text,COALESCE(p.display_name,a.display_name) name,c.country,c.number_ciphertext,c.expiry_date::text expiry,c.updated_at::text updated_at,c.updated_at updated_at_value,
   CASE WHEN j.status IN ('read','unreadable','failed') THEN j.status END reading
 FROM person_civil_ids c JOIN principals a ON a.id=c.principal_id LEFT JOIN person_profiles p ON p.principal_id=c.principal_id
 LEFT JOIN LATERAL (SELECT status FROM civil_id_ocr_jobs WHERE principal_id=c.principal_id AND side='front' AND superseded_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1) j ON true
 WHERE c.needs_review AND c.released_at IS NULL AND c.principal_id<>$1::text
), page AS (SELECT * FROM queue ORDER BY updated_at_value DESC,principal_id LIMIT 25 OFFSET $2::integer), totals AS (SELECT count(*)::text total FROM queue)
SELECT page.principal_id,page.name,page.country,page.number_ciphertext,page.expiry,page.updated_at,page.reading,totals.total FROM totals LEFT JOIN page ON true ORDER BY page.updated_at_value DESC,page.principal_id`,[excludePrincipalId,(Math.max(1,page)-1)*25]);
 return {rows:rows.filter(r=>r.principal_id!==null).map(pending),total:Number(rows[0]?.total??0)};}
 async countPending({excludePrincipalId}:{excludePrincipalId:string}){const {rows}=await this.#pool.query<{total:string}>(`SELECT count(*)::text total FROM person_civil_ids WHERE needs_review AND released_at IS NULL AND principal_id<>$1::text`,[excludePrincipalId]);return Number(rows[0]!.total);}
 async readForDecision(id:string){const {rows}=await this.#pool.query<PendingDb&{revision:number;needs_review:boolean}>(`SELECT c.principal_id::text,COALESCE(p.display_name,a.display_name) name,c.country,c.number_ciphertext,c.expiry_date::text expiry,c.updated_at::text updated_at,c.revision,c.needs_review,
 CASE WHEN j.status IN ('read','unreadable','failed') THEN j.status END reading,'0'::text total
 FROM person_civil_ids c JOIN principals a ON a.id=c.principal_id LEFT JOIN person_profiles p ON p.principal_id=c.principal_id
 LEFT JOIN LATERAL (SELECT status FROM civil_id_ocr_jobs WHERE principal_id=c.principal_id AND side='front' AND superseded_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1) j ON true
 WHERE c.principal_id=$1::text AND c.released_at IS NULL`,[id]);const r=rows[0];return r?{...pending(r),revision:r.revision,needsReview:r.needs_review}:null;}
 async decide(i:DecideInput):Promise<CivilIdDecideResult>{const c=await this.#pool.connect();try{await c.query("BEGIN");const row=await c.query<{needs_review:boolean;revision:number;released_at:string|null}>(`SELECT needs_review,revision,released_at::text FROM person_civil_ids WHERE principal_id=$1::text FOR UPDATE`,[i.subjectPrincipalId]);const replay=await c.query(`SELECT 1 FROM civil_id_review_decisions WHERE confirm_ref=$1::text`,[i.confirmRef]);if(replay.rowCount){await c.query("ROLLBACK");return {ok:false,reason:"already_decided"};}if(i.reviewerPrincipalId===i.subjectPrincipalId){await c.query("ROLLBACK");return {ok:false,reason:"own_civil_id"};}const r=row.rows[0];if(!r?.needs_review||r.released_at){await c.query("ROLLBACK");return {ok:false,reason:"not_waiting"};}if(r.revision!==i.civilRevision){await c.query("ROLLBACK");return {ok:false,reason:"stale_revision"};}
 await c.query(`INSERT INTO civil_id_review_decisions(id,subject_principal_id,reviewer_principal_id,decision,reason,civil_revision,front_version,back_version,confirm_ref) VALUES($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::integer,$7::uuid,$8::uuid,$9::text)`,[randomUUID(),i.subjectPrincipalId,i.reviewerPrincipalId,i.decision,i.reason,i.civilRevision,i.frontVersion,i.backVersion,i.confirmRef]);
 await c.query(`UPDATE person_civil_ids SET needs_review=false WHERE principal_id=$1::text`,[i.subjectPrincipalId]);await c.query("COMMIT");return {ok:true};}catch(e){await c.query("ROLLBACK").catch(()=>{});const x=e as {code?:string;constraint?:string};if(x.code==="23505"&&x.constraint==="civil_id_review_decisions_confirm_ref_key")return {ok:false,reason:"already_decided"};throw e;}finally{c.release();}}
 async stateFor(id:string):Promise<CivilIdReviewState>{const {rows}=await this.#pool.query<{released_at:string|null;needs_review:boolean;decision:"confirmed"|"rejected"|null;reason:string|null}>(`SELECT c.released_at::text,c.needs_review,d.decision,d.reason FROM person_civil_ids c LEFT JOIN LATERAL (SELECT decision,reason FROM civil_id_review_decisions WHERE subject_principal_id=c.principal_id AND civil_revision=c.revision ORDER BY decided_at DESC,id DESC LIMIT 1) d ON true WHERE c.principal_id=$1::text`,[id]);const r=rows[0];if(!r||r.released_at)return null;if(r.needs_review)return {state:"waiting"};return r.decision==="confirmed"?{state:"checked"}:r.decision==="rejected"?{state:"rejected",reason:r.reason!}:null;}
 async recordView(v:StaffView){await this.#pool.query(`INSERT INTO staff_person_views(viewer_principal_id,subject_principal_id,kind,document_type,document_version) VALUES($1::text,$2::text,$3::text,$4::text,$5::uuid)`,[v.viewerPrincipalId,v.subjectPrincipalId,v.kind,v.documentType??null,v.documentVersion??null]);}
}
