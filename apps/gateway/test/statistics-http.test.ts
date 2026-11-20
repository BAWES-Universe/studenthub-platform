import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { FiringHitMapService, STAFF_STATISTICS_COUNTERS, StatisticsService, type StatisticsStore } from "../../../packages/reports/src/index.js";
import { handleIdCards, type IdCardsHttpService } from "../src/reports/id-cards-http.js";

async function rig(t: TestContext) {
  const reads: string[] = [];
  const raw = Object.fromEntries(STAFF_STATISTICS_COUNTERS.filter(c => c.source.kind === "available").map(c => [c.key, 7]));
  const store: StatisticsStore = { async staffCounts(day) { reads.push(day); return raw; }, async hiring() { return { hired: 4, retained: 1, invitations: 0 }; }, async overviewCounts() { return { candidates: 50, assigned: 9, suggested: 30, requests: 12, requestsDelivered: 5 }; } };
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
  assert.match(html, /<h2>Overview<\/h2>/);
  assert.match(html, /Requests delivered<\/td><td>5<\/td>/);
  assert.match(html, /Staff on leave today<\/td><td>Not available <small>\(waits on staff leave/);
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

test("REPORTS_STATISTICS_HTTP staff see the firing hit map; everyone else gets the same not found", async (t) => {
  const isStaff = async (id: string) => id === "staff";
  const firings = new FiringHitMapService({ async firings() { return { companies: [{ orgId: "a", name: "Alpha & Co" }, { orgId: "b", name: "Beta" }], counts: [{ orgId: "a", month: "2026-11", total: 3 }] }; } },
    { isStaff }, () => new Date("2026-11-20T06:00:00Z"));
  const service = { isStaff, statistics: { page: async () => undefined, firingHitMap: (v: string) => firings.page(v) } } as unknown as IdCardsHttpService;
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, service, "https://studenthub.example", async s => ({ "s-alia": "alia", "s-staff": "staff" } as Record<string, string>)[s])) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (session?: string, accept = "application/json", method = "GET") => fetch(`${base}/workspace/statistics/firings`, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  const body = await (await call("s-staff")).json() as { months: string[]; companies: { name: string; cells: { total: number; level: string | null }[] }[] };
  assert.equal(body.months[0], "2026-11");
  assert.deepEqual(body.companies.map(c => [c.name, c.cells[0]!.total, c.cells[0]!.level]), [["Alpha & Co", 3, "danger"], ["Beta", 0, null]]);
  const html = await (await call("s-staff", "text/html")).text();
  assert.match(html, /<h1>Placements ended per company<\/h1>/);
  assert.match(html, /<th scope="row">Alpha &amp; Co<\/th><td class="danger"><strong>3<\/strong> <small>\(more than twice the average\)<\/small><\/td>/);
  assert.equal((await call("s-staff", "application/json", "POST")).status, 405);
  for (const session of [undefined, "s-alia"]) assert.equal((await call(session)).status, 404);
});

test("REPORTS_STATISTICS_HTTP without a hit map source the firings page is not found, and the statistics page links to it", async (t) => {
  const x = await rig(t);
  assert.equal((await x.call("/workspace/statistics/firings", "s-staff")).status, 404);
  assert.match(await (await x.call("/workspace/statistics", "s-staff", "text/html")).text(), /<a href="\/workspace\/statistics\/firings">/);
});
