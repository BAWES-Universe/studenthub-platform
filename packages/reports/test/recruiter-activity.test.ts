import assert from "node:assert/strict";
import test from "node:test";
import { RECRUITER_ACTIVITY_COLUMNS, RecruiterActivityService, calendarDay, rangeProblem, type RecruiterActivityStore } from "../src/index.js";

const NOW = () => new Date("2026-11-21T22:30:00Z"); // 22 November in Kuwait
function rig(counts: Record<string, Partial<Record<string, number>>>, staff = ["s-a", "s-b", "s-c"]) {
  const asked: [readonly string[], string, string][] = [];
  const store: RecruiterActivityStore = { async recruiterActivity(ids, from, to) {
    asked.push([ids, from, to]);
    return { names: new Map([["s-a", "Amal Saleh"], ["s-b", "Bader Ali"]]), counts: new Map(Object.entries(counts) as never) };
  } };
  const service = new RecruiterActivityService(store, { isStaff: async id => id.startsWith("s-") }, { async operatorStaff() { return staff; } }, NOW);
  return { service, asked };
}

test("REPORTS_RECRUITERS today in Kuwait by default; every staff member listed, busiest first, with totals", async () => {
  const x = rig({ "s-b": { placements: 2, requests: 0, suggestions: 3, notes: 1, invitations: 4, invitationsAccepted: 1, invitationsDeclined: 2 }, "s-c": { notes: 1 } });
  const page = await x.service.page("s-a");
  assert.ok(page && !("refused" in page));
  assert.deepEqual([page.from, page.to, page.today], ["2026-11-22", "2026-11-22", "2026-11-22"]);
  assert.deepEqual(x.asked, [[["s-a", "s-b", "s-c"], "2026-11-22", "2026-11-22"]]);
  assert.deepEqual(page.staff.map(r => r.name), ["Bader Ali", "s-c", "Amal Saleh"], "busiest first; someone with no name shows their id");
  assert.equal(page.staff[2]!.placements, 0, "someone with nothing recorded is zeros");
  assert.deepEqual(page.totals, { placements: 2, requests: 0, suggestions: 3, notes: 2, invitations: 4, invitationsAccepted: 1, invitationsDeclined: 2 });
  assert.deepEqual(Object.keys(page.totals), RECRUITER_ACTIVITY_COLUMNS.map(c => c.key));
});

test("REPORTS_RECRUITERS only staff see it, and nothing is read for anyone else", async () => {
  const x = rig({});
  assert.equal(await x.service.page("alia"), undefined);
  assert.deepEqual(x.asked, []);
});

test("REPORTS_RECRUITERS a range is real days, not after today, in order and at most a year; refused ranges read nothing", async () => {
  const x = rig({});
  const ok = await x.service.page("s-a", { from: "2025-11-22", to: "2026-11-22" });
  assert.ok(ok && !("refused" in ok), "366 days is allowed");
  assert.deepEqual(await x.service.page("s-a", { from: "2025-11-21", to: "2026-11-22" }), { refused: "too_long" });
  assert.deepEqual(await x.service.page("s-a", { from: "2026-11-20", to: "2026-11-23" }), { refused: "to" });
  assert.deepEqual(await x.service.page("s-a", { from: "2026-11-20", to: "2026-11-19" }), { refused: "order" });
  assert.deepEqual(await x.service.page("s-a", { from: "2026-02-30" }), { refused: "from" });
  assert.equal(x.asked.length, 1);
  const only = await x.service.page("s-a", { from: "2026-11-01" });
  assert.ok(only && !("refused" in only)); assert.equal(only.to, "2026-11-22", "the end defaults to today");
  const day = await x.service.page("s-a", { to: "2026-11-01" });
  assert.ok(day && !("refused" in day)); assert.equal(day.from, "2026-11-01", "the start defaults to the end");
  assert.equal(calendarDay("2024-02-29"), "2024-02-29"); assert.equal(calendarDay("2026-02-29"), null); assert.equal(calendarDay("2026-1-01"), null);
  assert.equal(rangeProblem("2026-11-22", "2026-11-22", "2026-11-22"), null);
});

test("REPORTS_RECRUITERS a count the store gave that is not a whole number is an error, not 0; no staff reads nothing", async () => {
  await assert.rejects(rig({ "s-a": { notes: -1 } }).service.page("s-a"), /notes/);
  const none = rig({}, []);
  const page = await none.service.page("s-a");
  assert.ok(page && !("refused" in page)); assert.deepEqual(page.staff, []); assert.deepEqual(none.asked, []);
});
