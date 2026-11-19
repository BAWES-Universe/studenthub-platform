import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { handleWork, type WorkHttpServices } from "../src/work/http.js";

const SESSION = "s".repeat(43), ORIGIN = "https://studenthub.test.invalid";
const ID = "aaaaaaaa-0000-4000-8000-000000000001";

function services(calls: unknown[][]): WorkHttpServices {
  const record = (name: string, result: unknown) => async (...args: unknown[]) => { calls.push([name, ...args]); return result; };
  return {
    personFor: async (id: string) => id === SESSION ? "person" : undefined,
    placements: { mine: record("mine", []), forOrganization: record("forOrganization", undefined), place: record("place", { kind: "refused", code: "forbidden" }),
      setEndDate: record("setEndDate", { kind: "ended", endDate: "2026-11-30" }), request: record("request", { kind: "refused", code: "duplicate_request" }),
      decideRequest: record("decideRequest", { kind: "rejected" }), requestsFor: record("requestsFor", undefined) },
    sessions: { today: record("today", { open: null, assignment: null }), start: record("start", { kind: "refused", code: "location_required" }),
      stop: record("stop", { kind: "refused", code: "not_working" }), discard: record("discard", { kind: "discarded" }), addManual: record("addManual", { kind: "refused", code: "in_future" }) },
    decisions: { decideSessions: record("decideSessions", { kind: "refused", code: "session_not_found", index: 1 }), decideDays: record("decideDays", { kind: "decided", decisions: [], changed: 0 }),
      undo: record("undo", { kind: "refused", code: "not_decided" }) },
    views: { mine: record("viewsMine", { rows: [], totals: {}, next: { workDate: "2026-11-18", id: ID } }), company: record("company", { kind: "refused", code: "forbidden" }),
      all: record("all", { rows: [], totals: {}, next: null }) },
    appeals: { raise: record("raise", { kind: "raised", appeal: { id: ID } }), mine: record("appealsMine", []), list: record("list", { kind: "refused", code: "forbidden" }),
      detail: record("detail", { kind: "refused", code: "appeal_not_found" }), postUpdate: record("postUpdate", { kind: "posted", update: {} }),
      setStatus: record("setStatus", { kind: "refused", code: "invalid_input" }), addMissing: record("addMissing", { kind: "refused", code: "overlaps_session" }),
      markRead: record("markRead", { kind: "read" }), correct: record("correct", { kind: "refused", code: "session_replaced" }) },
  } as unknown as WorkHttpServices;
}

type Opt = { method?: string; body?: string; origin?: string; cookie?: string | null; contentType?: string; service?: WorkHttpServices | undefined };
async function request(path: string, o: Opt = {}, calls: unknown[][] = []) {
  const req = Readable.from(o.body ? [o.body] : []) as Readable & { method?: string; url?: string; headers: Record<string, string> };
  req.method = o.method ?? "GET";
  req.url = path;
  req.headers = {
    ...(o.cookie === null ? {} : { cookie: `__Host-studenthub_session=${o.cookie ?? SESSION}` }),
    ...(o.body !== undefined ? { "content-type": o.contentType ?? "application/json", "content-length": String(Buffer.byteLength(o.body)) } : {}),
    ...(o.origin ? { origin: o.origin } : {}),
  };
  const res = new EventEmitter() as EventEmitter & { statusCode: number; headersSent: boolean; headers: Record<string, string>; chunks: string[]; writeHead(s: number, h: Record<string, string>): void; end(v?: unknown): void; destroy(): void };
  res.statusCode = 0; res.headers = {}; res.chunks = []; res.headersSent = false;
  res.writeHead = (s, h) => { res.statusCode = s; res.headers = h; res.headersSent = true; };
  res.end = (v) => { if (v !== undefined) res.chunks.push(String(v)); };
  res.destroy = () => {};
  const handled = await handleWork(req as never, res as never, Object.hasOwn(o, "service") ? o.service : services(calls), ORIGIN);
  return { handled, status: res.statusCode, headers: res.headers, json: res.chunks.length ? JSON.parse(res.chunks.join("")) as Record<string, unknown> : undefined };
}
const post = (path: string, body: unknown, extra: Opt = {}, calls: unknown[][] = []) => request(path, { method: "POST", origin: ORIGIN, body: JSON.stringify(body), ...extra }, calls);

test("WORK_HTTP only /work paths; unknown routes, wrong methods and a switched-off lane", async () => {
  assert.equal((await request("/profile")).handled, false);
  assert.equal((await request("/api/workers")).handled, false);
  assert.equal((await request("/work/track")).handled, false);
  assert.equal((await request("/api/work/nothing")).status, 404);
  assert.equal((await request("/api/work/sessions/start")).status, 404);
  assert.deepEqual([(await request("/api/work/today", { service: undefined })).status, (await request("/api/work/today", { service: undefined })).json], [503, { error: "work_unavailable" }]);
});

test("WORK_HTTP the signed-in person is the actor; writes need same origin, JSON and a session", async () => {
  assert.equal((await request("/api/work/today", { cookie: null })).status, 401);
  assert.equal((await request("/api/work/today", { cookie: "t".repeat(43) })).status, 401);
  assert.equal((await post("/api/work/sessions/discard", {}, { origin: "https://evil.invalid" })).status, 403);
  assert.equal((await post("/api/work/sessions/discard", {}, { cookie: null })).status, 401);
  assert.equal((await post("/api/work/sessions/discard", {}, { contentType: "text/plain" })).status, 400);
  assert.equal((await request("/api/work/sessions/discard", { method: "POST", origin: ORIGIN, body: "[1]" })).status, 400);
  assert.equal((await request("/api/work/sessions/discard", { method: "POST", origin: ORIGIN, body: "{" })).status, 400);
  const calls: unknown[][] = [];
  const out = await post("/api/work/sessions/discard", { personId: "someone-else", sessionId: ID }, {}, calls);
  assert.deepEqual([out.status, calls], [200, [["discard", "person", ID]]]);
  assert.equal(out.headers["cache-control"], "no-store");
});

