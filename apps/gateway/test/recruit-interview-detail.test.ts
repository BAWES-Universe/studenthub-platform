import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitInterviews, handleRecruitInterviews, type RecruitInterviewsStore } from "../src/recruit/interviews-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "d".repeat(43);
const INT = "923e4567-e89b-42d3-a456-426614174000", OTHER = "823e4567-e89b-42d3-a456-426614174000";
const REQUEST = "223e4567-e89b-42d3-a456-426614174000", CARD = "323e4567-e89b-42d3-a456-426614174000";
const own = { id: INT, org_name: "Co <script>&\"'", store_name: "Store <west>", position_title: "Lead <Cook>", scheduled_at: "2026-11-18T07:30:00.000Z", duration_minutes: 45, mode: "in_person" as const, location: "Gate <3>", status: "completed" as const, outcome: "passed" as const };

function setup(options: { mine?: () => Promise<readonly (typeof own)[]>; loggedIn?: boolean } = {}) {
  const calls: string[] = [];
  const store: RecruitInterviewsStore = {
    mine: async (person) => { calls.push(`mine:${person}`); return options.mine ? options.mine() : [own]; },
    forRequest: async (person, id) => { calls.push(`forRequest:${person}:${id}`); return id === REQUEST ? { request: { id, position_title: "Role", store_name: "Store", org_name: "Co" }, interviews: [], cards: [], canWrite: false, seesInternal: false } : null; },
    schedule: async () => { calls.push("schedule"); return { kind: "scheduled", interviewId: INT }; },
    cancel: async (_person, id) => { calls.push(`cancel:${id}`); return { kind: "cancelled" }; },
    evaluate: async (_person, id) => { calls.push(`evaluate:${id}`); return { kind: "evaluated", version: 1 }; },
  };
  const sessions = { get: async (cookie: string) => options.loggedIn === false || cookie !== SESSION ? undefined : { id: cookie, personId: "person-1" } };
  return { calls, service: createRecruitInterviews({ sessions, store }) };
}

