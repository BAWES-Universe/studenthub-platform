import { FACET_FIELDS, type FacetCounts, type FacetField, type QueryCase, type SearchCandidate } from "./dataset.js";

export interface SearchResult {
  readonly ids: readonly string[];
  readonly total: number;
  readonly facets: FacetCounts;
}

export interface SearchEngine {
  readonly name: "Meilisearch" | "Typesense";
  resetAndIndex(documents: readonly SearchCandidate[]): Promise<void>;
  search(query: QueryCase): Promise<SearchResult>;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed (${response.status}): ${text.slice(0, 500)}`);
  return text.length === 0 ? undefined as T : JSON.parse(text) as T;
}

function meiliFilter(filters: QueryCase["filters"]): readonly string[] {
  const entries: string[] = [];
  if (filters.country) entries.push(`country = ${JSON.stringify(filters.country)}`);
  if (filters.university) entries.push(`university = ${JSON.stringify(filters.university)}`);
  if (filters.company) entries.push(`company = ${JSON.stringify(filters.company)}`);
  if (filters.gender) entries.push(`gender = ${JSON.stringify(filters.gender)}`);
  if (filters.profile) entries.push(`profile = ${JSON.stringify(filters.profile)}`);
  if (filters.assignment) entries.push(`assignment = ${JSON.stringify(filters.assignment)}`);
  if (filters.status) entries.push(`status = ${JSON.stringify(filters.status)}`);
  if (filters.approved !== undefined) entries.push(`approved = ${String(filters.approved)}`);
  if (filters.skill) entries.push(`skills = ${JSON.stringify(filters.skill)}`);
  if (filters.document) entries.push(`documents = ${JSON.stringify(filters.document)}`);
  return entries;
}

function typesenseFilter(filters: QueryCase["filters"]): string {
  const entries: string[] = [];
  const escape = (value: string) => `\`${value.replaceAll("`", "\\`")}\``;
  if (filters.country) entries.push(`country:=${escape(filters.country)}`);
  if (filters.university) entries.push(`university:=${escape(filters.university)}`);
  if (filters.company) entries.push(`company:=${escape(filters.company)}`);
  if (filters.gender) entries.push(`gender:=${escape(filters.gender)}`);
  if (filters.profile) entries.push(`profile:=${escape(filters.profile)}`);
  if (filters.assignment) entries.push(`assignment:=${escape(filters.assignment)}`);
  if (filters.status) entries.push(`status:=${escape(filters.status)}`);
  if (filters.approved !== undefined) entries.push(`approved:=${String(filters.approved)}`);
  if (filters.skill) entries.push(`skills:=${escape(filters.skill)}`);
  if (filters.document) entries.push(`documents:=${escape(filters.document)}`);
  return entries.join(" && ");
}

function emptyFacetCounts(): Record<FacetField, Record<string, number>> {
  return Object.fromEntries(FACET_FIELDS.map((field) => [field, {}])) as Record<FacetField, Record<string, number>>;
}

function normalizeFacetCounts(input: Partial<Record<FacetField, Record<string, number>>>): FacetCounts {
  const normalized = emptyFacetCounts();
  for (const field of FACET_FIELDS) {
    for (const [value, count] of Object.entries(input[field] ?? {})) normalized[field][value] = count;
  }
  return normalized;
}

interface MeiliTask { readonly taskUid: number; readonly status?: string; readonly error?: unknown }

export class MeilisearchEngine implements SearchEngine {
  readonly name = "Meilisearch" as const;
  private readonly index = "shu47_candidates";

  constructor(private readonly baseUrl: string) {}

