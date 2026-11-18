// Recruit R6: interviews and evaluations.
//
// Legacy staff and companies scheduled interviews for a request's applicants
// (RequestInterview) and recorded an evaluation afterwards (CandidateEvaluation)
// with a note the company sees and an internal note only staff see. Here the
// same: an interview belongs to a pipeline card at a stage that allows it; it is
// scheduled, then completed with an evaluation, or cancelled. The person sees the
// time, place and outcome, never the evaluation text. Exam authoring is dropped
// (D-RC3); certificates stay with the profile.

import { requestReadDecision, type RecruitGrantRow } from "./requests.js";

export const INTERVIEW_MODES = ["in_person", "phone", "video"] as const;
export type InterviewMode = typeof INTERVIEW_MODES[number];
export const INTERVIEW_STATUSES = ["scheduled", "completed", "cancelled"] as const;
export type InterviewStatus = typeof INTERVIEW_STATUSES[number];
export const INTERVIEW_OUTCOMES = ["passed", "not_passed", "no_show"] as const;
export type InterviewOutcome = typeof INTERVIEW_OUTCOMES[number];
export const INTERVIEW_STAGES = ["contacted", "interviewing", "offered"] as const;
export const EVALUATION_NOTE_MAX = 5000;
export const INTERVIEW_LOCATION_MAX = 500;

/** A card can have interviews while it is contacted, interviewing or offered. */
export function interviewStageAllowed(stage: string): boolean {
  return (INTERVIEW_STAGES as readonly string[]).includes(stage);
}

/** Only a scheduled interview is completed or cancelled; both are final. */
export function interviewTransitionAllowed(from: InterviewStatus, to: InterviewStatus): boolean {
  return from === "scheduled" && (to === "completed" || to === "cancelled");
}

/** A scheduled interview is completed by its first evaluation; a completed one takes a corrected version; a cancelled one takes none. */
export function evaluationAllowed(status: InterviewStatus): boolean {
  return status === "scheduled" || status === "completed";
}

/** Scheduling and cancelling tell the person (the notifications lane drains the recruit outbox); evaluations never do. */
export const INTERVIEW_OUTBOX_KINDS = ["interview.scheduled", "interview.cancelled"] as const;
export function interviewOutbox(kind: typeof INTERVIEW_OUTBOX_KINDS[number], interviewId: string, personId: string): { readonly kind: string; readonly recipient: string; readonly dedupeKey: string } {
  return { kind, recipient: personId, dedupeKey: `${kind}:${interviewId}` };
}

/**
 * The company side of an interview: readers of the request through the company's own grants. Grants on an
 * operator organization never count here (operator people act through the pipeline: the assigned recruiter or a lead).
 */
export function interviewCompanyDecision(rows: readonly RecruitGrantRow[], orgId: string, ancestors: readonly string[], operators: readonly string[]): boolean {
  return requestReadDecision(rows.filter((row) => !operators.includes(row.org_id)), orgId, ancestors, operators);
}

/** Operator staff and admins write internal notes; nobody else does (a company's evaluation has the shared note only). */
export function internalNoteDecision(rows: readonly RecruitGrantRow[], operators: readonly string[]): boolean {
  return rows.some((row) => (row.role === "staff" || row.role === "admin" || row.role === "recruiter") && row.scope === "subtree" && operators.includes(row.org_id));
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const closed = (value: unknown, keys: readonly string[]) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).every((k) => keys.includes(k));

export interface InterviewFields { readonly cardId: string; readonly scheduledAt: string; readonly durationMinutes: number; readonly mode: InterviewMode; readonly location: string | null }

/**
 * Schedule fields. `scheduledAt` is a Kuwait wall-clock time "YYYY-MM-DDTHH:MM" (the form's datetime-local) or an
 * ISO instant with an offset; it is returned as a UTC instant. Times more than a year ahead, or already past by
 * more than a day, are refused.
 */
export function parseInterview(value: unknown, now: Date): InterviewFields | undefined {
  if (!closed(value, ["cardId", "scheduledAt", "durationMinutes", "mode", "location"])) return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.cardId !== "string" || !UUID.test(r.cardId)) return undefined;
  const at = typeof r.scheduledAt === "string" ? interviewInstant(r.scheduledAt) : undefined;
  if (!at || at.getTime() < now.getTime() - 86_400_000 || at.getTime() > now.getTime() + 366 * 86_400_000) return undefined;
  const rawDuration = r.durationMinutes === undefined || r.durationMinutes === "" ? 30 : typeof r.durationMinutes === "string" && /^\d{1,3}$/.test(r.durationMinutes) ? Number(r.durationMinutes) : r.durationMinutes;
  if (typeof rawDuration !== "number" || !Number.isInteger(rawDuration) || rawDuration < 5 || rawDuration > 480) return undefined;
  const mode = typeof r.mode === "string" && (INTERVIEW_MODES as readonly string[]).includes(r.mode) ? r.mode as InterviewMode : undefined;
  const location = text(r.location, INTERVIEW_LOCATION_MAX, false);
  if (!mode || location === undefined) return undefined;
  return { cardId: r.cardId.toLowerCase(), scheduledAt: at.toISOString(), durationMinutes: rawDuration, mode, location };
}

