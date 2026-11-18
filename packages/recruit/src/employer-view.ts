// Recruit R5 (S7): employers see the people suggested to, invited to or working
// through their requests.
//
// Legacy companies opened the profile of every candidate suggested to their
// requests or working in their stores. The 2026-10-27 decision keeps that sight:
// work-relevant profile fields here; the CV, photo, civil ID images and location
// only through authorised, time-limited, audited document links, which the
// documents area issues (a port; until it is wired the page says so). Staff of
// the operator see the same page for any person on any request.

export interface EmployerPersonRow {
  readonly principal_id: string; readonly name: string | null; readonly arabic_name: string | null; readonly objective: string | null; readonly introduction: string | null;
  readonly preferred_time: string | null; readonly gender: string | null; readonly birth_date: string | null; readonly driving_licence: boolean | null;
  readonly nationality_name: string | null; readonly area_name: string | null; readonly job_search_status: string | null;
}
export interface EmployerRecordRow { readonly kind: "education" | "experience" | "skill"; readonly fields: Readonly<Record<string, unknown>>; readonly university: string | null; readonly degree: string | null; readonly major: string | null }
export interface EmployerLinkRow { readonly stage: string | null; readonly invitation_status: string | null }

export interface EmployerPersonView {
  readonly personId: string; readonly name: string | null; readonly arabicName: string | null; readonly objective: string | null; readonly introduction: string | null;
  readonly preferredTime: string | null; readonly gender: string | null; readonly age: number | null; readonly drivingLicence: boolean | null;
  readonly nationality: string | null; readonly area: string | null; readonly lookingForWork: boolean;
  readonly education: readonly { readonly institution: string | null; readonly degree: string | null; readonly major: string | null; readonly graduationYear: number | null; readonly currentlyStudying: boolean }[];
  readonly experience: readonly { readonly title: string; readonly employer: string; readonly startYear: number; readonly endYear: number | null }[];
  readonly skills: readonly string[];
  readonly stage: string | null; readonly invitation: string | null;
}

/** Whole years between a birth date and today (both YYYY-MM-DD); null when unknown or not a sane age. */
/** The stores a principal manages, as the access lane's store-manager grants record them. */
export type ManagedStores = (principalId: string) => Promise<readonly { readonly orgId: string; readonly storeId: string }[]>;

/**
 * The store-manager source until the access lane's store-manager grants (A4) are on main: nobody manages a store,
 * so only company readers and operator staff see a request's people. A4 replaces this in the recruit wiring.
 */
export const NO_STORE_MANAGERS: ManagedStores = async () => [];

export function ageOn(birthDate: string | null, today: string): number | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  const age = ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
  return age >= 0 && age <= 120 ? age : null;
}

/** A person is in sight of a request's company while they have a live card or an invitation that was not withdrawn. */
export function employerMaySee(link: EmployerLinkRow | null): boolean {
  if (!link) return false;
  return (link.stage !== null && link.stage !== "withdrawn") || (link.invitation_status !== null && link.invitation_status !== "withdrawn");
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);

export function employerPersonView(person: EmployerPersonRow, records: readonly EmployerRecordRow[], link: EmployerLinkRow, today: string): EmployerPersonView {
  const education = records.filter((r) => r.kind === "education").map((r) => ({
    institution: r.university ?? str(r.fields.institutionName), degree: r.degree, major: r.major ?? str(r.fields.customMajor),
    graduationYear: num(r.fields.graduationYear), currentlyStudying: r.fields.currentlyStudying === true,
  }));
  const experience = records.filter((r) => r.kind === "experience" && str(r.fields.title) && str(r.fields.employer) && num(r.fields.startYear) !== null)
    .map((r) => ({ title: str(r.fields.title)!, employer: str(r.fields.employer)!, startYear: num(r.fields.startYear)!, endYear: num(r.fields.endYear) }))
    .sort((a, b) => b.startYear - a.startYear);
  const skills = records.filter((r) => r.kind === "skill").map((r) => str(r.fields.name)).filter((s): s is string => s !== null).sort((a, b) => a.localeCompare(b));
  return {
    personId: person.principal_id, name: person.name, arabicName: person.arabic_name, objective: person.objective, introduction: person.introduction,
    preferredTime: person.preferred_time, gender: person.gender, age: ageOn(person.birth_date, today), drivingLicence: person.driving_licence,
    nationality: person.nationality_name, area: person.area_name, lookingForWork: person.job_search_status === "active" || person.job_search_status === "open_to_offers",
    education, experience, skills, stage: link.stage === "withdrawn" ? null : link.stage, invitation: link.invitation_status === "withdrawn" ? null : link.invitation_status,
  };
}
