import {
  CANDIDATE_SEARCH_FACETS,
  type CandidateSearchAdapter,
  type CandidateSearchConstraints,
  type CandidateSearchDocument,
  type CandidateSearchFacet,
  type CandidateSearchFacetCounts,
  type CandidateSearchFilters,
  type CandidateSearchRequest,
  type CandidateSearchResult,
  type CandidateSearchScope,
  type CandidateSearchSort,
} from "@studenthub/contracts";

const FIELD_BY_FACET = {
  country: "country",
  university: "university",
  company: "company",
  skill: "skills",
  gender: "gender",
  profile: "profile",
  assignment: "assignment",
  document: "documents",
} as const satisfies Record<CandidateSearchFacet, string>;

const SORT_BY = {
  relevance: undefined,
  "score-ascending": "score:asc",
  "score-descending": "score:desc",
  "updated-descending": "updatedAtEpoch:desc",
} as const satisfies Record<CandidateSearchSort, string | undefined>;

interface TypesenseHit {
  readonly document: unknown;
}

interface TypesenseFacetCount {
  readonly field_name: string;
  readonly counts: readonly { readonly value: string; readonly count: number }[];
}

interface TypesenseSearchResult {
  readonly found?: number;
  readonly hits?: readonly TypesenseHit[];
  readonly facet_counts?: readonly TypesenseFacetCount[];
  readonly error?: string;
  readonly code?: number;
}

interface TypesenseMultiSearchResponse {
  readonly results?: readonly TypesenseSearchResult[];
}

interface TypesenseSearchParameters {
  readonly collection: string;
  readonly q: string;
  readonly query_by: string;
  readonly filter_by?: string;
  readonly facet_by?: string;
  readonly max_facet_values?: number;
  readonly page: number;
  readonly per_page: number;
  readonly sort_by?: string;
}

