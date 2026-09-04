import { createHash } from "node:crypto";

import { createPrng, seedFromString } from "../../fixtures/src/prng.js";

const FIRST_NAMES = ["Amber", "Basil", "Cedar", "Dune", "Ember", "Flint", "Grove", "Harbor"] as const;
const LAST_NAMES = ["Atlas", "Beacon", "Comet", "Delta", "Elm", "Fjord", "Gale", "Halo"] as const;
const COUNTRIES = ["KW", "AE", "SA", "QA", "BH", "OM"] as const;
const UNIVERSITIES = ["Gulf Tech", "Desert State", "Coast College", "Orbit University"] as const;
const COMPANIES = ["Atlas Retail", "Beacon Hospitality", "Comet Foods", "Delta Events"] as const;
const SKILLS = ["typescript", "python", "postgresql", "design", "finance", "operations"] as const;

export const FACET_FIELDS = ["country", "university", "company", "skills", "gender", "profile", "assignment", "documents"] as const;
export type FacetField = typeof FACET_FIELDS[number];
export type FacetCounts = Readonly<Record<FacetField, Readonly<Record<string, number>>>>;

export interface SearchCandidate {
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
}

export interface QueryCase {
  readonly name: string;
  readonly query: string;
  readonly filters: Readonly<Partial<Pick<SearchCandidate, "country" | "university" | "company" | "gender" | "profile" | "assignment" | "status" | "approved"> & { skill: string; document: string }>>;
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
    const assigned = random() < 0.72;
    const hasResume = random() < 0.68;
    const documents: ("resume" | "no-resume" | "civil-id")[] = [hasResume ? "resume" : "no-resume"];
    if (random() < 0.12) documents.push("civil-id");
    return {
      id,
      name: index === 0 ? "Quasar Benchmark" : `${pick(FIRST_NAMES, random)} ${pick(LAST_NAMES, random)} ${number}`,
      email: `candidate-${number}@search-benchmark.invalid`,
      phone: `synthetic-${String(number).padStart(6, "0")}`,
      country: index === 0 ? "KW" : pick(COUNTRIES, random),
      university: index === 0 ? "Gulf Tech" : pick(UNIVERSITIES, random),
      ...(assigned ? { company: index === 0 ? "Atlas Retail" : pick(COMPANIES, random) } : {}),
      skills: index === 0 ? ["typescript", "postgresql"] : skills,
      gender: index === 0 ? "female" : pick(["male", "female", "other", "not-set"] as const, random),
      profile: index === 0 ? "complete" : (random() < 0.76 ? "complete" : "incomplete"),
      assignment: assigned ? "assigned" : "unassigned",
      documents,
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
  { name: "all-facet-counts", query: "", filters: {} },
  { name: "country-facet", query: "", filters: { country: "KW" } },
  { name: "university-facet", query: "", filters: { university: "Gulf Tech" } },
  { name: "skill-facet", query: "", filters: { skill: "typescript" } },
  { name: "company-facet", query: "", filters: { company: "Atlas Retail" } },
  { name: "gender-facet", query: "", filters: { gender: "female" } },
  { name: "profile-facet", query: "", filters: { profile: "complete" } },
  { name: "assignment-facet", query: "", filters: { assignment: "assigned" } },
  { name: "document-facet", query: "", filters: { document: "resume" } },
  { name: "combined-filter", query: "", filters: { country: "KW", university: "Gulf Tech", company: "Atlas Retail", skill: "typescript", profile: "complete", assignment: "assigned", document: "resume" } },
]);

export function matchesFilters(candidate: SearchCandidate, filters: QueryCase["filters"]): boolean {
  return (filters.country === undefined || candidate.country === filters.country)
    && (filters.university === undefined || candidate.university === filters.university)
    && (filters.company === undefined || candidate.company === filters.company)
    && (filters.gender === undefined || candidate.gender === filters.gender)
    && (filters.profile === undefined || candidate.profile === filters.profile)
    && (filters.assignment === undefined || candidate.assignment === filters.assignment)
    && (filters.status === undefined || candidate.status === filters.status)
    && (filters.approved === undefined || candidate.approved === filters.approved)
    && (filters.skill === undefined || candidate.skills.includes(filters.skill))
    && (filters.document === undefined || candidate.documents.includes(filters.document as "resume" | "no-resume" | "civil-id"));
}

export function facetCounts(candidates: readonly SearchCandidate[]): FacetCounts {
  const counts = Object.fromEntries(FACET_FIELDS.map((field) => [field, {}])) as Record<FacetField, Record<string, number>>;
  for (const candidate of candidates) {
    const values: Record<FacetField, readonly string[]> = {
      country: [candidate.country],
      university: [candidate.university],
      company: candidate.company ? [candidate.company] : [],
      skills: candidate.skills,
      gender: [candidate.gender],
      profile: [candidate.profile],
      assignment: [candidate.assignment],
      documents: candidate.documents,
    };
    for (const field of FACET_FIELDS) {
      for (const value of new Set(values[field])) counts[field][value] = (counts[field][value] ?? 0) + 1;
    }
  }
  return counts;
}

export function datasetDigest(candidates: readonly SearchCandidate[]): string {
  return createHash("sha256").update(JSON.stringify(candidates)).digest("hex");
}
