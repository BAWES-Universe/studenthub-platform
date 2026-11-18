import pg from "pg";
import { databaseUrl } from "../connection.js";

// Recruit R3: staff search over people looking for work, on the platform's tables.
// One query pages the matches; one more counts the total and every facet with the
// other facets' filters applied (disjunctive counts). "Complete" follows the same
// requirements the staff people directory counts as details missing.

type Grant = { org_id: string; role: string; scope: string };
type Availability = "active" | "open_to_offers";
type Gender = "male" | "female" | "other";
type Facet = "area" | "nationality" | "university" | "availability" | "drivingLicence" | "gender";

export interface RecruitPeopleSearchQuery {
  readonly q: string; readonly area: readonly string[]; readonly nationality: readonly string[]; readonly university: readonly string[];
  readonly availability: readonly Availability[]; readonly drivingLicence: readonly ("yes" | "no")[]; readonly gender: readonly Gender[];
  readonly includeIncomplete: boolean; readonly page: number;
}
export interface RecruitPeopleSearchRow {
  principal_id: string; name: string | null; arabic_name: string | null; objective: string | null; availability: Availability; gender: Gender | null;
  driving_licence: boolean | null; area_name: string | null; nationality_name: string | null; universities: string[]; complete: boolean;
}
export interface RecruitPeopleSearchFacetRow { facet: Facet; value: string; label: string | null; count: number }
export interface RecruitPeopleSearchOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
  readonly searchDecision: (rows: readonly Grant[]) => boolean;
  readonly tokens: (q: string) => string[];
  readonly pageSize: number;
}

const BASE = `WITH base AS (
 SELECT p.id::text AS principal_id, coalesce(pp.display_name, p.display_name)::text AS name, pp.arabic_name::text, pp.objective::text,
  pp.job_search_status::text AS availability, pp.gender::text, pp.driving_licence, pl.area_id, ai.name::text AS area_name, pp.nationality_id, ci.name::text AS nationality_name,
  coalesce((SELECT array_agg(DISTINCT (r.fields->>'universityId')::uuid) FROM candidate_profile_records r
    WHERE r.owner_principal_id = p.id AND r.kind = 'education' AND r.status = 'active' AND r.fields->>'universityId' ~ '^[0-9a-f-]{36}$'), '{}'::uuid[]) AS universities,
  ((pp.nationality_id IS NOT NULL AND ci.id IS NOT NULL) AND pp.display_name IS NOT NULL AND pp.arabic_name IS NOT NULL AND pp.gender IS NOT NULL
   AND btrim(coalesce(pp.objective, '')) <> '' AND btrim(coalesce(p.email, '')) <> '' AND pp.phone IS NOT NULL AND pp.birth_date IS NOT NULL
   AND cid.number_hash IS NOT NULL AND cid.expiry_date IS NOT NULL AND cid.released_at IS NULL AND pp.driving_licence IS NOT NULL AND pl.area_id IS NOT NULL
   AND NOT (ci.code IS DISTINCT FROM 'KW' AND pp.kuwaiti_mother IS NULL)
   AND EXISTS (SELECT 1 FROM candidate_profile_records r WHERE r.owner_principal_id = p.id AND r.kind = 'education' AND r.status = 'active')
   AND EXISTS (SELECT 1 FROM candidate_profile_records r WHERE r.owner_principal_id = p.id AND r.kind = 'skill' AND r.status = 'active')) AS complete
 FROM person_profiles pp JOIN principals p ON p.id = pp.principal_id
 LEFT JOIN catalogue_items ci ON ci.id = pp.nationality_id AND ci.catalogue_type = 'country'
 LEFT JOIN person_locations pl ON pl.principal_id = p.id LEFT JOIN catalogue_items ai ON ai.id = pl.area_id
 LEFT JOIN person_civil_ids cid ON cid.principal_id = p.id
 WHERE pp.job_search_status IN ('active', 'open_to_offers')
  AND ($1::text = '' OR to_tsvector('simple', coalesce(pp.display_name, '') || ' ' || coalesce(pp.arabic_name, '')) @@ to_tsquery('simple', $1::text)
   OR to_tsvector('simple', coalesce(p.display_name, '')) @@ to_tsquery('simple', $1::text))
), f AS (
 SELECT base.*,
  (cardinality($2::uuid[]) = 0 OR area_id = ANY($2::uuid[])) AS fa,
  (cardinality($3::uuid[]) = 0 OR nationality_id = ANY($3::uuid[])) AS fn,
  (cardinality($4::uuid[]) = 0 OR universities && $4::uuid[]) AS fu,
  (cardinality($5::text[]) = 0 OR availability = ANY($5::text[])) AS fv,
  (cardinality($6::text[]) = 0 OR (CASE WHEN driving_licence THEN 'yes' WHEN NOT driving_licence THEN 'no' END) = ANY($6::text[])) AS fd,
  (cardinality($7::text[]) = 0 OR gender = ANY($7::text[])) AS fg
 FROM base WHERE ($8::boolean OR complete)
)`;

export class PostgresRecruitPeopleSearchStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(readonly options: RecruitPeopleSearchOptions) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }

  /** A page of matches, the total and the facet counts; null when the searcher may not search people. */
  async search(principalId: string, query: RecruitPeopleSearchQuery): Promise<{ rows: RecruitPeopleSearchRow[]; total: number; facets: RecruitPeopleSearchFacetRow[] } | null> {
    const grants = (await this.#pool.query<Grant>("SELECT org_id, role, scope FROM grants WHERE principal_id = $1::text", [principalId])).rows;
    if (!this.options.searchDecision(grants)) return null;
    const tokens = this.options.tokens(query.q).map((t) => `${t}:*`).join(" & ");
    const params = [tokens, query.area, query.nationality, query.university, query.availability, query.drivingLicence, query.gender, query.includeIncomplete];
    const [page, counts] = await Promise.all([
      this.#pool.query<RecruitPeopleSearchRow>(`${BASE}
 SELECT principal_id, name, arabic_name, objective, availability, gender, driving_licence, area_name, nationality_name, complete,
  coalesce((SELECT array_agg(u.name::text ORDER BY u.name) FROM catalogue_items u WHERE u.id = ANY(f.universities) AND u.catalogue_type = 'university'), '{}'::text[]) AS universities
 FROM f WHERE fa AND fn AND fu AND fv AND fd AND fg
 ORDER BY complete DESC, lower(coalesce(name, '')) COLLATE "C", principal_id LIMIT $9::integer OFFSET $10::integer`, [...params, this.options.pageSize, (query.page - 1) * this.options.pageSize]),
      this.#pool.query<RecruitPeopleSearchFacetRow & { count: string }>(`${BASE}
 SELECT 'total' AS facet, '' AS value, NULL::text AS label, count(*) AS count FROM f WHERE fa AND fn AND fu AND fv AND fd AND fg
 UNION ALL SELECT 'area', area_id::text, max(area_name), count(*) FROM f WHERE fn AND fu AND fv AND fd AND fg AND area_id IS NOT NULL GROUP BY area_id
 UNION ALL SELECT 'nationality', nationality_id::text, max(nationality_name), count(*) FROM f WHERE fa AND fu AND fv AND fd AND fg AND nationality_id IS NOT NULL GROUP BY nationality_id
 UNION ALL SELECT 'university', u.id::text, max(u.name)::text, count(*) FROM f CROSS JOIN LATERAL unnest(f.universities) AS uid JOIN catalogue_items u ON u.id = uid AND u.catalogue_type = 'university'
  WHERE fa AND fn AND fv AND fd AND fg GROUP BY u.id
 UNION ALL SELECT 'availability', availability, NULL, count(*) FROM f WHERE fa AND fn AND fu AND fd AND fg GROUP BY availability
 UNION ALL SELECT 'drivingLicence', CASE WHEN driving_licence THEN 'yes' ELSE 'no' END, NULL, count(*) FROM f WHERE fa AND fn AND fu AND fv AND fg AND driving_licence IS NOT NULL GROUP BY driving_licence
 UNION ALL SELECT 'gender', gender, NULL, count(*) FROM f WHERE fa AND fn AND fu AND fv AND fd AND gender IS NOT NULL GROUP BY gender`, params),
    ]);
    const total = Number(counts.rows.find((r) => (r.facet as string) === "total")?.count ?? 0);
    const facets = counts.rows.filter((r) => (r.facet as string) !== "total").map((r) => ({ facet: r.facet, value: r.value, label: r.label, count: Number(r.count) }));
    return { rows: page.rows, total, facets };
  }
}
