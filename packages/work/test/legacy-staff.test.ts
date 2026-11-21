import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLegacyStaffHours, mapLegacyStaffSession, mapLegacyStandupAnswer, mapLegacyStandupQuestion, type LegacyStaffSessionRow, type LegacyStandupAnswerRow } from "../src/index.js";

const session = (over: Partial<LegacyStaffSessionRow> = {}): LegacyStaffSessionRow => ({
  work_session_uuid: "work_session_1", staff_id: 12, total_minutes: 150, created_at: "2026-11-18 09:00:10", updated_at: "2026-11-18 11:30:40", ...over,
});
const answer = (over: Partial<LegacyStandupAnswerRow> = {}): LegacyStandupAnswerRow => ({
  answer_uuid: "answer_1", staff_id: "12", question_uuid: "question_1", question: "What will you do today?", answer: "Call the stores", created_at: "2026-11-19 01:30:00", ...over,
});

test("LEGACY_STAFF a closed session ends at updated_at when it agrees with the stored minutes", () => {
  const { session: s, issues } = mapLegacyStaffSession(session());
  assert.deepEqual(issues, []);
  assert.deepEqual([s?.legacyRef, s?.legacyStaffId, s?.workDate, s?.startedAt.toISOString(), s?.endedAt?.toISOString()],
    ["work_session_1", "12", "2026-11-18", "2026-11-18T06:00:10.000Z", "2026-11-18T08:30:40.000Z"]);
});

test("LEGACY_STAFF stored minutes win over a later save and the row is reported", () => {
  const { session: s, issues } = mapLegacyStaffSession(session({ updated_at: "2026-11-19 08:00:00" }));
  assert.equal(s?.endedAt?.toISOString(), "2026-11-18T08:30:10.000Z");
  assert.deepEqual(issues, [{ table: "staff_work_session", legacyId: "work_session_1", code: "minutes_mismatch", detail: "150" }]);
  // An update stamp before the start can't be the end either.
  assert.equal(mapLegacyStaffSession(session({ updated_at: "2026-11-18 08:00:00", total_minutes: 0 })).session?.endedAt?.toISOString(), "2026-11-18T06:00:10.000Z");
});

test("LEGACY_STAFF a session with no minutes stays open; its day is the Kuwait date of the start", () => {
  for (const total_minutes of [null, ""]) {
    const { session: s, issues } = mapLegacyStaffSession(session({ total_minutes, created_at: "2026-11-18 23:59:59" }));
    assert.deepEqual([s?.endedAt, s?.workDate, issues], [null, "2026-11-18", []]);
  }
});

test("LEGACY_STAFF bad rows are reported by legacy id and not imported", () => {
  const code = (over: Partial<LegacyStaffSessionRow>) => { const r = mapLegacyStaffSession(session(over)); assert.equal(r.session, undefined); return r.issues.map((i) => `${i.code}:${i.detail ?? ""}`); };
  assert.deepEqual(code({ staff_id: null }), ["no_staff:"]);
  assert.deepEqual(code({ staff_id: "0" }), ["no_staff:"]);
  assert.deepEqual(code({ created_at: "2026-11-18" }), ["bad_time:created_at"]);
  assert.deepEqual(code({ total_minutes: -5 }), ["bad_minutes:-5"]);
  assert.deepEqual(code({ total_minutes: "1.5" }), ["bad_minutes:1.5"]);
  // Non-numeric minutes are row text: the issue names the rule only.
  assert.deepEqual(code({ total_minutes: "private note" }), ["bad_minutes:"]);
});

test("LEGACY_STANDUP questions keep their legacy ref and trimmed text; bad ones are reported", () => {
  const { question, issues } = mapLegacyStandupQuestion({ question_uuid: "question_1", question: "  Blockers?  ", created_at: "2026-01-02 10:00:00", updated_at: "2026-01-01 10:00:00" });
  assert.deepEqual(issues, []);
  assert.deepEqual([question?.legacyRef, question?.question, question?.createdAt.toISOString(), question?.updatedAt.toISOString()],
    ["question_1", "Blockers?", "2026-01-02T07:00:00.000Z", "2026-01-02T07:00:00.000Z"]);
  for (const text of [null, "   ", "x".repeat(256), "Block\u0000ers?"]) {
    assert.deepEqual(mapLegacyStandupQuestion({ question_uuid: "q", question: text, created_at: "2026-01-02 10:00:00", updated_at: null }).issues.map((i) => i.code), ["bad_text"]);
  }
  // 255 characters outside the BMP are still 255 characters here, as Postgres counts them.
  assert.equal(mapLegacyStandupQuestion({ question_uuid: "q", question: "😀".repeat(255), created_at: "2026-01-02 10:00:00", updated_at: null }).issues.length, 0);
});

