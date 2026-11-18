// Recruit R7: the job board, kept as legacy (decision SHU-207).
//
// Legacy staff published jobs for a request (Job, JobSkills); people looking for
// work browsed active jobs, applied once with an optional note (JobInterest), and
// saw "My applications"; staff shortlisted or rejected an application and the
// person was told. Kept the same, with the legacy gap closed: a draft or closed
// job takes no application. Age and gender criteria are shown, never used to hide
// or refuse (no gender filtering).

import type { RecruitGrantRow } from "./requests.js";

export const JOB_STATUSES = ["draft", "active", "closed"] as const;
export type JobStatus = typeof JOB_STATUSES[number];
export const JOB_GENDERS = ["any", "male", "female", "other"] as const;
export type JobGender = typeof JOB_GENDERS[number];
export const APPLICATION_STATUSES = ["interested", "shortlisted", "rejected"] as const;
export type ApplicationStatus = typeof APPLICATION_STATUSES[number];
export const JOB_PAGE_SIZE = 25;
export const JOB_SKILLS_MAX = 30;
export const APPLICATION_NOTE_MAX = 2000;

/** Operator staff and admins publish and manage jobs and applications (legacy staff app). */
export function jobStaffDecision(rows: readonly RecruitGrantRow[], operators: readonly string[]): boolean {
  return rows.some((row) => (row.role === "staff" || row.role === "admin") && row.scope === "subtree" && operators.includes(row.org_id));
}

/** The candidate surface (navigation contract C-06/C-07, `candidate:self`): a principal holding a candidate grant browses and applies; employer and staff accounts do not. */
export function jobCandidateDecision(rows: readonly RecruitGrantRow[]): boolean {
  return rows.some((row) => row.role === "candidate");
}

/** Only an active job takes applications. */
export function jobAcceptsApplications(status: JobStatus): boolean {
  return status === "active";
}

/** Staff decide an application once it is in: interested to shortlisted or rejected, and shortlisted to rejected; rejected is final. */
export function applicationTransitionAllowed(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return (from === "interested" && (to === "shortlisted" || to === "rejected")) || (from === "shortlisted" && to === "rejected");
}

export const APPLICATION_OUTBOX_KINDS = ["application.shortlisted", "application.rejected"] as const;
export function applicationOutbox(to: ApplicationStatus, applicationId: string, personId: string): { readonly kind: string; readonly recipient: string; readonly dedupeKey: string } | null {
  if (to === "interested") return null;
  const kind = `application.${to}`;
  return { kind, recipient: personId, dedupeKey: `${kind}:${applicationId}` };
}

const CONTROL_LINE = /[\u0000-\u001f\u007f]/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function text(value: unknown, max: number, multiline: boolean): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t) return null;
  return [...t].length <= max && !(multiline ? CONTROL : CONTROL_LINE).test(t) ? t : undefined;
}
function int(value: unknown, min: number, max: number): number | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}
function day(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : undefined;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const closed = (value: unknown, keys: readonly string[]) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).every((k) => keys.includes(k));

export interface JobFields {
  readonly requestId: string; readonly areaId: string | null; readonly position: string; readonly positionAr: string | null; readonly description: string | null; readonly descriptionAr: string | null;
  readonly hoursPerDay: number | null; readonly daysPerWeek: number | null; readonly compensationType: string | null; readonly compensationAmount: string | null;
  readonly compensationDescription: string | null; readonly compensationDescriptionAr: string | null; readonly minAge: number | null; readonly maxAge: number | null;
  readonly gender: JobGender; readonly availableFrom: string | null; readonly availableTo: string | null; readonly status: JobStatus; readonly skills: readonly string[];
}
const JOB_KEYS = ["requestId", "areaId", "position", "positionAr", "description", "descriptionAr", "hoursPerDay", "daysPerWeek", "compensationType", "compensationAmount", "compensationDescription", "compensationDescriptionAr", "minAge", "maxAge", "gender", "availableFrom", "availableTo", "status", "skills"];

