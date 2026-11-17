// Legacy work history for the importer (M-5) and the W-7 reconciliation report.
//
// Pure mapping: legacy rows in, work records or named issues out. The importer
// lane owns reading the mirror, id maps and writing; this module owns what a
// legacy row means here. Reports carry legacy ids only.
//
// Legacy facts this relies on (Yii2 `studenthub`):
// - datetimes are written by PHP in Asia/Kuwait (`common/config/main.php`), no DST;
// - `candidate_working_hour.status` and `candidate_work_log_feedback.status`:
//   0 pending, 1 approved, 2 rejected; `via` is "Manual Log" for manual rows;
// - `total_time` came from a trigger that never ran on insert, so it can be
//   null or negative: duration is recomputed from the times and a mismatch is
//   reported, not imported;
// - one store at a time lived on `candidate.store_id` with no history, so
//   placements are derived from where the hours were logged.

import { isIsoDate, type IsoDate } from "./common.js";

/** Legacy `Y-m-d H:i:s` in Asia/Kuwait (UTC+3, no DST) to an instant. */
export function legacyInstant(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m || !isIsoDate(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4]) > 59) return undefined;
  return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}+03:00`);
}

export interface LegacyWorkingHourRow {
  readonly candidate_working_hour_uuid: string;
  readonly candidate_id: number | string;
  readonly store_id: number | string;
  readonly date: string | null;
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly total_time: number | string | null;
  readonly start_location_lat: string | number | null;
  readonly start_location_long: string | number | null;
  readonly end_location_lat: string | number | null;
  readonly end_location_long: string | number | null;
  readonly note: string | null;
  readonly status: number | string;
  readonly via: string | null;
  readonly appeal_uuid?: string | null;
}

export interface ImportedSession {
  readonly legacyRef: string;
  readonly legacyCandidateId: string;
  readonly legacyStoreId: string;
  readonly workDate: IsoDate;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly startLocation: { readonly latitude: number; readonly longitude: number } | null;
  readonly endLocation: { readonly latitude: number; readonly longitude: number } | null;
  readonly status: "pending" | "approved" | "rejected";
  readonly flags: readonly ("location_missing")[];
  readonly note: string | null;
  readonly manual: boolean;
  /** Legacy appeal this row answered (staff add-hour). */
  readonly legacyAppealRef: string | null;
}

export type ImportIssueCode =
  | "bad_time" | "open_session" | "end_before_start" | "total_time_mismatch" | "date_mismatch" | "bad_status" | "bad_rating" | "bad_location";
export interface ImportIssue { readonly table: string; readonly legacyId: string; readonly code: ImportIssueCode; readonly detail?: string }

const STATUS = ["pending", "approved", "rejected"] as const;
function status(value: unknown): "pending" | "approved" | "rejected" | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) ? STATUS[n] : undefined;
}
function coordinate(lat: unknown, long: unknown): { latitude: number; longitude: number } | null | undefined {
  const empty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
  if (empty(lat) && empty(long)) return null;
  // Half a pair is a defect, not a fix (Number(null) would read as 0).
  if (empty(lat) || empty(long)) return undefined;
  const a = Number(lat), b = Number(long);
  // Legacy wrote 0,0 when the device gave nothing.
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return undefined;
  if (a === 0 && b === 0) return null;
  return { latitude: Math.round(a * 1e6) / 1e6, longitude: Math.round(b * 1e6) / 1e6 };
}
const kuwaitDay = (d: Date): IsoDate => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);

/**
 * Maps one `candidate_working_hour` row. Open sessions are not imported (the
 * final sync runs with clocks stopped; an open row is reported). The work date
 * is the start's Kuwait date, as legacy wrote it; a differing `date` column is
 * reported and the start wins.
 */
export function mapLegacyWorkingHour(row: LegacyWorkingHourRow): { readonly session?: ImportedSession; readonly issues: readonly ImportIssue[] } {
  const id = String(row.candidate_working_hour_uuid);
  const issue = (code: ImportIssueCode, detail?: string): ImportIssue => ({ table: "candidate_working_hour", legacyId: id, code, ...(detail ? { detail } : {}) });
  const startedAt = legacyInstant(row.start_time);
  if (!startedAt) return { issues: [issue("bad_time", "start_time")] };
  if (row.end_time === null || row.end_time === undefined || row.end_time === "") return { issues: [issue("open_session")] };
  const endedAt = legacyInstant(row.end_time);
  if (!endedAt) return { issues: [issue("bad_time", "end_time")] };
  if (endedAt < startedAt) return { issues: [issue("end_before_start")] };
  const st = status(row.status);
  if (!st) return { issues: [issue("bad_status")] };
  const issues: ImportIssue[] = [];
  const workDate = kuwaitDay(startedAt);
  if (row.date && row.date !== workDate) issues.push(issue("date_mismatch", `${row.date}`));
  const seconds = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000);
  if (row.total_time === null || row.total_time === undefined || Number(row.total_time) !== seconds) issues.push(issue("total_time_mismatch", `${row.total_time ?? "null"}`));
  const start = coordinate(row.start_location_lat, row.start_location_long), end = coordinate(row.end_location_lat, row.end_location_long);
  if (start === undefined || end === undefined) issues.push(issue("bad_location"));
  const manual = row.via === "Manual Log";
  const startLocation = start ?? null, endLocation = end ?? null;
  const note = typeof row.note === "string" && row.note.trim() !== "" ? row.note.trim().slice(0, 1000) : null;
  return {
    session: Object.freeze({
      legacyRef: `cwh:${id}`, legacyCandidateId: String(row.candidate_id), legacyStoreId: String(row.store_id), workDate, startedAt, endedAt,
      startLocation, endLocation, status: st, flags: !manual && (startLocation === null || endLocation === null) ? ["location_missing"] as const : [],
      note, manual, legacyAppealRef: row.appeal_uuid ? `appeal:${row.appeal_uuid}` : null,
    }),
    issues,
  };
}

export interface LegacyFeedbackRow {
  readonly cwlf_uuid: string;
  readonly candidate_id: number | string;
  readonly store_id: number | string;
  readonly date: string;
  readonly candidate_working_hour_uuid: string | null;
  readonly status: number | string;
  readonly note: string | null;
  readonly reason: string | null;
  readonly is_public: number | string | boolean | null;
  readonly rating: number | string | null;
  readonly created_by: number | string | null;
  readonly created_at: string | null;
}

export interface ImportedDecision {
  readonly legacyRef: string;
  readonly legacyCandidateId: string;
  readonly legacyStoreId: string;
  readonly workDate: IsoDate;
  readonly scope: "session" | "day";
  /** Legacy session the decision named; null for a day decision. */
  readonly legacySessionRef: string | null;
  readonly outcome: "approved" | "rejected";
  readonly reason: string | null;
  readonly note: string | null;
  readonly rating: number | null;
  readonly notePublic: boolean;
  readonly legacyDecidedBy: string | null;
  readonly decidedAt: Date | null;
}

/** Maps one `candidate_work_log_feedback` row; a pending row is not a decision and is skipped. */
export function mapLegacyFeedback(row: LegacyFeedbackRow): { readonly decision?: ImportedDecision; readonly issues: readonly ImportIssue[] } {
  const id = String(row.cwlf_uuid);
  const issue = (code: ImportIssueCode, detail?: string): ImportIssue => ({ table: "candidate_work_log_feedback", legacyId: id, code, ...(detail ? { detail } : {}) });
  const st = status(row.status);
  if (!st) return { issues: [issue("bad_status")] };
  if (st === "pending") return { issues: [] };
  if (!isIsoDate(row.date)) return { issues: [issue("bad_time", "date")] };
  const issues: ImportIssue[] = [];
  let rating: number | null = null;
  if (row.rating !== null && row.rating !== undefined && row.rating !== "" && Number(row.rating) !== 0) {
    const r = Number(row.rating);
    if (Number.isInteger(r) && r >= 1 && r <= 5) rating = r; else issues.push(issue("bad_rating", String(row.rating)));
  }
  const text = (v: string | null, max: number) => typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null;
  return {
    decision: Object.freeze({
      legacyRef: `cwlf:${id}`, legacyCandidateId: String(row.candidate_id), legacyStoreId: String(row.store_id), workDate: row.date,
      scope: row.candidate_working_hour_uuid ? "session" : "day", legacySessionRef: row.candidate_working_hour_uuid ? `cwh:${row.candidate_working_hour_uuid}` : null,
      outcome: st, reason: text(row.reason, 255), note: text(row.note, 2000), rating,
      notePublic: row.is_public === true || Number(row.is_public) === 1, legacyDecidedBy: row.created_by === null || row.created_by === undefined ? null : `contact:${row.created_by}`,
      decidedAt: legacyInstant(row.created_at) ?? null,
    }),
    issues,
  };
}

export interface DerivedPlacement {
  readonly legacyCandidateId: string;
  readonly legacyStoreId: string;
  readonly startDate: IsoDate;
  /** Null for the person's current store. */
  readonly endDate: IsoDate | null;
}

const dayBefore = (d: IsoDate): IsoDate => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * Placements from where hours were logged: consecutive stretches at one store
 * become one placement, ending the day before the next store's first day. The
 * person's current store (`candidate.store_id`) stays open-ended, starting at
 * its first logged day or, with no hours there, at `currentSince`.
 */
export function derivePlacements(legacyCandidateId: string, sessions: readonly { readonly legacyStoreId: string; readonly workDate: IsoDate }[],
  current: { readonly legacyStoreId: string; readonly since: IsoDate } | null): readonly DerivedPlacement[] {
  const days = [...sessions].sort((a, b) => a.workDate.localeCompare(b.workDate) || a.legacyStoreId.localeCompare(b.legacyStoreId));
  const stretches: { store: string; first: IsoDate; last: IsoDate }[] = [];
  for (const s of days) {
    const last = stretches[stretches.length - 1];
    if (last && last.store === s.legacyStoreId) last.last = s.workDate;
    else if (last && last.last === s.workDate) continue; // Two stores on one day: the earlier stretch keeps the day; the importer reports the row.
    else stretches.push({ store: s.legacyStoreId, first: s.workDate, last: s.workDate });
  }
  const out: DerivedPlacement[] = stretches.map((s, i) => ({
    legacyCandidateId, legacyStoreId: s.store, startDate: s.first, endDate: stretches[i + 1] ? dayBefore(stretches[i + 1]!.first) : s.last,
  }));
  if (current) {
    const tail = out[out.length - 1];
    if (tail && tail.legacyStoreId === current.legacyStoreId) out[out.length - 1] = { ...tail, endDate: null };
    else {
      const start = tail && tail.endDate !== null && tail.endDate >= current.since ? new Date(Date.parse(`${tail.endDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : current.since;
      out.push({ legacyCandidateId, legacyStoreId: current.legacyStoreId, startDate: start, endDate: null });
    }
  }
  return Object.freeze(out.map((p) => Object.freeze(p)));
}