test("LEGACY_STANDUP answers keep the question as it read and the Kuwait day of created_at", () => {
  const { answer: a, issues } = mapLegacyStandupAnswer(answer());
  assert.deepEqual(issues, []);
  assert.deepEqual([a?.legacyRef, a?.legacyStaffId, a?.questionLegacyRef, a?.question, a?.answer, a?.workDate, a?.createdAt.toISOString()],
    ["answer_1", "12", "question_1", "What will you do today?", "Call the stores", "2026-11-19", "2026-11-18T22:30:00.000Z"]);
  const code = (over: Partial<LegacyStandupAnswerRow>) => mapLegacyStandupAnswer(answer(over)).issues.map((i) => `${i.code}:${i.detail ?? ""}`);
  assert.deepEqual(code({ staff_id: "abc" }), ["no_staff:"]);
  assert.deepEqual(code({ question_uuid: null }), ["no_question:"]);
  assert.deepEqual(code({ question: "" }), ["bad_text:question"]);
  assert.deepEqual(code({ question: " \n\t" }), ["bad_text:question"]);
  assert.deepEqual(code({ answer: " \n\t" }), ["bad_text:answer"]);
  assert.deepEqual(code({ answer: "a".repeat(4001) }), ["bad_text:answer"]);
  assert.deepEqual(code({ answer: "a".repeat(4000) }), []);
  // Postgres text can't hold NUL: reported, never stripped.
  assert.deepEqual(code({ answer: "Done\u0000today" }), ["bad_text:answer"]);
  assert.deepEqual(code({ question: "Plan\u0000?" }), ["bad_text:question"]);
  assert.deepEqual(code({ created_at: null }), ["bad_time:created_at"]);
});

test("LEGACY_STANDUP a Kuwait 00:01 stamp stays on its Kuwait day, though its UTC date is the day before", () => {
  // Legacy stamps are read as Asia/Kuwait wall time (UTC+3, no DST); the day is never the UTC date.
  const a = mapLegacyStandupAnswer(answer({ created_at: "2026-11-20 00:01:00" })).answer!;
  assert.deepEqual([a.workDate, a.createdAt.toISOString()], ["2026-11-20", "2026-11-19T21:01:00.000Z"]);
  const s = mapLegacyStaffSession(session({ created_at: "2026-11-20 00:01:00", total_minutes: null })).session!;
  assert.deepEqual([s.workDate, s.startedAt.toISOString()], ["2026-11-20", "2026-11-19T21:01:00.000Z"]);
  // Two legacy answers to one question on one day stay two rows (each keeps its own ref).
  const twice = [answer({ answer_uuid: "answer_a" }), answer({ answer_uuid: "answer_b" })].map((r) => mapLegacyStandupAnswer(r).answer!);
  assert.deepEqual(twice.map((x) => [x.legacyRef, x.workDate]), [["answer_a", "2026-11-19"], ["answer_b", "2026-11-19"]]);
});

test("LEGACY_STAFF_HOURS a staff record's hours per day keeps its number under staff:<id>; a missing or bad one is reported, not defaulted", () => {
  assert.deepEqual(mapLegacyStaffHours({ staff_id: 12, hours_per_day: 8 }), { hours: { legacyRef: "staff:12", legacyStaffId: "12", hours: 8 }, issues: [] });
  assert.deepEqual(mapLegacyStaffHours({ staff_id: " 7 ", hours_per_day: "0" }).hours, { legacyRef: "staff:7", legacyStaffId: "7", hours: 0 });
  assert.equal(mapLegacyStaffHours({ staff_id: 7, hours_per_day: 24 }).hours?.hours, 24);
  const bad = (hours_per_day: number | string | null) => mapLegacyStaffHours({ staff_id: 7, hours_per_day });
  assert.deepEqual(bad(null), { issues: [{ table: "staff", legacyId: "7", code: "bad_hours" }] });
  assert.deepEqual(bad(""), { issues: [{ table: "staff", legacyId: "7", code: "bad_hours" }] });
  assert.deepEqual(bad(25), { issues: [{ table: "staff", legacyId: "7", code: "bad_hours", detail: "25" }] });
  assert.deepEqual(bad(-1).issues.map((i) => i.code), ["bad_hours"]);
  assert.deepEqual(bad(7.5).issues.map((i) => [i.code, i.detail]), [["bad_hours", "7.5"]]);
  // Row text never reaches the report.
  assert.deepEqual(bad("eight"), { issues: [{ table: "staff", legacyId: "7", code: "bad_hours" }] });
  assert.deepEqual(mapLegacyStaffHours({ staff_id: null, hours_per_day: 8 }).issues.map((i) => i.code), ["no_staff"]);
  assert.deepEqual(mapLegacyStaffHours({ staff_id: "0", hours_per_day: 8 }).issues.map((i) => i.code), ["no_staff"]);
});
