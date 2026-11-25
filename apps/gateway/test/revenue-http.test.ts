import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { mayViewFinanceReports } from "../../../packages/access/src/index.js";
import { RevenueService, type RevenueStore } from "../../../packages/reports/src/index.js";
import { handleIdCards, type IdCardsHttpService } from "../src/reports/id-cards-http.js";

async function rig(t: TestContext) {
  const reads: string[] = [];
  const store: RevenueStore = {
    async read() { reads.push("read"); return { byStatus: [
      { currency: "KWD", status: "draft", transfers: 1, lines: 1, companyTotal: "2.000", candidateTotal: "1.000", grossProfit: "1.000" },
      { currency: "KWD", status: "complete", transfers: 2, lines: 3, companyTotal: "300.500", candidateTotal: "200.250", grossProfit: "100.250" },
    ], byMonth: [{ currency: "KWD", month: "2026-10", transfers: 2, companyTotal: "300.500", candidateTotal: "200.250", grossProfit: "100.250", received: "300.500" }] }; },
  };
  // The access lane's projection over each person's grants, as the wiring uses it.
  const grants: Record<string, { orgId: string; role: string; scope: string }[]> = {
    boss: [{ orgId: "root", role: "admin", scope: "subtree" }], fin: [{ orgId: "root", role: "finance", scope: "subtree" }],
    staff: [{ orgId: "root", role: "staff", scope: "subtree" }], selfadmin: [{ orgId: "root", role: "admin", scope: "self" }],
    owner: [{ orgId: "acme", role: "finance", scope: "subtree" }],
  };
  const mayViewRevenue = async (id: string) => mayViewFinanceReports(grants[id] ?? [], ["root"]);
  const revenue = new RevenueService(store, { mayViewRevenue }, () => new Date("2026-11-23T09:00:00Z"));
  const service = { isStaff: async (id: string) => id === "staff" || id === "boss", revenue: { mayViewRevenue, page: (v: string) => revenue.page(v) } } as unknown as IdCardsHttpService;
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, service, "https://studenthub.example", async s => ({ "s-alia": "alia", "s-staff": "staff", "s-boss": "boss", "s-fin": "fin", "s-selfadmin": "selfadmin", "s-owner": "owner" } as Record<string, string>)[s])) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (session?: string, accept = "application/json", method = "GET", path = "/reports/revenue") =>
    fetch(base + path, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  return { call, reads };
}

test("REVENUE_HTTP operator finance reads the page too, read only", async (t) => {
  const x = await rig(t);
  const r = await x.call("s-fin");
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json() as { received: { currency: string }[] }).received.map(c => c.currency), ["KWD"]);
  assert.equal((await x.call("s-fin", "application/json", "POST")).status, 405);
  const html = await (await x.call("s-fin", "text/html")).text();
  assert.match(html, /<h1>Revenue<\/h1>/);
  assert.doesNotMatch(html, /Back to operations/, "operations is a staff page, so finance gets no link to it");
  assert.match(await (await x.call("s-boss", "text/html")).text(), /<a href="\/reports\/operations">Back to operations<\/a>/, "staff and admins keep the link");
});

test("REVENUE_HTTP operator admins see received totals, the months and the reconciliation", async (t) => {
  const x = await rig(t);
  const r = await x.call("s-boss");
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json() as { received: { currency: string; grossProfit: string }[]; monthly: unknown[]; months: string[] };
  assert.deepEqual(body.received.map(c => [c.currency, c.grossProfit]), [["KWD", "100.250"]]);
  assert.deepEqual([body.months.length, body.monthly.length], [12, 12]);
  const html = await (await x.call("s-boss", "text/html")).text();
  assert.match(html, /<h1>Revenue<\/h1>/);
  assert.match(html, /<th scope="row">KWD<\/th><td>300\.500<\/td><td>200\.250<\/td><td>100\.250<\/td><td>2<\/td><td>3<\/td>/);
  assert.match(html, /<th scope="row">October 2026<\/th><td>2<\/td><td>300\.500<\/td><td>200\.250<\/td><td>100\.250<\/td><td>300\.500<\/td>/);
  assert.match(html, /<th scope="row">November 2025<\/th><td>0<\/td><td>0\.000<\/td>/, "a month with no transfers is zeros");
  assert.match(html, /<td>KWD<\/td><td>Draft<\/td><td>1<\/td><td>1<\/td><td>2\.000<\/td>/);
  assert.match(html, /Net profit: Not available <small>\(waits on staff salaries and expenses\)<\/small>/);
  assert.equal((await x.call("s-boss", "application/json", "POST")).status, 405);
});

test("REVENUE_HTTP staff, company finance, self-scoped admins, other people and the signed out get the same not found for every method, and nothing is read", async (t) => {
  const x = await rig(t);
  for (const session of [undefined, "s-alia", "s-staff", "s-selfadmin", "s-owner", "s-bogus"]) for (const method of ["GET", "POST"]) {
    const r = await x.call(session, "application/json", method);
    assert.equal(r.status, 404, `${method} ${session}`); assert.equal(await r.text(), JSON.stringify({ status: "not_found" }));
  }
  assert.deepEqual(x.reads, []);
  assert.equal((await x.call("s-boss", "application/json", "GET", "/reports/revenue/extra")).status, 418, "not this route's path");
});
