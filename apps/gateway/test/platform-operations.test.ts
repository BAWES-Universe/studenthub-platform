import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import { createPlatformOperations } from "../src/platform/operations-page.js";
import { MemoryJobRunsStore, createJobRegistry } from "../../../packages/observability/src/jobs.js";
import type { EmailDeliverySummary } from "../../../packages/db/src/postgres-email-outbox-store.js";

// Synthetic sessions, grants and counts only.
const NOW = new Date("2026-11-27T09:00:00.000Z"); // 12:00 Kuwait
const SESSIONS: Record<string, { grants: { orgId: string; role: string }[] }> = {
  ["a".repeat(43)]: { grants: [{ orgId: "root", role: "admin" }] },
  ["s".repeat(43)]: { grants: [{ orgId: "root", role: "staff" }] },
  ["o".repeat(43)]: { grants: [{ orgId: "org-a", role: "admin" }] },
  ["n".repeat(43)]: { grants: [] },
};
const ADMIN = "a".repeat(43);
const quiet: EmailDeliverySummary = { waiting: 0, overdue: 0, oldestWaitingSince: null, last24Hours: { sent: 12, failed: 0, not_sent: 1, suppressed: 0 } };

async function rig(t: TestContext, options: { email?: EmailDeliverySummary; runs?: (store: MemoryJobRunsStore) => Promise<void>; throws?: boolean } = {}) {
  const store = new MemoryJobRunsStore();
  await options.runs?.(store);
  const reads = { email: 0, grants: 0 };
  const operations = createPlatformOperations({
    sessions: { get: async (id: string) => SESSIONS[id] ? { id, personId: `person-${id[0]}` } as never : undefined },
    authz: { listGrantsForPrincipal: async (personId: string) => { reads.grants++; const s = SESSIONS[personId.slice(7).repeat(43)]; return (s?.grants ?? []).map((g, i) => ({ id: `g${i}`, principalId: personId, scope: "subtree", ...g })) as never; } },
    jobRuns: store,
    jobs: createJobRegistry(store, () => undefined),
    email: { deliverySummary: async (now: Date) => { reads.email++; assert.equal(now.getTime(), NOW.getTime()); if (options.throws) throw new Error("db down"); return options.email ?? quiet; } },
    now: () => NOW,
  });
  const server = createGatewayServer(undefined, undefined, undefined, { platformOperations: operations } as never);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "text/html", method = "GET") =>
    fetch(base + path, { method, headers: { accept, ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}) }, redirect: "manual" });
  return { call, reads };
}
const ran = (name: "heartbeat" | "missed_run_check" | "email_delivery", minutesAgo: number, outcome: "succeeded" | "failed" = "succeeded") => {
  const startedAt = new Date(NOW.getTime() - minutesAgo * 60_000);
  return { runId: `${name}-${minutesAgo}`, jobName: name, startedAt, finishedAt: new Date(startedAt.getTime() + 250), durationMs: 250, outcome };
};

test("OPS_PAGE an operator admin sees every job's last run and whether it is late, and email delivery at a glance", async (t) => {
  const { call, reads } = await rig(t, {
    runs: async (s) => { await s.record(ran("heartbeat", 1)); await s.record(ran("missed_run_check", 1)); await s.record(ran("email_delivery", 30)); await s.record(ran("email_delivery", 2, "failed")); },
    email: { waiting: 7, overdue: 3, oldestWaitingSince: new Date("2026-11-27T07:30:00.000Z"), last24Hours: { sent: 40, failed: 2, not_sent: 5, suppressed: 1 } },
  });
  const r = await call("/platform/operations", ADMIN);
  assert.equal(r.status, 200, "OPS_PAGE status");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
  const html = await r.text();
  assert.equal((html.match(/<h1>/g) ?? []).length, 1); assert.match(html, /<h1>Operations<\/h1>/);
  assert.match(html, /<a class="skip" href="#main">/);
  assert.match(html, /role="status">3 things need attention\./, "OPS_PAGE one late job, overdue email and failed attempts");
  assert.match(html, /Checked 27 Nov 2026, 12:00 Kuwait time\./);
  assert.match(html, /<th scope="row">Worker heartbeat<\/th><td>27 Nov 2026, 11:59 Kuwait time<\/td><td>Succeeded<\/td><td>On time<\/td>/);
  assert.match(html, /<th scope="row">Email delivery<\/th><td>27 Nov 2026, 11:58 Kuwait time<\/td><td><strong>Failed<\/strong><\/td><td><strong>Late<\/strong><\/td>/, "OPS_PAGE email job's last success is 30 minutes old");
  assert.match(html, /<dt>Waiting to send<\/dt><dd>7, the oldest queued 27 Nov 2026, 10:30 Kuwait time<\/dd>/);
  assert.match(html, /<dt>Overdue<\/dt><dd><strong>3<\/strong><\/dd>/);
  assert.match(html, /<tr><td>40<\/td><td><strong>2<\/strong><\/td><td>5<\/td><td>1<\/td><\/tr>/);
  assert.match(html, /href="\/admin\/jobs"/); assert.match(html, /href="\/admin\/outbox"/);
  assert.match(html, /Not sent means this environment does not send email or delivery is not set up\. Suppressed means the person turned that email off or it was no longer needed\. An email with no address counts as failed\./, "OPS_PAGE outcomes as the worker records them");
  assert.doesNotMatch(html, /cache|flush/i, "no cache flush");
  assert.equal(reads.email, 1);
});