export interface TypesenseCandidateSearchConfig {
  readonly url: string;
  readonly apiKey: string;
  readonly collection?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class CandidateSearchUnavailableError extends Error {
  readonly name = "CandidateSearchUnavailableError";
}

export class TypesenseCandidateSearchAdapter implements CandidateSearchAdapter {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #collection: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: TypesenseCandidateSearchConfig) {
    const endpoint = new URL(config.url);
    const loopback = endpoint.hostname === "localhost"
      || endpoint.hostname === "[::1]"
      || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
      throw new TypeError("Typesense endpoint must use HTTPS unless it is loopback");
    }
    if (!config.apiKey.trim()) throw new TypeError("Typesense API key is required");
    const collection = config.collection ?? "studenthub_candidates";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(collection)) throw new TypeError("invalid Typesense collection name");
    const timeoutMs = config.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new TypeError("Typesense timeout must be between 100 and 60000 milliseconds");
    }
    this.#baseUrl = endpoint.toString().replace(/\/$/, "");
    this.#apiKey = config.apiKey;
    this.#collection = collection;
    this.#timeoutMs = timeoutMs;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async search(request: CandidateSearchRequest): Promise<CandidateSearchResult> {
    const page = positiveInteger(request.page ?? 1, "page", 10_000);
    const pageSize = positiveInteger(request.pageSize ?? 25, "pageSize", 250);
    const query = (request.query ?? "").trim();
    if (query.length > 500) throw new TypeError("search query must not exceed 500 characters");
    if (request.sort !== undefined && !(request.sort in SORT_BY)) throw new TypeError("candidate search sort is invalid");
    const filters = normalizeFilters(request.filters === undefined ? {} : request.filters);
    const constraints = normalizeConstraints(request.constraints === undefined ? {} : request.constraints);
    const visibleIds = scopeIds(request.scope);
    if (visibleIds?.length === 0) return emptyResult(page, pageSize, filters);

    const common = {
      collection: this.#collection,
      q: query || "*",
      query_by: "name,email,phone,skills",
    } as const;
    const sort = SORT_BY[request.sort ?? "relevance"];
    const main: TypesenseSearchParameters = {
      ...common,
      ...optionalFilter(typesenseFilter(filters, constraints, visibleIds)),
      ...(sort ? { sort_by: sort } : {}),
      page,
      per_page: pageSize,
    };
    const facetSearches = CANDIDATE_SEARCH_FACETS.map((facet) => ({
      ...common,
      ...optionalFilter(typesenseFilter(filters, constraints, visibleIds, facet)),
      facet_by: FIELD_BY_FACET[facet],
      max_facet_values: 100,
      page: 1,
      per_page: 1,
    }));

    const response = await this.#request({ searches: [main, ...facetSearches] }, request.signal);
    if (!Array.isArray(response.results) || response.results.length !== 1 + CANDIDATE_SEARCH_FACETS.length) {
      throw new CandidateSearchUnavailableError("Typesense returned an invalid multi-search response");
    }
    const [mainResult, ...facetResults] = response.results;
    if (!Array.isArray(mainResult?.hits)) {
      throw new CandidateSearchUnavailableError("Typesense returned invalid search hits");
    }
    const hits = mainResult.hits.map((hit: TypesenseHit) => parseDocument(hit.document));
    const total = mainResult?.found;
    if (!Number.isSafeInteger(total) || (total ?? -1) < 0) {
      throw new CandidateSearchUnavailableError("Typesense returned an invalid result count");
    }
    const facets = Object.fromEntries(CANDIDATE_SEARCH_FACETS.map((facet, index) => [
      facet,
      facetOptions(facetResults[index], FIELD_BY_FACET[facet], filters[facet] ?? []),
    ])) as CandidateSearchFacetCounts;
    return { hits, total: total as number, page, pageSize, facets };
  }

  async #request(body: unknown, callerSignal?: AbortSignal): Promise<TypesenseMultiSearchResponse> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(this.#timeoutMs)])
      : AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/multi_search`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-TYPESENSE-API-KEY": this.#apiKey },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw new CandidateSearchUnavailableError("Typesense request failed", { cause: error });
    }
    if (!response.ok) throw new CandidateSearchUnavailableError(`Typesense request failed with status ${response.status}`);
    let payload: TypesenseMultiSearchResponse;
    try {
      payload = await response.json() as TypesenseMultiSearchResponse;
    } catch (error) {
      throw new CandidateSearchUnavailableError("Typesense returned invalid JSON", { cause: error });
    }
    const failed = payload.results?.find((result) => result.error || (result.code !== undefined && result.code >= 400));
    if (failed) throw new CandidateSearchUnavailableError(`Typesense search failed with status ${failed.code ?? "unknown"}`);
    return payload;
  }
}

function normalizeFilters(filters: CandidateSearchFilters): Partial<Record<CandidateSearchFacet, readonly string[]>> {
  if (!isRecord(filters)) throw new TypeError("candidate search filters must be an object");
  const normalized: Partial<Record<CandidateSearchFacet, readonly string[]>> = {};
  for (const facet of CANDIDATE_SEARCH_FACETS) {
    const rawValues = filters[facet];
    if (rawValues !== undefined && !isStringArray(rawValues)) throw new TypeError(`${facet} filter must be an array`);
    const values = [...new Set((rawValues ?? []).map((value) => value.trim()).filter(Boolean))];
    if (values.length > 100) throw new TypeError(`${facet} filter must not exceed 100 values`);
    if (values.some((value) => value.length > 200)) throw new TypeError(`${facet} filter values must not exceed 200 characters`);
    values.forEach(validateFilterLiteral);
    if (values.length) normalized[facet] = values;
  }
  return normalized;
}

function normalizeVisibleIds(values: readonly string[] | undefined): readonly string[] | undefined {
  if (values === undefined) return undefined;
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (normalized.length > 10_000) throw new TypeError("visible candidate scope must not exceed 10000 ids");
  if (normalized.some((value) => value.length > 128)) throw new TypeError("visible candidate ids must not exceed 128 characters");
  normalized.forEach(validateFilterLiteral);
  return normalized;
}

function scopeIds(scope: CandidateSearchScope): readonly string[] | undefined {
  if (!isRecord(scope) || (scope.kind !== "all" && scope.kind !== "candidate-ids")) {
    throw new TypeError("candidate search requires an explicit authorization scope");
  }
  if (scope.kind === "all") return undefined;
  if (!isStringArray(scope.ids)) throw new TypeError("candidate-id scope must contain string ids");
  return normalizeVisibleIds(scope.ids);
}

function normalizeConstraints(value: CandidateSearchConstraints): CandidateSearchConstraints {
  if (!isRecord(value)) throw new TypeError("candidate search constraints must be an object");
  if (value.status !== undefined
    && (!isStringArray(value.status) || value.status.some((status) => status !== "active" && status !== "inactive"))) {
    throw new TypeError("candidate status constraints are invalid");
  }
  if (value.approved !== undefined && typeof value.approved !== "boolean") {
    throw new TypeError("candidate approval constraint must be boolean");
  }
  return value;
}

function typesenseFilter(
  filters: Partial<Record<CandidateSearchFacet, readonly string[]>>,
  constraints: CandidateSearchConstraints,
  visibleIds?: readonly string[],
  excludedFacet?: CandidateSearchFacet,
): string {
  const clauses: string[] = [];
  if (visibleIds) clauses.push(`id:=[${visibleIds.map(quoted).join(",")}]`);
  if (constraints.status?.length) {
    const statuses = [...new Set(constraints.status)];
    clauses.push(`status:=[${statuses.map(quoted).join(",")}]`);
  }
  if (constraints.approved !== undefined) clauses.push(`approved:=${String(constraints.approved)}`);
  for (const facet of CANDIDATE_SEARCH_FACETS) {
    if (facet === excludedFacet) continue;
    const values = filters[facet];
    if (values?.length) clauses.push(`${FIELD_BY_FACET[facet]}:=[${values.map(quoted).join(",")}]`);
  }
  return clauses.join(" && ");
}

function quoted(value: string): string {
  return `\`${value.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
}

function validateFilterLiteral(value: string): void {
  if (/[`\\\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("candidate search filter values contain unsupported syntax characters");
  }
}

