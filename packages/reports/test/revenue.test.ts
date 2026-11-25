import assert from "node:assert/strict";
import test from "node:test";
import { monthlyRows, receivedTotals, REVENUE_MISSING, RevenueService, type RevenueStatusRow, type RevenueStore } from "../src/index.js";

const row = (currency: string, status: RevenueStatusRow["status"], company: string, candidate: string, transfers = 1, lines = 2): RevenueStatusRow =>
  ({ currency, status, transfers, lines, companyTotal: company, candidateTotal: candidate, grossProfit: "0.000" });

test("REVENUE_RECEIVED sums only payment sent, distributing and complete, per currency, exactly in fils", () => {
  const rows = [row("KWD", "draft", "999.000", "1.000"), row("KWD", "payment_sent", "0.100", "0.050"), row("KWD", "distributing", "0.200", "0.100", 2, 3),
    row("KWD", "complete", "123456789012.001", "0.001"), row("KWD", "cancelled", "5.000", "5.000"), row("USD", "complete", "10.000", "12.500")];
  assert.deepEqual(receivedTotals(rows), [
    { currency: "KWD", transfers: 4, lines: 7, companyTotal: "123456789012.301", candidateTotal: "0.151", grossProfit: "123456789012.150" },
    { currency: "USD", transfers: 1, lines: 2, companyTotal: "10.000", candidateTotal: "12.500", grossProfit: "-2.500" },
  ], "0.1 + 0.2 is 0.300 here, a loss shows as negative, and currencies are never added together");
  assert.throws(() => receivedTotals([row("KWD", "complete", "1.5", "0.000")]), /invalid amount/);
});

test("REVENUE_MONTHLY every currency gets every month, oldest first, zeros where nothing was billed", () => {
  const months = ["2026-09", "2026-10"];
  const sep = { currency: "USD", month: "2026-09", transfers: 1, companyTotal: "1.000", candidateTotal: "0.500", grossProfit: "0.500", received: "0.000" };
  assert.deepEqual(monthlyRows(months, ["USD", "KWD"], [sep]).map(r => [r.currency, r.month, r.companyTotal]),
    [["KWD", "2026-09", "0.000"], ["KWD", "2026-10", "0.000"], ["USD", "2026-09", "1.000"], ["USD", "2026-10", "0.000"]]);
  assert.throws(() => monthlyRows(months, ["USD"], [{ ...sep, month: "2026-11" }]), /outside the range/);
});

test("REVENUE_PAGE operator admins get the 12 whole months before this Kuwait month; nobody else reads anything", async () => {
  const calls: string[] = [];
  const store: RevenueStore = {
    async read(first, last) { calls.push(`read ${first} ${last}`); return { byStatus: [row("KWD", "complete", "3.000", "2.000")], byMonth: [] }; },
  };
  // 1 Nov 2026 00:30 in Kuwait is still 31 Oct in UTC: the Kuwait month decides.
  const service = new RevenueService(store, { mayViewRevenue: async id => id === "boss" }, () => new Date("2026-10-31T21:30:00Z"));
  assert.equal(await service.page("staff"), undefined);
  assert.deepEqual(calls, []);
  const page = (await service.page("boss"))!;
  assert.equal(page.day, "2026-11-01");
  assert.deepEqual([page.months[0], page.months.at(-1), page.months.length], ["2025-11", "2026-10", 12]);
  assert.deepEqual(calls, ["read 2025-11 2026-10"], "one read: both views from one snapshot");
  assert.equal(page.monthly.length, 12, "the currency from the reconciliation gets its 12 months even with no monthly rows");
  assert.equal(page.received[0]!.grossProfit, "1.000");
  assert.deepEqual(page.missing, REVENUE_MISSING);
});