test("OPS_PAGE everything running reads as all clear, a never-run job is late", async (t) => {
  const all = await rig(t, { runs: async (s) => { for (const name of ["heartbeat", "missed_run_check", "email_delivery"] as const) await s.record(ran(name, 1)); } });
  const html = await (await all.call("/platform/operations", ADMIN)).text();
  assert.match(html, /role="status">Everything is running\./);
  assert.match(html, /<dt>Waiting to send<\/dt><dd>0<\/dd>/);
  assert.match(html, /<dt>Overdue<\/dt><dd>0<\/dd>/);
  const none = await rig(t);
  const fresh = await (await none.call("/platform/operations", ADMIN)).text();
  assert.match(fresh, /role="status">3 things need attention\./);
  assert.match(fresh, /<th scope="row">Late job check<\/th><td>Never run<\/td><td>None<\/td><td><strong>Late<\/strong><\/td>/);
});

test("OPS_FAILED a failed latest run needs attention even when an earlier success keeps the job on schedule, and counts once", async (t) => {
  const recent = await rig(t, { runs: async (s) => {
    for (const name of ["heartbeat", "missed_run_check", "email_delivery"] as const) await s.record(ran(name, 1));
    await s.record(ran("heartbeat", 0.5, "failed"));
  } });
  const html = await (await recent.call("/platform/operations", ADMIN)).text();
  assert.doesNotMatch(html, /Everything is running/, "OPS_FAILED no all-clear over a failed run");
  assert.match(html, /role="status">1 thing needs attention\./);
  assert.match(html, /<th scope="row">Worker heartbeat<\/th><td>[^<]+<\/td><td><strong>Failed<\/strong><\/td><td>On time<\/td>/);
  const body = await (await recent.call("/platform/operations", ADMIN, "application/json")).json();
  assert.equal(body.needsAttention, 1);
  assert.deepEqual(body.jobs.map((j: { name: string; late: boolean; lastRun: { outcome: string } }) => [j.name, j.late, j.lastRun.outcome]),
    [["heartbeat", false, "failed"], ["missed_run_check", false, "succeeded"], ["email_delivery", false, "succeeded"]]);
  const both = await rig(t, { runs: async (s) => {
    for (const name of ["heartbeat", "missed_run_check"] as const) await s.record(ran(name, 1));
    await s.record(ran("email_delivery", 30)); await s.record(ran("email_delivery", 2, "failed"));
  } });
  const late = await (await both.call("/platform/operations", ADMIN, "application/json")).json();
  assert.deepEqual([late.jobs[2].late, late.jobs[2].lastRun.outcome, late.needsAttention], [true, "failed", 1], "OPS_FAILED late and failed counts once");
});

test("OPS_JSON an API caller gets the same view as JSON", async (t) => {
  const { call } = await rig(t, { runs: async (s) => { await s.record(ran("heartbeat", 1)); } });
  const r = await call("/platform/operations", ADMIN, "application/json");
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json();
  assert.equal(body.status, "ok"); assert.equal(body.checkedAt, NOW.toISOString());
  assert.deepEqual(body.jobs.map((j: { name: string; late: boolean }) => [j.name, j.late]), [["heartbeat", false], ["missed_run_check", true], ["email_delivery", true]]);
  assert.deepEqual(body.email, { waiting: 0, overdue: 0, oldestWaitingSince: null, last24Hours: quiet.last24Hours });
  assert.equal(body.needsAttention, 2);
});

test("OPS_HIDDEN anyone but an operator admin gets the unknown-path answer and nothing is read", async (t) => {
  const { call, reads } = await rig(t);
  for (const accept of ["text/html", "application/json"]) {
    const missing = await call("/no/such/page", undefined, accept), expected = { status: missing.status, type: missing.headers.get("content-type"), body: await missing.text() };
    for (const [who, session] of [["signed out", undefined], ["unknown session", "x".repeat(43)], ["no grant", "n".repeat(43)], ["root staff", "s".repeat(43)], ["admin at a company", "o".repeat(43)]] as const) {
      const r = await call("/platform/operations", session, accept);
      assert.deepEqual({ status: r.status, type: r.headers.get("content-type"), body: await r.text() }, expected, `OPS_HIDDEN ${who} ${accept}`);
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      const r = await call("/platform/operations", ADMIN, accept, method), m = await call("/no/such/page", ADMIN, accept, method);
      assert.deepEqual([r.status, await r.text()], [m.status, await m.text()], `OPS_HIDDEN ${method} ${accept}`);
    }
  }
  assert.equal(reads.email, 0, "OPS_HIDDEN email summary never read for a refused caller");
  assert.equal((await call("/platform/operations/x", ADMIN)).status, 404, "a deeper path is the wildcard");
});

test("OPS_UNAVAILABLE a failing read is the gateway's plain failure, never its text", async (t) => {
  const { call } = await rig(t, { throws: true });
  const r = await call("/platform/operations", ADMIN);
  assert.equal(r.status, 503);
  assert.doesNotMatch(await r.text(), /db down/);
});
