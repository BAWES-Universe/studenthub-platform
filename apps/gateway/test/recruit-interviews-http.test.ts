import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitInterviews, handleRecruitInterviews, type RecruitInterviewsStore } from "../src/recruit/interviews-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "k".repeat(43), STAFF = "t".repeat(43);
const REQ = "223e4567-e89b-42d3-a456-426614174000", INT = "923e4567-e89b-42d3-a456-426614174000", CARD = "323e4567-e89b-42d3-a456-426614174000";
const calls: string[] = [];
const row = { id: INT, card_id: CARD, person_name: "Noor <b>", scheduled_at: "2026-11-18T07:30:00.000Z", duration_minutes: 30, mode: "in_person" as const, location: "Gate <3>", status: "completed" as const, outcome: "passed" as const, rating: 4, shared_note: "Good <fit>", internal_note: "Staff <only>", scheduled_by_name: "Sara", evaluation_version: 2 };
const store: RecruitInterviewsStore = {
  schedule: async (p, r, f) => { calls.push(`schedule:${p}:${r}:${f.cardId}:${f.scheduledAt}:${f.durationMinutes}:${f.mode}:${f.location}`); return r !== REQ ? { kind: "not_found" } : f.mode === "video" ? { kind: "stage_refused", stage: "suggested" } : { kind: "scheduled", interviewId: INT }; },
  cancel: async (_p, id) => { calls.push(`cancel:${id}`); return id !== INT ? { kind: "not_found" } : { kind: "refused", status: "completed" }; },
  evaluate: async (p, id, f) => { calls.push(`evaluate:${p}:${id}:${f.outcome}:${f.rating}:${f.sharedNote}:${f.internalNote}`); return id !== INT ? { kind: "not_found" } : f.internalNote && p !== "staff" ? { kind: "internal_note_refused" } : { kind: "evaluated", version: 3 }; },
  forRequest: async (p, r) => r !== REQ ? null : { request: { id: REQ, position_title: "Cashier", store_name: "Avenues", org_name: "Sultan Co" }, interviews: [row], cards: [{ id: CARD, person_name: "Noor <b>", stage: "contacted" }], canWrite: p !== "reader", seesInternal: p === "staff" },
  mine: async () => [{ id: INT, org_name: "Sultan Co", store_name: "Avenues", position_title: "Cashier", scheduled_at: "2026-11-18T07:30:00.000Z", duration_minutes: 30, mode: "phone", location: null, status: "scheduled", outcome: null }],
};
const sessions = { get: async (id: string) => (id === SESSION ? { id, personId: "owner" } : id === STAFF ? { id, personId: "staff" } : undefined) };
const service = createRecruitInterviews({ sessions, store, now: () => new Date("2026-11-17T12:00:00Z") });

