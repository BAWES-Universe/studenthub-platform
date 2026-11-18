// Recruit: legacy value maps for the importer (tools/legacy-import, importer lane).
//
// Each map is the only place a legacy code becomes a new value. A code the map
// does not know comes back "unmapped" with the raw value, so the importer counts
// it as a reconciliation reason instead of guessing. Request status, suggestion
// stage and note type live beside their slices (legacyRequestStatus,
// legacySuggestionStage, legacyNoteType); these cover R4 to R9.

import type { InvitationStatus } from "./invitations.js";
import type { InterviewStatus } from "./interviews.js";
import type { ApplicationStatus, JobGender, JobStatus } from "./jobs.js";
import type { FulltimerGender } from "./fulltimers.js";
import type { RequestApplicationStatus } from "./request-applications.js";

export type LegacyMapped<T, R = number> = { readonly kind: "mapped"; readonly value: T } | { readonly kind: "unmapped"; readonly value: R };
function from<T, R extends string | number>(table: ReadonlyMap<R, T>, raw: R): LegacyMapped<T, R> {
  return table.has(raw) ? { kind: "mapped", value: table.get(raw)! } : { kind: "unmapped", value: raw };
}

/** invitation.invitation_status 1 invited, 2 rejected, 3 accepted; an invited row with invitation_seen_in set was seen. */
export function legacyInvitationStatus(status: number, seen: boolean): LegacyMapped<InvitationStatus> {
  return from(new Map<number, InvitationStatus>([[1, seen ? "seen" : "sent"], [2, "declined"], [3, "accepted"]]), status);
}

/**
 * request_interview.status 0 requested (by the company, with a time), 1 scheduled, 2 rejected by staff, 3 cancelled.
 * A requested or scheduled interview that has an evaluation took place, so it is completed.
 */
export function legacyInterviewStatus(status: number, evaluated: boolean): LegacyMapped<InterviewStatus> {
  return from(new Map<number, InterviewStatus>([[0, evaluated ? "completed" : "scheduled"], [1, evaluated ? "completed" : "scheduled"], [2, "cancelled"], [3, "cancelled"]]), status);
}

/** job.job_status 10 draft (0 in older rows), 1 active, 2 closed. */
export function legacyJobStatus(status: number): LegacyMapped<JobStatus> {
  return from(new Map<number, JobStatus>([[10, "draft"], [0, "draft"], [1, "active"], [2, "closed"]]), status);
}

/** job.gender 1 male, 2 female, 3 other, 4 any; shown as a preference only. */
export function legacyJobGender(gender: number): LegacyMapped<JobGender> {
  return from(new Map<number, JobGender>([[1, "male"], [2, "female"], [3, "other"], [4, "any"]]), gender);
}

/** job.compensation_type FIXED_PRICE, HOURLY, MONTHLY_SALARY, kept as the job's pay type words. */
export function legacyJobCompensationType(type: string): LegacyMapped<string, string> {
  return from(new Map<string, string>([["FIXED_PRICE", "Fixed price"], ["HOURLY", "Hourly"], ["MONTHLY_SALARY", "Monthly salary"]]), type);
}

/** job_interest.status INTERESTED, SHORTLISTED, REJECTED. */
export function legacyJobInterestStatus(status: string): LegacyMapped<ApplicationStatus, string> {
  return from(new Map<string, ApplicationStatus>([["INTERESTED", "interested"], ["SHORTLISTED", "shortlisted"], ["REJECTED", "rejected"]]), status);
}

/** request_application.status 0 applied, 1 interview scheduled, 2 accepted, 3 rejected; an interview means the person was taken on. */
export function legacyRequestApplicationStatus(status: number): LegacyMapped<RequestApplicationStatus> {
  return from(new Map<number, RequestApplicationStatus>([[0, "applied"], [1, "accepted"], [2, "accepted"], [3, "rejected"]]), status);
}

/** fulltimer.gender 1 male, 2 female, 3 other; empty stays unknown. */
export function legacyFulltimerGender(gender: number | null): LegacyMapped<FulltimerGender | null, number> {
  return gender === null ? { kind: "mapped", value: null } : from(new Map<number, FulltimerGender>([[1, "male"], [2, "female"], [3, "other"]]), gender);
}

/** fulltimer yes/no columns (employed, driving licence): 1 yes, 2 no; empty stays unknown. */
export function legacyYesNo(value: number | null): LegacyMapped<boolean | null, number> {
  return value === null ? { kind: "mapped", value: null } : from(new Map<number, boolean>([[1, true], [2, false]]), value);
}
