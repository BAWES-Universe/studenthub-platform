import pg from "pg";
import { randomUUID } from "node:crypto";
import { databaseUrl } from "./connection.js";

export type ReviewDecision="confirmed"|"rejected";
export type PendingCivilId={principalId:string;name:string;country:string|null;numberCiphertext:Buffer|null;expiry:string|null;updatedAt:string;ocrState:string|null;total:number};
type Row=Record<string,any>;
export class PostgresCivilIdReviewStore {
  readonly #pool:pg.Pool; readonly #owns:boolean;
  constructor(o:{connectionString?:string;pool?:pg.Pool}={}){this.#owns=!o.pool;this.#pool=o.pool??new pg.Pool({connectionString:o.connectionString??databaseUrl()});}
  async close(){if(this.#owns)await this.#pool.end();}
  async listPending(o:{page:number;excludePrincipalId:string}):Promise<{rows:PendingCivilId[];total:number}>{
    const {rows}=await this.#pool.query<Row>(`SELECT c.principal_id::text,COALESCE(p.display_name,p.email,c.principal_id) name,c.country,c.number_ciphertext,c.expiry_date::text,c.updated_at::text,
      (SELECT j.status FROM civil_id_ocr_jobs j WHERE j.principal_id=c.principal_id AND j.side='front' AND j.superseded_at IS NULL ORDER BY j.created_at DESC LIMIT 1) ocr_state,
      count(*) OVER()::integer total FROM person_civil_ids c JOIN principals p ON p.id=c.principal_id
      WHERE c.needs_review=true AND c.released_at IS NULL AND c.principal_id<>$1::text
      ORDER BY c.updated_at DESC,c.principal_id LIMIT 25 OFFSET (($2::integer-1)*25)`,[o.excludePrincipalId,o.page]);
    return {rows:rows.map(r=>({principalId:r.principal_id,name:r.name,country:r.country,numberCiphertext:r.number_ciphertext,expiry:r.expiry_date,updatedAt:r.updated_at,ocrState:r.ocr_state,total:r.total})),total:rows[0]?.total??0};
  }
  async countPending(o:{excludePrincipalId:string}){const {rows}=await this.#pool.query<{count:number}>(`SELECT count(*)::integer count FROM person_civil_ids WHERE needs_review=true AND released_at IS NULL AND principal_id<>$1::text`,[o.excludePrincipalId]);return rows[0]!.count;}
  async readForDecision(subject:string){const {rows}=await this.#pool.query<Row>(`SELECT c.principal_id::text,COALESCE(p.display_name,p.email,c.principal_id) name,c.country,c.number_ciphertext,c.expiry_date::text,c.updated_at::text,c.revision,
    (SELECT j.status FROM civil_id_ocr_jobs j WHERE j.principal_id=c.principal_id AND j.side='front' AND j.superseded_at IS NULL ORDER BY j.created_at DESC LIMIT 1) ocr_state
    FROM person_civil_ids c JOIN principals p ON p.id=c.principal_id WHERE c.principal_id=$1::text AND c.needs_review=true AND c.released_at IS NULL`,[subject]);return rows[0]??null;}
  async decide(o:{subjectPrincipalId:string;reviewerPrincipalId:string;decision:ReviewDecision;reason:string|null;civilRevision:number;frontVersion:string|null;backVersion:string|null;confirmRef:string;decidedAt?:string}){
    const c=await this.#pool.connect();try{await c.query("BEGIN");const replay=await c.query(`SELECT 1 FROM civil_id_review_decisions WHERE confirm_ref=$1::char(64)`,[o.confirmRef]);if(replay.rowCount){await c.query("ROLLBACK");return "already_decided" as const;}
      const locked=await c.query<Row>(`SELECT revision,needs_review,released_at::text FROM person_civil_ids WHERE principal_id=$1::text FOR UPDATE`,[o.subjectPrincipalId]);
      const row=locked.rows[0];if(!row||!row.needs_review||row.released_at||row.revision!==o.civilRevision||o.reviewerPrincipalId===o.subjectPrincipalId){await c.query("ROLLBACK");return "stale" as const;}
      await c.query(`INSERT INTO civil_id_review_decisions(id,subject_principal_id,reviewer_principal_id,decision,reason,civil_revision,front_version,back_version,confirm_ref,decided_at) VALUES($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::integer,$7::uuid,$8::uuid,$9::char(64),COALESCE($10::timestamptz,clock_timestamp()))`,[randomUUID(),o.subjectPrincipalId,o.reviewerPrincipalId,o.decision,o.reason,o.civilRevision,o.frontVersion,o.backVersion,o.confirmRef,o.decidedAt??null]);
      await c.query(`UPDATE person_civil_ids SET needs_review=false WHERE principal_id=$1::text AND revision=$2::integer AND needs_review=true AND released_at IS NULL`,[o.subjectPrincipalId,o.civilRevision]);await c.query("COMMIT");return "decided" as const;
    }catch(e){await c.query("ROLLBACK").catch(()=>{});const x=e as {code?:string;constraint?:string};if(x.code==="23505"&&x.constraint?.includes("confirm_ref"))return "already_decided" as const;throw e;}finally{c.release();}}
  async stateFor(principalId:string){const {rows}=await this.#pool.query<Row>(`SELECT CASE WHEN c.needs_review THEN 'waiting' WHEN d.decision='confirmed' THEN 'checked' WHEN d.decision='rejected' THEN 'rejected' ELSE 'waiting' END state,d.reason FROM person_civil_ids c LEFT JOIN LATERAL(SELECT decision,reason FROM civil_id_review_decisions WHERE subject_principal_id=c.principal_id AND civil_revision=c.revision ORDER BY decided_at DESC,id LIMIT 1)d ON true WHERE c.principal_id=$1::text AND c.released_at IS NULL`,[principalId]);return rows[0]??null;}
  async recordView(o:{viewerPrincipalId:string;subjectPrincipalId:string;kind:string;documentType?:string|null;documentVersion?:string|null}){await this.#pool.query(`INSERT INTO staff_person_views(viewer_principal_id,subject_principal_id,kind,document_type,document_version) VALUES($1::text,$2::text,$3::text,$4::text,$5::uuid)`,[o.viewerPrincipalId,o.subjectPrincipalId,o.kind,o.documentType??null,o.documentVersion??null]);}
}
