import assert from "node:assert/strict";
import test from "node:test";

import {
  M5_STAFF_SOURCES, M5InputError, m5SourceSql, planStaffWork, readM5StaffSources, resolveStaff, runStaffWork, staffCandidates,
  type M5StaffSources, type StaffMatch, type StaffMatcher,
} from "../src/m5-staff.js";
import type { LegacyReader } from "../src/twin/journey.js";

// Synthetic rows only.
const OPERATOR = "root";
const staffRow = (id: number, extra: Record<string, unknown> = {}) => ({ staff_id: id, staff_email: `staff${id}@example.invalid`, deleted: 0, hours_per_day: 8, ...extra });
const session = (uuid: string, staff: number, extra: Record<string, unknown> = {}) =>
  ({ work_session_uuid: uuid, staff_id: staff, total_minutes: 60, created_at: "2026-11-01 09:00:00", updated_at: "2026-11-01 10:00:00", ...extra });
const question = (uuid: string) => ({ question_uuid: uuid, question: "What did you do?", created_at: "2026-10-01 09:00:00", updated_at: "2026-10-01 09:00:00" });
const answer = (uuid: string, staff: number, q: string) =>
  ({ answer_uuid: uuid, staff_id: staff, question_uuid: q, question: "What did you do?", answer: "Things", created_at: "2026-11-01 09:30:00" });
const sources = (over: Partial<Record<keyof M5StaffSources, Record<string, unknown>[]>> = {}): M5StaffSources => ({
  staff: [staffRow(1), staffRow(2)],
  staff_work_session: [session("s-1", 1), session("s-2", 2)],
  daily_standup_question: [question("q-1")],
  daily_standup_answer: [answer("a-1", 1, "q-1"), answer("a-2", 2, "q-1")],
  ...over,
});

/** A matcher over a fixed list of principals: address, verified, operator staff. */
function matcher(people: { id: string; email: string; verified?: boolean; operator?: boolean }[]): { match: StaffMatcher; seen: string[][] } {
  const seen: string[][] = [];
  const match: StaffMatcher = async (candidates, org) => {
    assert.equal(org, OPERATOR);
    seen.push(candidates.map((c) => c.staffId));
    const out: StaffMatch[] = [];
    for (const c of candidates) {
      for (const p of people) {
        if (p.email.trim().toLowerCase() === c.email.trim().toLowerCase()) {
          out.push({ staffId: c.staffId, principalId: p.id, verified: p.verified ?? true, operatorStaff: p.operator ?? true });
        }
      }
    }
    return out;
  };
  return { match, seen };
}

test("each staff table is read with a fixed column list, and no column carries a password, token or name", () => {
  for (const [table, columns] of Object.entries(M5_STAFF_SOURCES)) {
    assert.ok(!columns.some((c) => /pass|token|auth|name|phone|salary/.test(c)), table);
    assert.match(m5SourceSql(table as keyof typeof M5_STAFF_SOURCES), new RegExp(`FROM \`${table}\`$`));
  }
});

test("a read that is not the whole table, unchanged during the read, is refused", async () => {
  const rows = sources();
  const reader = (drift: number, failOn?: string): LegacyReader => {
    let counts = 0;
    return {
      async rows(sql) {
        if (failOn && sql.includes(failOn) && !sql.includes("COUNT(*)")) throw new Error("boom: staff19@example.invalid");
        const table = /FROM `([a-z_]+)`$/.exec(sql)![1] as keyof M5StaffSources;
        if (sql.includes("COUNT(*)")) { counts++; return [{ n: rows[table].length + (counts === 2 ? drift : 0) }]; }
        return rows[table];
      },
    };
  };
  assert.deepEqual(Object.keys(await readM5StaffSources(reader(0))), Object.keys(M5_STAFF_SOURCES));
  await assert.rejects(readM5StaffSources(reader(1)), (e: unknown) => e instanceof M5InputError && e.code === "m5.inputIncomplete");
  await assert.rejects(readM5StaffSources(reader(0, "daily_standup_answer")), (e: unknown) => e instanceof M5InputError && e.code === "m5.read.daily_standup_answer" && !String(e).includes("@"));
});

test("a staff member resolves only by a verified address and an operator grant, one to one; everything else is reported", async () => {
  const rows = [staffRow(1), staffRow(2), staffRow(3), staffRow(4), staffRow(5), staffRow(6, { deleted: 1 }), staffRow(7, { staff_email: null }),
    staffRow(8, { staff_email: "shared@example.invalid" }), staffRow(9, { staff_email: "SHARED@example.invalid" }), staffRow(10), staffRow(10),
    staffRow(11, { deleted: null }), { staff_id: "x", staff_email: "bad@example.invalid", deleted: 0, hours_per_day: 8 }];
  const { match, seen } = matcher([
    { id: "p1", email: "staff1@example.invalid" },
    { id: "p2", email: "staff2@example.invalid", verified: false },
    { id: "p3", email: "staff3@example.invalid", operator: false },
    { id: "p4a", email: "staff4@example.invalid" }, { id: "p4b", email: "staff4@example.invalid" },
    { id: "p6", email: "staff6@example.invalid" },
    { id: "pshared", email: "shared@example.invalid" },
  ]);
  const { candidates, badIds } = staffCandidates(rows);
  assert.equal(badIds, 1);
  const r = await resolveStaff(candidates, match, OPERATOR);
  assert.deepEqual([...r.principals], [["1", "p1"]]);
  assert.deepEqual(Object.fromEntries(r.unresolved), {
    2: "unresolved", 3: "notOperatorStaff", 4: "ambiguous", 5: "unresolved", 6: "deleted", 7: "unresolved",
    // Two legacy rows to one principal: neither.
    8: "ambiguous", 9: "ambiguous",
    // One id twice in legacy: neither.
    10: "ambiguous",
    // A deleted flag that is not an explicit 0 fails closed.
    11: "deleted",
  });
  // A deleted or addressless row is never sent to the match.
  assert.ok(!seen.flat().some((id) => ["6", "7", "11"].includes(id)));
});

