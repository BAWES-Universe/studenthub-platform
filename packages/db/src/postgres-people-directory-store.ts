import pg from "pg";
import { databaseUrl } from "./connection.js";
type PeopleCivilState="none"|"waiting"|"rejected"|"expired"|"checked"|"recorded";type Work="not_looking"|"active"|"open_to_offers";type PeopleDirectoryQuery={q?:string;status?:Work|"unset";nationality?:string;civil?:PeopleCivilState;details?:"complete"|"missing";page:number};type PeopleDirectoryRow={principalId:string;name:string|null;universeName:string|null;arabicName:string|null;workStatus:Work|null;nationality:{id:string;name:string}|null;detailsMissing:number;civilState:PeopleCivilState;imported:boolean;employeeId:string|null;phoneLast4:string|null};interface PeopleDirectoryStore{page(query:PeopleDirectoryQuery,today:string):Promise<{rows:PeopleDirectoryRow[];total:number}>}

const PEOPLE_PAGE_SIZE=25;
const localClassify=(raw:string)=>{const q=raw.trim().normalize("NFC"),ascii=q.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,c=>String(c.charCodeAt(0)-(c<="\u0669"?0x0660:0x06f0))),employee=/^[cC]([0-9]+)$/.exec(q),compact=ascii.replace(/[ ()-]/g,"");let phone:string|null=null;if(/^[+0-9 ()-]+$/.test(ascii)&&ascii.trim()===ascii){const international=compact.startsWith("+")||compact.startsWith("00"),digits=compact.startsWith("+")?compact.slice(1):compact.startsWith("00")?compact.slice(2):compact;const normalized=digits.length===8&&!international?`+965${digits}`:international||digits.startsWith("965")?`+${digits}`:compact;if(/^\+[0-9]{8,15}$/.test(normalized))phone=normalized}return {employeeId:employee?employee[1]!.replace(/^0+(?=\d)/,""):null,phone,phoneSuffix:!phone&&/^[0-9\u0660-\u0669\u06f0-\u06f9]{4,8}$/.test(q)?ascii:null,handle:/^@?[A-Za-z][A-Za-z0-9._-]{2,29}$/.test(q)?q.replace(/^@/,"").toLowerCase():null,nameTokens:[...q.toLowerCase().matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map(m=>m[0]!)}}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CIVIL:readonly PeopleCivilState[]=["none","waiting","rejected","expired","checked","recorded"];
type DbRow={principal_id:string|null;name:string|null;universe_name:string|null;arabic_name:string|null;work_status:PeopleDirectoryRow["workStatus"];nationality_id:string|null;nationality_name:string|null;details_missing:number|null;civil_state:PeopleCivilState|null;imported:boolean|null;legacy_candidate_id:string|null;phone_last4:string|null;total:number|string};

