import pg from "pg";
import { randomUUID } from "node:crypto";
import { databaseUrl } from "./connection.js";

export type ReviewDecision="confirmed"|"rejected";
export type ReviewViewKind="civil_id_page"|"civil_id_image_issue"|"civil_id_image_deliver"|"person_page"|"person_document_issue"|"person_document_deliver";
type PendingRow={principal_id:string;display_name:string|null;country:string|null;number_ciphertext:Buffer|null;expiry_date:string|null;updated_at:string;ocr_status:string|null;total_count:string};
export class PostgresCivilIdReviewStore {
 readonly #pool:pg.Pool; readonly #owns:boolean;
 constructor(options:{connectionString?:string;pool?:pg.Pool}={}){this.#owns=!options.pool;this.#pool=options.pool??new pg.Pool({connectionString:options.connectionString??databaseUrl()});}
 async close(){if(this.#owns)await this.#pool.end();}
 async listPending({page,excludePrincipalId}:{page:number;excludePrincipalId:string}){const {rows}=await this.#pool.query<PendingRow>(`SELECT c.principal_id::text,COALESCE(pf.display_name,p.display_name,p.email) AS display_name,c.country,c.number_ciphertext,c.expiry_date::text,c.updated_at::text,
 (SELECT j.status FROM civil_id_ocr_jobs j WHERE j.principal_id=c.principal_id AND j.side='front' AND j.superseded_at IS NULL ORDER BY j.created_at DESC LIMIT 1) AS ocr_status,
 count(*) OVER()::text AS total_count FROM person_civil_ids c JOIN principals p ON p.id=c.principal_id LEFT JOIN person_profiles pf ON pf.principal_id=c.principal_id
 WHERE c.needs_review AND c.released_at IS NULL AND c.principal_id<>$1::text ORDER BY c.updated_at DESC,c.principal_id LIMIT 25 OFFSET $2::integer`,[excludePrincipalId,(page-1)*25]);return rows;}
 async countPending({excludePrincipalId}:{excludePrincipalId:string}){const {rows}=await this.#pool.query<{count:string}>(`SELECT count(*)::text AS count FROM person_civil_ids WHERE needs_review AND released_at IS NULL AND principal_id<>$1::text`,[excludePrincipalId]);return Number(rows[0]?.count??0);}
 async readForDecision(subject:string){const {rows}=await this.#pool.query(`SELECT c.principal_id::text,COALESCE(pf.display_name,p.display_name,p.email) AS display_name,c.country,c.number_ciphertext,c.expiry_date::text,c.updated_at::text,c.revision,
 j.status AS ocr_status,j.last4,j.expiry_date::text AS ocr_expiry FROM person_civil_ids c JOIN principals p ON p.id=c.principal_id LEFT JOIN person_profiles pf ON pf.principal_id=c.principal_id LEFT JOIN LATERAL (SELECT status,last4,expiry_date FROM civil_id_ocr_jobs WHERE principal_id=c.principal_id AND side='front' AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1) j ON true
 WHERE c.principal_id=$1::text AND c.needs_review AND c.released_at IS NULL`,[subject]);return rows[0]??null;}
 async decide(input:{subject:string;reviewer:string;decision:ReviewDecision;reason:string|null;revision:number;frontVersion:string|null;backVersion:string|null;confirmRef:string;decidedAt?:string}){const client=await this.#pool.connect();try{await client.query("BEGIN");
  const replay=await client.query(`SELECT 1 FROM civil_id_review_decisions WHERE confirm_ref=$1::text`,[input.confirmRef]);if(replay.rowCount){await client.query("ROLLBACK");return "already_decided" as const;}
  const current=await client.query<{revision:number}>(`SELECT revision FROM person_civil_ids WHERE principal_id=$1::text AND needs_review AND released_at IS NULL FOR UPDATE`,[input.subject]);
  if(input.subject===input.reviewer||current.rows[0]?.revision!==input.revision){await client.query("ROLLBACK");return "stale" as const;}
  await client.query(`INSERT INTO civil_id_review_decisions(id,subject_principal_id,reviewer_principal_id,decision,reason,civil_revision,front_version,back_version,confirm_ref,decided_at) VALUES($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::integer,$7::uuid,$8::uuid,$9::text,COALESCE($10::timestamptz,clock_timestamp()))`,[randomUUID(),input.subject,input.reviewer,input.decision,input.reason,input.revision,input.frontVersion,input.backVersion,input.confirmRef,input.decidedAt??null]);
  await client.query(`UPDATE person_civil_ids SET needs_review=false WHERE principal_id=$1::text AND revision=$2::integer`,[input.subject,input.revision]);await client.query("COMMIT");return "decided" as const;
 }catch(e){await client.query("ROLLBACK").catch(()=>{});if((e as {code?:string}).code==="23505")return "already_decided" as const;throw e;}finally{client.release();}}
 async stateFor(principalId:string){const {rows}=await this.#pool.query<{needs_review:boolean;decision:ReviewDecision|null;reason:string|null}>(`SELECT c.needs_review,d.decision,d.reason FROM person_civil_ids c LEFT JOIN LATERAL (SELECT decision,reason FROM civil_id_review_decisions WHERE subject_principal_id=c.principal_id AND civil_revision=c.revision ORDER BY decided_at DESC,id DESC LIMIT 1)d ON true WHERE c.principal_id=$1::text AND c.released_at IS NULL`,[principalId]);const r=rows[0];return !r||r.needs_review||!r.decision?{state:"waiting" as const}:r.decision==="confirmed"?{state:"checked" as const}:{state:"rejected" as const,reason:r.reason!};}
 async recordView(v:{viewerPrincipalId:string;subjectPrincipalId:string;kind:ReviewViewKind;documentType?:string;documentVersion?:string}){await this.#pool.query(`INSERT INTO staff_person_views(viewer_principal_id,subject_principal_id,kind,document_type,document_version) VALUES($1::text,$2::text,$3::text,$4::text,$5::uuid)`,[v.viewerPrincipalId,v.subjectPrincipalId,v.kind,v.documentType??null,v.documentVersion??null]);}
}
