import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { handleStaffPages } from "../src/work/staff-pages.js";
import type { WorkHttpServices } from "../src/work/http.js";

const SESSION = "s".repeat(43), ORIGIN = "https://studenthub.test.invalid";
const STORE = "aaaaaaaa-0000-4000-8000-000000000001";
const S1 = "bbbbbbbb-0000-4000-8000-000000000001", APPEAL = "cccccccc-0000-4000-8000-000000000001", REQ = "dddddddd-0000-4000-8000-000000000001";
const PLACEMENT = "eeeeeeee-0000-4000-8000-000000000001";

function session(over: Record<string, unknown> = {}) {
  return { id: S1, assignmentId: PLACEMENT, personId: "person-1", orgId: "co", storeId: STORE, workDate: "2026-11-18",
    startedAt: "2026-11-18T06:00:00.000Z", endedAt: "2026-11-18T08:30:00.000Z", durationSeconds: 9000, startLocation: null, endLocation: null,
    source: "timer", status: "rejected", flags: [], note: null, correctsSessionId: null, decisionId: null, deletedAt: null, createdBy: "person-1", createdAt: "x", ...over };
}
const appeal = { id: APPEAL, sessionId: S1, personId: "person-1", orgId: "co", storeId: STORE, reason: "I stayed <late>", status: "submitted", createdAt: "2026-11-18T19:00:00.000Z", updatedAt: "x" };
const detail = { appeal, session: session(), updates: [], entries: [] };

interface World { placements?: unknown[] | null; requests?: unknown[] | null; outcome?: unknown; appeals?: unknown; detail?: unknown; rows?: unknown[] | null }
function services(calls: unknown[][], world: World = {}): WorkHttpServices {
  const out = (name: string, fallback: unknown) => async (...args: unknown[]) => { calls.push([name, ...args]); return world.outcome ?? fallback; };
  return {
    personFor: async (id: string) => id === SESSION ? "staff" : undefined,
    placements: {
      forOrganization: async (...args: unknown[]) => { calls.push(["forOrganization", ...args]); return world.placements === null ? undefined : world.placements ?? []; },
      requestsFor: async (...args: unknown[]) => { calls.push(["requestsFor", ...args]); return world.requests === null ? undefined : world.requests ?? []; },
      place: out("place", { kind: "placed", assignment: {} }),
      setEndDate: out("setEndDate", { kind: "ended", endDate: "2026-12-31" }),
      decideRequest: out("decideRequest", { kind: "accepted", assignment: {} }),
    },
    appeals: {
      list: async (...args: unknown[]) => { calls.push(["list", ...args]); return world.appeals ?? [appeal]; },
      detail: async (...args: unknown[]) => { calls.push(["detail", ...args]); return world.detail ?? detail; },
      postUpdate: out("postUpdate", { kind: "posted", update: {} }),
      setStatus: out("setStatus", { kind: "updated", appeal }),
      addMissing: out("addMissing", { kind: "entered", session: session(), decision: {} }),
      correct: out("correct", { kind: "entered", session: session(), decision: {} }),
    },
    views: { all: async (...args: unknown[]) => { calls.push(["all", ...args]); return world.rows === null ? { kind: "refused", code: "forbidden" } : { rows: (world.rows ?? [{ session: session(), decision: null }]), totals: {}, next: null }; } },
    storeNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, "Avenues <Mall>"])),
    storesOf: async () => [{ id: STORE, name: "Avenues <Mall>" }],
    personNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, "Sara <S>"])),
  } as unknown as WorkHttpServices;
}

type Opt = { method?: string; body?: string; origin?: string; cookie?: string | null; service?: WorkHttpServices | undefined; world?: World };
async function request(path: string, o: Opt = {}, calls: unknown[][] = []) {
  const req = Readable.from(o.body !== undefined ? [o.body] : []) as Readable & { method?: string; url?: string; headers: Record<string, string> };
  req.method = o.method ?? "GET";
  req.url = path;
  req.headers = {
    ...(o.cookie === null ? {} : { cookie: `__Host-studenthub_session=${o.cookie ?? SESSION}` }),
    ...(o.body !== undefined ? { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(o.body)) } : {}),
    ...(o.origin ? { origin: o.origin } : {}),
  };
  const res = new EventEmitter() as EventEmitter & { statusCode: number; headersSent: boolean; headers: Record<string, string>; chunks: string[]; writeHead(s: number, h: Record<string, string>): void; end(v?: unknown): void; destroy(): void };
  res.statusCode = 0; res.headers = {}; res.chunks = []; res.headersSent = false;
  res.writeHead = (s, h) => { res.statusCode = s; res.headers = h; res.headersSent = true; };
  res.end = (v) => { if (v !== undefined) res.chunks.push(String(v)); };
  res.destroy = () => {};
  const svc = Object.hasOwn(o, "service") ? o.service : services(calls, o.world);
  const handled = await handleStaffPages(req as never, res as never, svc, ORIGIN);
  return { handled, status: res.statusCode, headers: res.headers, html: res.chunks.join("") };
}
const post = (path: string, body: string, extra: Opt = {}, calls: unknown[][] = []) => request(path, { method: "POST", origin: ORIGIN, body, ...extra }, calls);

