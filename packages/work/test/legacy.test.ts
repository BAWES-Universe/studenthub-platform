import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePlacements, legacyInstant, mapLegacyFeedback, mapLegacyWorkingHour, reconcileDays, type LegacyWorkingHourRow } from "../src/index.js";

const hour = (over: Partial<LegacyWorkingHourRow> = {}): LegacyWorkingHourRow => ({
  candidate_working_hour_uuid: "cwh-1", candidate_id: 7, store_id: 3, date: "2026-11-18", start_time: "2026-11-18 09:00:00", end_time: "2026-11-18 11:30:15",
  total_time: 9015, start_location_lat: "29.375900", start_location_long: "47.977400", end_location_lat: "29.3759", end_location_long: "47.9774",
  note: " left early ", status: 1, via: null, ...over,
});

test("LEGACY_TIME legacy datetimes are Asia/Kuwait, no DST; bad values are refused", () => {
  assert.equal(legacyInstant("2026-11-18 09:00:00")?.toISOString(), "2026-11-18T06:00:00.000Z");
  assert.equal(legacyInstant("2026-07-01 00:30:00")?.toISOString(), "2026-06-30T21:30:00.000Z");
  for (const bad of ["2026-02-30 09:00:00", "2026-11-18T09:00:00", "2026-11-18 24:00:00", "", null, 0]) assert.equal(legacyInstant(bad), undefined, String(bad));
});

test("LEGACY_HOUR a closed row maps with both locations, status and its Kuwait start date", () => {
  const { session, issues } = mapLegacyWorkingHour(hour());
  assert.deepEqual(issues, []);
  assert.deepEqual([session?.legacyRef, session?.workDate, session?.status, session?.startedAt.toISOString(), session?.note, session?.flags],
    ["cwh:cwh-1", "2026-11-18", "approved", "2026-11-18T06:00:00.000Z", "left early", []]);
  assert.deepEqual(session?.endLocation, { latitude: 29.3759, longitude: 47.9774 });
});

test("LEGACY_HOUR the legacy defects are reported, never imported silently", () => {
  assert.deepEqual(mapLegacyWorkingHour(hour({ end_time: null })).issues.map((i) => i.code), ["open_session"]);
  assert.deepEqual(mapLegacyWorkingHour(hour({ end_time: "2026-11-18 08:00:00" })).issues.map((i) => i.code), ["end_before_start"]);
  assert.deepEqual(mapLegacyWorkingHour(hour({ status: 9 })).issues.map((i) => i.code), ["bad_status"]);
  // Legacy's trigger never ran on insert: a null or wrong total is reported; the duration comes from the times.
  const wrong = mapLegacyWorkingHour(hour({ total_time: null }));
  assert.deepEqual([wrong.session?.legacyRef, wrong.issues.map((i) => i.code)], ["cwh:cwh-1", ["total_time_mismatch"]]);
  assert.deepEqual(mapLegacyWorkingHour(hour({ total_time: -30 })).issues.map((i) => i.code), ["total_time_mismatch"]);
  // Past midnight keeps the start's date; a different `date` column is reported.
  const late = mapLegacyWorkingHour(hour({ date: "2026-11-19", start_time: "2026-11-18 23:00:00", end_time: "2026-11-19 01:00:00", total_time: 7200 }));
  assert.deepEqual([late.session?.workDate, late.issues.map((i) => i.code)], ["2026-11-18", ["date_mismatch"]]);
  // 0,0 meant no fix: a timer row without a location is flagged for the approver; manual rows never had one.
  assert.deepEqual(mapLegacyWorkingHour(hour({ start_location_lat: "0", start_location_long: "0" })).session?.flags, ["location_missing"]);
  assert.deepEqual(mapLegacyWorkingHour(hour({ via: "Manual Log", start_location_lat: null, start_location_long: null, end_location_lat: null, end_location_long: null })).session?.flags, []);
  assert.deepEqual(mapLegacyWorkingHour(hour({ start_location_lat: "95" })).issues.map((i) => i.code), ["bad_location"]);
});