export class PostgresPeopleDirectoryStore implements PeopleDirectoryStore {
 readonly #pool:pg.Pool;readonly #owns:boolean;
 constructor(options:{pool?:pg.Pool;connectionString?:string}){this.#owns=!options.pool;this.#pool=options.pool??new pg.Pool({connectionString:options.connectionString??databaseUrl()})}
 async close(){if(this.#owns)await this.#pool.end()}
 async page(query:PeopleDirectoryQuery,today:string):Promise<{rows:PeopleDirectoryRow[];total:number}>{
  if(!Number.isInteger(query.page)||query.page<1)throw Error("page must be a whole number of 1 or more");
  if(query.nationality!==undefined&&!UUID.test(query.nationality))throw Error("nationality must be a uuid");
  const q=(query.q??"").trim();if([...q].length>200)throw Error("q must be at most 200 characters");
  const search=localClassify(q),tokens=search.nameTokens.map((t:string)=>`${t}:*`).join(" & ");
  const result=await this.#pool.query<DbRow>(`WITH people AS (
 SELECT p.id::text principal_id,coalesce(pp.display_name,p.display_name)::text name,p.display_name::text universe_name,pp.arabic_name::text,
 pp.job_search_status::text work_status,ci.id::text nationality_id,ci.name::text nationality_name,
 ((pp.nationality_id IS NULL OR ci.id IS NULL)::int+(pp.display_name IS NULL)::int+(pp.arabic_name IS NULL)::int+(pp.gender IS NULL)::int+
 (pp.objective IS NULL OR btrim(pp.objective)='')::int+(p.email IS NULL OR btrim(p.email)='')::int+(pp.phone IS NULL)::int+(pp.birth_date IS NULL)::int+
 (cid.number_hash IS NULL OR cid.released_at IS NOT NULL)::int+(cid.expiry_date IS NULL OR cid.released_at IS NOT NULL)::int+(pp.driving_licence IS NULL)::int+
 (pl.area_id IS NULL)::int+((pp.nationality_id IS NOT NULL AND ci.code IS DISTINCT FROM 'KW') AND pp.kuwaiti_mother IS NULL)::int+
 (NOT EXISTS(SELECT 1 FROM candidate_profile_records r WHERE r.owner_principal_id=p.id AND r.kind='education' AND r.status='active'))::int+
 (NOT EXISTS(SELECT 1 FROM candidate_profile_records r WHERE r.owner_principal_id=p.id AND r.kind='skill' AND r.status='active'))::int)::int details_missing,
 CASE WHEN cid.released_at IS NOT NULL OR (cid.number_hash IS NULL AND cid.expiry_date IS NULL) THEN 'none'
  WHEN cid.needs_review THEN 'waiting' WHEN decision.decision='rejected' THEN 'rejected' WHEN cid.expiry_date < $8::date THEN 'expired'
  WHEN decision.decision='confirmed' THEN 'checked' ELSE 'recorded' END::text civil_state,
 (l.principal_id IS NOT NULL) imported,l.legacy_candidate_id::text,
 CASE WHEN pp.phone IS NULL THEN NULL ELSE right(pp.phone,4) END::text phone_last4
 FROM principals p LEFT JOIN person_profiles pp ON pp.principal_id=p.id LEFT JOIN legacy_account_links l ON l.principal_id=p.id
 LEFT JOIN catalogue_items ci ON ci.id=pp.nationality_id AND ci.catalogue_type='country' LEFT JOIN person_civil_ids cid ON cid.principal_id=p.id
 LEFT JOIN person_locations pl ON pl.principal_id=p.id LEFT JOIN LATERAL (SELECT d.decision FROM civil_id_review_decisions d WHERE d.subject_principal_id=p.id AND d.civil_revision=cid.revision ORDER BY d.decided_at DESC,d.id DESC LIMIT 1) decision ON true
 WHERE ($1::text IS NULL OR coalesce(pp.job_search_status,'unset')=$1::text) AND ($2::uuid IS NULL OR pp.nationality_id=$2::uuid)
 AND ($3::text IS NULL OR (CASE WHEN cid.released_at IS NOT NULL OR (cid.number_hash IS NULL AND cid.expiry_date IS NULL) THEN 'none' WHEN cid.needs_review THEN 'waiting' WHEN decision.decision='rejected' THEN 'rejected' WHEN cid.expiry_date<$8::date THEN 'expired' WHEN decision.decision='confirmed' THEN 'checked' ELSE 'recorded' END)=$3::text)
 AND ($4::text='' OR l.legacy_candidate_id=$5::text OR pp.phone=$6::text OR (length($7::text)>=4 AND reverse(pp.phone) LIKE reverse($7::text)||'%') OR pp.profile_handle=$9::text OR CASE WHEN $10::text<>'' THEN (to_tsvector('simple',coalesce(pp.display_name,'')||' '||coalesce(pp.arabic_name,'')) @@ to_tsquery('simple',$10::text) OR to_tsvector('simple',coalesce(p.display_name,'')) @@ to_tsquery('simple',$10::text)) ELSE false END)
 ), filtered AS (SELECT * FROM people WHERE ($11::text IS NULL OR ($11::text='complete' AND details_missing=0) OR ($11::text='missing' AND details_missing>0))),
 paged AS (SELECT * FROM filtered ORDER BY lower(name) COLLATE "C",principal_id LIMIT $12::integer OFFSET $13::integer), totals AS (SELECT count(*)::bigint total FROM filtered)
 SELECT paged.*,totals.total FROM totals LEFT JOIN paged ON true ORDER BY lower(paged.name) COLLATE "C",paged.principal_id`,[
   query.status??null,query.nationality??null,query.civil??null,q,search.employeeId,search.phone,search.phoneSuffix,today,search.handle,tokens,query.details??null,PEOPLE_PAGE_SIZE,(query.page-1)*PEOPLE_PAGE_SIZE]);
  const total=Number(result.rows[0]?.total??0),rows=result.rows.filter(r=>r.principal_id!==null).map(r=>({principalId:r.principal_id!,name:r.name,universeName:r.universe_name,arabicName:r.arabic_name,workStatus:r.work_status,nationality:r.nationality_id?{id:r.nationality_id,name:r.nationality_name!}:null,detailsMissing:r.details_missing!,civilState:r.civil_state!,imported:r.imported!,employeeId:r.legacy_candidate_id?`C${r.legacy_candidate_id.padStart(5,"0")}`:null,phoneLast4:r.phone_last4}));
  return {rows,total};
 }
}
