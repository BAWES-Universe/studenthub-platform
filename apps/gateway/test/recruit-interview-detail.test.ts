import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitInterviews, handleRecruitInterviews, type RecruitInterviewsStore } from "../src/recruit/interviews-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "d".repeat(43);
const INT = "923e4567-e89b-42d3-a456-426614174000", OTHER = "a23e4567-e89b-42d3-a456-426614174000";
const REQ = "223e4567-e89b-42d3-a456-426614174000", CARD = "323e4567-e89b-42d3-a456-426614174000";
const interview = { id: INT, org_name: "Sultan <Co>", store_name: "Avenues & More", position_title: "Cashier <Lead>", scheduled_at: "2026-11-18T07:30:00.000Z", duration_minutes: 45, mode: "in_person" as const, location: "Gate <3>", status: "completed" as const, outcome: "passed" as const };

function setup(options: { mine?: RecruitInterviewsStore["mine"]; session?: boolean } = {}) {
  const calls: string[] = [];
  const store: RecruitInterviewsStore = {
    mine: options.mine ?? (async (person) => { calls.push(`mine:${person}`); return [interview]; }),
    forRequest: async (person, id) => { calls.push(`forRequest:${person}:${id}`); return { request: { id: REQ, position_title: "Role", store_name: "Store", org_name: "Org" }, interviews: [], cards: [], canWrite: false, seesInternal: false }; },
    schedule: async () => { calls.push("schedule"); return { kind: "not_found" }; },
    cancel: async (_person, id) => { calls.push(`cancel:${id}`); return { kind: "not_found" }; },
    evaluate: async (_person, id) => { calls.push(`evaluate:${id}`); return { kind: "not_found" }; },
  };
  const sessions = { get: async (id: string) => options.session === false ? undefined : { id, personId: "candidate" } };
  return { calls, service: createRecruitInterviews({ sessions, store }) };
}

async function call(service: ReturnType<typeof createRecruitInterviews> | undefined, path: string, options: { method?: string; html?: boolean; cookie?: boolean; body?: string } = {}) {
  const req = Readable.from(options.body ? [options.body] : []) as IncomingMessage;
  req.url = path; req.method = options.method ?? "GET";
  req.headers = { accept: options.html ? "text/html" : "application/json", "content-type": "application/json", origin: ORIGIN, cookie: options.cookie === false ? "" : `__Host-studenthub_session=${SESSION}` };
  let status = 0, payload = "", page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number) { status = code; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitInterviews(req, fake as unknown as ServerResponse, service, ORIGIN, (code, _title, body) => { page = { status: code, body }; }, options.html ?? false);
  return { handled, status: page?.status ?? status, body: page?.body ?? payload, json: payload ? JSON.parse(payload) as unknown : undefined };
}

test("INTDET_SHOW renders the selected interview safely in HTML and as PersonInterviewView JSON", async () => {
  const { service, calls } = setup();
  const shown = await call(service, `/recruit/interviews/${INT}`, { html: true });
  assert.equal(shown.status, 200);
  for (const value of ["Cashier &lt;Lead&gt;", "Sultan &lt;Co&gt;", "Avenues &amp; More", "Completed", "2026-11-18 10:30 (Kuwait)", "45 min", "In person", "Gate &lt;3&gt;", "Passed", 'href="/recruit/my-interviews"']) assert.ok(shown.body.includes(value), `INTDET_SHOW renders ${value}`);
  for (const raw of ["Cashier <Lead>", "Sultan <Co>", "Gate <3>"]) assert.equal(shown.body.includes(raw), false, `INTDET_SHOW escapes ${raw}`);
  const json = await call(service, `/recruit/interviews/${INT}`);
  assert.deepEqual(json.json, { interview: { interviewId: INT, company: "Sultan <Co>", store: "Avenues & More", positionTitle: "Cashier <Lead>", scheduledAt: "2026-11-18T07:30:00.000Z", kuwaitTime: "2026-11-18 10:30", durationMinutes: 45, mode: "in_person", location: "Gate <3>", status: "completed", outcome: "passed" } });
  assert.deepEqual(calls, ["mine:candidate", "mine:candidate"]);
});