/** Kuwait is UTC+3 all year (no daylight saving). */
export function interviewInstant(value: string): Date | undefined {
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (local) {
    const [, y, mo, d, h, mi] = local.map(Number) as [number, number, number, number, number, number];
    const date = new Date(Date.UTC(y, mo - 1, d, h - 3, mi));
    const back = new Date(date.getTime() + 3 * 3_600_000);
    return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d && back.getUTCHours() === h ? date : undefined;
  }
  const offset = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!offset) return undefined;
  // The written calendar day must exist: 2027-02-30 is refused, not rolled into March.
  const [y, mo, d] = [Number(offset[1]), Number(offset[2]), Number(offset[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function kuwaitWallClock(instant: string | Date): string {
  const d = new Date((instant instanceof Date ? instant : new Date(instant)).getTime() + 3 * 3_600_000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

/** `expectedVersion` (the version the form showed, 0 for none) refuses a correction from a stale form; absent, no check. */
export interface EvaluationFields { readonly outcome: InterviewOutcome; readonly rating: number | null; readonly sharedNote: string | null; readonly internalNote: string | null; readonly expectedVersion?: number }
export function parseEvaluation(value: unknown): EvaluationFields | undefined {
  if (!closed(value, ["outcome", "rating", "sharedNote", "internalNote", "version"])) return undefined;
  const r = value as Record<string, unknown>;
  const outcome = typeof r.outcome === "string" && (INTERVIEW_OUTCOMES as readonly string[]).includes(r.outcome) ? r.outcome as InterviewOutcome : undefined;
  const rawRating = r.rating === undefined || r.rating === null || r.rating === "" ? null : typeof r.rating === "string" && /^[1-5]$/.test(r.rating) ? Number(r.rating) : r.rating;
  const rating = rawRating === null ? null : typeof rawRating === "number" && Number.isInteger(rawRating) && rawRating >= 1 && rawRating <= 5 ? rawRating : undefined;
  const sharedNote = text(r.sharedNote, EVALUATION_NOTE_MAX, true), internalNote = text(r.internalNote, EVALUATION_NOTE_MAX, true);
  if (!outcome || rating === undefined || sharedNote === undefined || internalNote === undefined) return undefined;
  if (outcome === "no_show" && rating !== null) return undefined;
  if (r.version === undefined) return { outcome, rating, sharedNote, internalNote };
  const expectedVersion = typeof r.version === "string" && /^(0|[1-9][0-9]{0,8})$/.test(r.version) ? Number(r.version) : typeof r.version === "number" && Number.isInteger(r.version) && r.version >= 0 && r.version < 1e9 ? r.version : undefined;
  if (expectedVersion === undefined) return undefined;
  return { outcome, rating, sharedNote, internalNote, expectedVersion };
}

export interface InterviewRow {
  readonly id: string; readonly card_id: string; readonly person_name: string | null; readonly scheduled_at: string | Date; readonly duration_minutes: number; readonly mode: InterviewMode;
  readonly location: string | null; readonly status: InterviewStatus; readonly outcome: InterviewOutcome | null; readonly rating: number | null;
  readonly shared_note: string | null; readonly internal_note: string | null; readonly scheduled_by_name: string | null; readonly evaluation_version: number | null;
}
export interface InterviewView {
  readonly interviewId: string; readonly cardId: string; readonly personName: string | null; readonly scheduledAt: string; readonly kuwaitTime: string; readonly durationMinutes: number;
  readonly mode: InterviewMode; readonly location: string | null; readonly status: InterviewStatus; readonly outcome: InterviewOutcome | null; readonly rating: number | null;
  readonly sharedNote: string | null; readonly internalNote?: string | null; readonly scheduledBy: string | null; readonly evaluationVersion: number | null;
}
const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();

/** Staff and the company see the evaluation; only operator staff see the internal note. */
export function interviewView(row: InterviewRow, seesInternal: boolean): InterviewView {
  const base = {
    interviewId: row.id, cardId: row.card_id, personName: row.person_name, scheduledAt: iso(row.scheduled_at), kuwaitTime: kuwaitWallClock(row.scheduled_at), durationMinutes: row.duration_minutes,
    mode: row.mode, location: row.location, status: row.status, outcome: row.outcome, rating: row.rating, sharedNote: row.shared_note, scheduledBy: row.scheduled_by_name, evaluationVersion: row.evaluation_version,
  };
  return seesInternal ? { ...base, internalNote: row.internal_note } : base;
}

export interface PersonInterviewRow { readonly id: string; readonly org_name: string; readonly store_name: string; readonly position_title: string; readonly scheduled_at: string | Date; readonly duration_minutes: number; readonly mode: InterviewMode; readonly location: string | null; readonly status: InterviewStatus; readonly outcome: InterviewOutcome | null }
/** What the person sees: when, where, and the outcome; never a rating or any note. */
export function personInterviewView(row: PersonInterviewRow): { readonly interviewId: string; readonly company: string; readonly store: string; readonly positionTitle: string; readonly scheduledAt: string; readonly kuwaitTime: string; readonly durationMinutes: number; readonly mode: InterviewMode; readonly location: string | null; readonly status: InterviewStatus; readonly outcome: InterviewOutcome | null } {
  return { interviewId: row.id, company: row.org_name, store: row.store_name, positionTitle: row.position_title, scheduledAt: iso(row.scheduled_at), kuwaitTime: kuwaitWallClock(row.scheduled_at), durationMinutes: row.duration_minutes, mode: row.mode, location: row.location, status: row.status, outcome: row.outcome };
}
