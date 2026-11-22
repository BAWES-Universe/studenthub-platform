import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { FiringHitMapService, RecruiterActivityService, STAFF_STATISTICS_COUNTERS, StatisticsService, type StatisticsStore } from "../../../packages/reports/src/index.js";
import { handleIdCards, type IdCardsHttpService } from "../src/reports/id-cards-http.js";

async function rig(t: TestContext) {
  const reads: string[] = [];
  const raw = Object.fromEntries(STAFF_STATISTICS_COUNTERS.filter(c => c.source.kind === "available").map(c => [c.key, 7]));
  const store: StatisticsStore = { async emailsByDay() { return [{ day: "2026-11-20", sent: 501, failed: 2 }, { day: "2026-11-19", sent: 40, failed: 0 }]; }, async invitationsByMonth() { return [{ month: "2026-10", noAnswer: 1, accepted: 3, declined: 0, withdrawn: 0 }]; }, async staffCounts(day) { reads.push(day); return raw; }, async hiring() { return { hired: 4, retained: 1, invitations: 0 }; }, async overviewCounts() { return { candidates: 50, assigned: 9, suggested: 30, requests: 12, requestsDelivered: 5 }; } };
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
  assert.match(html, /<h2>Invitations by month<\/h2>/);
  assert.match(html, /<th scope="row">October 2026<\/th><td><meter min="0" max="4" value="4"><\/meter> 4<\/td><td>1<\/td><td>3<\/td><td>0<\/td><td>0<\/td><td>75%<\/td><td>0%<\/td>/);
  assert.match(html, /<th scope="row">November 2025<\/th><td><meter min="0" max="4" value="0"><\/meter> 0<\/td>(<td>0<\/td>){4}<td>–<\/td><td>–<\/td>/);
  assert.equal((body as unknown as { invitationsByMonth: unknown[] }).invitationsByMonth.length, 12);
  assert.match(html, /<h2>Emails sent per day<\/h2><p>Emails sent in each of the last 14 days/);
  assert.match(html, /<th scope="row">2026-11-20<\/th><td><meter min="0" max="501" high="500" value="501"><\/meter> 501 <strong>\(over 500\)<\/strong><\/td><td>2<\/td>/);
  assert.match(html, /<th scope="row">2026-11-19<\/th><td><meter min="0" max="501" high="500" value="40"><\/meter> 40<\/td><td>0<\/td>/);
  assert.match(html, /<th scope="row">2026-11-07<\/th>/, "oldest of the 14 days");
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

test("REPORTS_STATISTICS_HTTP staff turn the spike email on and off from the hit map, same origin only", async (t) => {
  const isStaff = async (id: string) => id === "staff";
  const subs = new Set<string>();
  const firings = new FiringHitMapService({ async firings() { return { companies: [], counts: [] }; } }, { isStaff }, () => new Date("2026-11-20T06:00:00Z"),
    { async isSubscribed(id) { return subs.has(id); }, async setSubscribed(id, on) { if (on) subs.add(id); else subs.delete(id); } });
  const service = { isStaff, statistics: { page: async () => undefined, firingHitMap: (v: string) => firings.page(v), firingSpikeEmail: (v: string, on: boolean) => firings.subscribe(v, on) } } as unknown as IdCardsHttpService;
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, service, "https://studenthub.example", async s => ({ "s-alia": "alia", "s-staff": "staff" } as Record<string, string>)[s])) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workspace/statistics/firings`;
  const post = (session: string | undefined, body: string, headers: Record<string, string> = {}) => fetch(url, { method: "POST", redirect: "manual", body,
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://studenthub.example", ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), ...headers } });
  const html = async () => (await fetch(url, { headers: { cookie: "__Host-studenthub_session=s-staff", accept: "text/html" } })).text();
  assert.match(await html(), /<input type="hidden" name="email" value="on">.*Email me when a company spikes/s);
  assert.deepEqual(await (await post("s-staff", "email=on", { accept: "application/json" })).json(), { status: "ok", spikeEmail: true });
  assert.deepEqual([...subs], ["staff"]);
  assert.match(await html(), /Stop the spike emails/);
  const back = await post("s-staff", "email=off", { accept: "text/html" });
  assert.deepEqual([back.status, back.headers.get("location")], [303, "/workspace/statistics/firings"]);
  assert.deepEqual([...subs], []);
  assert.equal((await post("s-staff", "email=on", { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("s-staff", "email=maybe")).status, 400);
  assert.equal((await post("s-staff", "email=on&x=1")).status, 400);
  for (const session of [undefined, "s-alia"]) assert.equal((await post(session, "email=on")).status, 404);
  assert.deepEqual([...subs], [], "nothing changed by refused requests");
});

test("REPORTS_RECRUITERS_HTTP staff see what each staff member did, today by default or over a range; bad ranges are refused; everyone else gets not found", async (t) => {
  const isStaff = async (id: string) => id === "staff";
  const asked: string[] = [];
  const recruiters = new RecruiterActivityService({ async recruiterActivity(_ids, from, to) {
    asked.push(`${from}..${to}`);
    return { names: new Map([["staff", "Sara <Ops>"]]), counts: new Map([["staff", { placements: 1, requests: 2, suggestions: 3, notes: 4, invitations: 5, invitationsAccepted: 1, invitationsDeclined: 2 }]]) };
  } }, { isStaff }, { async operatorStaff() { return ["staff", "omar"]; } }, () => new Date("2026-11-20T06:00:00Z"));
  const service = { isStaff, statistics: { page: async () => undefined, recruiters: (v: string, r: never) => recruiters.page(v, r) } } as unknown as IdCardsHttpService;
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, service, "https://studenthub.example", async s => ({ "s-alia": "alia", "s-staff": "staff" } as Record<string, string>)[s])) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (query = "", session = "s-staff", accept = "application/json", method = "GET") =>
    fetch(`${base}/workspace/statistics/recruiters${query}`, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  const r = await call();
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json() as { from: string; to: string; staff: { name: string; notes: number }[]; totals: { invitations: number } };
  assert.deepEqual([body.from, body.to], ["2026-11-20", "2026-11-20"]);
  assert.deepEqual(body.staff.map(s => [s.name, s.notes]), [["Sara <Ops>", 4], ["omar", 0]]);
  assert.equal(body.totals.invitations, 5);
  const html = await (await call("?from=2026-11-01&to=2026-11-20", "s-staff", "text/html")).text();
  assert.match(html, /<h1>What each staff member did<\/h1>/);
  assert.match(html, /2026-11-01 to 2026-11-20/);
  assert.match(html, /<th scope="row">Sara &lt;Ops&gt;<\/th><td>1<\/td><td>2<\/td><td>3<\/td><td>4<\/td><td>5<\/td><td>1<\/td><td>2<\/td>/);
  assert.match(html, /<tfoot><tr><th scope="row">All staff<\/th><td>1<\/td>/);
  assert.match(html, /<input type="date" name="from" value="2026-11-01" max="2026-11-20" required>/);
  assert.deepEqual(asked, ["2026-11-20..2026-11-20", "2026-11-01..2026-11-20"]);
  for (const [q, field] of [["?to=2026-11-21", "to"], ["?from=2025-11-19&to=2026-11-20", "too_long"], ["?from=x", "from"], ["?from=2026-11-20&to=2026-11-19", "order"], ["?day=2026-11-20", "query"], ["?from=2026-11-01&from=2026-11-02", "query"]] as const) {
    const bad = await call(q);
    assert.equal(bad.status, 400, q); assert.deepEqual(await bad.json(), { status: "invalid", field }, q);
  }
  const refused = await call("?to=2026-11-21", "s-staff", "text/html");
  assert.equal(refused.status, 400); assert.match(await refused.text(), /role="alert">The end is not a real day, or is after today\./);
  assert.equal(asked.length, 2, "a refused range reads nothing");
  assert.equal((await call("", "s-staff", "application/json", "POST")).status, 405);
  for (const session of ["", "s-alia"]) for (const q of ["", "?from=x"]) assert.equal((await call(q, session)).status, 404, `${session} ${q}`);
  assert.equal(asked.length, 2);
});

test("REPORTS_RECRUITERS_HTTP without the source the page is not found, and the statistics page links to it", async (t) => {
  const x = await rig(t);
  assert.equal((await x.call("/workspace/statistics/recruiters", "s-staff")).status, 404);
  assert.match(await (await x.call("/workspace/statistics", "s-staff", "text/html")).text(), /<a href="\/workspace\/statistics\/recruiters">What each staff member did today<\/a>/);
});
