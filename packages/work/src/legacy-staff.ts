// Legacy staff time and the daily stand-up for the importer (M-5).
//
// Pure mapping, like legacy.ts: legacy rows in, records or named issues out.
// The importer lane reads the mirror, resolves a legacy `staff_id` to a
// principal (a staff id with no principal is reported by the importer, not
// here) and calls the work import store. Issues carry legacy ids, rule codes
// and numbers only, never row text. Mapping and importing send nothing (no
// notices, outbox rows or emails).
//
// Legacy facts this relies on (Yii2 `studenthub`, m221215_072607_attendance):
// - datetimes are Asia/Kuwait wall time (UTC+3, no DST);
// - `staff_work_session`: `created_at` is the start; ending a session
//   (staff DailyStandupController::actionEndSession) saves
//   `total_minutes = (int)((now - created_at) / 60)` and `updated_at = NOW()`
//   in the same save, so `updated_at` is the end. A row with no minutes is
//   open: legacy's export showed the staff member's hours per day for it;
// - `daily_standup_question`: deleted outright in legacy, so an answer can
//   name a question the mirror no longer holds;
// - `daily_standup_answer`: keeps a copy of the question text; repeats on a
//   day were allowed.

import type { IsoDate } from "./common.js";
import { legacyInstant } from "./legacy.js";

export interface LegacyStaffSessionRow {
  readonly work_session_uuid: string;
  readonly staff_id: number | string | null;
  readonly total_minutes: number | string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
}
export interface LegacyStandupQuestionRow {
  readonly question_uuid: string;
  readonly question: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
}
export interface LegacyStandupAnswerRow {
  readonly answer_uuid: string;
  readonly staff_id: number | string | null;
  readonly question_uuid: string | null;
  readonly question: string | null;
  readonly answer: string | null;
  readonly created_at: string | null;
}

export type StaffImportIssueCode = "bad_time" | "bad_minutes" | "minutes_mismatch" | "no_staff" | "no_question" | "bad_text";
export interface StaffImportIssue {
  readonly table: "staff_work_session" | "daily_standup_question" | "daily_standup_answer";
  readonly legacyId: string;
  readonly code: StaffImportIssueCode;
  readonly detail?: string;
}

export interface ImportedStaffSession {
  /** The legacy primary key `work_session_uuid`, as a string (`work_session_<uuid>`). */
  readonly legacyRef: string;
  readonly legacyStaffId: string;
  /** The Kuwait date of the start, as legacy grouped it. */
  readonly workDate: IsoDate;
  readonly startedAt: Date;
  /** Null while legacy still shows it open. */
  readonly endedAt: Date | null;
}
export interface ImportedStandupQuestion {
  /** The legacy primary key `question_uuid`. */
  readonly legacyRef: string;
  readonly question: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface ImportedStandupAnswer {
  /** The legacy primary key `answer_uuid`. */
  readonly legacyRef: string;
  readonly legacyStaffId: string;
  readonly questionLegacyRef: string;
  /** The question as it read when answered. */
  readonly question: string;
  readonly answer: string;
  readonly workDate: IsoDate;
  readonly createdAt: Date;
}

const kuwaitDay = (d: Date): IsoDate => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
const staffId = (v: unknown): string | undefined => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^[1-9][0-9]{0,18}$/.test(s) ? s : undefined;
};
const MAX_ANSWER = 4000;
/** Characters as Postgres counts them (code points, not UTF-16 units). */
const chars = (s: string): number => [...s].length;

/**
 * One `staff_work_session` row. The end is `updated_at` when it agrees with
 * the minutes legacy stored; when it doesn't (the row was saved again later),
 * the minutes win, because they are what legacy showed and exported, and the
 * row is imported with a `minutes_mismatch` issue.
 */