export interface LegacyDayRow {
  readonly cwd_uuid: string;
  readonly candidate_id: number | string;
  readonly store_id: number | string;
  readonly date: string;
  /** Seconds of the day's closed sessions, every status (legacy kept rejected time in it). */
  readonly total_time: number | string | null;
  /** Session counts, not seconds. */
  readonly total_approved: number | string | null;
  readonly total_pending: number | string | null;
  readonly total_rejected: number | string | null;
}
export interface DayTotalsHere {
  readonly legacyCandidateId: string;
  readonly legacyStoreId: string;
  readonly workDate: IsoDate;
  readonly approvedSeconds: number;
  readonly pendingSeconds: number;
  readonly rejectedSeconds: number;
  readonly approvedCount: number;
  readonly pendingCount: number;
  readonly rejectedCount: number;
}
export interface DayDrift {
  readonly legacyId: string | null;
  readonly legacyCandidateId: string;
  readonly legacyStoreId: string;
  readonly workDate: IsoDate;
  readonly field: "total_time" | "approved_count" | "pending_count" | "rejected_count" | "missing_here" | "missing_in_legacy";
  readonly legacy: number | null;
  readonly here: number | null;
}

/**
 * W-7 reconciliation: compares legacy `candidate_working_date` (closed seconds
 * of every status, and session counts per status) with the day totals here.
 * Lists every difference and changes nothing (the legacy repair crons are
 * retired). Legacy ids only.
 */