function optionalFilter(value: string): { readonly filter_by?: string } {
  return value ? { filter_by: value } : {};
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function facetOptions(
  result: TypesenseSearchResult | undefined,
  expectedField: string,
  activeValues: readonly string[],
): readonly { readonly value: string; readonly count: number; readonly active: boolean }[] {
  if (!Array.isArray(result?.facet_counts)) {
    throw new CandidateSearchUnavailableError(`Typesense omitted facet counts for ${expectedField}`);
  }
  const facet = result?.facet_counts?.find((candidate) => candidate.field_name === expectedField);
  if (!facet) {
    return activeValues.map((value) => ({ value, count: 0, active: true }));
  }
  if (!Array.isArray(facet.counts)) {
    throw new CandidateSearchUnavailableError(`Typesense returned invalid facet counts for ${expectedField}`);
  }
  const counts = new Map<string, number>();
  for (const item of facet.counts as readonly unknown[]) {
    if (!isRecord(item)
      || typeof item.value !== "string"
      || !Number.isSafeInteger(item.count)
      || (item.count as number) < 0) {
      throw new CandidateSearchUnavailableError(`Typesense returned invalid facet values for ${expectedField}`);
    }
    counts.set(item.value, item.count as number);
  }
  for (const value of activeValues) if (!counts.has(value)) counts.set(value, 0);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, active: activeValues.includes(value) }))
    .sort((left, right) => Number(right.active) - Number(left.active) || right.count - left.count || left.value.localeCompare(right.value));
}

function emptyResult(
  page: number,
  pageSize: number,
  filters: Partial<Record<CandidateSearchFacet, readonly string[]>>,
): CandidateSearchResult {
  const facets = Object.fromEntries(CANDIDATE_SEARCH_FACETS.map((facet) => [
    facet,
    (filters[facet] ?? []).map((value) => ({ value, count: 0, active: true })),
  ])) as unknown as CandidateSearchFacetCounts;
  return { hits: [], total: 0, page, pageSize, facets };
}

function parseDocument(value: unknown): CandidateSearchDocument {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || typeof value.email !== "string"
    || typeof value.phone !== "string"
    || typeof value.country !== "string"
    || typeof value.university !== "string"
    || (value.company !== undefined && typeof value.company !== "string")
    || !isStringArray(value.skills)
    || !["male", "female", "other", "not-set"].includes(String(value.gender))
    || !["complete", "incomplete"].includes(String(value.profile))
    || !["assigned", "unassigned"].includes(String(value.assignment))
    || !isStringArray(value.documents)
    || !value.documents.every((item) => ["resume", "no-resume", "civil-id"].includes(item))
    || !["active", "inactive"].includes(String(value.status))
    || typeof value.approved !== "boolean"
    || typeof value.score !== "number"
    || typeof value.updatedAtEpoch !== "number") {
    throw new CandidateSearchUnavailableError("Typesense returned an invalid candidate document");
  }
  return value as unknown as CandidateSearchDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