test("INTDET_READONLY has no mutation controls and bare detail mutations fall through", async () => {
  const { service, calls } = setup();
  const shown = await call(service, `/recruit/interviews/${INT}`, { html: true });
  assert.equal(/<form|cancel|evaluate/i.test(shown.body), false, "INTDET_READONLY detail has no form, cancel or evaluate control");
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal((await call(service, `/recruit/interviews/${INT}`, { method })).handled, false, `INTDET_READONLY ${method} falls through`);
  assert.equal((await call(service, `/recruit/interviews/${INT}`, { method: "HEAD" })).status, 200, "INTDET_READONLY HEAD is served");
  assert.equal((await call(service, `/recruit/interviews/${INT}/cancel`, { method: "POST", body: "{}" })).handled, true);
  assert.equal((await call(service, `/recruit/interviews/${INT}/evaluate`, { method: "POST", body: '{"outcome":"passed"}' })).handled, true);
  assert.ok(calls.includes(`cancel:${INT}`) && calls.includes(`evaluate:${INT}`), "INTDET_READONLY existing actions remain routed");
});

test("INTDET_MINE reveals no distinction between unheld, unknown and malformed ids", async () => {
  const { service, calls } = setup();
  const unknown = "b23e4567-e89b-42d3-a456-426614174000";
  const json = await Promise.all([OTHER, unknown, "not-an-id"].map((id) => call(service, `/recruit/interviews/${id}`)));
  assert.deepEqual(json.map((r) => [r.status, r.body]), [[404, '{"error":"not_found"}'], [404, '{"error":"not_found"}'], [404, '{"error":"not_found"}']], "INTDET_MINE JSON denials are byte-identical");
  const pages = await Promise.all([OTHER, unknown, "not-an-id"].map((id) => call(service, `/recruit/interviews/${id}`, { html: true })));
  assert.deepEqual(pages.map((r) => [r.status, r.body]), pages.map(() => [404, pages[0]!.body]), "INTDET_MINE HTML denials are byte-identical");
  assert.ok(calls.every((entry) => entry === "mine:candidate"), "INTDET_MINE reads only mine");
  assert.equal(calls.length, 4, "INTDET_MINE malformed ids do not read the store");
});

test("INTDET_DENY requires a session for JSON and HTML", async () => {
  const { service, calls } = setup({ session: false });
  assert.deepEqual(await call(service, `/recruit/interviews/${INT}`), { handled: true, status: 401, body: '{"error":"unauthorized"}', json: { error: "unauthorized" } });
  const html = await call(service, `/recruit/interviews/${INT}`, { html: true, cookie: false });
  assert.deepEqual([html.status, html.body], [401, ""]);
  assert.deepEqual(calls, []);
});

test("INTDET_PASSTHROUGH preserves existing paths, method fallthrough and unavailable behavior", async () => {
  const { service, calls } = setup();
  assert.equal((await call(service, "/recruit/my-interviews")).status, 200);
  assert.equal((await call(service, `/recruit/requests/${REQ}/interviews`)).status, 200);
  assert.equal((await call(service, `/recruit/interviews/${INT}`, { method: "POST" })).handled, false);
  assert.deepEqual(calls, ["mine:candidate", `forRequest:candidate:${REQ}`]);
  assert.deepEqual((await call(undefined, `/recruit/interviews/${INT}`)).json, { error: "recruit_unavailable" });
  assert.equal((await call(undefined, `/recruit/interviews/${INT}`, { html: true })).status, 503);
});

test("INTDET_UNAVAILABLE hides mine failures in JSON and HTML", async () => {
  const { service } = setup({ mine: async () => { throw new Error("secret stack and data"); } });
  const json = await call(service, `/recruit/interviews/${INT}`);
  assert.deepEqual([json.status, json.json, json.body.includes("secret")], [503, { error: "recruit_unavailable" }, false]);
  const html = await call(service, `/recruit/interviews/${INT}`, { html: true });
  assert.equal(html.status, 503);
  assert.equal(html.body.includes("secret"), false);
});
