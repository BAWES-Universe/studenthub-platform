import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitInterviews, handleRecruitInterviews, type RecruitInterviewsStore } from "../src/recruit/interviews-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "d".repeat(43);
const INT = "923e4567-e89b-42d3-a456-426614174000", OTHER = "823e4567-e89b-42d3-a456-426614174000";
const REQ = "223e4567-e89b-42d3-a456-426614174000", CARD = "323e4567-e89b-42d3-a456-426614174000";
const calls: string[] = [];
const mineRow = { id: INT, org_name: "Co <script>", store_name: "Store & Sons", position_title: "Lead > Cashier", scheduled_at: "2026-11-18T07:30:00.000Z", duration_minutes: 45, mode: "in_person" as const, location: "Gate <3> & lobby", status: "completed" as const, outcome: "passed" as const };

function store(rows = [mineRow], mineError = false): RecruitInterviewsStore {
  return {
    mine: async (person) => { calls.push(`mine:${person}`); if (mineError) throw new Error("private stack marker"); return rows; },
    schedule: async () => { calls.push("schedule"); return { kind: "not_found" }; },
    cancel: async () => { calls.push("cancel"); return { kind: "not_found" }; },
    evaluate: async () => { calls.push("evaluate"); return { kind: "not_found" }; },
    forRequest: async () => { calls.push("forRequest"); return null; },
  };
}

function service(rows = [mineRow], mineError = false) {
  return createRecruitInterviews({ sessions: { get: async (cookie: string) => cookie === SESSION ? { id: cookie, personId: "person-1" } : undefined }, store: store(rows, mineError) });
}

async function call(path: string, options: { method?: string; html?: boolean; cookie?: string; service?: ReturnType<typeof service> | undefined; body?: string } = {}) {
  const req = Readable.from(options.body ? [options.body] : []) as IncomingMessage;
  req.url = path; req.method = options.method ?? "GET";
  req.headers = { accept: options.html ? "text/html" : "application/json", cookie: options.cookie === "none" ? undefined : `__Host-studenthub_session=${options.cookie ?? SESSION}`, origin: ORIGIN, "content-type": "application/json" };
  let status = 0, payload = "", responseHeaders: Record<string, string> = {}, page: { status: number; title: string; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number, headers: Record<string, string>) { status = code; responseHeaders = headers; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const selected = Object.hasOwn(options, "service") ? options.service : service();
  const handled = await handleRecruitInterviews(req, fake as unknown as ServerResponse, selected, ORIGIN, (code, title, body) => { page = { status: code, title, body }; }, options.html ?? false);
  return { handled, status: page?.status ?? status, payload, json: payload ? JSON.parse(payload) as Record<string, unknown> : undefined, headers: responseHeaders, page };
}

test("INTDET_SHOW GET renders the owned interview and returns its person view as JSON", async () => {
  calls.length = 0;
  const shown = await call(`/recruit/interviews/${INT}`, { html: true });
  assert.equal(shown.status, 200);
  const body = shown.page!.body;
  for (const value of ["Lead &gt; Cashier", "Co &lt;script&gt;", "Store &amp; Sons", "Completed", "2026-11-18 10:30 (Kuwait)", "45 min", "In person", "Gate &lt;3&gt; &amp; lobby", "Passed", 'href="/recruit/my-interviews"']) assert.ok(body.includes(value), `INTDET_SHOW renders escaped ${value}`);
  for (const unsafe of ["Co <script>", "Store & Sons", "Lead > Cashier", "Gate <3> & lobby"]) assert.equal(body.includes(unsafe), false, `INTDET_SHOW escapes ${unsafe}`);
  assert.deepEqual(calls, ["mine:person-1"], "INTDET_SHOW reads mine only");
  const json = await call(`/recruit/interviews/${INT}`);
  assert.equal(json.status, 200);
  assert.equal(json.headers["content-type"], "application/json");
  assert.deepEqual(json.json, { interview: { interviewId: INT, company: "Co <script>", store: "Store & Sons", positionTitle: "Lead > Cashier", scheduledAt: "2026-11-18T07:30:00.000Z", kuwaitTime: "2026-11-18 10:30", durationMinutes: 45, mode: "in_person", location: "Gate <3> & lobby", status: "completed", outcome: "passed" } });
});

test("INTDET_READONLY detail is read-only and action paths retain their existing handlers", async () => {
  const page = (await call(`/recruit/interviews/${INT}`, { html: true })).page!.body;
  assert.equal(/<form\b|cancel|evaluate/i.test(page), false, "INTDET_READONLY has no form, cancel, or evaluate control");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await call(`/recruit/interviews/${INT}`, { method })).handled, false, `INTDET_READONLY ${method} falls through`);
  calls.length = 0;
  assert.equal((await call(`/recruit/interviews/${INT}/cancel`, { method: "POST", body: "{}" })).handled, true);
  assert.deepEqual(calls, ["cancel"], "INTDET_READONLY cancel action is unchanged");
  calls.length = 0;
  assert.equal((await call(`/recruit/interviews/${INT}/evaluate`, { method: "POST", body: "{}" })).handled, true);
  assert.deepEqual(calls, [], "INTDET_READONLY invalid evaluation remains rejected before its store call");
});

