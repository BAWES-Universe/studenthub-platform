import pg from "pg";
import { databaseUrl } from "./connection.js";

type PeopleWorkStatus = "not_looking" | "active" | "open_to_offers" | "unset";
type PeopleCivilState = "none" | "waiting" | "rejected" | "expired" | "checked" | "recorded";
interface PeopleDirectoryQuery { q?: string; status?: PeopleWorkStatus; nationality?: string; civil?: PeopleCivilState; details?: "complete" | "missing"; page: number }
interface PeopleDirectoryRow { principalId: string; name: string | null; universeName: string | null; arabicName: string | null; workStatus: Exclude<PeopleWorkStatus, "unset"> | null; nationality: { id: string; name: string } | null; detailsMissing: number; civilState: PeopleCivilState; imported: boolean; employeeId: string | null; phoneLast4: string | null }
interface PeopleDirectoryStore { page(query: PeopleDirectoryQuery, today: string): Promise<{ rows: PeopleDirectoryRow[]; total: number }> }
const PEOPLE_PAGE_SIZE = 25;
const searchDigits = (value: string) => value.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, character => String(character.charCodeAt(0) - (character <= "\u0669" ? 0x0660 : 0x06f0)));
function classifySearchTerm(q: string) {
  const raw=q.trim().normalize("NFC"),employee=/^c([0-9]+)$/i.exec(raw),candidate=searchDigits(raw),compact=candidate.replace(/[ ()-]/g,""),international=compact.startsWith("+")||compact.startsWith("00"),digits=compact.startsWith("+")?compact.slice(1):compact.startsWith("00")?compact.slice(2):compact;
  const normalized=digits.length===8&&!international?`+965${digits}`:international||digits.startsWith("965")?`+${digits}`:compact;
  const fullPhone=/^\+[0-9]{8,15}$/.test(normalized)?normalized:null,phoneLike=/^[+0-9 ()-]+$/.test(candidate),phoneDigits=candidate.replace(/[^0-9]/g,"");
  const link=/^(?:https?:\/\/[^/]+\/profile\/|\/profile\/|@)([a-z][a-z0-9._-]{2,29})\/?$/i.exec(raw),plain=/^[a-z][a-z0-9._-]{2,29}$/i.test(raw)&&/[._-]/.test(raw)?raw:null;
  return {employeeId:employee?String(Number(employee[1])):null,fullPhone,phoneSuffix:phoneLike&&!fullPhone&&phoneDigits.length>=4?phoneDigits:null,handle:(link?.[1]??plain)?.toLowerCase()??null,nameTokens:[...raw.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map(match=>match[0]!)};
}

type Row = {
  principal_id: string | null; name: string | null; universe_name: string | null; arabic_name: string | null;
  work_status: Exclude<PeopleWorkStatus, "unset"> | null; nationality_id: string | null; nationality_name: string | null;
  details_missing: number | string | null; civil_state: PeopleCivilState | null; imported: boolean | null;
  employee_id: string | null; phone_last4: string | null; total: number | string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedStatus = new Set<PeopleWorkStatus>(["not_looking", "active", "open_to_offers", "unset"]);
const allowedCivil = new Set<PeopleCivilState>(["none", "waiting", "rejected", "expired", "checked", "recorded"]);

export class PostgresPeopleDirectoryStore implements PeopleDirectoryStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) { this.#owns = !options.pool; this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() }); }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  async page(query: PeopleDirectoryQuery, today: string): Promise<{ rows: PeopleDirectoryRow[]; total: number }> {
    if (!Number.isInteger(query.page) || query.page < 1) throw new TypeError("People directory page must be a whole number of 1 or more");
    if (query.nationality !== undefined && !UUID.test(query.nationality)) throw new TypeError("People directory nationality must be a UUID");
    if (query.status !== undefined && !allowedStatus.has(query.status)) throw new TypeError("Invalid people work status");
    if (query.civil !== undefined && !allowedCivil.has(query.civil)) throw new TypeError("Invalid people civil state");
    if (query.details !== undefined && query.details !== "complete" && query.details !== "missing") throw new TypeError("Invalid people details filter");
    const q = query.q?.trim() ?? "";
    if ([...q].length > 200) throw new TypeError("People directory search is limited to 200 characters");
    const search = q === "" ? null : classifySearchTerm(q);
    const tsquery = search?.nameTokens.length ? search.nameTokens.map(token => `${token}:*`).join(" & ") : null;
    const values = [search?.employeeId ?? null, search?.fullPhone ?? null, search?.phoneSuffix ?? null, search?.handle ?? null, tsquery,
      query.status ?? null, query.nationality ?? null, query.civil ?? null, query.details ?? null, today, (query.page - 1) * PEOPLE_PAGE_SIZE, PEOPLE_PAGE_SIZE, search !== null];
    const result = await this.#pool.query<Row>(`WITH directory AS (
 SELECT p.id::text principal_id,COALESCE(pp.display_name,p.display_name) name,p.display_name universe_name,pp.arabic_name,
  pp.job_search_status work_status,ci.id::text nationality_id,ci.name nationality_name,
  ((pp.nationality_id IS NULL OR ci.id IS NULL)::int+(NULLIF(btrim(pp.display_name),'') IS NULL)::int+(NULLIF(btrim(pp.arabic_name),'') IS NULL)::int+
   (pp.gender IS NULL)::int+(NULLIF(btrim(pp.objective),'') IS NULL)::int+(NULLIF(btrim(p.email),'') IS NULL)::int+(pp.phone IS NULL)::int+
   (pp.birth_date IS NULL)::int+(c.number_hash IS NULL OR c.released_at IS NOT NULL)::int+(c.expiry_date IS NULL OR c.released_at IS NOT NULL)::int+
   (pp.driving_licence IS NULL)::int+(loc.area_id IS NULL)::int+
   ((ci.code IS DISTINCT FROM 'KW') AND pp.kuwaiti_mother IS NULL)::int+
   (NOT EXISTS(SELECT 1 FROM candidate_profile_records e WHERE e.owner_principal_id=p.id AND e.kind='education' AND e.status='active'))::int+
   (NOT EXISTS(SELECT 1 FROM candidate_profile_records s WHERE s.owner_principal_id=p.id AND s.kind='skill' AND s.status='active'))::int) details_missing,
  CASE WHEN c.principal_id IS NULL OR c.released_at IS NOT NULL OR (c.number_hash IS NULL AND c.expiry_date IS NULL) THEN 'none'
   WHEN c.needs_review THEN 'waiting' WHEN decision.decision='rejected' THEN 'rejected'
   WHEN c.expiry_date<$10::date THEN 'expired' WHEN decision.decision='confirmed' THEN 'checked' ELSE 'recorded' END civil_state,
  (link.principal_id IS NOT NULL) imported,CASE WHEN link.legacy_candidate_id IS NULL THEN NULL ELSE 'C'||lpad(link.legacy_candidate_id,5,'0') END employee_id,
  CASE WHEN pp.phone IS NULL THEN NULL ELSE right(pp.phone,4) END phone_last4,
  lower(COALESCE(pp.display_name,p.display_name)) COLLATE "C" sort_name
 FROM principals p JOIN person_profiles pp ON pp.principal_id=p.id
 LEFT JOIN catalogue_items ci ON ci.id=pp.nationality_id AND ci.catalogue_type='country' AND ci.status='active'
 LEFT JOIN person_locations loc ON loc.principal_id=p.id LEFT JOIN person_civil_ids c ON c.principal_id=p.id
 LEFT JOIN LATERAL (SELECT d.decision FROM civil_id_review_decisions d WHERE d.subject_principal_id=p.id AND d.civil_revision=c.revision ORDER BY d.decided_at DESC,d.id DESC LIMIT 1) decision ON true
 LEFT JOIN legacy_account_links link ON link.principal_id=p.id
 WHERE ($13::boolean=false OR
   ($1::text IS NOT NULL AND link.legacy_candidate_id=$1::text) OR
   ($2::text IS NOT NULL AND pp.phone=$2::text) OR
   ($3::text IS NOT NULL AND reverse(pp.phone) LIKE reverse($3::text)||'%') OR
   ($4::text IS NOT NULL AND pp.profile_handle=$4::text) OR
   ($5::text IS NOT NULL AND (to_tsvector('simple',coalesce(pp.display_name,'')||' '||coalesce(pp.arabic_name,''))@@to_tsquery('simple',$5::text) OR to_tsvector('simple',coalesce(p.display_name,''))@@to_tsquery('simple',$5::text))))
   AND ($7::uuid IS NULL OR pp.nationality_id=$7::uuid)
 ), filtered AS (
 SELECT * FROM directory WHERE ($6::text IS NULL OR ($6::text='unset' AND work_status IS NULL) OR work_status=$6::text)
  AND ($8::text IS NULL OR civil_state=$8::text)
  AND ($9::text IS NULL OR ($9::text='complete' AND details_missing=0) OR ($9::text='missing' AND details_missing>0))
 ), counted AS (SELECT count(*)::int total FROM filtered), paged AS (
 SELECT * FROM filtered ORDER BY sort_name,principal_id OFFSET $11::integer LIMIT $12::integer
 ) SELECT paged.*,counted.total FROM counted LEFT JOIN paged ON true ORDER BY paged.sort_name,paged.principal_id`, values);
    const total = Number(result.rows[0]?.total ?? 0);
    return { total, rows: result.rows.filter(row => row.principal_id !== null).map(row => ({
      principalId: row.principal_id!, name: row.name, universeName: row.universe_name, arabicName: row.arabic_name, workStatus: row.work_status,
      nationality: row.nationality_id === null ? null : { id: row.nationality_id, name: row.nationality_name! }, detailsMissing: Number(row.details_missing), civilState: row.civil_state!,
      imported: row.imported!, employeeId: row.employee_id, phoneLast4: row.phone_last4,
    })) };
  }
}
