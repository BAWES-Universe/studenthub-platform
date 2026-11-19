import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { duration, handleWorkPages, kuwaitInstant } from "../src/work/pages.js";
import type { WorkHttpServices } from "../src/work/http.js";

const SESSION = "s".repeat(43), ORIGIN = "https://studenthub.test.invalid";
const STORE = "aaaaaaaa-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-18T09:30:00Z"); // 12:30 in Kuwait

function session(over: Record<string, unknown> = {}) {
  return { id: "bbbbbbbb-0000-4000-8000-000000000001", assignmentId: "a", personId: "person", orgId: "co", storeId: STORE, workDate: "2026-11-18",
    startedAt: "2026-11-18T06:00:00.000Z", endedAt: "2026-11-18T08:30:00.000Z", durationSeconds: 9000, startLocation: null, endLocation: null,
    source: "timer", status: "pending", flags: [], note: null, correctsSessionId: null, decisionId: null, deletedAt: null, createdBy: "person", createdAt: "x", ...over };
}

const APPEAL_ID = "cccccccc-0000-4000-8000-000000000001";
function appeal(over: Record<string, unknown> = {}) {
  return { id: APPEAL_ID, sessionId: session().id, personId: "person", orgId: "co", storeId: STORE, reason: "I stayed until 9 <pm>", status: "in_progress",
    createdAt: "2026-11-18T19:00:00.000Z", updatedAt: "x", ...over };
}
interface World { failRead?: boolean; placements?: unknown[]; open?: unknown; assignment?: unknown; rows?: unknown[]; outcome?: unknown; appeals?: unknown[]; detail?: unknown; raised?: unknown; pages?: unknown[][] }
function services(calls: unknown[][], world: World = {}): WorkHttpServices {
  const rows = world.rows ?? [];
  const totals = { approvedSeconds: 3600, pendingSeconds: 9000, rejectedSeconds: 0, open: 0 };
  const result = world.outcome ?? { kind: "started", session: session() };
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return result; };
  return {
    personFor: async (id: string) => id === SESSION ? "person" : undefined,
    placements: { mine: async (...args: unknown[]) => { calls.push(["placementsMine", ...args]); return world.placements ?? []; } },
    sessions: { today: async () => ({ open: world.open ?? null, assignment: world.assignment ?? null }), start: record("start"), stop: record("stop"), discard: record("discard"), addManual: record("addManual") },
    views: { mineSession: async (...args: unknown[]) => {
      calls.push(["mineSession", ...args]);
      const all = (world.pages ? world.pages.flat() : rows) as { session: { id: string; workDate: string } }[];
      return all.find((r) => r.session.id === args[2] && r.session.workDate === args[1]);
    }, mine: async (...args: unknown[]) => {
      calls.push(["mine", ...args]);
      if (!world.pages) return { rows, totals, next: null };
      const at = args[2] === null ? 0 : Number((args[2] as { id: string }).id.slice(-12));
      return { rows: world.pages[at], totals, next: at + 1 < world.pages.length ? { workDate: "2026-11-18", id: `00000000-0000-4000-8000-${String(at + 1).padStart(12, "0")}` } : null };
    } },
    appeals: {
      mine: async (...args: unknown[]) => { calls.push(["appealsMine", ...args]); return world.appeals ?? []; },
      detail: async (...args: unknown[]) => { calls.push(["detail", ...args]); return world.detail ?? { kind: "refused", code: "appeal_not_found" }; },
      markRead: async (...args: unknown[]) => { calls.push(["markRead", ...args]); if (world.failRead) throw new Error("receipt store down"); return { kind: "read" }; },
      raise: async (...args: unknown[]) => { calls.push(["raise", ...args]); return world.raised ?? { kind: "raised", appeal: appeal() }; },
    },
    storeNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, "Avenues <Mall>"])),
  } as unknown as WorkHttpServices;
}

