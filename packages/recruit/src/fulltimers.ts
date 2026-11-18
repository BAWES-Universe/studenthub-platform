// Recruit R9: the full-timer track, kept by the legacy-benchmark rule.
//
// Legacy staff kept records of people looking for full-time work who had no
// StudentHub account (Fulltimer with tags, skills and experience), refused a
// second record with the same name or phone, filtered the list by currency, and
// suggested them to requests next to candidates. Here the same: operator staff
// and recruiters keep the records and add them to the request pipeline; a
// full-timer never gets a work assignment (no account to pay), so "placed"
// records the hire. Delete becomes archive, because cards and notes refer to it.

import type { RecruitGrantRow } from "./requests.js";

export const FULLTIMER_GENDERS = ["male", "female", "other"] as const;
export type FulltimerGender = typeof FULLTIMER_GENDERS[number];
export const FULLTIMER_PAGE_SIZE = 50;

/** Operator staff, admins and recruiters (subtree on an operator organization): the people who used the legacy staff app. */
export function fulltimerStaffDecision(rows: readonly RecruitGrantRow[], operators: readonly string[]): boolean {
  return rows.some((row) => ["staff", "admin", "recruiter"].includes(row.role) && row.scope === "subtree" && operators.includes(row.org_id));
}

/** The duplicate key legacy matched on: the name, case and spacing folded. */
export function fulltimerNameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Phone digits with an optional leading plus; spaces, dashes and brackets dropped. */
export function normalizePhone(value: string): string | undefined {
  const compact = value.replace(/[\s\-().]/g, "");
  return /^\+?[0-9]{6,20}$/.test(compact) ? compact : undefined;
}

const CONTROL_LINE = /[\u0000-\u001f\u007f]/;
function text(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t) return null;
  return [...t].length <= max && !CONTROL_LINE.test(t) ? t : undefined;
}
function list(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  const raw = value === undefined || value === null || value === "" ? [] : typeof value === "string" ? value.split(/[,\n]/) : Array.isArray(value) ? value : undefined;
  if (!raw) return undefined;
  const items = raw.map((v) => text(v, maxLength));
  if (items.includes(undefined)) return undefined;
  const out = [...new Set(items.filter((v): v is string => v !== null && v !== undefined))];
  return out.length <= maxItems ? out : undefined;
}
function flag(value: unknown): boolean | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return undefined;
}
function coordinate(value: unknown, limit: number): number | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" && /^-?\d{1,3}(\.\d{1,6})?$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ref = (value: unknown): string | null | undefined => (value === undefined || value === null || value === "" ? null : typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined);
const closed = (value: unknown, keys: readonly string[]) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).every((k) => keys.includes(k));

/** A real calendar day: 2020-13-01 and 2021-02-29 are refused instead of throwing or rolling over. */
const calendarDate = (value: string): boolean => { const d = new Date(`${value}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value; };

export interface FulltimerFields {
  readonly name: string; readonly phone: string | null; readonly email: string | null; readonly nationalityId: string | null; readonly countryId: string | null; readonly areaId: string | null; readonly universityId: string | null;
  readonly latitude: number | null; readonly longitude: number | null; readonly gender: FulltimerGender | null; readonly birthDate: string | null; readonly employed: boolean | null; readonly drivingLicence: boolean | null;
  readonly currentSalary: string | null; readonly expectedSalary: string | null; readonly currencyCode: string; readonly tags: readonly string[]; readonly skills: readonly string[]; readonly experience: readonly string[];
  readonly cvReference: string | null;
}
const KEYS = ["name", "phone", "email", "nationalityId", "countryId", "areaId", "universityId", "latitude", "longitude", "gender", "birthDate", "employed", "drivingLicence", "currentSalary", "expectedSalary", "currencyCode", "tags", "skills", "experience", "cvReference"];

/** The legacy full-timer form; lists come as arrays or as comma- or newline-separated text (the HTML form). */
export function parseFulltimer(value: unknown, today: string): FulltimerFields | undefined {
  if (!closed(value, KEYS)) return undefined;
  const r = value as Record<string, unknown>;
  const name = text(r.name, 255);
  const rawPhone = text(r.phone, 40);
  const phone = rawPhone === null ? null : rawPhone === undefined ? undefined : normalizePhone(rawPhone);
  const email = text(r.email, 254);
  const refs = { nationalityId: ref(r.nationalityId), countryId: ref(r.countryId), areaId: ref(r.areaId), universityId: ref(r.universityId) };
  const latitude = coordinate(r.latitude, 90), longitude = coordinate(r.longitude, 180);
  const gender = r.gender === undefined || r.gender === null || r.gender === "" ? null : typeof r.gender === "string" && (FULLTIMER_GENDERS as readonly string[]).includes(r.gender) ? r.gender as FulltimerGender : undefined;
  const birthDate = r.birthDate === undefined || r.birthDate === null || r.birthDate === "" ? null
    : typeof r.birthDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.birthDate) && calendarDate(r.birthDate) && r.birthDate >= "1900-01-01" && r.birthDate <= today ? r.birthDate : undefined;
  const employed = flag(r.employed), drivingLicence = flag(r.drivingLicence);
  const currentSalary = text(r.currentSalary, 64), expectedSalary = text(r.expectedSalary, 64);
  const currencyCode = r.currencyCode === undefined || r.currencyCode === "" ? "KWD" : typeof r.currencyCode === "string" && /^[A-Za-z]{3}$/.test(r.currencyCode) ? r.currencyCode.toUpperCase() : undefined;
  const tags = list(r.tags, 30, 100), skills = list(r.skills, 50, 100), experience = list(r.experience, 30, 500);
  const cvReference = text(r.cvReference, 1024);
  if (!name || phone === undefined || email === undefined || (email !== null && !/^[^@\s]+@[^@\s]+$/.test(email)) || Object.values(refs).includes(undefined)) return undefined;
  if (latitude === undefined || longitude === undefined || (latitude === null) !== (longitude === null) || gender === undefined || birthDate === undefined || employed === undefined || drivingLicence === undefined) return undefined;
  if (currentSalary === undefined || expectedSalary === undefined || !currencyCode || !tags || !skills || !experience || cvReference === undefined) return undefined;
  return { name, phone, email, ...(refs as { [K in keyof typeof refs]: string | null }), latitude, longitude, gender, birthDate, employed, drivingLicence, currentSalary, expectedSalary, currencyCode, tags, skills, experience, cvReference };
}

export function parseFulltimerQuery(raw: Readonly<Record<string, string | readonly string[] | undefined>>): { readonly q: string | null; readonly currency: string; readonly tag: string | null; readonly archived: boolean; readonly page: number } | undefined {
  for (const key of Object.keys(raw)) if (!["q", "currency", "tag", "archived", "page", "request"].includes(key) || Array.isArray(raw[key])) return undefined;
  const q = text(raw.q, 100), tag = text(raw.tag, 100);
  const currency = raw.currency === undefined || raw.currency === "" ? "KWD" : /^[A-Za-z]{3}$/.test(raw.currency as string) ? (raw.currency as string).toUpperCase() : undefined;
  const page = raw.page === undefined ? 1 : /^[1-9]\d{0,2}$/.test(raw.page as string) ? Number(raw.page) : undefined;
  if (q === undefined || tag === undefined || !currency || page === undefined || (raw.archived !== undefined && raw.archived !== "1")) return undefined;
  return { q, currency, tag, archived: raw.archived === "1", page };
}
