import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { MORNING_SUMMARY_KEYS, MorningSummaryService } from "../../../packages/reports/src/index.js";
import { handleStaffMessages } from "../src/comms/staff-messages-http.js";

const ORIGIN = "https://studenthub.example", STAFF = "staff-1", PERSON = "person-1";

async function rig(t: TestContext, wired = true) {
  const subscribed = new Set<string>(), reads: string[] = [];
  const store = { async counts(day: string) { reads.push(day); return { interviewScheduledToday: 0, activeRequests: 4, assignedExpiredCivilID: 2 }; },
    async sendDay() { return null; }, async isSubscribed(id: string) { return subscribed.has(id); },
    async setSubscribed(id: string, on: boolean) { if (on) subscribed.add(id); else subscribed.delete(id); } };
  const authority = { async isStaff(id: string) { return id === STAFF; } };
  const summary = new MorningSummaryService(store, authority);
  const http = { isStaff: authority.isStaff, async send() { return { status: "forbidden" } as const; },
    ...(wired ? { morningSummary: { today: (v: string) => summary.today(v), subscribe: (v: string, on: boolean) => summary.subscribe(v, on) } } : {}) };
  const server = createServer(async (req, res) => {
    if (!await handleStaffMessages(req, res, http, ORIGIN, async s => s === "s-staff" ? STAFF : s === "s-person" ? PERSON : undefined)) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, path = "/workspace/morning-summary";
  const get = (session = "s-staff", accept = "application/json") => fetch(base + path, { headers: { cookie: `__Host-studenthub_session=${session}`, accept } });
  const post = (fields: Record<string, string>, session = "s-staff", headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", redirect: "manual",
    headers: { cookie: `__Host-studenthub_session=${session}`, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers }, body: new URLSearchParams(fields).toString() });
  return { get, post, subscribed, reads };
}

test("REPORTS_MORNING_SUMMARY_HTTP staff see every counter, with not available for a missing source, and the email switch", async (t) => {
  const x = await rig(t);
  const res = await x.get();
  assert.equal(res.status, 200);
  const body = await res.json() as { status: string; day: string; subscribed: boolean; counters: { key: string; value: number | null; waitsOn: string | null }[] };
  assert.equal(body.status, "ok");
  assert.match(body.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.subscribed, false);
  assert.deepEqual(body.counters.map(c => c.key), MORNING_SUMMARY_KEYS);
  assert.deepEqual(body.counters.filter(c => c.value !== null).map(c => [c.key, c.value]), [["interviewScheduledToday", 0], ["activeRequests", 4], ["assignedExpiredCivilID", 2]]);
  const html = await (await x.get("s-staff", "text/html")).text();
  assert.match(html, /<h1>Morning summary<\/h1>/);
  assert.match(html, /Candidates missing bank info<\/td><td>Not available<br><small>Waits on unpaid transfers from the pay lane/);
  assert.match(html, /Active requests that need an update<\/td><td>4</);
  assert.match(html, /name="email" value="on"/);
  assert.match(html, /Email me this every morning/);
});

test("REPORTS_MORNING_SUMMARY_HTTP staff turn the email on and off for themselves; a browser is sent back to the page", async (t) => {
  const x = await rig(t);
  const on = await x.post({ email: "on" });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { status: "ok", subscribed: true });
  assert.deepEqual([...x.subscribed], [STAFF]);
  assert.equal(((await (await x.get()).json()) as { subscribed: boolean }).subscribed, true);
  assert.match(await (await x.get("s-staff", "text/html")).text(), /name="email" value="off"/);
  const off = await x.post({ email: "off" }, "s-staff", { accept: "text/html" });
  assert.equal(off.status, 303);
  assert.equal(off.headers.get("location"), "/workspace/morning-summary");
  assert.equal(x.subscribed.size, 0);
  for (const bad of [{ email: "yes" }, {}, { email: "on", other: "1" }] as Record<string, string>[]) assert.equal((await x.post(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await x.post({ email: "on" }, "s-staff", { origin: "https://evil.example" })).status, 403);
  assert.equal(x.subscribed.size, 0);
});

test("REPORTS_MORNING_SUMMARY_HTTP non-staff, signed-out callers and an unwired gateway get the same not found, and nothing is read or saved", async (t) => {
  const x = await rig(t);
  for (const session of ["s-person", "nobody", ""]) {
    const res = await x.get(session);
    assert.equal(res.status, 404, session);
    assert.deepEqual(await res.json(), { status: "not_found" });
    assert.equal((await x.post({ email: "on" }, session)).status, 404);
  }
  assert.deepEqual(x.reads, []);
  assert.equal(x.subscribed.size, 0);
  const unwired = await rig(t, false);
  assert.equal((await unwired.get()).status, 404);
});
