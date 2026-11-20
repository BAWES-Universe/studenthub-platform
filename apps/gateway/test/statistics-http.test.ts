import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { STAFF_STATISTICS_COUNTERS, StatisticsService, type StatisticsStore } from "../../../packages/reports/src/index.js";
import { handleIdCards, type IdCardsHttpService } from "../src/reports/id-cards-http.js";

async function rig(t: TestContext) {
  const reads: string[] = [];
  const raw = Object.fromEntries(STAFF_STATISTICS_COUNTERS.filter(c => c.source.kind === "available").map(c => [c.key, 7]));
  const store: StatisticsStore = { async staffCounts(day) { reads.push(day); return raw; }, async hiring() { return { hired: 4, retained: 1, invitations: 0 }; } };
  const isStaff = async (id: string) => id === "staff";
  const statistics = new StatisticsService(store, { isStaff }, () => new Date("2026-11-20T06:00:00Z"));
  const service = { isStaff, statistics: { page: (v: string) => statistics.page(v) } } as unknown as IdCardsHttpService;
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, service, "https://studenthub.example", async s => ({ "s-alia": "alia", "s-staff": "staff" } as Record<string, string>)[s])) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "application/json", method = "GET") => fetch(base + path, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  return { call, reads };
}

test("REPORTS_STATISTICS_HTTP staff see every counter, with not available for a missing source, and the hiring figures", async (t) => {
  const x = await rig(t);
  const r = await x.call("/workspace/statistics", "s-staff");
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json() as { day: string; counters: { key: string; value: number | null }[]; hiring: { retentionRatio: number | null; recruitmentYield: number | null } };
  assert.equal(body.day, "2026-11-20");
  assert.equal(body.counters.length, STAFF_STATISTICS_COUNTERS.length);
  assert.equal(body.counters.find(c => c.key === "workLogAppeals")!.value, 7);
  assert.equal(body.counters.find(c => c.key === "missingBankInfo")!.value, null);
  assert.deepEqual([body.hiring.retentionRatio, body.hiring.recruitmentYield], [25, null]);
  const html = await (await x.call("/workspace/statistics", "s-staff", "text/html")).text();
  assert.match(html, /<h1>Statistics<\/h1>/);
  assert.match(html, /Candidates missing bank info<\/td><td>Not available <small>\(waits on unpaid transfers from the pay lane/);
  assert.match(html, /Retention ratio<\/dt><dd>25%<\/dd>/);
  assert.match(html, /Recruitment yield \(hires per 100 invitations\)<\/dt><dd>Not available \(nothing to divide by\)<\/dd>/);
  assert.equal((await x.call("/workspace/statistics", "s-staff", "application/json", "POST")).status, 405);
});

test("REPORTS_STATISTICS_HTTP everyone who is not staff gets the same not found for every method, before anything is counted", async (t) => {
  const x = await rig(t);
  for (const session of [undefined, "s-alia", "s-bogus"]) for (const method of ["GET", "POST", "DELETE"]) {
    const r = await x.call("/workspace/statistics", session, "application/json", method);
    assert.equal(r.status, 404, `${method} ${session}`); assert.equal(await r.text(), JSON.stringify({ status: "not_found" }));
  }
  assert.deepEqual(x.reads, []);
  assert.equal((await x.call("/workspace/statistics/extra", "s-staff")).status, 418, "not this route's path");
});
