import { CONTRACT_VERSIONS } from "./versions.js";

export const SEARCH_CONTRACT_VERSION = CONTRACT_VERSIONS.search;

export const CANDIDATE_SEARCH_FACETS = [
  "country",
  "university",
  "company",
  "skill",
  "gender",
  "profile",
  "assignment",
  "document",
] as const;

export type CandidateSearchFacet = typeof CANDIDATE_SEARCH_FACETS[number];

export interface CandidateSearchDocument {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly country: string;
  readonly university: string;
  readonly company?: string;
  readonly skills: readonly string[];
  readonly gender: "male" | "female" | "other" | "not-set";
  readonly profile: "complete" | "incomplete";
  readonly assignment: "assigned" | "unassigned";
  readonly documents: readonly ("resume" | "no-resume" | "civil-id")[];
  readonly status: "active" | "inactive";
  readonly approved: boolean;
  readonly score: number;
  readonly updatedAtEpoch: number;
}

export type CandidateSearchFilters = Readonly<
  Partial<Record<CandidateSearchFacet, readonly string[]>>
>;

export type CandidateSearchSort =
  | "relevance"
  | "score-ascending"
  | "score-descending"
  | "updated-descending";

export type CandidateSearchScope =
  | { readonly kind: "all" }
  | { readonly kind: "candidate-ids"; readonly ids: readonly string[] };

export interface CandidateSearchConstraints {
  readonly status?: readonly ("active" | "inactive")[];
  readonly approved?: boolean;
}

export interface CandidateSearchRequest {
  /** Required so a caller cannot accidentally omit its authorization scope. */
  readonly scope: CandidateSearchScope;
  readonly query?: string;
  readonly filters?: CandidateSearchFilters;
  readonly constraints?: CandidateSearchConstraints;
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: CandidateSearchSort;
  readonly signal?: AbortSignal;
}

export interface CandidateSearchFacetOption {
  readonly value: string;
  readonly count: number;
  readonly active: boolean;
}

export type CandidateSearchFacetCounts = Readonly<
  Record<CandidateSearchFacet, readonly CandidateSearchFacetOption[]>
>;

export interface CandidateSearchResult {
  readonly hits: readonly CandidateSearchDocument[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** Counts are disjunctive: each facet excludes its own active filter. */
  readonly facets: CandidateSearchFacetCounts;
}

export interface CandidateSearchAdapter {
  search(request: CandidateSearchRequest): Promise<CandidateSearchResult>;
}