async function call(path: string, o: { body?: string; method?: string; headers?: Record<string, string>; html?: boolean; session?: string } = {}) {
  const req = Readable.from(o.body ? [o.body] : []) as IncomingMessage;
  req.url = path; req.method = o.method ?? "GET";
  req.headers = { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-studenthub_session=${o.session ?? SESSION}`, ...o.headers };
  let status = 0, payload = "", headers: Record<string, string> = {}, page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number, h: Record<string, string>) { status = code; headers = h; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitInterviews(req, fake as unknown as ServerResponse, service, ORIGIN, (s, _t, body) => { page = { status: s, body }; }, o.html ?? false);
  return { handled, status: page?.status ?? status, headers, json: payload ? JSON.parse(payload) as Record<string, unknown> : undefined, page };
}
const post = (value: unknown, session?: string) => ({ body: JSON.stringify(value), method: "POST", ...(session ? { session } : {}) });
const form = (body: string) => ({ body, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, html: true });

test("REC6_HTTP schedule, cancel and evaluate answer by the store's outcome; the internal note never reaches the company", async () => {
  calls.length = 0;
  assert.deepEqual((await call(`/recruit/requests/${REQ}/interviews`, post({ cardId: CARD, scheduledAt: "2026-11-18T10:30", mode: "in_person", location: "Gate 3" }))).json, { interviewId: INT });
  assert.equal(calls[0], `schedule:owner:${REQ}:${CARD}:2026-11-18T07:30:00.000Z:30:in_person:Gate 3`, "Kuwait wall-clock becomes a UTC instant");
  assert.deepEqual((await call(`/recruit/requests/${REQ}/interviews`, post({ cardId: CARD, scheduledAt: "2026-11-18T10:30", mode: "video" }))).json, { error: "stage_refused", stage: "suggested" });
  assert.equal((await call(`/recruit/requests/${REQ}/interviews`, post({ cardId: CARD, scheduledAt: "2025-01-01T10:30", mode: "phone" }))).status, 400);
  assert.equal((await call(`/recruit/requests/nope/interviews`, post({ cardId: CARD, scheduledAt: "2026-11-18T10:30", mode: "phone" }))).status, 404);
  assert.deepEqual((await call(`/recruit/interviews/${INT}/cancel`, post({}))).json, { error: "interview_closed", status: "completed" });
  assert.deepEqual((await call(`/recruit/interviews/${INT}/evaluate`, post({ outcome: "passed", rating: 4, internalNote: "x" }))).json, { error: "internal_note_refused" });
  assert.deepEqual((await call(`/recruit/interviews/${INT}/evaluate`, post({ outcome: "passed", rating: 4, internalNote: "x" }, STAFF))).json, { interviewId: INT, version: 3 });
  assert.equal((await call(`/recruit/interviews/${INT}/evaluate`, post({ outcome: "no_show", rating: 3 }))).status, 400);
  const company = (await call(`/recruit/requests/${REQ}/interviews`)).json as { interviews: Record<string, unknown>[]; seesInternal: boolean };
  assert.deepEqual([company.seesInternal, "internalNote" in company.interviews[0]!, company.interviews[0]!.kuwaitTime], [false, false, "2026-11-18 10:30"]);
  assert.equal(((await call(`/recruit/requests/${REQ}/interviews`, { session: STAFF })).json as { interviews: Record<string, unknown>[] }).interviews[0]!.internalNote, "Staff <only>");
  assert.deepEqual(Object.keys(((await call("/recruit/my-interviews")).json as { interviews: Record<string, unknown>[] }).interviews[0]!).includes("rating"), false);
  assert.equal((await call(`/recruit/requests/${REQ}/interviews`, { session: "x" })).status, 401);
  assert.equal((await call(`/recruit/requests/${REQ}/interviews`, { ...post({}), headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/recruit/my-interviews", post({}))).status, 404);
  assert.equal((await call(`/recruit/requests/${REQ}`)).handled, false);
});

test("REC6_HTTP_PAGE pages escape every value, show internal notes only to staff, and forms redirect back to the request", async () => {
  const company = (await call(`/recruit/requests/${REQ}/interviews`, { html: true })).page!.body;
  for (const text of ["Noor &lt;b&gt;", "Gate &lt;3&gt;", "Good &lt;fit&gt;", "2026-11-18 10:30 (Kuwait)", "corrected (version 2)", 'name="cardId"', "Correct the evaluation"]) assert.ok(company.includes(text), text);
  assert.equal(company.includes("Staff"), false, "no internal note or its field for the company");
  const staff = (await call(`/recruit/requests/${REQ}/interviews`, { html: true, session: STAFF })).page!.body;
  assert.ok(staff.includes("Internal: Staff &lt;only&gt;") && staff.includes('name="internalNote"'));
  const sent = await call(`/recruit/interviews/${INT}/evaluate`, form(`outcome=passed&rating=5&sharedNote=Great&internalNote=&requestId=${REQ}`));
  assert.deepEqual([sent.status, sent.headers.location], [303, `/recruit/requests/${REQ}/interviews`]);
  assert.equal((await call(`/recruit/interviews/${INT}/cancel`, form(`requestId=${REQ}`))).page!.status, 409);
  const mine = (await call("/recruit/my-interviews", { html: true })).page!.body;
  assert.ok(mine.includes("Cashier") && mine.includes("Phone") && mine.includes("2026-11-18 10:30 (Kuwait)"));
});
