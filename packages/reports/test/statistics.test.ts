import assert from "node:assert/strict";
import test from "node:test";
import { MORNING_SUMMARY_COUNTERS, STAFF_STATISTICS_COUNTERS, STATISTICS_OVERVIEW, StatisticsService, emailDays, emailsByDay, invitationMonths, invitationsByMonth, percent, type StatisticsStore } from "../src/index.js";

const AVAILABLE = STAFF_STATISTICS_COUNTERS.filter(c => c.source.kind === "available").map(c => c.key);

const OVERVIEW = { candidates: 100, assigned: 7, suggested: 20, requests: 9, requestsDelivered: 4 };
function rig(raw: Record<string, number>, hiring = { hired: 8, retained: 3, invitations: 40 }, overview: Record<string, number> = OVERVIEW) {
  const calls: string[] = [];
  const store: StatisticsStore = { async emailsByDay() { return []; }, async invitationsByMonth() { return []; }, async staffCounts(day) { calls.push(`counts ${day}`); return raw; }, async hiring(day) { calls.push(`hiring ${day}`); return hiring; }, async overviewCounts() { return overview; } };
  const service = new StatisticsService(store, { isStaff: async id => id === "staff" }, () => new Date("2026-11-20T22:30:00Z"));
  return { service, calls };
}
const full = () => Object.fromEntries(AVAILABLE.map((k, i) => [k, i + 1]));

test("REPORTS_STATISTICS every counter comes back in legacy's order; a missing source is null with what it waits on, never 0", async () => {
  const page = (await rig(full()).service.page("staff"))!;
  assert.equal(page.day, "2026-11-21", "the Asia/Kuwait day");
  assert.deepEqual(page.counters.map(c => c.key), STAFF_STATISTICS_COUNTERS.map(c => c.key));
  for (const c of page.counters) {
    if (AVAILABLE.includes(c.key as never)) { assert.equal(c.value, AVAILABLE.indexOf(c.key as never) + 1, c.key); assert.equal(c.waitsOn, null); }
    else { assert.equal(c.value, null, c.key); assert.ok(c.waitsOn && c.waitsOn.length > 0, c.key); }
  }
  assert.deepEqual(page.hiring, { hired: 8, retained: 3, invitations: 40, retentionRatio: 37.5, recruitmentYield: 20 });
});

test("REPORTS_STATISTICS counters shared with the morning summary have the same key and the same source there", () => {
  const morning = new Map(MORNING_SUMMARY_COUNTERS.map(c => [c.key as string, c.source.kind]));
  const shared = STAFF_STATISTICS_COUNTERS.filter(c => morning.has(c.key));
  assert.ok(shared.length >= 10);
  for (const c of shared) assert.equal(c.source.kind, morning.get(c.key), c.key);
  assert.equal(new Set(STAFF_STATISTICS_COUNTERS.map(c => c.key)).size, STAFF_STATISTICS_COUNTERS.length, "keys are unique");
  assert.ok(!STAFF_STATISTICS_COUNTERS.some(c => /ticket/i.test(c.key)), "support tickets were dropped (C-5)");
});

test("REPORTS_STATISTICS only staff see the page, and nothing is read for anyone else", async () => {
  const x = rig(full());
  assert.equal(await x.service.page("alia"), undefined);
  assert.deepEqual(x.calls, []);
});

test("REPORTS_STATISTICS an available counter the store did not answer is an error, not 0; ratios with nothing to divide by are null", async () => {
  const { activeRequests: _, ...rest } = full();
  await assert.rejects(rig(rest).service.page("staff"), /activeRequests/);
  await assert.rejects(rig({ ...full(), totalMinor: -1 }).service.page("staff"), /totalMinor/);
  const empty = (await rig(full(), { hired: 0, retained: 0, invitations: 0 }).service.page("staff"))!;
  assert.deepEqual([empty.hiring.retentionRatio, empty.hiring.recruitmentYield], [null, null]);
  assert.equal(percent(1, 3), 33.3);
  assert.equal(percent(12, 5), 240, "yield can pass 100 (assignments without an invitation)");
});