test("WORK_STAFF only staff paths; the person's appeal list stays with the person's screens", async () => {
  for (const p of ["/work/appeals", "/work/appeals?as=person", `/work/appeals/${APPEAL}`, "/work/assignment", "/work/logs", "/work/assignments/x"]) assert.equal((await request(p)).handled, false, p);
  assert.equal((await request("/work/assignments", { cookie: null })).status, 401);
  assert.equal((await request("/work/assignments", { service: undefined })).status, 503);
  assert.equal((await request("/work/assignments", { method: "POST", origin: ORIGIN, body: "" })).status, 405);
});

test("WORK_STAFF A-12 placements: pick a company, see requests and placements, place, end and answer requests", async () => {
  const calls: unknown[][] = [];
  assert.match((await request("/work/assignments", {}, calls)).html, /Open a company/);
  assert.equal(calls.length, 0);
  const placements = [{ id: PLACEMENT, personId: "person-1", orgId: "co", storeId: STORE, startDate: "2026-01-01", endDate: null, warnings: ["civil_id_missing"], source: "request" }];
  const requests = [{ id: REQ, personId: "person-2", orgId: "co", storeId: STORE, status: "pending", note: "weekends", requestedBy: "owner", requestedAt: "2026-11-17T08:00:00.000Z" }];
  const page = await request("/work/assignments?org=co", { world: { placements, requests } }, calls);
  assert.equal(page.status, 200);
  assert.deepEqual(calls.slice(0, 2), [["forOrganization", "staff", "co"], ["requestsFor", "staff", "co", { status: "pending" }]]);
  assert.match(page.html, /Check: No civil ID on file/);
  assert.match(page.html, /<option value="aaaaaaaa-0000-4000-8000-000000000001">Avenues &lt;Mall&gt;<\/option>/);
  assert.match(page.html, /Accept and place/);
  assert.equal((await request("/work/assignments?org=co", { world: { placements: null } })).status, 403);
  assert.equal((await request("/work/assignments?org=a%20b")).status, 400);

  const placed: unknown[][] = [];
  const p = await post("/work/assignments/place", `org=co&personId=person-9&storeId=${STORE.toUpperCase()}&startDate=2026-12-01&endDate=&payContractId=`, {}, placed);
  assert.deepEqual([p.status, p.headers.location], [303, "/work/assignments?org=co&done=placed"]);
  assert.deepEqual(placed[0], ["place", "staff", { personId: "person-9", storeId: STORE, startDate: "2026-12-01", endDate: null }]);
  const bad: unknown[][] = [];
  assert.equal((await post("/work/assignments/place", "org=co&personId=person-9&storeId=x&startDate=2026-12-01", {}, bad)).status, 400);
  assert.equal(bad.filter((c) => c[0] === "place").length, 0);
  assert.equal((await post("/work/assignments/place", "org=co&personId=p&storeId=x&startDate=2026-12-01", { origin: "https://evil.invalid" })).status, 403);
  const ended: unknown[][] = [];
  await post("/work/assignments/end", `org=co&assignmentId=${PLACEMENT}&endDate=`, {}, ended);
  assert.deepEqual(ended[0], ["setEndDate", "staff", PLACEMENT, null]);
  const answered: unknown[][] = [];
  const a = await post("/work/assignments/request", `org=co&requestId=${REQ}&decision=accept&startDate=2026-12-01&reason=ok`, {}, answered);
  assert.deepEqual([a.headers.location, answered[0]], ["/work/assignments?org=co&done=accepted", ["decideRequest", "staff", REQ, "accept", { reason: "ok", placement: { startDate: "2026-12-01" } }]]);
  const conflict = await post("/work/assignments/end", `org=co&assignmentId=${PLACEMENT}&endDate=2026-11-01`, { world: { outcome: { kind: "refused", code: "open_session" } } });
  assert.equal(conflict.status, 409);
  assert.match(conflict.html, /clocked in there/);
});