/** The legacy job form. Skills come as an array or as one comma- or newline-separated string (the HTML form). */
export function parseJob(value: unknown): JobFields | undefined {
  if (!closed(value, JOB_KEYS)) return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.requestId !== "string" || !UUID.test(r.requestId)) return undefined;
  const areaId = r.areaId === undefined || r.areaId === null || r.areaId === "" ? null : typeof r.areaId === "string" && UUID.test(r.areaId) ? r.areaId.toLowerCase() : undefined;
  const position = text(r.position, 255, false);
  const strings = { positionAr: text(r.positionAr, 255, false), description: text(r.description, 10000, true), descriptionAr: text(r.descriptionAr, 10000, true), compensationType: text(r.compensationType, 64, false),
    compensationAmount: text(r.compensationAmount, 255, false), compensationDescription: text(r.compensationDescription, 2000, true), compensationDescriptionAr: text(r.compensationDescriptionAr, 2000, true) };
  const numbers = { hoursPerDay: int(r.hoursPerDay, 1, 24), daysPerWeek: int(r.daysPerWeek, 1, 7), minAge: int(r.minAge, 14, 99), maxAge: int(r.maxAge, 14, 99) };
  const availableFrom = day(r.availableFrom), availableTo = day(r.availableTo);
  const gender = r.gender === undefined || r.gender === "" ? "any" : typeof r.gender === "string" && (JOB_GENDERS as readonly string[]).includes(r.gender) ? r.gender as JobGender : undefined;
  const status = r.status === undefined || r.status === "" ? "draft" : typeof r.status === "string" && (JOB_STATUSES as readonly string[]).includes(r.status) ? r.status as JobStatus : undefined;
  const rawSkills = r.skills === undefined || r.skills === null || r.skills === "" ? [] : typeof r.skills === "string" ? r.skills.split(/[,\n]/) : Array.isArray(r.skills) ? r.skills : undefined;
  const skills = rawSkills?.map((s) => text(s, 100, false));
  if (!position || areaId === undefined || availableFrom === undefined || availableTo === undefined || !gender || !status || !skills) return undefined;
  if (Object.values(strings).includes(undefined) || Object.values(numbers).includes(undefined) || skills.includes(undefined)) return undefined;
  const unique = [...new Set(skills.filter((s): s is string => s !== null))];
  if (unique.length > JOB_SKILLS_MAX) return undefined;
  if (numbers.minAge != null && numbers.maxAge != null && numbers.minAge > numbers.maxAge) return undefined;
  if (availableFrom && availableTo && availableFrom > availableTo) return undefined;
  return { requestId: r.requestId.toLowerCase(), areaId, position, ...(strings as { [K in keyof typeof strings]: string | null }), ...(numbers as { [K in keyof typeof numbers]: number | null }), gender, availableFrom, availableTo, status, skills: unique };
}

/** An application: an optional note; nothing else. */
export function parseApplication(value: unknown): { readonly note: string | null } | undefined {
  if (!closed(value, ["note"])) return undefined;
  const note = text((value as Record<string, unknown>).note, APPLICATION_NOTE_MAX, true);
  return note === undefined ? undefined : { note };
}

export function parseJobQuery(raw: Readonly<Record<string, string | readonly string[] | undefined>>): { readonly q: string | null; readonly applied: boolean; readonly page: number } | undefined {
  for (const key of Object.keys(raw)) if (!["q", "applied", "page"].includes(key) || Array.isArray(raw[key])) return undefined;
  const q = text(raw.q, 100, false), page = raw.page === undefined ? 1 : /^[1-9]\d{0,2}$/.test(raw.page as string) ? Number(raw.page) : undefined;
  if (q === undefined || page === undefined || (raw.applied !== undefined && raw.applied !== "1")) return undefined;
  return { q, applied: raw.applied === "1", page };
}

export interface JobRow {
  readonly id: string; readonly request_id: string; readonly org_name: string; readonly store_name: string; readonly area_name: string | null; readonly position: string; readonly position_ar: string | null;
  readonly description: string | null; readonly description_ar: string | null; readonly hours_per_day: number | null; readonly days_per_week: number | null; readonly compensation_type: string | null;
  readonly compensation_amount: string | null; readonly compensation_description: string | null; readonly compensation_description_ar: string | null; readonly min_age: number | null; readonly max_age: number | null;
  readonly gender: JobGender; readonly available_from: string | null; readonly available_to: string | null; readonly status: JobStatus; readonly skills: readonly string[]; readonly created_at: string | Date;
  readonly application_status?: ApplicationStatus | null;
}
const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();

/** What a person sees of a job: everything published, the criteria as information, and their own application. */
export function jobView(row: JobRow) {
  return {
    jobId: row.id, company: row.org_name, store: row.store_name, area: row.area_name, position: row.position, positionAr: row.position_ar, description: row.description, descriptionAr: row.description_ar,
    hoursPerDay: row.hours_per_day, daysPerWeek: row.days_per_week, compensation: { type: row.compensation_type, amount: row.compensation_amount, description: row.compensation_description, descriptionAr: row.compensation_description_ar },
    criteria: { minAge: row.min_age, maxAge: row.max_age, gender: row.gender }, availableFrom: row.available_from, availableTo: row.available_to, status: row.status, skills: [...row.skills],
    postedAt: iso(row.created_at), application: row.application_status ?? null, canApply: jobAcceptsApplications(row.status) && !row.application_status,
  };
}
export type JobView = ReturnType<typeof jobView>;