export function mapLegacyStaffSession(row: LegacyStaffSessionRow): { readonly session?: ImportedStaffSession; readonly issues: readonly StaffImportIssue[] } {
  const id = String(row.work_session_uuid);
  const issue = (code: StaffImportIssueCode, detail?: string): StaffImportIssue => ({ table: "staff_work_session", legacyId: id, code, ...(detail ? { detail } : {}) });
  const staff = staffId(row.staff_id);
  if (!staff) return { issues: [issue("no_staff")] };
  const startedAt = legacyInstant(row.created_at);
  if (!startedAt) return { issues: [issue("bad_time", "created_at")] };
  const base = { legacyRef: id, legacyStaffId: staff, workDate: kuwaitDay(startedAt), startedAt };
  if (row.total_minutes === null || row.total_minutes === undefined || row.total_minutes === "") {
    return { session: Object.freeze({ ...base, endedAt: null }), issues: [] };
  }
  const minutes = Number(row.total_minutes);
  if (!Number.isInteger(minutes) || minutes < 0) return { issues: [issue("bad_minutes", String(row.total_minutes))] };
  const updatedAt = legacyInstant(row.updated_at);
  if (updatedAt && updatedAt >= startedAt && Math.floor((updatedAt.getTime() - startedAt.getTime()) / 60_000) === minutes) {
    return { session: Object.freeze({ ...base, endedAt: updatedAt }), issues: [] };
  }
  return { session: Object.freeze({ ...base, endedAt: new Date(startedAt.getTime() + minutes * 60_000) }), issues: [issue("minutes_mismatch", String(minutes))] };
}

/** One `daily_standup_question` row; the text is trimmed, as questions are kept here. */
export function mapLegacyStandupQuestion(row: LegacyStandupQuestionRow): { readonly question?: ImportedStandupQuestion; readonly issues: readonly StaffImportIssue[] } {
  const id = String(row.question_uuid);
  const issue = (code: StaffImportIssueCode, detail?: string): StaffImportIssue => ({ table: "daily_standup_question", legacyId: id, code, ...(detail ? { detail } : {}) });
  const text = typeof row.question === "string" ? row.question.trim() : "";
  if (chars(text) < 1 || chars(text) > 255) return { issues: [issue("bad_text", "question")] };
  const createdAt = legacyInstant(row.created_at);
  if (!createdAt) return { issues: [issue("bad_time", "created_at")] };
  const updated = legacyInstant(row.updated_at);
  // An update stamp before the creation is a defect: the creation stands for both.
  const updatedAt = updated && updated >= createdAt ? updated : createdAt;
  return { question: Object.freeze({ legacyRef: id, question: text, createdAt, updatedAt }), issues: [] };
}

/**
 * One `daily_standup_answer` row. The day is the Kuwait date of `created_at`.
 * An answer with no visible text, or longer than answers here may be, is
 * reported and not imported: cutting it would change what was said.
 */
export function mapLegacyStandupAnswer(row: LegacyStandupAnswerRow): { readonly answer?: ImportedStandupAnswer; readonly issues: readonly StaffImportIssue[] } {
  const id = String(row.answer_uuid);
  const issue = (code: StaffImportIssueCode, detail?: string): StaffImportIssue => ({ table: "daily_standup_answer", legacyId: id, code, ...(detail ? { detail } : {}) });
  const staff = staffId(row.staff_id);
  if (!staff) return { issues: [issue("no_staff")] };
  const questionRef = typeof row.question_uuid === "string" ? row.question_uuid.trim() : "";
  if (questionRef === "") return { issues: [issue("no_question")] };
  const question = typeof row.question === "string" ? row.question : "";
  if (chars(question) < 1 || chars(question) > 255) return { issues: [issue("bad_text", "question")] };
  const answer = typeof row.answer === "string" ? row.answer : "";
  if (!/[^\s]/u.test(answer) || chars(answer) > MAX_ANSWER) return { issues: [issue("bad_text", "answer")] };
  const createdAt = legacyInstant(row.created_at);
  if (!createdAt) return { issues: [issue("bad_time", "created_at")] };
  return {
    answer: Object.freeze({ legacyRef: id, legacyStaffId: staff, questionLegacyRef: questionRef, question, answer, workDate: kuwaitDay(createdAt), createdAt }),
    issues: [],
  };
}