test("WORK_STAFF A-13 appeals: staff list, replies, status, added time and corrections, all in Kuwait time", async () => {
  const calls: unknown[][] = [];
  const list = await request("/work/appeals?as=staff&status=submitted", {}, calls);
  assert.equal(list.status, 200);
  assert.deepEqual(calls[0], ["list", "staff", { status: "submitted", after: null }]);
  assert.match(list.html, new RegExp(`href="/work/appeals/${APPEAL}">Sara &lt;S&gt;</a>, raised Wednesday, 18 November 2026: <strong>New</strong>. I stayed &lt;late&gt;`));
  assert.equal((await request("/work/appeals?as=staff", { world: { appeals: { kind: "refused", code: "forbidden" } } })).status, 403);
  assert.equal((await request("/work/appeals?as=staff&after=nope")).status, 400);

  const posted: unknown[][] = [];
  const reply = await post(`/work/appeals/${APPEAL}/reply`, "title=Checking&detail=We+are+looking", {}, posted);
  assert.deepEqual([reply.headers.location, posted[0]], [`/work/appeals/${APPEAL}?done=posted`, ["postUpdate", "staff", APPEAL, { title: "Checking", detail: "We are looking" }]]);
  await post(`/work/appeals/${APPEAL}/status`, "status=resolved", {}, posted);
  assert.deepEqual(posted[1], ["setStatus", "staff", APPEAL, "resolved"]);
  await post(`/work/appeals/${APPEAL}/missing-time`, "startedAt=2026-11-18T17%3A00&endedAt=2026-11-18T21%3A00&reason=store+log", {}, posted);
  assert.deepEqual(posted[2], ["addMissing", "staff", APPEAL, { startedAt: "2026-11-18T17:00:00+03:00", endedAt: "2026-11-18T21:00:00+03:00", reason: "store log" }]);
  const refused = await post(`/work/appeals/${APPEAL}/missing-time`, "startedAt=2026-11-18T17%3A00&endedAt=2026-11-18T21%3A00&reason=x", { world: { outcome: { kind: "refused", code: "overlaps_session" } } });
  assert.equal(refused.status, 400);
  assert.match(refused.html, /overlap other hours/);
  assert.match(refused.html, /value="2026-11-18T09:00"/, "the correction form starts from the session's Kuwait times");
  const own = await post(`/work/appeals/${APPEAL}/status`, "status=resolved", { world: { outcome: { kind: "refused", code: "appeal_not_found" }, detail: { ...detail, appeal: { ...appeal, personId: "staff" } } } });
  assert.equal(own.status, 404);

  const corrected: unknown[][] = [];
  const c = await post("/work/corrections", `sessionId=${S1}&appealId=${APPEAL}&startedAt=2026-11-18T09%3A00&endedAt=2026-11-18T21%3A00&reason=store+log`, {}, corrected);
  assert.deepEqual([c.headers.location, corrected[0]], [`/work/appeals/${APPEAL}?done=entered`,
    ["correct", "staff", S1, { startedAt: "2026-11-18T09:00:00+03:00", endedAt: "2026-11-18T21:00:00+03:00", reason: "store log", appealId: APPEAL }]]);
});

test("WORK_STAFF A-13 corrections from the work logs: the form finds the session, needs a reason and keeps the date", async () => {
  const calls: unknown[][] = [];
  const form = await request(`/work/corrections/new?session=${S1}&date=2026-11-18`, {}, calls);
  assert.equal(form.status, 200);
  assert.deepEqual(calls[0], ["all", "staff", { from: "2026-11-18", to: "2026-11-18" }, { after: null }]);
  assert.match(form.html, /name="reason" required/);
  assert.match(form.html, /value="2026-11-18T11:30"/);
  assert.equal((await request(`/work/corrections/new?session=${S1}&date=2026-11-18`, { world: { rows: null } })).status, 404);
  assert.equal((await request(`/work/corrections/new?session=${S1}&date=2026-11-18`, { world: { rows: [{ session: session({ endedAt: null }), decision: null }] } })).status, 404);
  assert.equal((await request(`/work/corrections/new?session=x&date=2026-11-18`)).status, 404);
  const saved = await post("/work/corrections", `sessionId=${S1}&date=2026-11-18&startedAt=2026-11-18T09%3A00&endedAt=2026-11-18T12%3A00&reason=typo`);
  assert.equal(saved.headers.location, "/work/corrections?done=entered");
  assert.match((await request("/work/corrections?done=entered")).html, /saved and approved/);
  const noReason = await post("/work/corrections", `sessionId=${S1}&date=2026-11-18&startedAt=2026-11-18T09%3A00&endedAt=2026-11-18T12%3A00&reason=`, { world: { outcome: { kind: "refused", code: "invalid_input" } } });
  assert.equal(noReason.status, 400);
  assert.match(noReason.html, /Correct hours/);
});