type Opt = { method?: string; body?: string; origin?: string; cookie?: string | null; contentType?: string; service?: WorkHttpServices | undefined; world?: World };
async function request(path: string, o: Opt = {}, calls: unknown[][] = []) {
  const req = Readable.from(o.body !== undefined ? [o.body] : []) as Readable & { method?: string; url?: string; headers: Record<string, string> };
  req.method = o.method ?? "GET";
  req.url = path;
  req.headers = {
    ...(o.cookie === null ? {} : { cookie: `__Host-studenthub_session=${o.cookie ?? SESSION}` }),
    ...(o.body !== undefined ? { "content-type": o.contentType ?? "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(o.body)) } : {}),
    ...(o.origin ? { origin: o.origin } : {}),
  };
  const res = new EventEmitter() as EventEmitter & { statusCode: number; headersSent: boolean; headers: Record<string, string>; chunks: string[]; writeHead(s: number, h: Record<string, string>): void; end(v?: unknown): void; destroy(): void };
  res.statusCode = 0; res.headers = {}; res.chunks = []; res.headersSent = false;
  res.writeHead = (s, h) => { res.statusCode = s; res.headers = h; res.headersSent = true; };
  res.end = (v) => { if (v !== undefined) res.chunks.push(String(v)); };
  res.destroy = () => {};
  const svc = Object.hasOwn(o, "service") ? o.service : services(calls, o.world);
  const handled = await handleWorkPages(req as never, res as never, svc, ORIGIN, svc?.storeNames, () => NOW);
  return { handled, status: res.statusCode, headers: res.headers, html: res.chunks.join("") };
}
const post = (path: string, body: string, extra: Opt = {}, calls: unknown[][] = []) => request(path, { method: "POST", origin: ORIGIN, body, ...extra }, calls);

test("WORK_PAGES only the person's work paths; signed-out and switched-off answers", async () => {
  assert.equal((await request("/work/assignmentx")).handled, false);
  assert.equal((await request("/work/assignment/not-a-uuid")).handled, false);
  assert.equal((await request("/work/appeals/not-a-uuid")).handled, false);
  assert.equal((await request("/api/work/today")).handled, false);
  assert.equal((await request("/work/trackx")).handled, false);
  assert.equal((await request("/work/track", { cookie: null })).status, 401);
  assert.equal((await request("/work/track", { service: undefined })).status, 503);
  assert.equal((await request("/work/history/2026-11-18", { method: "POST", origin: ORIGIN, body: "" })).status, 405);
});

test("WORK_PAGES Track shows the right state, and the only script runs under the page's nonce", async () => {
  const open = await request("/work/track", { world: { open: session({ endedAt: null, durationSeconds: null }) } });
  assert.equal(open.status, 200);
  assert.match(open.html, /You're clocked in/);
  assert.match(open.html, /Since 09:00 at Avenues &lt;Mall&gt; \(3h 30m so far\)/);
  assert.match(open.html, /action="\/work\/track\/stop" data-location><input type="hidden" name="sessionId" value="bbbbbbbb-/);
  assert.match(open.html, /action="\/work\/track\/discard"><input type="hidden" name="sessionId" value="bbbbbbbb-/);
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(open.headers["content-security-policy"]!)?.[1];
  assert.ok(nonce);
  assert.equal(open.html.split("<script").length - 1, 1);
  assert.match(open.html, new RegExp(`<script nonce="${nonce}">`));
  assert.equal(open.headers["cache-control"], "no-store");
  const placed = await request("/work/track", { world: { assignment: { storeId: STORE } } });
  assert.match(placed.html, /action="\/work\/track\/start" data-location/);
  const none = await request("/work/track");
  assert.match(none.html, /aren't placed at a store today/);
  assert.doesNotMatch(none.html, /\/work\/track\/start/);
  assert.match(none.html, /action="\/work\/track\/manual"/);
  assert.match((await request("/work/track?done=stopped")).html, /You&#39;re clocked out/);
  assert.doesNotMatch((await request("/work/track?done=<b>")).html, /<b>/);
});

test("WORK_PAGES writes need the same origin and a form; the person comes from the session", async () => {
  const calls: unknown[][] = [];
  assert.equal((await post("/work/track/start", "latitude=29.3&longitude=47.9", { origin: "https://evil.invalid" }, calls)).status, 403);
  assert.equal((await post("/work/track/start", "latitude=29.3&longitude=47.9", { cookie: null }, calls)).status, 401);
  assert.equal((await post("/work/track/start", "latitude=29.3&longitude=47.9&personId=x", {}, calls)).status, 400);
  assert.equal((await post("/work/track/start", "{}", { contentType: "application/json" }, calls)).status, 400);
  assert.equal((await post("/work/track/start", "latitude=29.3&longitude=47.9", { contentType: "application/x-www-form-urlencodedx" }, calls)).status, 400);
  assert.equal(calls.length, 0);
  // A browser or proxy may add a charset or change case; the media type is what counts.
  for (const contentType of ["application/x-www-form-urlencoded; charset=UTF-8", "Application/X-WWW-Form-URLEncoded"]) {
    const ok = await post("/work/track/start", "latitude=29.3&longitude=47.9", { contentType }, []);
    assert.equal(ok.status, 303, contentType);
  }
  const started = await post("/work/track/start", "latitude=29.3&longitude=47.9", {}, calls);
  assert.deepEqual([started.status, started.headers.location], [303, "/work/track?done=started"]);
  assert.deepEqual(calls[0], ["start", "person", { latitude: 29.3, longitude: 47.9 }]);
  // Stop and discard name the session the page showed, so a stale tab can't act on a newer one.
  await post("/work/track/stop", `sessionId=${STORE}&latitude=&longitude=`, {}, calls);
  assert.deepEqual(calls[1], ["stop", "person", STORE, undefined]);
  await post("/work/track/discard", `sessionId=${STORE}`, {}, calls);
  assert.deepEqual(calls[2], ["discard", "person", STORE]);
  const changed = await post("/work/track/discard", `sessionId=${STORE}`, { world: { outcome: { kind: "refused", code: "session_changed" } } });
  assert.equal(changed.status, 409);
  assert.match(changed.html, /changed in another tab or device/);
});

test("WORK_PAGES refusals re-render Track with a plain message; manual times are Kuwait time", async () => {
  const refused = await post("/work/track/start", "latitude=&longitude=", { world: { outcome: { kind: "refused", code: "location_required" } } });
  assert.equal(refused.status, 400);
  assert.match(refused.html, /role="alert"><p>We need your location/);
  assert.equal((await post("/work/track/stop", "latitude=1&longitude=1", { world: { outcome: { kind: "refused", code: "not_working" } } })).status, 409);
  const calls: unknown[][] = [];
  const added = await post("/work/track/manual", "startedAt=2026-11-17T09%3A00&endedAt=2026-11-17T13%3A15&note=forgot", { world: { outcome: { kind: "added", session: session() } } }, calls);
  assert.deepEqual([added.status, added.headers.location], [303, "/work/track?done=added"]);
  assert.deepEqual(calls[0], ["addManual", "person", { startedAt: "2026-11-17T09:00:00+03:00", endedAt: "2026-11-17T13:15:00+03:00", note: "forgot" }]);
  assert.equal((await post("/work/track/manual", "startedAt=2026-11-17T09%3A00Z&endedAt=2026-11-17T13%3A15", {}, calls)).status, 400);
  assert.equal(calls.length, 1);
  assert.equal(kuwaitInstant("2026-11-17 09:00"), undefined);
  assert.equal(kuwaitInstant("2026-11-17T09:00:30"), "2026-11-17T09:00:30+03:00");
  assert.equal(kuwaitInstant("2026-11-17T09:00:3"), undefined);
  assert.equal(kuwaitInstant("2026-11-17T09:00:30.9"), "2026-11-17T09:00:30.9+03:00");
  assert.equal(kuwaitInstant("2026-11-17T09:00:30.1234"), undefined);
  assert.deepEqual([duration(59), duration(3600), duration(5400)], ["0m", "1h", "1h 30m"]);
});

test("WORK_PAGES History lists the month by day and a day shows each decision the person may see", async () => {
  const calls: unknown[][] = [];
  const rows = [
    { session: session(), decision: null },
    { session: session({ id: "bbbbbbbb-0000-4000-8000-000000000002", workDate: "2026-11-17", status: "rejected", source: "manual" }), decision: { outcome: "rejected", reason: "late <again>", note: "see manager", decidedAt: "x" } },
  ];
  const month = await request("/work/history", { world: { rows } }, calls);
  assert.equal(month.status, 200);
  assert.deepEqual(calls[0]?.slice(0, 3), ["mine", "person", { from: "2026-11-01", to: "2026-11-30" }]);
  assert.match(month.html, /November 2026/);
  assert.match(month.html, /href="\/work\/history\/2026-11-18">Wednesday, 18 November 2026<\/a>: 1 session, 2h 30m waiting/);
  assert.ok(month.html.indexOf("2026-11-18\"") < month.html.indexOf("2026-11-17\""));
  assert.doesNotMatch(month.html, /Next month/);
  assert.match((await request("/work/history?month=2026-10", { world: { rows: [] } })).html, /No hours logged in October 2026[\s\S]*Next month/);
  for (const bad of ["2026-13", "2026-12", "26-11", "2026-11'"]) assert.equal((await request(`/work/history?month=${bad}`)).status, 400, bad);
  const day = await request("/work/history/2026-11-17", { world: { rows: [rows[1]] } }, calls);
  assert.match(day.html, /Avenues &lt;Mall&gt; · <strong>Rejected<\/strong> · entered late/);
  assert.match(day.html, /Reason: late &lt;again&gt;/);
  assert.match(day.html, /Note: see manager/);
  assert.equal((await request("/work/history/2026-02-30")).status, 404);
});

test("WORK_PAGES a day and a new appeal follow every page of that day, so no session is dropped", async () => {
  const calls: unknown[][] = [];
  const later = session({ id: "bbbbbbbb-0000-4000-8000-000000000007", status: "rejected" });
  const pages = [[{ session: session(), decision: null }], [{ session: later, decision: null }]];
  const day = await request("/work/history/2026-11-18", { world: { pages } }, calls);
  assert.equal(day.html.split("Appeal these hours").length - 1, 1);
  assert.deepEqual(calls.filter((c) => c[0] === "mine").map((c) => c[3]), [null, { workDate: "2026-11-18", id: "00000000-0000-4000-8000-000000000001" }]);
  assert.doesNotMatch(day.html, /Later sessions on this day/);
  const form = await request(`/work/appeals/new?session=${later.id}&date=2026-11-18`, { world: { pages } });
  assert.match(form.html, new RegExp(`name="sessionId" value="${later.id}"`));
});

test("WORK_PAGES a day past the page cap continues on a later screen, and a session there can still be appealed", async () => {
  const last = session({ id: "bbbbbbbb-0000-4000-8000-000000000006", status: "rejected" });
  const pages = [...Array.from({ length: 20 }, () => [{ session: session(), decision: null }]), [{ session: last, decision: null }]];
  const first = await request("/work/history/2026-11-18", { world: { pages } });
  assert.doesNotMatch(first.html, /Appeal these hours/);
  const link = /href="\/work\/history\/2026-11-18\?after=([^"]+)">Later sessions on this day/.exec(first.html);
  assert.equal(link?.[1], encodeURIComponent("2026-11-18~00000000-0000-4000-8000-000000000020"));
  const rest = await request(`/work/history/2026-11-18?after=${link![1]}`, { world: { pages } });
  assert.equal(rest.html.split("Appeal these hours").length - 1, 1);
  assert.doesNotMatch(rest.html, /Later sessions on this day/);
  const calls: unknown[][] = [];
  const form = await request(`/work/appeals/new?session=${last.id}&date=2026-11-18`, { world: { pages } }, calls);
  assert.match(form.html, new RegExp(`name="sessionId" value="${last.id}"`));
  // The appeal form looks the one session up instead of reading the day's pages.
  assert.deepEqual(calls.map((c) => c[0]), ["mineSession"]);
  for (const bad of ["nope", encodeURIComponent("2026-11-17~00000000-0000-4000-8000-000000000020")]) assert.equal((await request(`/work/history/2026-11-18?after=${bad}`)).status, 400, bad);
});

test("WORK_PAGES appeals: raised from a day's closed session, listed, and opened by their owner only", async () => {
  const calls: unknown[][] = [];
  const closed = session({ status: "rejected" });
  const day = await request("/work/history/2026-11-18", { world: { rows: [{ session: closed, decision: null }, { session: session({ id: "bbbbbbbb-0000-4000-8000-000000000008" }), decision: null },
    { session: session({ id: "bbbbbbbb-0000-4000-8000-000000000009", endedAt: null, status: "rejected" }), decision: null }] } });
  assert.equal(day.html.split("Appeal these hours").length - 1, 1);
  const form = await request(`/work/appeals/new?session=${closed.id}&date=2026-11-18`, { world: { rows: [{ session: closed, decision: null }] } });
  assert.match(form.html, new RegExp(`name="sessionId" value="${closed.id}"`));
  assert.equal((await request(`/work/appeals/new?session=${closed.id}&date=2026-11-18`, { world: { rows: [] } })).status, 404);
  assert.equal((await request("/work/appeals/new?session=x&date=2026-11-18")).status, 404);
  const raised = await post("/work/appeals", `sessionId=${closed.id}&date=2026-11-18&reason=late`, {}, calls);
  assert.deepEqual([raised.status, raised.headers.location, calls[0]], [303, `/work/appeals/${APPEAL_ID}?done=raised`, ["raise", "person", closed.id, "late"]]);
  assert.equal((await post("/work/appeals", `sessionId=${closed.id}&date=2026-11-18&reason=late`, { origin: "https://evil.invalid" })).status, 403);
  // A long reason in a two-byte script fits the appeal form's byte limit; a body past it gets 413.
  const longReason = encodeURIComponent("ع".repeat(2000));
  assert.equal((await post("/work/appeals", `sessionId=${closed.id}&date=2026-11-18&reason=${longReason}`)).status, 303);
  assert.equal((await post("/work/appeals", `sessionId=${closed.id}&date=2026-11-18&reason=${"x".repeat(30000)}`)).status, 413);
  const empty = await post("/work/appeals", `sessionId=${closed.id}&date=2026-11-18&reason=`, { world: { rows: [{ session: closed, decision: null }], raised: { kind: "refused", code: "invalid_input" } } });
  assert.deepEqual([empty.status, /Tell us what is wrong/.test(empty.html)], [400, true]);

  const list = await request("/work/appeals", { world: { appeals: [appeal()] } });
  assert.match(list.html, new RegExp(`href="/work/appeals/${APPEAL_ID}">Raised Wednesday, 18 November 2026</a>: <strong>Being looked at</strong>. I stayed until 9 &lt;pm&gt;`));
  assert.match((await request("/work/appeals")).html, /haven't appealed any hours/);
  assert.equal((await request("/work/appeals?after=nope")).status, 400);

  const unread = { id: "dddddddd-0000-4000-8000-000000000001", appealId: APPEAL_ID, title: "Checking", detail: "Looking at the store log", authorId: "staff", createdAt: "2026-11-19T06:00:00.000Z", readAt: null };
  const read = { ...unread, id: "dddddddd-0000-4000-8000-000000000002", readAt: "2026-11-19T07:00:00.000Z" };
  const fix = session({ id: "bbbbbbbb-0000-4000-8000-000000000003", source: "correction", endedAt: "2026-11-18T18:00:00.000Z", durationSeconds: 43200 });
  const detail = { appeal: appeal(), session: closed, updates: [unread, read], entries: [fix] };
  const seen: unknown[][] = [];
  const opened = await request(`/work/appeals/${APPEAL_ID}?done=raised`, { world: { detail } }, seen);
  assert.equal(opened.status, 200);
  assert.match(opened.html, /Your appeal was sent/);
  assert.match(opened.html, /Corrected to Wednesday, 18 November 2026, 09:00 to 21:00 \(12h\)/);
  assert.match(opened.html, /<h3>Checking<\/h3><p>Looking at the store log<\/p><p>Thursday, 19 November 2026 · New<\/p>/);
  assert.deepEqual(seen.filter((c) => c[0] === "markRead"), [["markRead", "person", unread.id]]);
  // A failed read receipt never replaces the page: the reply is shown and stays new for next time.
  const failed = await request(`/work/appeals/${APPEAL_ID}`, { world: { detail, failRead: true } });
  assert.equal(failed.status, 200);
  assert.match(failed.html, /Looking at the store log<\/p><p>Thursday, 19 November 2026 · New/);
  // The service only returns someone else's appeal to staff of its company; they get the staff view, and nothing is marked read.
  const staffSeen: unknown[][] = [];
  const staffView = await request(`/work/appeals/${APPEAL_ID}`, { world: { detail: { ...detail, appeal: appeal({ personId: "someone" }) } } }, staffSeen);
  assert.equal(staffView.status, 200);
  assert.match(staffView.html, /Reply to the person/);
  assert.equal(staffSeen.filter((c) => c[0] === "markRead").length, 0);
  assert.equal((await request(`/work/appeals/${APPEAL_ID}`)).status, 404);
});

test("WORK_PAGES Placement shows where the person works now, next and before, and only their own placements open", async () => {
  const place = (id: string, startDate: string, endDate: string | null, source = "staff") => ({ id: `eeeeeeee-0000-4000-8000-00000000000${id}`, personId: "person", orgId: "co", storeId: STORE, startDate, endDate, source });
  const placements = [place("1", "2026-11-01", null), place("2", "2027-01-01", "2027-01-31"), place("3", "2026-01-01", "2026-03-31", "request")];
  const calls: unknown[][] = [];
  const page = await request("/work/assignment", { world: { placements } }, calls);
  assert.equal(page.status, 200);
  assert.deepEqual(calls[0], ["placementsMine", "person"]);
  assert.match(page.html, /Where you work now<\/h2><p><strong>Avenues &lt;Mall&gt;<\/strong><\/p><p>From Sunday, 1 November 2026, no end date<\/p>/);
  assert.match(page.html, /Coming up[\s\S]*Friday, 1 January 2027 to Sunday, 31 January 2027/);
  assert.match(page.html, /Before[\s\S]*Thursday, 1 January 2026 to Tuesday, 31 March 2026/);
  assert.match(page.html, /aria-current="page">Placement/);
  assert.match((await request("/work/assignment")).html, /aren't placed at a store right now/);
  const one = await request(`/work/assignment/${placements[2]!.id}`, { world: { placements } });
  assert.match(one.html, /Placed at the company&#39;s request/);
  assert.equal((await request("/work/assignment/eeeeeeee-0000-4000-8000-000000000009", { world: { placements } })).status, 404);
});