test("WORK_HTTP refusals map to 400, 403, 404 and 409 and keep extra detail", async () => {
  assert.deepEqual([(await post("/api/work/sessions/start", {})).status, (await post("/api/work/sessions/start", {})).json], [400, { error: "location_required" }]);
  const stopCalls: unknown[][] = [];
  assert.equal((await post("/api/work/sessions/stop", { sessionId: ID, latitude: 1, longitude: 1 }, {}, stopCalls)).status, 409);
  assert.deepEqual(stopCalls, [["stop", "person", ID, { latitude: 1, longitude: 1 }]]);
  assert.equal((await post("/api/work/placements", { personId: "p", storeId: ID })).status, 403);
  assert.deepEqual((await post("/api/work/decisions/sessions", { sessionIds: [ID, ID], decision: "approve" })).json, { error: "session_not_found", index: 1 });
  assert.equal((await post("/api/work/decisions/sessions", { sessionIds: "x" })).status, 400);
  // Accepting a request checks the placement terms like a new placement, before the service runs.
  const calls: unknown[][] = [];
  for (const placement of [{ startDate: "2026-02-30" }, { endDate: "soon" }, { payContractId: "x" }, { storeId: ID }, "terms"]) {
    assert.equal((await post(`/api/work/placement-requests/${ID}/accept`, { placement }, {}, calls)).status, 400, JSON.stringify(placement));
  }
  assert.equal(calls.length, 0);
  await post(`/api/work/placement-requests/${ID}/accept`, { placement: { startDate: "2026-12-01", endDate: null, payContractId: ID.toUpperCase() } }, {}, calls);
  assert.deepEqual(calls[0], ["decideRequest", "person", ID, "accept", { placement: { startDate: "2026-12-01", endDate: null, payContractId: ID } }]);
  assert.equal((await request(`/api/work/appeals/${ID}`)).status, 404);
  assert.equal((await post(`/api/work/sessions/${ID}/correct`, { startedAt: "x" })).status, 409);
  assert.equal((await request("/api/work/hours/company/acme?from=2026-11-01&to=2026-11-30")).status, 403);
  assert.equal((await request("/api/work/placements/company/acme")).status, 403);
  const listed: unknown[][] = [];
  assert.equal((await request(`/api/work/placement-requests/company/acme?status=pending&storeId=${ID}`, {}, listed)).status, 403);
  assert.deepEqual(listed[0], ["requestsFor", "person", "acme", { storeId: ID, status: "pending" }]);
  assert.equal((await request("/api/work/placement-requests/company/acme?status=open", {}, listed)).status, 400);
  assert.equal(listed.length, 1);
  assert.equal((await request("/api/work/appeals")).status, 403);
});

test("WORK_HTTP hours pages bind ranges, cursors and statuses before reaching the service", async () => {
  const calls: unknown[][] = [];
  for (const bad of ["", "?from=2026-11-01", "?from=2026-11-30&to=2026-11-01", "?from=2026-01-01&to=2027-06-01", "?from=2026-11-01&to=2026-11-30&after=nope",
    "?from=2026-11-01'--&to=2026-11-30"]) {
    assert.equal((await request(`/api/work/hours/mine${bad}`, {}, calls)).status, 400, bad);
  }
  assert.equal((await request("/api/work/hours/all?from=2026-11-01&to=2026-11-30&status=open", {}, calls)).status, 400);
  assert.equal(calls.length, 0);
  const mine = await request("/api/work/hours/mine?from=2026-11-01&to=2026-11-30", {}, calls);
  assert.deepEqual([mine.status, mine.json?.next], [200, `2026-11-18~${ID}`]);
  assert.deepEqual(calls[0], ["viewsMine", "person", { from: "2026-11-01", to: "2026-11-30" }, null]);
  const all = await request(`/api/work/hours/all?from=2026-11-01&to=2026-11-30&status=approved&after=2026-11-02~${ID}`, {}, calls);
  assert.equal(all.status, 200);
  assert.deepEqual(calls[1], ["all", "person", { from: "2026-11-01", to: "2026-11-30" }, { status: "approved", after: { workDate: "2026-11-02", id: ID } }]);
});

test("WORK_HTTP appeals and corrections pass ids from the path, never from the body", async () => {
  const calls: unknown[][] = [];
  assert.equal((await post(`/api/work/appeals/${ID.toUpperCase()}/updates`, { appealId: "other", title: "Hi", detail: "Checking" }, {}, calls)).status, 200);
  assert.deepEqual(calls[0], ["postUpdate", "person", ID.toUpperCase(), { title: "Hi", detail: "Checking" }]);
  assert.equal((await post(`/api/work/appeal-updates/${ID}/read`, {}, {}, calls)).status, 200);
  assert.equal((await post(`/api/work/appeals/${ID}/missing-time`, { startedAt: "a", endedAt: "b", reason: "r" }, {}, calls)).status, 409);
  assert.equal((await post("/api/work/appeals", { sessionId: ID, reason: "late" }, {}, calls)).status, 200);
  assert.deepEqual(calls.map((c) => c[0]), ["postUpdate", "markRead", "addMissing", "raise"]);
});