async function call(service: ReturnType<typeof createRecruitInterviews> | undefined, path: string, options: { method?: string; html?: boolean; cookie?: boolean; body?: string } = {}) {
  const req = Readable.from(options.body ? [options.body] : []) as IncomingMessage;
  req.url = path; req.method = options.method ?? "GET";
  req.headers = { accept: options.html ? "text/html" : "application/json", origin: ORIGIN, "content-type": "application/json", ...(options.cookie === false ? {} : { cookie: `__Host-studenthub_session=${SESSION}` }) };
  let status = 0, payload = "", headers: Record<string, string> = {}, page: { status: number; title: string; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number, h: Record<string, string>) { status = code; headers = h; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitInterviews(req, fake as unknown as ServerResponse, service, ORIGIN, (s, title, body) => { page = { status: s, title, body }; }, options.html ?? false);
  return { handled, status: page?.status ?? status, payload, headers, page, json: payload ? JSON.parse(payload) as unknown : undefined };
}

test("INTDET_SHOW GET renders the person's interview and returns its person view as JSON", async () => {
  const { service, calls } = setup();
  const shown = await call(service, `/recruit/interviews/${INT.toUpperCase()}`, { html: true });
  assert.equal(shown.status, 200);
  const body = shown.page!.body;
  for (const value of ["Lead &lt;Cook&gt;", "Store &lt;west&gt;", "Completed", "2026-11-18 10:30 (Kuwait)", "45 min", "In person", "Gate &lt;3&gt;", "Passed", 'href="/recruit/my-interviews"']) assert.ok(body.includes(value), `INTDET_SHOW renders ${value}`);
  assert.ok(body.includes("Co &lt;script&gt;&amp;&quot;&#39;") && !body.includes("Co <script>"), "INTDET_SHOW the company name is escaped");
  const json = await call(service, `/recruit/interviews/${INT}`);
  assert.equal(json.status, 200);
  assert.equal(json.headers["content-type"], "application/json");
  assert.deepEqual(json.json, { interview: { interviewId: INT, company: own.org_name, store: own.store_name, positionTitle: own.position_title, scheduledAt: "2026-11-18T07:30:00.000Z", kuwaitTime: "2026-11-18 10:30", durationMinutes: 45, mode: "in_person", location: own.location, status: "completed", outcome: "passed" } });
  assert.deepEqual(calls, ["mine:person-1", "mine:person-1"]);
});

test("INTDET_READONLY detail has no write controls and bare non-read methods fall through", async () => {
  const { service, calls } = setup();
  const body = (await call(service, `/recruit/interviews/${INT}`, { html: true })).page!.body;
  assert.equal(/<form|cancel|evaluate/i.test(body), false, "INTDET_READONLY the detail page has no form, cancel, or evaluate control");
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal((await call(service, `/recruit/interviews/${INT}`, { method })).handled, false, `INTDET_READONLY ${method} falls through`);
  assert.equal((await call(service, `/recruit/interviews/${INT}`, { method: "HEAD" })).status, 200);
  assert.equal(calls.filter((x) => x.startsWith("mine:")).length, 2);
});

test("INTDET_MINE absent, unknown, and malformed ids are indistinguishable and read no store but mine", async () => {
  const { service, calls } = setup();
  const paths = [OTHER, "723e4567-e89b-42d3-a456-426614174000", "not-an-id"];
  const json = await Promise.all(paths.map((id) => call(service, `/recruit/interviews/${id}`)));
  for (const response of json) { assert.equal(response.status, 404, "INTDET_MINE an unavailable id is 404"); assert.deepEqual(response.json, { error: "not_found" }); }
  assert.deepEqual(new Set(json.map((response) => response.payload)).size, 1, "INTDET_MINE JSON bodies are byte-identical");
  const pages = await Promise.all(paths.map((id) => call(service, `/recruit/interviews/${id}`, { html: true })));
  for (const response of pages) assert.equal(response.status, 404, "INTDET_MINE HTML unavailable id is 404");
  assert.equal(new Set(pages.map((response) => response.page!.body)).size, 1, "INTDET_MINE HTML bodies are byte-identical");
  assert.deepEqual(calls, ["mine:person-1", "mine:person-1", "mine:person-1", "mine:person-1"], "INTDET_MINE only valid ids read mine and no other store method");
});

test("INTDET_DENY a missing session is unauthorized in HTML and JSON", async () => {
  const { service, calls } = setup();
  const json = await call(service, `/recruit/interviews/${INT}`, { cookie: false });
  assert.deepEqual([json.status, json.json], [401, { error: "unauthorized" }]);
  const page = await call(service, `/recruit/interviews/${INT}`, { cookie: false, html: true });
  assert.deepEqual([page.status, page.page!.body], [401, ""]);
  assert.deepEqual(calls, []);
});

test("INTDET_PASSTHROUGH existing reads and action posts remain routed and unavailable detail is 503", async () => {
  const { service, calls } = setup();
  assert.equal((await call(service, "/recruit/my-interviews")).status, 200);
  assert.equal((await call(service, `/recruit/requests/${REQUEST}/interviews`)).status, 200);
  const post = { method: "POST", body: "{}" };
  assert.equal((await call(service, `/recruit/interviews/${INT}/cancel`, post)).status, 200);
  assert.equal((await call(service, `/recruit/interviews/${INT}/evaluate`, { method: "POST", body: '{"outcome":"passed"}' })).status, 200);
  assert.ok(calls.includes(`cancel:${INT}`) && calls.includes(`evaluate:${INT}`));
  assert.equal((await call(undefined, `/recruit/interviews/${INT}`)).status, 503);
  assert.equal((await call(undefined, `/recruit/interviews/${INT}`, { html: true })).status, 503);
  assert.equal((await call(undefined, `/recruit/interviews/${INT}`, { method: "POST" })).handled, false, "INTDET_PASSTHROUGH unsupported detail method falls through before availability");
});

test("INTDET_UNAVAILABLE mine failures become generic unavailable responses", async () => {
  const broken = setup({ mine: async () => { throw new Error("secret stack and another person's data"); } }).service;
  const json = await call(broken, `/recruit/interviews/${INT}`);
  assert.deepEqual([json.status, json.json], [503, { error: "recruit_unavailable" }]);
  assert.equal(json.payload.includes("secret"), false);
  const page = await call(broken, `/recruit/interviews/${INT}`, { html: true });
  assert.equal(page.status, 503);
  assert.equal(page.page!.body.includes("secret"), false);
});