test("REPORTS_STATISTICS overview: store, company directory and staff time figures in legacy's order; a source not given or not answering is not available", async () => {
  const store: StatisticsStore = { async emailsByDay() { return []; }, async invitationsByMonth() { return []; }, async staffCounts() { return full(); }, async hiring() { return { hired: 1, retained: 0, invitations: 2 }; }, async overviewCounts() { return OVERVIEW; } };
  const isStaff = async (id: string) => id === "staff";
  const now = () => new Date("2026-11-20T06:00:00Z");
  const days: string[] = [];
  const staffTime = { async operatorStaff() { return ["staff", "sara", "omar"]; }, async staffWithSessionOn(day: string) { days.push(day); return new Set(["sara", "left-last-week"]); } };
  const companies = { async counts(viewer: string) { return viewer === "staff" ? { activeClients: 6, companies: 11 } : undefined; } };
  const page = (await new StatisticsService(store, { isStaff }, now, { companies, staffTime }).page("staff"))!;
  assert.deepEqual(page.overview.map(r => r.key), STATISTICS_OVERVIEW.map(f => f.key));
  const value = (key: string) => page.overview.find(r => r.key === key)!;
  assert.deepEqual([value("candidates").value, value("assigned").value, value("requestsDelivered").value], [100, 7, 4]);
  assert.deepEqual([value("activeClients").value, value("companies").value], [6, 11]);
  assert.deepEqual([value("staff").value, value("staffAttended").value], [3, 1], "someone no longer staff does not count as attending");
  assert.deepEqual(days, ["2026-11-20"]);
  for (const key of ["unapproved", "payableCandidates", "staffAbsent", "staffNotAttended"]) { assert.equal(value(key).value, null, key); assert.ok(value(key).waitsOn, key); }
  assert.ok(!STATISTICS_OVERVIEW.some(f => (f.key as string) === "universitiesToFix"), "the catalogue keeps one name, so nothing to fix");
  const bare = (await new StatisticsService(store, { isStaff }, now, { companies: { async counts() { return undefined; } } }).page("staff"))!;
  assert.match(bare.overview.find(r => r.key === "companies")!.waitsOn!, /company directory/);
  assert.match(bare.overview.find(r => r.key === "staff")!.waitsOn!, /work lane/);
  await assert.rejects(new StatisticsService({ ...store, async overviewCounts() { return { ...OVERVIEW, requests: undefined as never }; } }, { isStaff }, now).page("staff"), /requests/);
});

test("REPORTS_STATISTICS invitations by month: the 12 whole months before the Kuwait month, oldest first, with rates", async () => {
  assert.deepEqual(invitationMonths("2026-11-21"), ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(invitationMonths("2027-01-01").slice(-2), ["2026-11", "2026-12"], "across the new year");
  const asked: (readonly string[])[] = [];
  const store: StatisticsStore = { async emailsByDay() { return []; }, async invitationsByMonth(months) { asked.push(months); return [{ month: "2026-10", noAnswer: 3, accepted: 4, declined: 2, withdrawn: 1 }]; },
    async staffCounts() { return full(); }, async hiring() { return { hired: 0, retained: 0, invitations: 0 }; }, async overviewCounts() { return OVERVIEW; } };
  // 31 October 21:30 UTC is already 1 November in Kuwait, so October is the newest whole month.
  const page = (await new StatisticsService(store, { isStaff: async () => true }, () => new Date("2026-10-31T21:30:00Z")).page("staff"))!;
  assert.deepEqual(asked, [invitationMonths("2026-11-01")]);
  assert.equal(page.invitationsByMonth.length, 12);
  assert.deepEqual(page.invitationsByMonth.at(-1), { month: "2026-10", noAnswer: 3, accepted: 4, declined: 2, withdrawn: 1, total: 10, acceptanceRate: 40, declineRate: 20 });
  assert.deepEqual(page.invitationsByMonth[0], { month: "2025-11", noAnswer: 0, accepted: 0, declined: 0, withdrawn: 0, total: 0, acceptanceRate: null, declineRate: null }, "a month with none is zeros, with no rate");
  assert.throws(() => invitationsByMonth(["2026-10"], [{ month: "2026-09", noAnswer: 1, accepted: 0, declined: 0, withdrawn: 0 }]), /not asked for/);
  assert.throws(() => invitationsByMonth(["2026-10"], [{ month: "2026-10", noAnswer: -1, accepted: 0, declined: 0, withdrawn: 0 }]), /noAnswer/);
});

test("REPORTS_STATISTICS emails per day: the 14 Kuwait days up to today, oldest first, marked past the volume threshold", async () => {
  assert.deepEqual(emailDays("2026-03-02").slice(0, 2), ["2026-02-17", "2026-02-18"]);
  assert.equal(emailDays("2026-03-02").at(-1), "2026-03-02");
  assert.equal(emailDays("2024-03-01")[12], "2024-02-29", "leap day");
  const asked: (readonly string[])[] = [];
  const store: StatisticsStore = { async emailsByDay(days) { asked.push(days); return [{ day: "2026-11-01", sent: 501, failed: 3 }, { day: "2026-10-31", sent: 500, failed: 0 }]; },
    async invitationsByMonth() { return []; }, async staffCounts() { return full(); }, async hiring() { return { hired: 0, retained: 0, invitations: 0 }; }, async overviewCounts() { return OVERVIEW; } };
  const page = (await new StatisticsService(store, { isStaff: async () => true }, () => new Date("2026-10-31T21:30:00Z")).page("staff"))!;
  assert.deepEqual(asked, [emailDays("2026-11-01")]);
  assert.equal(page.emailThreshold, 500);
  assert.deepEqual(page.emailsByDay.slice(-2), [{ day: "2026-10-31", sent: 500, failed: 0, overThreshold: false }, { day: "2026-11-01", sent: 501, failed: 3, overThreshold: true }]);
  assert.deepEqual(page.emailsByDay[0], { day: "2026-10-19", sent: 0, failed: 0, overThreshold: false });
  assert.throws(() => emailsByDay(["2026-11-01"], [{ day: "2026-11-02", sent: 1, failed: 0 }]), /not asked for/);
  assert.throws(() => emailsByDay(["2026-11-01"], [{ day: "2026-11-01", sent: 1.5, failed: 0 }]), /sent/);
});
