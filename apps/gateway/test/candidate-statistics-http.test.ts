import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { CandidateStatisticsService, type CandidateStatisticsStore } from "../../../packages/reports/src/index.js";
import { handleIdCards, type IdCardsHttpService } from "../src/reports/id-cards-http.js";

async function rig(t: TestContext, withService = true) {
  const reads: string[] = [];
  const store: CandidateStatisticsStore = {
    async read(person) {
      reads.push(person);
      return person === "alia"
        ? { lines: [{ currency: "KWD", candidateTotal: "12.500", paidOut: true, calculation: null }, { currency: "KWD", candidateTotal: "1.000", paidOut: false, calculation: null }], upcomingInterviews: 1 }
        : { lines: [], upcomingInterviews: 0 };
    },
  };
  const statistics = new CandidateStatisticsService(store, () => new Date("2026-11-27T10:00:00Z"));
  const service = { isStaff: async () => false, ...(withService ? { candidateStatistics: { own: (p: string) => statistics.own(p) } } : {}) } as unknown as IdCardsHttpService;
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, service, "https://studenthub.example", async s => ({ "s-alia": "alia", "s-new": "new" } as Record<string, string>)[s])) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (session?: string, accept = "application/json", method = "GET", path = "/profile/statistics") =>
    fetch(base + path, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  return { call, reads };
}

test("CANDIDATE_STATISTICS_HTTP a person reads only their own figures, as JSON or a page", async (t) => {
  const x = await rig(t);
  const r = await x.call("s-alia");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { status: "ok", worked: { hours: "0", minutes: 0, seconds: 0 }, money: [{ currency: "KWD", paid: "12.500", bonus: "0.000", earnings: "12.500" }], upcomingInterviews: 1 });
  const other = await x.call("s-alia", "application/json", "GET", "/profile/statistics?person=new");
  assert.equal(other.status, 200);
  assert.deepEqual(x.reads, ["alia", "alia"], "a person parameter is ignored: always the signed-in person");
  const html = await (await x.call("s-alia", "text/html")).text();
  assert.match(html, /<h1>Your statistics<\/h1>/);
  assert.match(html, /<td>KWD<\/td><td>12\.500<\/td><td>0\.000<\/td><td>12\.500<\/td>/);
  assert.match(html, /1 upcoming interview\./);
  assert.match(await (await x.call("s-new", "text/html")).text(), /Nothing has been paid out to you yet/);
});

test("CANDIDATE_STATISTICS_HTTP signed out gets 401, other methods 405, no service 404, other paths fall through", async (t) => {
  const x = await rig(t);
  assert.deepEqual([(await x.call()).status, (await x.call(undefined, "text/html")).status, (await x.call("s-bogus")).status], [401, 401, 401]);
  assert.equal((await x.call("s-alia", "application/json", "POST")).status, 405);
  assert.equal((await x.call("s-alia", "application/json", "GET", "/profile/statistics/extra")).status, 418);
  assert.deepEqual(x.reads, [], "nothing is read for a refused call");
  const none = await rig(t, false);
  assert.equal((await none.call("s-alia")).status, 404);
});
