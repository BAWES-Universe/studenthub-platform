import pg from "pg";
import { databaseUrl } from "./connection.js";

type DirectoryQuery = { q?: string; status?: "not_looking"|"active"|"open_to_offers"|"unset"; nationality?: string; civil?: "none"|"waiting"|"rejected"|"expired"|"checked"|"recorded"; details?: "complete"|"missing"; page: number };
type ClassifiedSearch = { employeeId:string|null; phone:string|null; phoneSuffix:string|null; handle:string|null; nameTokens:readonly string[] };
type DirectoryRow = {principalId:string;name:string|null;universeName:string|null;arabicName:string|null;workStatus:"not_looking"|"active"|"open_to_offers"|null;nationality:{id:string;name:string}|null;detailsMissing:number;civilState:"none"|"waiting"|"rejected"|"expired"|"checked"|"recorded";imported:boolean;employeeId:string|null;phoneLast4:string|null};

const classify = async (q: string): Promise<ClassifiedSearch> => {
  // The profile package is built after db, so keep this package acyclic while using the identical closed classifier rules.
  const digit = (c:string) => /[0-9]/.test(c) ? c : /[\u0660-\u0669]/.test(c) ? String(c.charCodeAt(0)-0x0660) : /[\u06f0-\u06f9]/.test(c) ? String(c.charCodeAt(0)-0x06f0) : c;
  const text=q.trim().normalize("NFC"), employee=/^c0*([1-9][0-9]*)$/i.exec(text), converted=text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,digit);
  const allowed=/^[+0-9\u0660-\u0669\u06f0-\u06f9 ()-]+$/.test(text), compact=converted.replace(/[ ()-]/g,""), international=compact.startsWith("+")||compact.startsWith("00"), digits=compact.startsWith("+")?compact.slice(1):compact.startsWith("00")?compact.slice(2):compact;
  const phone=digits.length===8&&!international?`+965${digits}`:international||digits.startsWith("965")?`+${digits}`:compact;
  const valid=allowed&&/^\+[0-9]{8,15}$/.test(phone), suffix=[...text].map(digit).join("").replace(/\D/g,"");
  const link=/^(?:https?:\/\/[^/]+)?\/(?:people|profile)\/([a-z][a-z0-9._-]{2,29})\/?$/i.exec(text), bare=/^[a-z][a-z0-9._-]{2,29}$/i.test(text)?text.toLowerCase():null;
  return {employeeId:employee?.[1]??null,phone:valid?phone:null,phoneSuffix:allowed&&!valid&&suffix.length>=4?suffix:null,handle:link?.[1]?.toLowerCase()??bare,nameTokens:text.toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu)??[]};
};