  private async waitFor(taskUid: number): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const task = await jsonRequest<MeiliTask>(`${this.baseUrl}/tasks/${taskUid}`);
      if (task.status === "succeeded") return;
      if (task.status === "failed" || task.status === "canceled") throw new Error(`Meilisearch task ${taskUid} failed: ${JSON.stringify(task.error)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Meilisearch task ${taskUid} timed out`);
  }

  async resetAndIndex(documents: readonly SearchCandidate[]): Promise<void> {
    const existing = await fetch(`${this.baseUrl}/indexes/${this.index}`);
    if (!existing.ok && existing.status !== 404) throw new Error(`Meilisearch index lookup failed (${existing.status})`);
    if (existing.ok) {
      const deletion = await jsonRequest<MeiliTask>(`${this.baseUrl}/indexes/${this.index}`, { method: "DELETE" });
      await this.waitFor(deletion.taskUid);
    }

    const created = await jsonRequest<MeiliTask>(`${this.baseUrl}/indexes`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: this.index, primaryKey: "id" }),
    });
    await this.waitFor(created.taskUid);
    const settings = await jsonRequest<MeiliTask>(`${this.baseUrl}/indexes/${this.index}/settings`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
        searchableAttributes: ["name", "email", "phone", "skills"],
        filterableAttributes: [...FACET_FIELDS, "status", "approved"],
        sortableAttributes: ["score"],
        pagination: { maxTotalHits: documents.length },
      }),
    });
    await this.waitFor(settings.taskUid);
    for (let offset = 0; offset < documents.length; offset += 1_000) {
      const task = await jsonRequest<MeiliTask>(`${this.baseUrl}/indexes/${this.index}/documents`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(documents.slice(offset, offset + 1_000)),
      });
      await this.waitFor(task.taskUid);
    }
  }

  async search(query: QueryCase): Promise<SearchResult> {
    const result = await jsonRequest<{ hits: Array<{ id: string }>; totalHits: number; facetDistribution: Partial<Record<FacetField, Record<string, number>>> }>(`${this.baseUrl}/indexes/${this.index}/search`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        q: query.query, filter: meiliFilter(query.filters), facets: FACET_FIELDS, page: 1, hitsPerPage: 50,
      }),
    });
    return { ids: result.hits.map((hit) => hit.id), total: result.totalHits, facets: normalizeFacetCounts(result.facetDistribution) };
  }
}

export class TypesenseEngine implements SearchEngine {
  readonly name = "Typesense" as const;
  private readonly collection = "shu47_candidates";

  constructor(private readonly baseUrl: string, private readonly apiKey: string) {
    const endpoint = new URL(baseUrl);
    const loopback = endpoint.hostname === "localhost"
      || endpoint.hostname === "[::1]"
      || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
      throw new Error("Typesense endpoint must use HTTPS unless it is loopback");
    }
  }

  private headers(contentType?: string): HeadersInit {
    return { "X-TYPESENSE-API-KEY": this.apiKey, ...(contentType ? { "content-type": contentType } : {}) };
  }

  async resetAndIndex(documents: readonly SearchCandidate[]): Promise<void> {
    const deletion = await fetch(`${this.baseUrl}/collections/${this.collection}`, { method: "DELETE", headers: this.headers() });
    if (!deletion.ok && deletion.status !== 404) throw new Error(`Typesense delete failed (${deletion.status})`);
    await jsonRequest(`${this.baseUrl}/collections`, {
      method: "POST", headers: this.headers("application/json"), body: JSON.stringify({ name: this.collection, fields: [
        { name: "id", type: "string" }, { name: "name", type: "string" }, { name: "email", type: "string" },
        { name: "phone", type: "string" }, { name: "country", type: "string", facet: true },
        { name: "university", type: "string", facet: true }, { name: "company", type: "string", facet: true, optional: true },
        { name: "skills", type: "string[]", facet: true }, { name: "gender", type: "string", facet: true },
        { name: "profile", type: "string", facet: true }, { name: "assignment", type: "string", facet: true },
        { name: "documents", type: "string[]", facet: true },
        { name: "status", type: "string", facet: true }, { name: "approved", type: "bool", facet: true },
        { name: "score", type: "int32", sort: true },
      ] }),
    });
    for (let offset = 0; offset < documents.length; offset += 1_000) {
      const payload = documents.slice(offset, offset + 1_000).map((document) => JSON.stringify(document)).join("\n");
      const response = await fetch(`${this.baseUrl}/collections/${this.collection}/documents/import?action=upsert`, {
        method: "POST", headers: this.headers("text/plain"), body: payload,
      });
      const text = await response.text();
      if (!response.ok || text.split("\n").some((line) => line && (JSON.parse(line) as { success: boolean }).success !== true)) {
        throw new Error(`Typesense import failed (${response.status}): ${text.slice(0, 500)}`);
      }
    }
  }

  async search(query: QueryCase): Promise<SearchResult> {
    const params = new URLSearchParams({
      q: query.query || "*", query_by: "name,email,phone,skills", facet_by: FACET_FIELDS.join(","), max_facet_values: "100", per_page: "50",
    });
    const filter = typesenseFilter(query.filters);
    if (filter) params.set("filter_by", filter);
    const result = await jsonRequest<{ found: number; hits: Array<{ document: { id: string } }>; facet_counts: Array<{ field_name: FacetField; counts: Array<{ value: string; count: number }> }> }>(`${this.baseUrl}/collections/${this.collection}/documents/search?${params}`, { headers: this.headers() });
    const facets = emptyFacetCounts();
    for (const facet of result.facet_counts) {
      if (!FACET_FIELDS.includes(facet.field_name)) continue;
      for (const item of facet.counts) facets[facet.field_name][item.value] = item.count;
    }
    return { ids: result.hits.map((hit) => hit.document.id), total: result.found, facets };
  }
}
