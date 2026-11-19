import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { handleMyWorkPages, handleStaffTimePages, minutesText } from "../src/work/staff-time-pages.js";
import type { WorkHttpServices } from "../src/work/http.js";

const SESSION = "t".repeat(43), ORIGIN = "https://studenthub.test.invalid";
const NOW = new Date("2026-11-18T09:30:00Z");

interface World { forbidden?: boolean; open?: boolean; endResult?: unknown }
function services(calls: unknown[][], world: World = {}): WorkHttpServices {
  const refused = { kind: "refused", code: "forbidden" };
  const session = (over: Record<string, unknown> = {}) => ({ id: "s1", staffId: "actor", workDate: "2026-11-18", startedAt: "2026-11-18T05:00:00.000Z", endedAt: "2026-11-18T07:05:00.000Z", minutes: 125, source: "timer", ...over });
  return {
    personFor: async (id: string) => id === SESSION ? "actor" : undefined,
    personNames: async (ids: readonly string[]) => new Map(ids.filter((i) => i !== "nameless").map((i) => [i, i === "actor" ? "Huda <H>" : "Omar"])),
    staffTime: {
      today: async (...a: unknown[]) => { calls.push(["today", ...a]); return world.forbidden ? refused : { kind: "today", workDate: "2026-11-18", sessions: world.open ? [session(), session({ id: "s2", startedAt: "2026-11-18T08:00:00.000Z", endedAt: null, minutes: null })] : [session()] }; },
      start: async (...a: unknown[]) => { calls.push(["start", ...a]); return world.forbidden ? refused : { kind: "started", session: session(), already: false }; },
      end: async (...a: unknown[]) => { calls.push(["end", ...a]); return world.forbidden ? refused : world.endResult ?? { kind: "ended", session: session() }; },
      days: async (...a: unknown[]) => { calls.push(["days", ...a]); return world.forbidden ? refused : (a[1] as string) > (a[2] as string) ? { kind: "refused", code: "invalid_input" }
        : { kind: "days", days: [{ staffId: "actor", workDate: "2026-11-17", minutes: 480, sessions: 1, open: false, firstStart: "2026-11-17T05:00:00.000Z", lastEnd: "2026-11-17T13:00:00.000Z" },
          { staffId: "other", workDate: "2026-11-17", minutes: 0, sessions: 1, open: true, firstStart: "2026-11-17T06:00:00.000Z", lastEnd: null }], next: { workDate: "2026-11-17", staffId: "other" } }; },
      inactive: async (...a: unknown[]) => { calls.push(["inactive", ...a]); return world.forbidden ? refused : { kind: "inactive", workDate: a[1], staffIds: ["nameless", "other"] }; },
    },
  } as unknown as WorkHttpServices;
}