export function reconcileDays(legacy: readonly LegacyDayRow[], here: readonly DayTotalsHere[]): readonly DayDrift[] {
  const key = (c: string, s: string, d: string) => `${c}|${s}|${d}`;
  const ours = new Map(here.map((h) => [key(h.legacyCandidateId, h.legacyStoreId, h.workDate), h]));
  const seen = new Set<string>();
  const drift: DayDrift[] = [];
  const n = (v: number | string | null) => Number(v ?? 0);
  for (const row of legacy) {
    const c = String(row.candidate_id), s = String(row.store_id), k = key(c, s, row.date);
    seen.add(k);
    const h = ours.get(k);
    const base = { legacyId: String(row.cwd_uuid), legacyCandidateId: c, legacyStoreId: s, workDate: row.date };
    if (!h) {
      if (n(row.total_time) !== 0 || n(row.total_approved) + n(row.total_pending) + n(row.total_rejected) > 0) drift.push({ ...base, field: "missing_here", legacy: n(row.total_time), here: null });
      continue;
    }
    const checks = [
      ["total_time", n(row.total_time), h.approvedSeconds + h.pendingSeconds + h.rejectedSeconds],
      ["approved_count", n(row.total_approved), h.approvedCount],
      ["pending_count", n(row.total_pending), h.pendingCount],
      ["rejected_count", n(row.total_rejected), h.rejectedCount],
    ] as const;
    for (const [field, l, ours2] of checks) if (l !== ours2) drift.push({ ...base, field, legacy: l, here: ours2 });
  }
  for (const h of here) {
    const total = h.approvedSeconds + h.pendingSeconds + h.rejectedSeconds;
    const count = h.approvedCount + h.pendingCount + h.rejectedCount;
    if (!seen.has(key(h.legacyCandidateId, h.legacyStoreId, h.workDate)) && (total > 0 || count > 0)) {
      drift.push({ legacyId: null, legacyCandidateId: h.legacyCandidateId, legacyStoreId: h.legacyStoreId, workDate: h.workDate, field: "missing_in_legacy", legacy: null, here: total });
    }
  }
  return Object.freeze(drift.sort((a, b) => a.workDate.localeCompare(b.workDate) || a.legacyCandidateId.localeCompare(b.legacyCandidateId) || a.field.localeCompare(b.field)));
}
