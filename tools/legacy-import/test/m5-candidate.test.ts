import assert from "node:assert/strict";
import test from "node:test";

import {
  M5_CANDIDATE_SOURCES, M5CandidateInputError, candidateLookupIds, m5CandidateSourceSql, placementRef, planCandidateWork,
  readM5CandidateSources, runCandidateWork, type M5CandidateSources, type MappedStore,
} from "../src/m5-candidate.js";
import type { LegacyReader } from "../src/twin/journey.js";

// Synthetic rows only.
const hour = (uuid: string, candidate: number, store: number, day: string, extra: Record<string, unknown> = {}) => ({
  candidate_working_hour_uuid: uuid, candidate_id: candidate, store_id: store, date: day,
  start_time: `${day} 09:00:00`, end_time: `${day} 10:00:00`, total_time: 3600,
  start_location_lat: "29.3", start_location_long: "47.9", end_location_lat: "29.3", end_location_long: "47.9",
  note: null, status: 1, via: "App", ...extra,
});
const feedback = (uuid: string, candidate: number, store: number, day: string, hourUuid: string | null, status = 1) => ({
  cwlf_uuid: uuid, candidate_id: candidate, store_id: store, date: day, candidate_working_hour_uuid: hourUuid, status,
  note: null, reason: null, is_public: 0, rating: 4, created_by: 55, created_at: `${day} 12:00:00`,
});
const sources = (over: Partial<Record<keyof M5CandidateSources, Record<string, unknown>[]>> = {}): M5CandidateSources => ({
  candidate: [{ candidate_id: 1, store_id: 10, deleted: 0 }, { candidate_id: 2, store_id: 10, deleted: 0 }],
  candidate_working_hour: [hour("h-1", 1, 10, "2026-11-01"), hour("h-2", 2, 10, "2026-11-01")],
  candidate_work_log_feedback: [feedback("f-1", 1, 10, "2026-11-01", "h-1")],
  candidate_working_date: [],
  ...over,
});
const STORES = new Map<string, MappedStore>([["10", { storeId: "s-uuid-10", orgId: "co-10" }], ["20", { storeId: "s-uuid-20", orgId: "co-20" }]]);

test("each candidate table is read with a fixed column list, and no column carries a name, phone, email or password", () => {
  for (const [table, columns] of Object.entries(M5_CANDIDATE_SOURCES)) {
    assert.ok(!columns.some((c) => /pass|token|auth|name|phone|email|civil/.test(c)), table);
    assert.match(m5CandidateSourceSql(table as keyof typeof M5_CANDIDATE_SOURCES), new RegExp(`FROM \`${table}\`$`));
  }
});

test("a read that is not the whole table, unchanged during the read, is refused with a fixed code", async () => {
  const rows = sources();
  const reader = (drift: number, failOn?: string): LegacyReader => {
    let counts = 0;
    return {
      async rows(sql) {
        if (failOn && sql.includes(failOn) && !sql.includes("COUNT(*)")) throw new Error("boom: 29.3,47.9");
        const table = /FROM `([a-z_]+)`$/.exec(sql)![1] as keyof M5CandidateSources;
        if (sql.includes("COUNT(*)")) { counts++; return [{ n: rows[table].length + (counts === 2 ? drift : 0) }]; }
        return rows[table];
      },
    };
  };
  assert.deepEqual(Object.keys(await readM5CandidateSources(reader(0))), Object.keys(M5_CANDIDATE_SOURCES));
  await assert.rejects(readM5CandidateSources(reader(1)), (e: unknown) => e instanceof M5CandidateInputError && e.code === "m5.inputIncomplete");
  await assert.rejects(readM5CandidateSources(reader(0, "candidate_work_log_feedback")),
    (e: unknown) => e instanceof M5CandidateInputError && e.code === "m5.read.candidate_work_log_feedback" && !String(e).includes("29.3"));
});

test("lookups ask for every legacy candidate and store id once, and only well-formed ids", () => {
  const ids = candidateLookupIds(sources({ candidate: [{ candidate_id: 1, store_id: 30, deleted: 0 }, { candidate_id: "x", store_id: 0, deleted: 0 }] }));
  assert.deepEqual(ids, { candidates: ["1", "2"], stores: ["10", "30"] });
});