test("INTDET_MINE absent, unknown, and malformed ids are indistinguishable and use mine only", async () => {
  calls.length = 0;
  const absent = await call(`/recruit/interviews/${OTHER}`), unknown = await call("/recruit/interviews/723e4567-e89b-42d3-a456-426614174000"), malformed = await call("/recruit/interviews/not-an-id");
  assert.deepEqual([absent.status, unknown.status, malformed.status], [404, 404, 404], "INTDET_MINE every unavailable id is 404");
  assert.equal(absent.payload, unknown.payload, "INTDET_MINE absent and unknown JSON bodies match");
  assert.equal(unknown.payload, malformed.payload, "INTDET_MINE unknown and malformed JSON bodies match");
  assert.deepEqual(calls, ["mine:person-1", "mine:person-1"], "INTDET_MINE valid ids read mine and malformed ids read no store");
  const htmlBodies = await Promise.all([OTHER, "723e4567-e89b-42d3-a456-426614174000", "not-an-id"].map((id) => call(`/recruit/interviews/${id}`, { html: true })));
  assert.deepEqual(htmlBodies.map((r) => r.status), [404, 404, 404]);
  assert.equal(htmlBodies[0]!.page!.body, htmlBodies[1]!.page!.body, "INTDET_MINE absent and unknown HTML bodies match");
  assert.equal(htmlBodies[1]!.page!.body, htmlBodies[2]!.page!.body, "INTDET_MINE unknown and malformed HTML bodies match");
});

test("INTDET_DENY missing sessions receive the standard 401 answers", async () => {
  calls.length = 0;
  const json = await call(`/recruit/interviews/${INT}`, { cookie: "none" });
  const page = await call(`/recruit/interviews/${INT}`, { cookie: "none", html: true });
  assert.deepEqual([json.status, json.json, page.status, page.page!.body], [401, { error: "unauthorized" }, 401, ""]);
  assert.deepEqual(calls, [], "INTDET_DENY does not read the store");
});

test("INTDET_PASSTHROUGH existing paths and unavailable configuration keep their behavior", async () => {
  assert.equal((await call("/recruit/my-interviews")).handled, true);
  assert.equal((await call(`/recruit/requests/${REQ}/interviews`)).handled, true);
  assert.equal((await call(`/recruit/interviews/${INT}`, { method: "POST", service: undefined })).handled, false, "INTDET_PASSTHROUGH detail writes fall through before availability checks");
  const unavailable = await call(`/recruit/interviews/${INT}`, { service: undefined });
  assert.deepEqual([unavailable.handled, unavailable.status, unavailable.json], [true, 503, { error: "recruit_unavailable" }]);
  const head = await call(`/recruit/interviews/${INT}`, { method: "HEAD" });
  assert.deepEqual([head.handled, head.status], [true, 200], "INTDET_PASSTHROUGH HEAD is served");
});

test("INTDET_UNAVAILABLE mine failures return a sealed 503 response", async () => {
  const json = await call(`/recruit/interviews/${INT}`, { service: service([mineRow], true) });
  const page = await call(`/recruit/interviews/${INT}`, { service: service([mineRow], true), html: true });
  assert.deepEqual([json.status, json.json, page.status], [503, { error: "recruit_unavailable" }, 503]);
  assert.equal(json.payload.includes("private stack marker") || page.page!.body.includes("private stack marker"), false, "INTDET_UNAVAILABLE exposes no thrown data");
});