test("the plan reports every row of an unresolved staff member as no_staff and keeps every legacy ref for reconciliation", async () => {
  const { match } = matcher([{ id: "p1", email: "staff1@example.invalid" }]);
  const src = sources({ staff_work_session: [session("s-1", 1), session("s-2", 2), session("s-3", 1, { total_minutes: -5 }), session("s-4", 1, { total_minutes: 90 })] });
  const resolution = await resolveStaff(staffCandidates(src.staff).candidates, match, OPERATOR);
  const plan = planStaffWork(src, resolution);
  assert.deepEqual(plan.sessions.map((s) => [s.legacyRef, s.staffPrincipalId]), [["s-1", "p1"], ["s-4", "p1"]]);
  assert.deepEqual(plan.issues.work_staff_sessions, [{ legacyRef: "s-2", code: "no_staff" }, { legacyRef: "s-3", code: "bad_minutes" }, { legacyRef: "s-4", code: "minutes_mismatch" }]);
  assert.deepEqual(plan.answers.map((a) => a.legacyRef), ["a-1"]);
  assert.deepEqual(plan.issues.work_standup_answers, [{ legacyRef: "a-2", code: "no_staff" }]);
  assert.deepEqual(plan.hours, [{ legacyRef: "staff:1", staffPrincipalId: "p1", hours: 8 }]);
  assert.deepEqual(plan.issues.work_staff_hours_per_day, [{ legacyRef: "staff:2", code: "no_staff" }]);
  assert.deepEqual(plan.legacyRefs.work_staff_sessions, ["s-1", "s-2", "s-3", "s-4"]);
  assert.deepEqual(plan.legacyRefs.work_standup_questions, ["q-1"]);
  const text = JSON.stringify(plan.issues);
  assert.ok(!text.includes("@") && !text.includes("Things"), "issues carry refs and codes only");
});

test("the run writes questions before answers, in batches, and is complete only when nothing is missing, extra or held", async () => {
  const { match } = matcher([{ id: "p1", email: "staff1@example.invalid" }, { id: "p2", email: "staff2@example.invalid" }]);
  const src = sources();
  const plan = planStaffWork(src, await resolveStaff(staffCandidates(src.staff).candidates, match, OPERATOR));
  const calls: string[] = [];
  const held = new Map<string, Set<string>>();
  const fake = (conflict?: string) => {
    const write = (table: string) => async (rows: readonly { legacyRef: string }[]) => {
      calls.push(`${table}:${rows.length}`);
      const set = held.get(table) ?? new Set<string>(); held.set(table, set);
      for (const r of rows) set.add(r.legacyRef);
      return { inserted: rows.filter((r) => r.legacyRef !== conflict).length, unchanged: 0, updated: 0,
        conflicts: rows.filter((r) => r.legacyRef === conflict).map((r) => ({ legacyRef: r.legacyRef, existingDigest: "a".repeat(64), incomingDigest: "b".repeat(64) })), refused: [] };
    };
    return {
      importStandupQuestions: write("work_standup_questions"), importStaffSessions: write("work_staff_sessions"),
      importStandupAnswers: write("work_standup_answers"), importStaffHours: write("work_staff_hours_per_day"),
      reconcileStaffImport: async (table: string, refs: readonly string[], reported: readonly string[] = [], heldRefs: readonly string[] = []) => {
        const here = held.get(table) ?? new Set<string>();
        const missing = refs.filter((r) => !here.has(r) && !reported.includes(r)), skipped = refs.filter((r) => !here.has(r) && reported.includes(r));
        const h = refs.filter((r) => here.has(r) && heldRefs.includes(r));
        return { table: table as never, legacy: refs.length, imported: here.size, missing, skipped, extra: [], covered: refs.length - missing.length - skipped.length,
          held: h, verified: refs.length - missing.length - skipped.length - h.length, clean: !missing.length && !skipped.length && !h.length };
      },
    };
  };
  const ok = await runStaffWork(fake(), plan);
  assert.deepEqual(calls, ["work_standup_questions:1", "work_staff_sessions:2", "work_standup_answers:2", "work_staff_hours_per_day:2"]);
  assert.equal(ok.clean, true); assert.equal(ok.complete, true);
  assert.equal(ok.tables.work_staff_sessions.inserted, 2);
  held.clear(); calls.length = 0;
  const conflicted = await runStaffWork(fake("s-2"), plan);
  assert.equal(conflicted.complete, false, "a held row is unexplained content");
  assert.deepEqual([conflicted.tables.work_staff_sessions.conflicts, conflicted.tables.work_staff_sessions.held], [1, 1]);
  assert.deepEqual(conflicted.refs.work_staff_sessions.conflicts, ["s-2"]);
  // An unresolved staff member's rows are skipped and explained: complete, not clean.
  held.clear();
  const one = planStaffWork(src, await resolveStaff(staffCandidates(src.staff).candidates, matcher([{ id: "p1", email: "staff1@example.invalid" }]).match, OPERATOR));
  const partial = await runStaffWork(fake(), one);
  assert.deepEqual([partial.clean, partial.complete, partial.tables.work_staff_sessions.skipped, partial.tables.work_staff_sessions.issues], [false, true, 1, { no_staff: 1 }]);
});