test("only a linked candidate and a mapped store import; everything else is reported by ref", () => {
  const src = sources({
    candidate_working_hour: [hour("h-1", 1, 10, "2026-11-01"), hour("h-2", 2, 10, "2026-11-01"), hour("h-3", 1, 99, "2026-11-02"),
      hour("h-4", 1, 10, "2026-11-03", { end_time: null })],
    candidate_work_log_feedback: [feedback("f-1", 1, 10, "2026-11-01", "h-1"), feedback("f-2", 2, 10, "2026-11-01", "h-2"),
      feedback("f-3", 1, 10, "2026-11-01", null, 0), feedback("f-4", 1, 99, "2026-11-02", "h-3")],
  });
  const plan = planCandidateWork(src, new Map([["1", "p1"]]), STORES);
  assert.deepEqual(plan.sessions.map((s) => s.legacyRef), ["cwh:h-1"]);
  assert.deepEqual(plan.issues.work_sessions, [
    { legacyRef: "cwh:h-2", code: "no_person" }, { legacyRef: "cwh:h-3", code: "no_store" }, { legacyRef: "cwh:h-4", code: "open_session" }]);
  assert.deepEqual(plan.decisions.map((d) => [d.legacyRef, d.personId, d.orgId, d.storeId, d.decidedBy, d.legacyDecidedBy]),
    [["cwlf:f-1", "p1", "co-10", "s-uuid-10", null, "contact:55"]]);
  assert.deepEqual(plan.issues.work_decisions, [
    { legacyRef: "cwlf:f-2", code: "no_person" }, { legacyRef: "cwlf:f-3", code: "pending_feedback" }, { legacyRef: "cwlf:f-4", code: "no_store" }]);
  assert.deepEqual(plan.legacyRefs.work_sessions, ["cwh:h-1", "cwh:h-2", "cwh:h-3", "cwh:h-4"]);
  assert.deepEqual(plan.legacyRefs.work_decisions, ["cwlf:f-1", "cwlf:f-2", "cwlf:f-3", "cwlf:f-4"]);
  const text = JSON.stringify(plan.issues);
  assert.ok(!text.includes("29.3") && !text.includes("p1"), "issues carry refs and codes only");
});

test("placements follow where hours were logged; the current store stays open only where the hours end", () => {
  const src = sources({
    candidate: [{ candidate_id: 1, store_id: 20, deleted: 0 }, { candidate_id: 3, store_id: 10, deleted: 0 }, { candidate_id: 4, store_id: 10, deleted: 1 }],
    candidate_working_hour: [hour("a", 1, 10, "2026-10-01"), hour("b", 1, 10, "2026-10-05"), hour("c", 1, 20, "2026-10-10"),
      hour("d", 1, 20, "2026-10-05", { start_time: "2026-10-05 15:00:00", end_time: "2026-10-05 16:00:00" }),
      hour("e", 4, 10, "2026-10-01")],
    candidate_work_log_feedback: [],
  });
  const plan = planCandidateWork(src, new Map([["1", "p1"], ["3", "p3"], ["4", "p4"]]), STORES);
  assert.deepEqual(plan.placements.map((p) => [p.legacyRef, p.personId, p.storeId, p.startDate, p.endDate]), [
    [placementRef("1", "10", "2026-10-01"), "p1", "s-uuid-10", "2026-10-01", "2026-10-09"],
    [placementRef("1", "20", "2026-10-10"), "p1", "s-uuid-20", "2026-10-10", null],
    // A deleted candidate keeps the history and gets no open placement.
    [placementRef("4", "10", "2026-10-01"), "p4", "s-uuid-10", "2026-10-01", "2026-10-01"],
  ]);
  assert.deepEqual(plan.sessions.map((s) => [s.legacyRef, s.placementLegacyRef]), [
    ["cwh:a", placementRef("1", "10", "2026-10-01")], ["cwh:b", placementRef("1", "10", "2026-10-01")], ["cwh:c", placementRef("1", "20", "2026-10-10")],
    ["cwh:e", placementRef("4", "10", "2026-10-01")],
  ]);
  // Store 20 on a day the stretch at 10 already holds: that stretch keeps the day, and this row is reported.
  assert.deepEqual(plan.issues.work_sessions, [{ legacyRef: "cwh:d", code: "two_stores_one_day" }]);
  // Candidate 3 is placed at store 10 with no hours: no start date is made up.
  assert.deepEqual(plan.unplaced, ["candidate:3"]);
  assert.equal(plan.people, 2);
});

test("the run writes placements before sessions before decisions, and is complete only when nothing is missing, extra or held", async () => {
  const plan = planCandidateWork(sources(), new Map([["1", "p1"], ["2", "p2"]]), STORES);
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
      importPlacements: write("work_assignments"), importSessions: write("work_sessions"), importDecisions: write("work_decisions"),
      reconcileCandidateImport: async (table: string, refs: readonly string[], reported: readonly string[] = [], heldRefs: readonly string[] = []) => {
        const here = held.get(table) ?? new Set<string>();
        const missing = refs.filter((r) => !here.has(r) && !reported.includes(r)), skipped = refs.filter((r) => !here.has(r) && reported.includes(r));
        const h = refs.filter((r) => here.has(r) && heldRefs.includes(r));
        return { table: table as never, legacy: refs.length, imported: here.size, missing, skipped, extra: [], covered: refs.length - missing.length - skipped.length,
          held: h, verified: refs.length - missing.length - skipped.length - h.length, clean: !missing.length && !skipped.length && !h.length };
      },
    };
  };
  const ok = await runCandidateWork(fake(), plan);
  assert.deepEqual(calls, ["work_assignments:2", "work_sessions:2", "work_decisions:1"]);
  assert.deepEqual([ok.clean, ok.complete], [true, true]);
  held.clear();
  const conflicted = await runCandidateWork(fake("cwh:h-2"), plan);
  assert.equal(conflicted.complete, false, "a held row is unexplained content");
  assert.deepEqual(conflicted.refs.work_sessions.conflicts, ["cwh:h-2"]);
  held.clear();
  const partial = await runCandidateWork(fake(), planCandidateWork(sources(), new Map([["1", "p1"]]), STORES));
  assert.deepEqual([partial.clean, partial.complete, partial.tables.work_sessions.skipped, partial.tables.work_sessions.issues], [false, true, 1, { no_person: 1 }]);
});
