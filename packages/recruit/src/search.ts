// Recruit R3: staff search people who are looking for work.
//
// Legacy staff searched candidates through Algolia with facets (country, university,
// gender, area and more). Here the search runs on the server over the platform's own
// tables: only people whose work status is "actively looking" or "open to offers" are
// searchable, complete profiles by default. Facets are disjunctive: a facet's own
// choices are left out of its counts while every other active filter applies.
// Company users get nothing here; what employers may see of people is R5 (S7).

import { isRecruitId, type RecruitGrantRow } from "./requests.js";

export const SEARCH_AVAILABILITY = ["active", "open_to_offers"] as const;
export type SearchAvailability = typeof SEARCH_AVAILABILITY[number];
export const SEARCH_GENDERS = ["male", "female", "other"] as const;
export type SearchGender = typeof SEARCH_GENDERS[number];
export const SEARCH_FACETS = ["area", "nationality", "university", "availability", "drivingLicence", "gender"] as const;
export type SearchFacet = typeof SEARCH_FACETS[number];
export const PEOPLE_SEARCH_PAGE_SIZE = 25;
export const SEARCH_VALUES_MAX = 20;
export const SEARCH_TEXT_MAX = 200;
export const SEARCH_PAGE_MAX = 400;

/** Operator staff, admins and recruiters search everyone looking for work. */
export function peopleSearchDecision(rows: readonly RecruitGrantRow[], operators: readonly string[]): boolean {
  return rows.some((row) => ["staff", "admin", "recruiter"].includes(row.role) && row.scope === "subtree" && operators.includes(row.org_id));
}

export interface PeopleSearchQuery {
  readonly q: string;
  readonly area: readonly string[];
  readonly nationality: readonly string[];
  readonly university: readonly string[];
  readonly availability: readonly SearchAvailability[];
  readonly drivingLicence: readonly ("yes" | "no")[];
  readonly gender: readonly SearchGender[];
  readonly includeIncomplete: boolean;
  readonly page: number;
}

type Raw = Readonly<Record<string, string | readonly string[] | undefined>>;
const KEYS = new Set(["q", "area", "nationality", "university", "availability", "drivingLicence", "gender", "includeIncomplete", "page"]);
const CONTROL = /[\u0000-\u001f\u007f]/;

function list<T extends string>(value: string | readonly string[] | undefined, ok: (v: string) => v is T, lower = false): T[] | undefined {
  const values = value === undefined ? [] : typeof value === "string" ? [value] : [...value];
  const out = [...new Set(values.filter((v) => v !== "").map((v) => (lower ? v.toLowerCase() : v)))];
  return out.length <= SEARCH_VALUES_MAX && out.every(ok) ? out : undefined;
}
const single = (value: string | readonly string[] | undefined) => (value === undefined || typeof value === "string" ? value : value.length === 1 ? value[0] : null);
const oneOf = <T extends string>(choices: readonly T[]) => (v: string): v is T => (choices as readonly string[]).includes(v);

/** Query parameters (repeated keys allowed for facets) into a search; undefined when anything is unknown or out of range. */
export function parsePeopleSearch(raw: Raw): PeopleSearchQuery | undefined {
  if (Object.keys(raw).some((k) => !KEYS.has(k) && raw[k] !== undefined)) return undefined;
  const q = single(raw.q), page = single(raw.page), incomplete = single(raw.includeIncomplete);
  if (q === null || page === null || incomplete === null) return undefined;
  const text = (q ?? "").trim();
  if ([...text].length > SEARCH_TEXT_MAX || CONTROL.test(text)) return undefined;
  const pageNumber = page === undefined || page === "" ? 1 : /^[1-9]\d{0,2}$/.test(page) ? Number(page) : undefined;
  if (pageNumber === undefined || pageNumber > SEARCH_PAGE_MAX) return undefined;
  const includeIncomplete = incomplete === undefined || incomplete === "" || incomplete === "0" ? false : incomplete === "1" || incomplete === "on" ? true : undefined;
  const area = list(raw.area, isRecruitId, true), nationality = list(raw.nationality, isRecruitId, true), university = list(raw.university, isRecruitId, true);
  const availability = list(raw.availability, oneOf(SEARCH_AVAILABILITY)), drivingLicence = list(raw.drivingLicence, oneOf(["yes", "no"] as const)), gender = list(raw.gender, oneOf(SEARCH_GENDERS));
  if (includeIncomplete === undefined || !area || !nationality || !university || !availability || !drivingLicence || !gender) return undefined;
  return { q: text, area, nationality, university, availability, drivingLicence, gender, includeIncomplete, page: pageNumber };
}

