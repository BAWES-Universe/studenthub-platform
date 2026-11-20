import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { handleReviewPages } from "../src/work/review-pages.js";
import type { WorkHttpServices } from "../src/work/http.js";

const SESSION = "s".repeat(43), ORIGIN = "https://studenthub.test.invalid";
const STORE = "aaaaaaaa-0000-4000-8000-000000000001", OTHER_STORE = "aaaaaaaa-0000-4000-8000-000000000002";
const S1 = "bbbbbbbb-0000-4000-8000-000000000001", S2 = "bbbbbbbb-0000-4000-8000-000000000002", S3 = "bbbbbbbb-0000-4000-8000-000000000003";
const REQ = "cccccccc-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-18T09:30:00Z");

function session(over: Record<string, unknown> = {}) {
  return { id: S1, assignmentId: "a", personId: "person-1", orgId: "co", storeId: STORE, workDate: "2026-11-18",
    startedAt: "2026-11-18T06:00:00.000Z", endedAt: "2026-11-18T08:30:00.000Z", durationSeconds: 9000, startLocation: null, endLocation: null,
    source: "timer", status: "pending", flags: [], note: null, correctsSessionId: null, decisionId: null, deletedAt: null, createdBy: "person-1", createdAt: "x", ...over };
}
const ROWS = [
  { session: session({ startLocation: { latitude: 29.3759, longitude: 47.9774 }, endLocation: { latitude: 29.37, longitude: 47.98 } }), decision: null },
  { session: session({ id: S2, status: "rejected", source: "manual" }), decision: { outcome: "rejected", reason: "late <again>", note: "private word", notePublic: false, rating: 2, decidedBy: "manager", decidedAt: "2026-11-18T10:00:00.000Z" } },
  { session: session({ id: S3, endedAt: null, durationSeconds: null }), decision: null },
];
interface World { language?: "en" | "ar"; rows?: unknown[]; entry?: unknown | null; viewRefused?: boolean; decided?: unknown; requests?: unknown[] | null; requestOutcome?: unknown }
function services(calls: unknown[][], world: World = {}): WorkHttpServices {
  const decided = world.decided ?? { kind: "decided", decisions: [], changed: 1 };
  return {
    personFor: async (id: string) => id === SESSION ? "actor" : undefined,
    language: async (personId: string) => personId === "actor" ? world.language : undefined,
    views: { all: async (...args: unknown[]) => { calls.push(["all", ...args]); return world.viewRefused ? { kind: "refused", code: "forbidden" } : { rows: world.rows ?? ROWS, totals: { approvedSeconds: 0, pendingSeconds: 0, rejectedSeconds: 0, open: 0 }, next: null }; },
      storeSession: async (...args: unknown[]) => { calls.push(["storeSession", ...args]); return world.entry === null ? undefined : world.entry ?? ROWS[1]; },
      company: async (...args: unknown[]) => { calls.push(["company", ...args]); return world.viewRefused ? { kind: "refused", code: "forbidden" } : { rows: world.rows ?? ROWS, totals: { approvedSeconds: 0, pendingSeconds: 9000, rejectedSeconds: 9000, open: 1 }, next: null }; } },
    decisions: {
      decideSessions: async (...args: unknown[]) => { calls.push(["decideSessions", ...args]); return decided; },
      undo: async (...args: unknown[]) => { calls.push(["undo", ...args]); return decided; },
    },
    placements: {
      requestsFor: async (...args: unknown[]) => { calls.push(["requestsFor", ...args]); return world.requests === null ? undefined : world.requests ?? []; },
      request: async (...args: unknown[]) => { calls.push(["request", ...args]); return world.requestOutcome ?? { kind: "requested", request: {} }; },
      decideRequest: async (...args: unknown[]) => { calls.push(["decideRequest", ...args]); return world.requestOutcome ?? { kind: "cancelled" }; },
    },
    storeNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, "Avenues <Mall>"])),
    storeInfo: async (id: string) => id === STORE ? { orgId: "co", name: "Avenues <Mall>", active: true } : undefined,
    personNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, id === "manager" ? "Mona" : "Sara <S>"])),
  } as unknown as WorkHttpServices;
}