type Opt = { method?: string; body?: string; origin?: string; cookie?: string | null; service?: WorkHttpServices | undefined; world?: World; contentType?: string };
async function request(path: string, o: Opt = {}, calls: unknown[][] = []) {
  const req = Readable.from(o.body !== undefined ? [o.body] : []) as Readable & { method?: string; url?: string; headers: Record<string, string> };
  req.method = o.method ?? "GET"; req.url = path;
  req.headers = { ...(o.cookie === null ? {} : { cookie: `__Host-studenthub_session=${o.cookie ?? SESSION}` }),
    ...(o.body !== undefined ? { "content-type": o.contentType ?? "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(o.body)) } : {}), ...(o.origin ? { origin: o.origin } : {}) };
  const res = new EventEmitter() as EventEmitter & { statusCode: number; headersSent: boolean; headers: Record<string, string>; chunks: string[]; writeHead(s: number, h: Record<string, string>): void; end(v?: unknown): void; destroy(): void };
  res.statusCode = 0; res.headers = {}; res.chunks = []; res.headersSent = false;
  res.writeHead = (s, h) => { res.statusCode = s; res.headers = h; res.headersSent = true; };
  res.end = (v) => { if (v !== undefined) res.chunks.push(String(v)); };
  res.destroy = () => {};
  const svc = Object.hasOwn(o, "service") ? o.service : services(calls, o.world);
  const handled = (await handleMyWorkPages(req as never, res as never, svc, ORIGIN)) || (await handleStaffTimePages(req as never, res as never, svc, () => NOW));
  return { handled, status: res.statusCode, headers: res.headers, html: res.chunks.join("") };
}
const post = (path: string, extra: Opt = {}, calls: unknown[][] = []) => request(path, { method: "POST", origin: ORIGIN, body: "", ...extra }, calls);

test("STAFF_TIME_PAGES only their own paths; signed out, switched off and not staff", async () => {
  assert.equal(minutesText(125), "2h 05m");
  for (const p of ["/me/workx", "/me/work/pause", "/work/staff-timex", "/work/track"]) assert.equal((await request(p)).handled, false, p);
  assert.equal((await request("/me/work", { cookie: null })).status, 401);
  assert.equal((await request("/work/staff-time", { cookie: null })).status, 401);
  assert.equal((await request("/me/work", { service: undefined })).status, 503);
  assert.equal((await request("/work/staff-time", { service: undefined })).status, 503);
  assert.equal((await request("/me/work", { world: { forbidden: true } })).status, 403);
  assert.equal((await request("/work/staff-time", { world: { forbidden: true } })).status, 403);
  assert.equal((await request("/me/work/start")).status, 405);
  assert.equal((await request("/work/staff-time", { method: "POST", origin: ORIGIN, body: "" })).status, 405);
});

test("STAFF_TIME_PAGES /me/work shows today and the last 30 days, and starts or ends the day", async () => {
  const calls: unknown[][] = [];
  const idle = await request("/me/work", {}, calls);
  assert.equal(idle.status, 200);
  assert.match(idle.html, /Wednesday, 18 November 2026[\s\S]*08:00 to 10:05 \(2h 05m\)[\s\S]*Today so far: 2h 05m\.[\s\S]*action="\/me\/work\/start"/);
  assert.match(idle.html, /Last 30 days[\s\S]*Tuesday, 17 November 2026: 8h 00m/);
  assert.deepEqual(calls.find((c) => c[0] === "days"), ["days", "actor", "2026-10-20", "2026-11-18", { staffId: "actor" }]);
  const working = await request("/me/work", { world: { open: true } });
  assert.match(working.html, /action="\/me\/work\/end"><p>You started at 11:00\.<\/p>/);
  assert.match(working.html, /plus the session in progress/);
  const started = await post("/me/work/start", {}, calls);
  assert.deepEqual([started.status, started.headers.location], [303, "/me/work?done=started"]);
  const ended = await post("/me/work/end", {}, calls);
  assert.deepEqual([ended.status, ended.headers.location], [303, "/me/work?done=ended"]);
  assert.deepEqual(calls.filter((c) => c[0] === "start" || c[0] === "end"), [["start", "actor"], ["end", "actor"]]);
  assert.match((await request("/me/work?done=ended")).html, /Your day has ended\./);
  const nothing = await post("/me/work/end", { world: { endResult: { kind: "refused", code: "not_working" } } });
  assert.equal(nothing.status, 409);
  assert.match(nothing.html, /no session in progress today/);
});

test("STAFF_TIME_PAGES start and end need the same origin and an empty form", async () => {
  const calls: unknown[][] = [];
  assert.equal((await post("/me/work/start", { origin: "https://evil.invalid" }, calls)).status, 403);
  assert.equal((await post("/me/work/start", { body: "extra=1" }, calls)).status, 400);
  assert.equal((await post("/me/work/start", { contentType: "application/json" }, calls)).status, 400);
  assert.equal(calls.filter((c) => c[0] === "start").length, 0);
  assert.equal((await post("/me/work/start", { world: { forbidden: true } })).status, 403);
});

test("STAFF_TIME_PAGES /work/staff-time lists days with names, pages on, and shows who didn't start", async () => {
  const calls: unknown[][] = [];
  const page = await request("/work/staff-time?from=2026-11-01&to=2026-11-18&staff=other", {}, calls);
  assert.equal(page.status, 200);
  assert.match(page.html, /<td>Huda &lt;H&gt;<\/td><td>2026-11-17<\/td><td>08:00<\/td><td>16:00<\/td><td>8h 00m<\/td><td>Ended<\/td>/);
  assert.match(page.html, /<td>Omar<\/td><td>2026-11-17<\/td><td>09:00<\/td><td><\/td><td>0h 00m<\/td><td>Not ended<\/td>/);
  assert.match(page.html, /href="\/work\/staff-time\?from=2026-11-01&amp;to=2026-11-18&amp;staff=other&amp;inactive=2026-11-18&amp;after=2026-11-17%7Eother">More days/);
  assert.match(page.html, /Not started on Wednesday, 18 November 2026[\s\S]*<li>nameless<\/li><li>Omar<\/li>/);
  assert.ok(page.html.includes('<form method="post" action="/exports/work-staff-sessions?from=2026-11-01&amp;to=2026-11-18&amp;staff=other" class="p-card" aria-label="Export">'));
  assert.deepEqual(calls.find((c) => c[0] === "days"), ["days", "actor", "2026-11-01", "2026-11-18", { staffId: "other", after: null }]);
  assert.deepEqual(calls.find((c) => c[0] === "inactive"), ["inactive", "actor", "2026-11-18"]);
  // Defaults: this Kuwait month so far; the cursor round-trips.
  const calls2: unknown[][] = [];
  await request("/work/staff-time?after=2026-11-17~other", {}, calls2);
  assert.deepEqual(calls2.find((c) => c[0] === "days"), ["days", "actor", "2026-11-01", "2026-11-18", { after: { workDate: "2026-11-17", staffId: "other" } }]);
  assert.equal((await request("/work/staff-time?after=broken")).status, 400);
  assert.equal((await request("/work/staff-time?from=2026-11-18&to=2026-11-01")).status, 400);
});
