import { createHash } from "node:crypto";

import { createPrng, seedFromString } from "../../fixtures/src/prng.js";

const FIRST_NAMES = ["Amber", "Basil", "Cedar", "Dune", "Ember", "Flint", "Grove", "Harbor"] as const;
const LAST_NAMES = ["Atlas", "Beacon", "Comet", "Delta", "Elm", "Fjord", "Gale", "Halo"] as const;
const COUNTRIES = ["KW", "AE", "SA", "QA", "BH", "OM"] as const;
const UNIVERSITIES = ["Gulf Tech", "Desert State", "Coast College", "Orbit University"] as const;
const SKILLS = ["typescript", "python", "postgresql", "design", "finance", "operations"] as const;

export interface SearchCandidate {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly country: string;
  readonly university: string;
  readonly skills: readonly string[];
  readonly status: "active" | "inactive";
  readonly approved: boolean;
  readonly score: number;
}

export interface QueryCase {
  readonly name: string;
  readonly query: string;
  readonly filters: Readonly<Partial<Pick<SearchCandidate, "country" | "university" | "status" | "approved"> & { skill: string }>>;
  readonly expectedId?: string;
}

function pick<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length)] as T;
}

export function generateSearchCandidates(count: number, seed = "shu-47-v1"): readonly SearchCandidate[] {
  if (!Number.isSafeInteger(count) || count < 100) throw new Error("document count must be an integer >= 100");
  const random = createPrng(seedFromString(seed));

  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const id = `candidate-${String(number).padStart(6, "0")}`;
    const skills = [...new Set([pick(SKILLS, random), pick(SKILLS, random)])];
    return {
      id,
      name: index === 0 ? "Quasar Benchmark" : `${pick(FIRST_NAMES, random)} ${pick(LAST_NAMES, random)} ${number}`,
      email: `candidate-${number}@search-benchmark.invalid`,
      phone: `synthetic-${String(number).padStart(6, "0")}`,
      country: index === 0 ? "KW" : pick(COUNTRIES, random),
      university: index === 0 ? "Gulf Tech" : pick(UNIVERSITIES, random),
      skills: index === 0 ? ["typescript", "postgresql"] : skills,
      status: random() < 0.85 ? "active" : "inactive",
      approved: random() < 0.7,
      score: Math.floor(random() * 101),
    };
  });
}

export const SEARCH_WORKLOAD: readonly QueryCase[] = Object.freeze([
  { name: "exact-name", query: "Quasar Benchmark", filters: {}, expectedId: "candidate-000001" },
  { name: "typo-tolerance", query: "Quasar Benchmrk", filters: {}, expectedId: "candidate-000001" },
  { name: "name-prefix", query: "Quas", filters: {}, expectedId: "candidate-000001" },
  { name: "country-facet", query: "", filters: { country: "KW" } },
  { name: "university-facet", query: "", filters: { university: "Gulf Tech" } },
  { name: "skill-facet", query: "", filters: { skill: "typescript" } },
  { name: "combined-filter", query: "", filters: { country: "KW", university: "Gulf Tech", skill: "typescript" } },
]);

export function matchesFilters(candidate: SearchCandidate, filters: QueryCase["filters"]): boolean {
  return (filters.country === undefined || candidate.country === filters.country)
    && (filters.university === undefined || candidate.university === filters.university)
    && (filters.status === undefined || candidate.status === filters.status)
    && (filters.approved === undefined || candidate.approved === filters.approved)
    && (filters.skill === undefined || candidate.skills.includes(filters.skill));
}

export function datasetDigest(candidates: readonly SearchCandidate[]): string {
  return createHash("sha256").update(JSON.stringify(candidates)).digest("hex");
}