const SQL = `
WITH source AS (
 SELECT p.id AS principal_id, pp.display_name AS name, p.display_name AS universe_name,
  pp.arabic_name, pp.job_search_status AS work_status, ci.id::text AS nationality_id, ci.name AS nationality_name,
  (lal.principal_id IS NOT NULL) AS imported,
  CASE WHEN lal.legacy_candidate_id IS NULL THEN NULL ELSE 'C'||lpad(lal.legacy_candidate_id,5,'0') END AS employee_id,
  right(pp.phone,4) AS phone_last4,
  (CASE WHEN ci.id IS NULL OR ci.catalogue_type<>'country' THEN 1 ELSE 0 END
   + CASE WHEN nullif(btrim(pp.display_name),'') IS NULL THEN 1 ELSE 0 END
   + CASE WHEN nullif(btrim(pp.arabic_name),'') IS NULL THEN 1 ELSE 0 END
   + CASE WHEN pp.gender IS NULL THEN 1 ELSE 0 END
   + CASE WHEN nullif(btrim(pp.objective),'') IS NULL THEN 1 ELSE 0 END
   + CASE WHEN nullif(btrim(p.email),'') IS NULL THEN 1 ELSE 0 END
   + CASE WHEN pp.phone IS NULL THEN 1 ELSE 0 END
   + CASE WHEN pp.birth_date IS NULL THEN 1 ELSE 0 END
   + CASE WHEN pc.number_hash IS NULL OR pc.released_at IS NOT NULL THEN 1 ELSE 0 END
   + CASE WHEN pc.expiry_date IS NULL OR pc.released_at IS NOT NULL THEN 1 ELSE 0 END
   + CASE WHEN pp.driving_licence IS NULL THEN 1 ELSE 0 END
   + CASE WHEN pl.area_id IS NULL THEN 1 ELSE 0 END
   + CASE WHEN ci.code IS NOT NULL AND ci.code<>'KW' AND pp.kuwaiti_mother IS NULL THEN 1 ELSE 0 END
   + CASE WHEN NOT EXISTS (SELECT 1 FROM candidate_profile_records r WHERE r.owner_principal_id=p.id AND r.kind='education' AND r.status='active') THEN 1 ELSE 0 END
   + CASE WHEN NOT EXISTS (SELECT 1 FROM candidate_profile_records r WHERE r.owner_principal_id=p.id AND r.kind='skill' AND r.status='active') THEN 1 ELSE 0 END) AS details_missing,
  CASE WHEN pc.principal_id IS NULL OR pc.released_at IS NOT NULL OR (pc.number_hash IS NULL AND pc.expiry_date IS NULL) THEN 'none'
       WHEN pc.needs_review THEN 'waiting' WHEN decision.decision='rejected' THEN 'rejected'
       WHEN pc.expiry_date<$11::date THEN 'expired' WHEN decision.decision='confirmed' THEN 'checked' ELSE 'recorded' END AS civil_state
 FROM principals p JOIN person_profiles pp ON pp.principal_id=p.id
 LEFT JOIN catalogue_items ci ON ci.id=pp.nationality_id AND ci.catalogue_type='country'
 LEFT JOIN person_locations pl ON pl.principal_id=p.id
 LEFT JOIN person_civil_ids pc ON pc.principal_id=p.id
 LEFT JOIN LATERAL (SELECT d.decision FROM civil_id_review_decisions d WHERE d.subject_principal_id=p.id AND d.civil_revision=pc.revision ORDER BY d.decided_at DESC,d.id DESC LIMIT 1) decision ON true
 LEFT JOIN legacy_account_links lal ON lal.principal_id=p.id
), filtered AS (
 SELECT * FROM source s WHERE
  ($1::text IS NULL OR s.principal_id IN (SELECT principal_id FROM legacy_account_links WHERE legacy_candidate_id=$1::text)
   OR ($2::text IS NOT NULL AND s.principal_id IN (SELECT principal_id FROM person_profiles WHERE phone=$2::text))
   OR ($3::text IS NOT NULL AND s.principal_id IN (SELECT principal_id FROM person_profiles WHERE reverse(phone) LIKE reverse($3::text)||'%'))
   OR ($4::text IS NOT NULL AND s.principal_id IN (SELECT principal_id FROM person_profiles WHERE profile_handle=$4::text))
   OR ($5::text IS NOT NULL AND (s.principal_id IN (SELECT principal_id FROM person_profiles WHERE to_tsvector('simple',coalesce(display_name,'')||' '||coalesce(arabic_name,'')) @@ to_tsquery('simple',$5::text))
     OR s.principal_id IN (SELECT id FROM principals WHERE to_tsvector('simple',coalesce(display_name,'')) @@ to_tsquery('simple',$5::text)))))
  AND ($6::text IS NULL OR ($6::text='unset' AND s.work_status IS NULL) OR s.work_status=$6::text)
  AND ($7::uuid IS NULL OR s.nationality_id=$7::uuid::text) AND ($8::text IS NULL OR s.civil_state=$8::text)
  AND ($9::text IS NULL OR ($9::text='complete' AND s.details_missing=0) OR ($9::text='missing' AND s.details_missing>0))
), page_rows AS (
 SELECT * FROM filtered ORDER BY lower(coalesce(name,universe_name,'')) COLLATE "C",principal_id LIMIT 25 OFFSET $10::integer
)
SELECT (SELECT count(*)::integer FROM filtered) AS total,
 coalesce(jsonb_agg(jsonb_build_object('principalId',principal_id,'name',name,'universeName',universe_name,'arabicName',arabic_name,'workStatus',work_status,'nationality',CASE WHEN nationality_id IS NULL THEN NULL ELSE jsonb_build_object('id',nationality_id,'name',nationality_name) END,'detailsMissing',details_missing,'civilState',civil_state,'imported',imported,'employeeId',employee_id,'phoneLast4',phone_last4) ORDER BY lower(coalesce(name,universe_name,'')) COLLATE "C",principal_id) FILTER (WHERE principal_id IS NOT NULL),'[]'::jsonb) AS rows
FROM page_rows`;

export class PostgresPeopleDirectoryStore {
  readonly #pool:pg.Pool; readonly #owns:boolean;
  constructor(options:{pool?:pg.Pool;connectionString?:string}){this.#owns=!options.pool;this.#pool=options.pool??new pg.Pool({connectionString:options.connectionString??databaseUrl()});}
  async close(){if(this.#owns)await this.#pool.end();}
  async page(query:DirectoryQuery,today:string):Promise<{rows:DirectoryRow[];total:number}>{
    const c=query.q===undefined?null:await classify(query.q), ts=c&&c.nameTokens.length?c.nameTokens.map(token=>`${token}:*`).join(" & "):null;
    const searchAbsent=query.q===undefined?null:"";
    const result=await this.#pool.query<{total:number;rows:Array<Record<string,unknown>>}>(SQL,[c?.employeeId??searchAbsent,c?.phone??null,c?.phoneSuffix??null,c?.handle??null,ts,query.status??null,query.nationality??null,query.civil??null,query.details??null,Math.max(0,query.page-1)*25,today]);
    return {rows:(result.rows[0]?.rows??[]) as DirectoryRow[],total:result.rows[0]?.total??0};
  }
}