type Opt = { acceptLanguage?: string; method?: string; body?: string; origin?: string; cookie?: string | null; contentType?: string; service?: WorkHttpServices | undefined; world?: World };
async function request(path: string, o: Opt = {}, calls: unknown[][] = []) {
  const req = Readable.from(o.body !== undefined ? [o.body] : []) as Readable & { method?: string; url?: string; headers: Record<string, string> };
  req.method = o.method ?? "GET";
  req.url = path;
  req.headers = {
    ...(o.cookie === null ? {} : { cookie: `__Host-studenthub_session=${o.cookie ?? SESSION}` }),
    ...(o.body !== undefined ? { "content-type": o.contentType ?? "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(o.body)) } : {}),
    ...(o.origin ? { origin: o.origin } : {}),
    ...(o.acceptLanguage ? { "accept-language": o.acceptLanguage } : {}),
  };
  const res = new EventEmitter() as EventEmitter & { statusCode: number; headersSent: boolean; headers: Record<string, string>; chunks: string[]; writeHead(s: number, h: Record<string, string>): void; end(v?: unknown): void; destroy(): void };
  res.statusCode = 0; res.headers = {}; res.chunks = []; res.headersSent = false;
  res.writeHead = (s, h) => { res.statusCode = s; res.headers = h; res.headersSent = true; };
  res.end = (v) => { if (v !== undefined) res.chunks.push(String(v)); };
  res.destroy = () => {};
  const svc = Object.hasOwn(o, "service") ? o.service : services(calls, o.world);
  const handled = await handleReviewPages(req as never, res as never, svc, ORIGIN, () => NOW);
  return { handled, status: res.statusCode, headers: res.headers, html: res.chunks.join("") };
}
const post = (path: string, body: string, extra: Opt = {}, calls: unknown[][] = []) => request(path, { method: "POST", origin: ORIGIN, body, ...extra }, calls);

test("WORK_REVIEW only its own paths; signed-out, switched-off and unknown-store answers", async () => {
  for (const p of ["/organization/co/workx", "/organization/co/work/undo", "/store/nope/time-approvals", `/store/${STORE}/other`, "/work/track"]) assert.equal((await request(p)).handled, false, p);
  assert.equal((await request("/organization/co/work", { cookie: null })).status, 401);
  assert.equal((await request("/organization/co/work", { service: undefined })).status, 503);
  assert.equal((await request(`/store/${OTHER_STORE}/time-approvals`)).status, 404);
  assert.equal((await request(`/store/${STORE}/assignment-changes/decide`, { method: "POST", origin: ORIGIN, body: "" })).status, 404);
  assert.equal((await request("/organization/co/work/decide")).status, 405);
});

test("WORK_REVIEW O-11 lists the company's hours with names, private notes and an undo for decided hours", async () => {
  const calls: unknown[][] = [];
  const page = await request("/organization/co/work", {}, calls);
  assert.equal(page.status, 200);
  assert.deepEqual(calls[0], ["company", "actor", "co", { from: "2026-11-01", to: "2026-11-18" }, { after: null }]);
  assert.match(page.html, new RegExp(`<input type="checkbox" name="sessionId" value="${S1}"`));
  assert.doesNotMatch(page.html, new RegExp(`name="sessionId" value="${S3}"`), "an open session can't be selected");
  assert.match(page.html, /Sara &lt;S&gt;/);
  assert.match(page.html, /Note \(only your company can see it\): private word/);
  assert.match(page.html, /Rating: 2 of 5/);
  assert.match(page.html, /by Mona/);
  assert.match(page.html, new RegExp(`<button type="submit" name="undo" value="${S2}">`));
  assert.equal(page.html.split('name="undo"').length - 1, 1);
  assert.equal(page.html.includes("<script"), false);
  assert.match(page.headers["content-security-policy"]!, /default-src 'none'/);
  const filtered: unknown[][] = [];
  await request(`/organization/co/work?from=2026-10-01&to=2026-10-31&status=approved&store=${STORE}`, {}, filtered);
  assert.deepEqual(filtered[0], ["company", "actor", "co", { from: "2026-10-01", to: "2026-10-31" }, { storeId: STORE, status: "approved", after: null }]);
  for (const bad of ["?status=open", "?from=2026-02-30", "?from=2024-01-01&to=2026-01-01", "?after=nope", "?store=x"]) assert.equal((await request(`/organization/co/work${bad}`)).status, 400, bad);
  assert.equal((await request("/organization/co/work", { world: { viewRefused: true } })).status, 403);
});

test("WORK_REVIEW M-03 is the store's queue: waiting hours by default, scoped to the store", async () => {
  const calls: unknown[][] = [];
  const page = await request(`/store/${STORE}/time-approvals`, {}, calls);
  assert.equal(page.status, 200);
  assert.deepEqual(calls[0], ["company", "actor", "co", { from: "2026-11-01", to: "2026-11-18" }, { storeId: STORE, status: "pending", after: null }]);
  assert.match(page.html, /Time approvals: Avenues &lt;Mall&gt;/);
  assert.match(page.html, new RegExp(`action="/store/${STORE}/time-approvals/decide"`));
  // Enter in the reason field uses the form's default button, the first submit button: it is disabled, so it can't undo a row or decide.
  const decideForm = page.html.slice(page.html.indexOf(`action="/store/${STORE}/time-approvals/decide"`));
  assert.match(decideForm, /^[^>]*><button type="submit" disabled hidden aria-hidden="true" tabindex="-1"><\/button>/);
  assert.ok(decideForm.indexOf('name="undo"') > decideForm.indexOf("disabled hidden"));
  // D-WK1: the approver sees both places, start and stop, and a session without them shows none.
  assert.match(page.html, /Started at <a href="https:\/\/www\.openstreetmap\.org\/\?mlat=29\.37590&amp;mlon=47\.97740#map=17\/29\.37590\/47\.97740" rel="noopener noreferrer" target="_blank">29\.37590, 47\.97740<\/a>, stopped at <a [^>]*>29\.37000, 47\.98000<\/a>/);
  assert.equal((page.html.match(/Started at/g) ?? []).length, 1);
  const all: unknown[][] = [];
  await request(`/store/${STORE}/time-approvals?status=&store=${OTHER_STORE}`, {}, all);
  assert.deepEqual(all[0]?.[4], { storeId: STORE, after: null }, "the path's store wins over a query store");
});

test("WORK_REVIEW a decision form past its byte limit gets 413, and a full note in a two-byte script fits", async () => {
  const note = encodeURIComponent("ع".repeat(2000));
  assert.notEqual((await post(`/store/${STORE}/time-approvals/decide`, `back=&decision=reject&note=${note}`)).status, 413);
  assert.equal((await post(`/store/${STORE}/time-approvals/decide`, `back=&note=${"x".repeat(70 * 1024)}`)).status, 413);
});

test("WORK_REVIEW decisions: same origin, selected sessions, the decision fields, and back to the same filters", async () => {
  const calls: unknown[][] = [];
  const back = encodeURIComponent("/organization/co/work?from=2026-10-01&to=2026-10-31&status=pending");
  const body = `back=${back}&sessionId=${S1}&sessionId=${S2}&reason=late&note=n&notePublic=on&rating=3&action=reject`;
  assert.equal((await post("/organization/co/work/decide", body, { origin: "https://evil.invalid" }, calls)).status, 403);
  assert.equal((await post("/organization/co/work/decide", `${body}&orgId=other`, {}, calls)).status, 400);
  assert.equal((await post("/organization/co/work/decide", `${body}&reason=again`, {}, calls)).status, 400, "a field other than sessionId can't repeat");
  assert.equal((await post("/organization/co/work/decide", body, { contentType: "text/plain" }, calls)).status, 400);
  assert.equal(calls.filter((c) => c[0] === "decideSessions").length, 0);
  const charset = await post("/organization/co/work/decide", body, { contentType: " Application/x-www-form-urlencoded ; charset=utf-8" }, []);
  assert.equal(charset.status, 303, "a charset parameter and case don't refuse the form");
  const done = await post("/organization/co/work/decide", body, {}, calls);
  assert.deepEqual([done.status, done.headers.location], [303, "/organization/co/work?from=2026-10-01&to=2026-10-31&status=pending&done=decided"]);
  assert.deepEqual(calls.find((c) => c[0] === "decideSessions"), ["decideSessions", "actor", [S1, S2], { decision: "reject", reason: "late", note: "n", rating: "3", notePublic: "on" }]);
  const elsewhere = await post("/organization/co/work/decide", `back=${encodeURIComponent("https://evil.invalid/x")}&sessionId=${S1}&action=approve`);
  assert.equal(elsewhere.headers.location, "/organization/co/work?done=decided");
  const other = await post("/organization/co/work/decide", `back=${encodeURIComponent("/organization/other/work")}&sessionId=${S1}&action=approve`);
  assert.equal(other.headers.location, "/organization/co/work?done=decided");
  const undo: unknown[][] = [];
  const undone = await post(`/store/${STORE}/time-approvals/decide`, `undo=${S2}&reason=mistake`, {}, undo);
  assert.deepEqual([undone.headers.location, undo[0]], [`/store/${STORE}/time-approvals?done=undone`, ["undo", "actor", S2, "mistake"]]);
  const refused = await post("/organization/co/work/decide", `sessionId=${S3}&action=approve`, { world: { decided: { kind: "refused", code: "session_open", index: 0 } } });
  assert.equal(refused.status, 409);
  assert.match(refused.html, /role="alert"><p>Hours still in progress can&#39;t be decided yet/);
  assert.equal((await post("/organization/co/work/decide", `sessionId=${S1}&action=maybe`)).status, 400);
  assert.equal((await post("/organization/co/work/decide", `sessionId=${S1}&action=approve`, { world: { decided: { kind: "refused", code: "session_not_found" }, viewRefused: true } })).status, 403);
});

test("WORK_REVIEW M-04 lists the store's requests, asks for a person and cancels a waiting request", async () => {
  const calls: unknown[][] = [];
  const requests = [
    { id: REQ, personId: "person-1", orgId: "co", storeId: STORE, status: "pending", note: "weekends <only>", requestedBy: "actor", requestedAt: "2026-11-17T08:00:00.000Z", decidedBy: null, decidedAt: null, decisionReason: null },
    { id: "cccccccc-0000-4000-8000-000000000002", personId: "person-2", orgId: "co", storeId: STORE, status: "rejected", note: null, requestedBy: "actor", requestedAt: "2026-11-01T08:00:00.000Z", decidedBy: "staff", decidedAt: "x", decisionReason: "not available" },
  ];
  const page = await request(`/store/${STORE}/assignment-changes`, { world: { requests } }, calls);
  assert.equal(page.status, 200);
  assert.deepEqual(calls[0], ["requestsFor", "actor", "co", { storeId: STORE }]);
  assert.match(page.html, /Waiting for StudentHub/);
  assert.match(page.html, /Your note: weekends &lt;only&gt;/);
  assert.match(page.html, /Answer: not available/);
  assert.equal(page.html.split("Cancel this request").length - 1, 1);
  assert.equal((await request(`/store/${STORE}/assignment-changes`, { world: { requests: null } })).status, 403);
  const asked: unknown[][] = [];
  const sent = await post(`/store/${STORE}/assignment-changes/request`, "personId=+person-9+&note=please", {}, asked);
  assert.deepEqual([sent.headers.location, asked[0]], [`/store/${STORE}/assignment-changes?done=requested`, ["request", "actor", { personId: "person-9", storeId: STORE, note: "please" }]]);
  const cancelled: unknown[][] = [];
  const gone = await post(`/store/${STORE}/assignment-changes/cancel`, `requestId=${REQ}`, {}, cancelled);
  assert.deepEqual([gone.headers.location, cancelled[0]], [`/store/${STORE}/assignment-changes?done=cancelled`, ["decideRequest", "actor", REQ, "cancel"]]);
  const dup = await post(`/store/${STORE}/assignment-changes/request`, "personId=person-1", { world: { requests, requestOutcome: { kind: "refused", code: "duplicate_request" } } });
  assert.equal(dup.status, 409);
  assert.match(dup.html, /already a waiting request/);
  assert.equal((await post(`/store/${STORE}/assignment-changes/request`, `personId=p&storeId=${OTHER_STORE}`)).status, 400);
});

test("WORK_REVIEW A-12 work logs: staff see every company, filter by person, decide and open a correction", async () => {
  const calls: unknown[][] = [];
  const page = await request("/work/logs?person=person-1&status=", {}, calls);
  assert.equal(page.status, 200);
  assert.deepEqual(calls[0], ["all", "actor", { from: "2026-11-01", to: "2026-11-18" }, { personId: "person-1", after: null }]);
  assert.match(page.html, /action="\/work\/logs\/decide"/);
  assert.match(page.html, new RegExp(`href="/work/corrections/new\\?session=${S1}&amp;date=2026-11-18">Correct these hours`));
  assert.doesNotMatch(page.html, new RegExp(`session=${S3}`), "hours in progress can't be corrected");
  assert.equal((await request("/organization/co/work")).html.includes("Correct these hours"), false, "companies don't correct hours");
  assert.equal((await request("/work/logs", { world: { viewRefused: true } })).status, 403);
  assert.equal((await request("/work/logs?person=a%20b")).status, 400);
  const decided: unknown[][] = [];
  const done = await post("/work/logs/decide", `back=${encodeURIComponent("/work/logs?person=person-1")}&sessionId=${S1}&action=approve`, {}, decided);
  assert.equal(done.headers.location, "/work/logs?person=person-1&done=decided");
});

test("WORK_EXPORT the company screen exports these hours in detail or per person to the shared export route; the store screen has no export", async () => {
  const page = await request("/organization/co/work?from=2026-11-01&to=2026-11-18&status=approved&store=" + STORE);
  const query = `orgId=co&amp;from=2026-11-01&amp;to=2026-11-18&amp;status=approved&amp;store=${STORE}`;
  assert.ok(page.html.includes(`<form method="post" action="/exports/work-log-detailed?${query}"><button type="submit">Export each entry</button></form>`), page.html);
  assert.ok(page.html.includes(`<form method="post" action="/exports/work-log-summary?${query}"><button type="submit">Export totals per person</button></form>`));
  // No status or store chosen: they are left out of the query, not sent empty.
  assert.ok((await request("/organization/co/work?from=2026-11-01&to=2026-11-18&status=")).html.includes('action="/exports/work-log-summary?orgId=co&amp;from=2026-11-01&amp;to=2026-11-18"'));
  assert.doesNotMatch((await request(`/store/${STORE}/time-approvals`)).html, /\/exports\//);
  assert.ok((await request("/work/logs?from=2026-01-01&to=2026-11-18")).html.includes('<form method="post" action="/exports/work-assigned-history?from=2026-01-01&amp;to=2026-11-18"><button type="submit">Export who worked where (CSV)</button></form>'));
  // The old screen-local export path is gone.
  assert.equal((await post("/organization/co/work/export", "kind=summary")).handled, false);
});

test("WORK_REVIEW in Arabic: the actor's saved language, else the browser's; right to left, Kuwait dates, the same forms", async () => {
  const page = await request("/organization/co/work", { world: { language: "ar" } });
  assert.match(page.html, /<html lang="ar" dir="rtl">/);
  assert.match(page.html, /<h1>مراجعة العمل<\/h1>/);
  assert.match(page.html, /<option value="pending">بانتظار الموافقة<\/option>/);
  assert.match(page.html, /<p>تمت الموافقة 0 د · بالانتظار 2 س 30 د · مرفوضة 2 س 30 د · 1 جارية<\/p>/);
  assert.match(page.html, /<p>الأربعاء، 18 نوفمبر 2026، 09:00 إلى 11:30 \(2 س 30 د\) · Avenues &lt;Mall&gt;<\/p><p><strong>مرفوضة<\/strong> · أُدخلت متأخرة<\/p>/);
  assert.match(page.html, /<p>ملاحظة \(تراها شركتك فقط\): private word<\/p><p>التقييم: 2 من 5<\/p><p>صدر القرار في الأربعاء، 18 نوفمبر 2026 من Mona<\/p>/);
  assert.match(page.html, /<button type="submit" name="action" value="approve">الموافقة على المحدد<\/button>/);
  // A refused decision explains itself in the actor's language.
  const refused = await post("/organization/co/work/decide", `sessionId=${S1}&action=approve`, { world: { language: "ar", decided: { kind: "refused", code: "session_open" } } });
  assert.match(refused.html, /لا يمكن اتخاذ قرار بشأن ساعات ما زالت جارية\./);
  // The store screens and their tabs.
  const changes = await request(`/store/${STORE}/assignment-changes`, { world: { language: "ar", requests: [{ id: REQ, personId: "person-1", storeId: STORE, orgId: "co", status: "pending", note: null, requestedAt: "2026-11-17T10:00:00.000Z", decisionReason: null }] } });
  assert.match(changes.html, /<h1>طلبات التعيين: Avenues &lt;Mall&gt;<\/h1><\/header><nav class="p-card" aria-label="المتجر"><a href="\/store\/[^"]+\/time-approvals">اعتماد الساعات<\/a>/);
  assert.match(changes.html, /<strong>بانتظار StudentHub<\/strong> · طُلب في الثلاثاء، 17 نوفمبر 2026/);
  // A saved English preference wins over an Arabic browser; no preference follows the browser, before and after sign-in.
  assert.match((await request("/organization/co/work", { world: { language: "en" }, acceptLanguage: "ar" })).html, /<h1>Work review<\/h1>/);
  assert.match((await request("/organization/co/work", { acceptLanguage: "ar-KW,ar;q=0.9" })).html, /<h1>مراجعة العمل<\/h1>/);
  const signedOut = await request("/organization/co/work", { cookie: null, acceptLanguage: "ar" });
  assert.deepEqual([signedOut.status, /<h1>تسجيل الدخول<\/h1><p>سجّل الدخول لمراجعة الساعات\.<\/p>/.test(signedOut.html)], [401, true]);
  assert.match((await request("/work/logs", { world: { language: "ar" } })).html, /<h1>سجلات العمل<\/h1>[\s\S]*تصحيح هذه الساعات/);
});

test("WORK_REVIEW M-03 entry page: one entry from the store's queue, decided or undone in place", async () => {
  // The store's queue links each entry; the company screen doesn't.
  const queue = await request(`/store/${STORE}/time-approvals`);
  assert.match(queue.html, new RegExp(`<a href="/store/${STORE}/time-approvals/${S1}\\?date=2026-11-18">Details</a>`));
  assert.doesNotMatch((await request("/organization/co/work")).html, />Details</);

  const calls: unknown[][] = [];
  const page = await request(`/store/${STORE}/time-approvals/${S2}?date=2026-11-18`, {}, calls);
  assert.equal(page.status, 200);
  assert.deepEqual(calls[0], ["storeSession", "actor", "co", STORE, "2026-11-18", S2]);
  assert.match(page.html, /<title>Hours: Sara &lt;S&gt;/);
  assert.match(page.html, /Reason: late &lt;again&gt;/);
  assert.match(page.html, /Note \(only your company can see it\): private word/);
  assert.match(page.html, /by Mona/);
  const form = page.html.slice(page.html.indexOf(`action="/store/${STORE}/time-approvals/decide"`));
  assert.match(form, /^[^>]*><button type="submit" disabled hidden aria-hidden="true" tabindex="-1"><\/button>/);
  assert.match(form, new RegExp(`name="back" value="/store/${STORE}/time-approvals/${S2}\\?date=2026-11-18"><input type="hidden" name="sessionId" value="${S2}">`));
  assert.match(form, new RegExp(`<button type="submit" name="undo" value="${S2}">Undo this decision</button>`));
  assert.match(page.html, new RegExp(`<a href="/store/${STORE}/time-approvals">Back to time approvals</a>`));
  assert.equal(page.html.includes("<script"), false);

  // Waiting hours have no undo; hours in progress can't be decided yet.
  assert.doesNotMatch((await request(`/store/${STORE}/time-approvals/${S1}?date=2026-11-18`, { world: { entry: ROWS[0] } })).html, /name="undo"/);
  const open = await request(`/store/${STORE}/time-approvals/${S3}?date=2026-11-18`, { world: { entry: ROWS[2] } });
  assert.match(open.html, /still in progress/);
  assert.doesNotMatch(open.html, /\/decide"/);

  // Not this store's, not that day, or not the actor's: one answer. Unknown store, a post, signed out.
  assert.equal((await request(`/store/${STORE}/time-approvals/${S2}?date=2026-11-18`, { world: { entry: null } })).status, 404);
  assert.equal((await request(`/store/${OTHER_STORE}/time-approvals/${S2}?date=2026-11-18`)).status, 404);
  assert.equal((await post(`/store/${STORE}/time-approvals/${S2}?date=2026-11-18`, `sessionId=${S2}&action=approve`)).status, 405);
  assert.equal((await request(`/store/${STORE}/time-approvals/${S2}?date=2026-11-18`, { cookie: null })).status, 401);
  for (const p of [`/store/${STORE}/time-approvals/nope`, `/store/${STORE}/assignment-changes/${S2}`, `/store/${STORE}/time-approvals/${S2}/x`]) assert.equal((await request(p)).handled, false, p);
});

test("WORK_REVIEW M-03 entry page: a decision goes back to the entry; a refusal shows it again; the way back stays on it", async () => {
  const entry = `/store/${STORE}/time-approvals/${S2}?date=2026-11-18`;
  const calls: unknown[][] = [];
  const done = await post(`/store/${STORE}/time-approvals/decide`, `back=${encodeURIComponent(entry)}&sessionId=${S2}&action=approve&rating=4`, {}, calls);
  assert.deepEqual([done.status, done.headers.location], [303, `${entry}&done=decided`]);
  assert.deepEqual(calls.find((c) => c[0] === "decideSessions"), ["decideSessions", "actor", [S2], { decision: "approve", reason: undefined, note: undefined, rating: "4", notePublic: "" }]);
  const undone = await post(`/store/${STORE}/time-approvals/decide`, `back=${encodeURIComponent(entry)}&undo=${S2}`);
  assert.equal(undone.headers.location, `${entry}&done=undone`);
  assert.match((await request(`${entry}&done=decided`)).html, /Your decision was saved\./);

  const refused = await post(`/store/${STORE}/time-approvals/decide`, `back=${encodeURIComponent(entry)}&sessionId=${S2}&action=approve`, { world: { decided: { kind: "refused", code: "session_replaced" } } });
  assert.equal(refused.status, 409);
  assert.match(refused.html, /<title>Hours: Sara/);
  assert.match(refused.html, /Those hours were corrected by StudentHub/);
  // The entry is gone by the time of the refusal: the store's queue, with the same message.
  const gone = await post(`/store/${STORE}/time-approvals/decide`, `back=${encodeURIComponent(entry)}&sessionId=${S2}&action=approve`, { world: { decided: { kind: "refused", code: "session_replaced" }, entry: null } });
  assert.deepEqual([gone.status, /Time approvals: Avenues/.test(gone.html)], [409, true]);

  for (const bad of [`https://evil.invalid/store/${STORE}/time-approvals/${S2}?date=2026-11-18`, `//evil.invalid/store/${STORE}/time-approvals/${S2}?date=2026-11-18`,
    `/store/${STORE}/time-approvals/${S2}/../../../../x?date=2026-11-18`, `/store/${OTHER_STORE}/time-approvals/${S2}?date=2026-11-18`, `/store/${STORE}/time-approvals/${S2}?date=soon`,
    `/store/${STORE}/time-approvals/${S2}`]) {
    const moved = await post(`/store/${STORE}/time-approvals/decide`, `back=${encodeURIComponent(bad)}&sessionId=${S2}&action=approve`);
    assert.equal(moved.headers.location, `/store/${STORE}/time-approvals?done=decided`, bad);
  }
  // The company screen has no entry pages to go back to.
  const company = await post("/organization/co/work/decide", `back=${encodeURIComponent(`/organization/co/work/${S2}?date=2026-11-18`)}&sessionId=${S2}&action=approve`);
  assert.equal(company.headers.location, "/organization/co/work?done=decided");
});

test("WORK_REVIEW M-03 entry page in Arabic", async () => {
  const page = await request(`/store/${STORE}/time-approvals/${S2}?date=2026-11-18`, { world: { language: "ar" } });
  assert.match(page.html, /<html lang="ar" dir="rtl">/);
  assert.match(page.html, /<title>ساعات: Sara &lt;S&gt;/);
  assert.match(page.html, />موافقة<\/button> <button type="submit" name="action" value="reject">رفض<\/button>/);
  assert.match(page.html, />العودة إلى اعتماد الساعات</);
  assert.match((await request(`/store/${STORE}/time-approvals/${S2}?date=2026-11-18`, { world: { entry: null }, acceptLanguage: "ar" })).html, /الساعات غير موجودة/);
});