test("LEGACY_FEEDBACK decisions keep the legacy actor; pending rows are not decisions; ratings outside 1-5 drop with a report", () => {
  const row = { cwlf_uuid: "f-1", candidate_id: 7, store_id: 3, date: "2026-11-18", candidate_working_hour_uuid: "cwh-1", status: 2, note: "private", reason: " late ",
    is_public: 0, rating: 7, created_by: 44, created_at: "2026-11-18 20:00:00" };
  const { decision, issues } = mapLegacyFeedback(row);
  assert.deepEqual([decision?.legacyRef, decision?.scope, decision?.legacySessionRef, decision?.outcome, decision?.reason, decision?.rating, decision?.notePublic, decision?.legacyDecidedBy],
    ["cwlf:f-1", "session", "cwh:cwh-1", "rejected", "late", null, false, "contact:44"]);
  assert.deepEqual(issues.map((i) => i.code), ["bad_rating"]);
  assert.equal(mapLegacyFeedback({ ...row, candidate_working_hour_uuid: null, rating: 0 }).decision?.scope, "day");
  assert.deepEqual(mapLegacyFeedback({ ...row, status: 0 }), { issues: [] });
});

test("LEGACY_PLACEMENTS stretches at a store become placements; the current store stays open", () => {
  const s = (store: string, d: string) => ({ legacyStoreId: store, workDate: d });
  assert.deepEqual(derivePlacements("7", [s("A", "2026-01-05"), s("A", "2026-01-20"), s("B", "2026-02-03"), s("A", "2026-03-01")], { legacyStoreId: "A", since: "2025-12-01" }), [
    { legacyCandidateId: "7", legacyStoreId: "A", startDate: "2026-01-05", endDate: "2026-02-02" },
    { legacyCandidateId: "7", legacyStoreId: "B", startDate: "2026-02-03", endDate: "2026-02-28" },
    { legacyCandidateId: "7", legacyStoreId: "A", startDate: "2026-03-01", endDate: null },
  ]);
  assert.deepEqual(derivePlacements("7", [s("A", "2026-01-05")], { legacyStoreId: "C", since: "2026-04-01" }).map((p) => [p.legacyStoreId, p.startDate, p.endDate]),
    [["A", "2026-01-05", "2026-01-05"], ["C", "2026-04-01", null]]);
  assert.deepEqual(derivePlacements("7", [], null), []);
});

test("LEGACY_RECONCILE legacy day rows vs totals here: every difference listed, legacy ids only", () => {
  const here = [
    { legacyCandidateId: "7", legacyStoreId: "3", workDate: "2026-11-18", approvedSeconds: 3600, pendingSeconds: 0, rejectedSeconds: 600, approvedCount: 1, pendingCount: 0, rejectedCount: 1 },
    { legacyCandidateId: "7", legacyStoreId: "3", workDate: "2026-11-19", approvedSeconds: 60, pendingSeconds: 0, rejectedSeconds: 0, approvedCount: 1, pendingCount: 0, rejectedCount: 0 },
  ];
  const legacy = [
    { cwd_uuid: "d-1", candidate_id: 7, store_id: 3, date: "2026-11-18", total_time: 4200, total_approved: 1, total_pending: 0, total_rejected: 1 },
    { cwd_uuid: "d-2", candidate_id: 7, store_id: 3, date: "2026-11-17", total_time: 100, total_approved: 0, total_pending: 1, total_rejected: 0 },
  ];
  assert.deepEqual(reconcileDays(legacy, here), [
    { legacyId: "d-2", legacyCandidateId: "7", legacyStoreId: "3", workDate: "2026-11-17", field: "missing_here", legacy: 100, here: null },
    { legacyId: null, legacyCandidateId: "7", legacyStoreId: "3", workDate: "2026-11-19", field: "missing_in_legacy", legacy: null, here: 60 },
  ]);
  const drifted = reconcileDays([{ ...legacy[0]!, total_time: 3600, total_approved: 2 }], [here[0]!]);
  assert.deepEqual(drifted.map((d) => [d.field, d.legacy, d.here]), [["approved_count", 2, 1], ["total_time", 3600, 4200]]);
});
