import pg from "pg";
import { databaseUrl } from "./connection.js";
type PeopleWorkStatus="not_looking"|"active"|"open_to_offers"|"unset";type PeopleCivilState="none"|"waiting"|"rejected"|"expired"|"checked"|"recorded";
type PeopleDirectoryQuery={q?:string;status?:PeopleWorkStatus;nationality?:string;civil?:PeopleCivilState;details?:"complete"|"missing";page:number};
type PeopleDirectoryRow={principalId:string;name:string|null;universeName:string|null;arabicName:string|null;workStatus:Exclude<PeopleWorkStatus,"unset">|null;nationality:{id:string;name:string}|null;detailsMissing:number;civilState:PeopleCivilState;imported:boolean;employeeId:string|null;phoneLast4:string|null};
interface PeopleDirectoryStore{page(query:PeopleDirectoryQuery,today:string):Promise<{rows:PeopleDirectoryRow[];total:number}>}const PEOPLE_PAGE_SIZE=25;
const digits=(s:string)=>s.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,c=>String(c.charCodeAt(0)%16));
export function classifyDirectorySearchTerm(input:string){const q=input.trim().normalize("NFC"),employee=/^c(\d+)$/i.exec(q),candidate=digits(q),digitOnly=/^[0-9\s()+-]+$/.test(candidate),compact=digitOnly?candidate.replace(/[^0-9]/g,""):"";let normalized:string|null=null;if(digitOnly&&[...candidate].length<=32){const raw=candidate.replace(/[ ()-]/g,"");const international=raw.startsWith("+")||raw.startsWith("00"),ds=raw.startsWith("+")?raw.slice(1):raw.startsWith("00")?raw.slice(2):raw;const value=ds.length===8&&!international?`+965${ds}`:international||ds.startsWith("965")?`+${ds}`:raw;if(/^\+[0-9]{8,15}$/.test(value))normalized=value;}const handle=/^(?:https?:\/\/[^/]+\/profile\/|@)([a-z][a-z0-9._-]{2,29})\/?$/i.exec(q)??/^([a-z][a-z0-9._-]{2,29})$/i.exec(q);return{employeeId:employee?String(BigInt(employee[1]!)):null,fullPhone:normalized,phoneSuffix:digitOnly&&!normalized&&compact.length>=4?compact:null,handle:handle?.[1]?.toLowerCase()??null,nameTokens:[...q.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map(m=>m[0]!)}};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQL=`WITH people AS (
 SELECT p.id::text principal_id,pp.display_name,p.display_name universe_name,pp.arabic_name,pp.job_search_status,
  ci.id::text nationality_id,ci.name nationality_name,l.legacy_candidate_id,
  CASE WHEN pp.phone IS NULL THEN NULL ELSE right(pp.phone,4) END phone_last4,
  (l.principal_id IS NOT NULL) imported,
  CASE WHEN civ.released_at IS NOT NULL OR (civ.number_hash IS NULL AND civ.expiry_date IS NULL) THEN 'none'
       WHEN civ.needs_review THEN 'waiting' WHEN dec.decision='rejected' THEN 'rejected'
       WHEN civ.expiry_date<$11::date THEN 'expired' WHEN dec.decision='confirmed' THEN 'checked' ELSE 'recorded' END civil_state,
  ((ci.id IS NULL)::int+(nullif(btrim(pp.display_name),'') IS NULL)::int+(nullif(btrim(pp.arabic_name),'') IS NULL)::int+
   (pp.gender IS NULL)::int+(nullif(btrim(pp.objective),'') IS NULL)::int+(nullif(btrim(p.email),'') IS NULL)::int+
   (pp.phone IS NULL)::int+(pp.birth_date IS NULL)::int+(civ.number_hash IS NULL OR civ.released_at IS NOT NULL)::int+
   (civ.expiry_date IS NULL OR civ.released_at IS NOT NULL)::int+(pp.driving_licence IS NULL)::int+
   (loc.area_id IS NULL)::int+((ci.id IS NOT NULL AND ci.code IS DISTINCT FROM 'KW' AND pp.kuwaiti_mother IS NULL))::int+
   (NOT EXISTS(SELECT 1 FROM candidate_profile_records r WHERE r.owner_principal_id=p.id AND r.kind='education' AND r.status='active'))::int+
   (NOT EXISTS(SELECT 1 FROM candidate_profile_records r WHERE r.owner_principal_id=p.id AND r.kind='skill' AND r.status='active'))::int) details_missing
 FROM person_profiles pp JOIN principals p ON p.id=pp.principal_id
 LEFT JOIN catalogue_items ci ON ci.id=pp.nationality_id AND ci.catalogue_type='country'
 LEFT JOIN legacy_account_links l ON l.principal_id=p.id
 LEFT JOIN person_locations loc ON loc.principal_id=p.id
 LEFT JOIN person_civil_ids civ ON civ.principal_id=p.id
 LEFT JOIN LATERAL (SELECT d.decision FROM civil_id_review_decisions d WHERE d.subject_principal_id=p.id AND d.civil_revision=civ.revision ORDER BY d.decided_at DESC,d.id DESC LIMIT 1) dec ON true
 WHERE ($12::boolean=false OR l.legacy_candidate_id=$1::text OR pp.phone=$2::text OR reverse(pp.phone) LIKE $3::text OR pp.profile_handle=$4::text OR
   to_tsvector('simple',coalesce(pp.display_name,'')||' '||coalesce(pp.arabic_name,'')) @@ to_tsquery('simple',$5::text) OR
   to_tsvector('simple',coalesce(p.display_name,'')) @@ to_tsquery('simple',$5::text)) AND ($7::uuid IS NULL OR pp.nationality_id=$7::uuid)
), filtered AS (SELECT * FROM people WHERE ($6::text IS NULL OR CASE WHEN $6::text='unset' THEN job_search_status IS NULL ELSE job_search_status=$6::text END)
 AND ($8::text IS NULL OR civil_state=$8::text)
 AND ($9::text IS NULL OR ($9::text='complete' AND details_missing=0) OR ($9::text='missing' AND details_missing>0))),
paged AS (SELECT * FROM filtered ORDER BY lower(coalesce(display_name,universe_name,'')) COLLATE "C",principal_id LIMIT $10::integer OFFSET $13::integer)
SELECT (SELECT count(*)::integer FROM filtered) total,coalesce((SELECT jsonb_agg(jsonb_build_object('principalId',principal_id,'name',coalesce(display_name,universe_name),'universeName',universe_name,'arabicName',arabic_name,'workStatus',job_search_status,'nationality',CASE WHEN nationality_id IS NULL THEN NULL ELSE jsonb_build_object('id',nationality_id,'name',nationality_name) END,'detailsMissing',details_missing,'civilState',civil_state,'imported',imported,'employeeId',CASE WHEN legacy_candidate_id IS NULL THEN NULL ELSE 'C'||lpad(legacy_candidate_id,5,'0') END,'phoneLast4',phone_last4) ORDER BY lower(coalesce(display_name,universe_name,'')) COLLATE "C",principal_id) FROM paged),'[]'::jsonb) rows`;

export class PostgresPeopleDirectoryStore implements PeopleDirectoryStore {
 readonly #pool:pg.Pool;readonly #owns:boolean;
 constructor(options:{pool?:pg.Pool;connectionString?:string}={}){this.#owns=!options.pool;this.#pool=options.pool??new pg.Pool({connectionString:options.connectionString??databaseUrl()});}
 async close(){if(this.#owns)await this.#pool.end();}
 async page(query:PeopleDirectoryQuery,today:string):Promise<{rows:PeopleDirectoryRow[];total:number}>{
  if(!Number.isInteger(query.page)||query.page<1)throw new TypeError("page must be a whole number of 1 or more");
  if(query.nationality!==undefined&&!UUID.test(query.nationality))throw new TypeError("nationality must be a uuid");
  const q=query.q?.trim()??"";if([...q].length>200)throw new TypeError("q must be at most 200 characters");
  const c=classifyDirectorySearchTerm(q);const ts=c.nameTokens.length?c.nameTokens.map(t=>`${t}:*`).join(" & "):"";
  const active=q!=="";const suffix=c.phoneSuffix?`${[...c.phoneSuffix].reverse().join("")}%`:null;
  const {rows}=await this.#pool.query<{total:number;rows:PeopleDirectoryRow[]}>(SQL,[c.employeeId,c.fullPhone,suffix,c.handle,ts,query.status??null,query.nationality??null,query.civil??null,query.details??null,PEOPLE_PAGE_SIZE,today,active,(query.page-1)*PEOPLE_PAGE_SIZE]);
  return {rows:rows[0]?.rows??[],total:rows[0]?.total??0};
 }
}
