import assert from "node:assert/strict";
import test from "node:test";
import { FiringHitMapService, buildFiringHitMap, firingLevel, lastTwelveMonths, type FiringHitMapStore } from "../src/index.js";

test("REPORTS_FIRINGS the last 12 months run newest first and cross the year", () => {
  assert.deepEqual(lastTwelveMonths("2026-02-10"), ["2026-02", "2026-01", "2025-12", "2025-11", "2025-10", "2025-09", "2025-08", "2025-07", "2025-06", "2025-05", "2025-04", "2025-03"]);
  assert.equal(lastTwelveMonths("2026-12-31")[11], "2026-01");
});

test("REPORTS_FIRINGS a month is danger above twice the 12-month average and warning above it, as legacy", () => {
  // 12 ended over the year: the average is 1.
  assert.equal(firingLevel(3, 12), "danger");
  assert.equal(firingLevel(2, 12), "warning", "exactly twice the average is not danger");
  assert.equal(firingLevel(1, 12), null, "exactly the average is not a warning");
  assert.equal(firingLevel(0, 0), null);
  assert.equal(firingLevel(1, 1), "danger", "one placement ended in a quiet year stands out, as in legacy");
});

test("REPORTS_FIRINGS every company gets the same 12 columns, quiet months are 0, and the busiest companies come first", () => {
  const map = buildFiringHitMap("2026-11-20", [{ orgId: "b", name: "Beta" }, { orgId: "a", name: "Alpha" }, { orgId: "q", name: "Quiet" }],
    [{ orgId: "a", month: "2026-11", total: 6 }, { orgId: "a", month: "2026-01", total: 6 }, { orgId: "b", month: "2026-10", total: 1 }, { orgId: "gone", month: "2026-11", total: 9 }]);
  assert.equal(map.months.length, 12);
  assert.deepEqual(map.companies.map(c => c.name), ["Alpha", "Beta", "Quiet"], "a company not in the list (deleted) is left out");
  const a = map.companies[0]!;
  assert.deepEqual(a.cells.map(c => c.month), map.months);
  assert.deepEqual([a.total, a.average, a.cells[0]!.total, a.cells[0]!.level, a.cells[10]!.total, a.cells[1]!.total, a.cells[1]!.level], [12, 1, 6, "danger", 6, 0, null]);
  assert.deepEqual(map.companies[1]!.cells[1], { month: "2026-10", total: 1, level: "danger" });
  assert.equal(map.companies[1]!.average, 0.08);
  assert.ok(map.companies[2]!.cells.every(c => c.total === 0 && c.level === null));
  assert.throws(() => buildFiringHitMap("2026-11-20", [], [{ orgId: "a", month: "2026-11", total: -1 }]), TypeError);
});

test("REPORTS_FIRINGS only staff see it, counted for the Kuwait day", async () => {
  const asked: string[] = [];
  const store: FiringHitMapStore = { async firings(day, months) { asked.push(`${day} ${months[0]} ${months[11]}`); return { companies: [{ orgId: "a", name: "Alpha" }], counts: [] }; } };
  const service = new FiringHitMapService(store, { isStaff: async id => id === "staff" }, () => new Date("2026-11-30T22:00:00Z"));
  assert.equal(await service.page("alia"), undefined);
  assert.deepEqual(asked, [], "nothing is counted for someone who is not staff");
  const map = (await service.page("staff"))!;
  assert.equal(map.day, "2026-12-01");
  assert.deepEqual(asked, ["2026-12-01 2026-12 2026-01"]);
});