/** Name tokens for a prefix match, letters and digits of any script; at most eight. */
export function searchTokens(q: string): string[] {
  return [...q.normalize("NFC").toLowerCase().matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map((m) => m[0]!).slice(0, 8);
}

export interface SearchPersonRow {
  readonly principal_id: string; readonly name: string | null; readonly arabic_name: string | null; readonly objective: string | null;
  readonly availability: SearchAvailability; readonly gender: SearchGender | null; readonly driving_licence: boolean | null;
  readonly area_name: string | null; readonly nationality_name: string | null; readonly universities: readonly string[]; readonly complete: boolean;
}
export interface SearchFacetRow { readonly facet: SearchFacet; readonly value: string; readonly label: string | null; readonly count: number }
export interface FacetValue { readonly value: string; readonly label: string; readonly count: number; readonly selected: boolean }

const AVAILABILITY_LABEL: Readonly<Record<SearchAvailability, string>> = { active: "Actively looking", open_to_offers: "Open to offers" };
const GENDER_LABEL: Readonly<Record<SearchGender, string>> = { male: "Male", female: "Female", other: "Other" };
const LICENCE_LABEL: Readonly<Record<string, string>> = { yes: "Has a driving licence", no: "No driving licence" };

/** Facet rows grouped per facet, most common first, with every selected value kept even at zero so it can be cleared. */
export function facetView(rows: readonly SearchFacetRow[], query: PeopleSearchQuery): Readonly<Record<SearchFacet, readonly FacetValue[]>> {
  const selected: Readonly<Record<SearchFacet, readonly string[]>> = { area: query.area, nationality: query.nationality, university: query.university, availability: query.availability, drivingLicence: query.drivingLicence, gender: query.gender };
  const label = (facet: SearchFacet, value: string, given: string | null) =>
    facet === "availability" ? AVAILABILITY_LABEL[value as SearchAvailability] ?? value : facet === "gender" ? GENDER_LABEL[value as SearchGender] ?? value : facet === "drivingLicence" ? LICENCE_LABEL[value] ?? value : given ?? "Unknown";
  const out = {} as Record<SearchFacet, FacetValue[]>;
  for (const facet of SEARCH_FACETS) {
    const mine = rows.filter((r) => r.facet === facet);
    const values = mine.map((r) => ({ value: r.value, label: label(facet, r.value, r.label), count: r.count, selected: selected[facet].includes(r.value) }));
    for (const value of selected[facet]) if (!values.some((v) => v.value === value)) values.push({ value, label: label(facet, value, null), count: 0, selected: true });
    out[facet] = values.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  }
  return out;
}

export interface SearchPersonView {
  readonly personId: string; readonly name: string | null; readonly arabicName: string | null; readonly objective: string | null;
  readonly availability: SearchAvailability; readonly area: string | null; readonly nationality: string | null; readonly universities: readonly string[];
  readonly gender: SearchGender | null; readonly drivingLicence: boolean | null; readonly complete: boolean;
}
export function searchPersonView(row: SearchPersonRow): SearchPersonView {
  return {
    personId: row.principal_id, name: row.name, arabicName: row.arabic_name, objective: row.objective, availability: row.availability,
    area: row.area_name, nationality: row.nationality_name, universities: [...row.universities].sort(), gender: row.gender, drivingLicence: row.driving_licence, complete: row.complete,
  };
}

/** The query string that reproduces a search, for links and paging. */
export function searchQueryString(query: PeopleSearchQuery, page = query.page): string {
  const p = new URLSearchParams();
  if (query.q) p.set("q", query.q);
  for (const facet of SEARCH_FACETS) for (const v of query[facet]) p.append(facet, v);
  if (query.includeIncomplete) p.set("includeIncomplete", "1");
  if (page > 1) p.set("page", String(page));
  return p.toString();
}
