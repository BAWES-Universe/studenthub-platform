import assert from "node:assert/strict";
import test from "node:test";
import { MORNING_SUMMARY_COUNTERS, STAFF_STATISTICS_COUNTERS, StatisticsService, percent, type StatisticsStore } from "../src/index.js";

const AVAILABLE = STAFF_STATISTICS_COUNTERS.filter(c => c.source.kind === "available").map(c => c.key);

function rig(raw: Record<string, number>, hiring = { hired: 8, retained: 3, invitations: 40 }) {
  const calls: string[] = [];
  const store: StatisticsStore = { async staffCounts(day) { calls.push(`counts ${day}`); return raw; }, async hiring(day) { calls.push(`hiring ${day}`); return hiring; } };
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
