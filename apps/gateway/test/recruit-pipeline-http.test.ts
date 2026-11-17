import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitPipeline, handleRecruitPipeline, type RecruitPipelineStore } from "../src/recruit/pipeline-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "d".repeat(43);
const REQ = "223e4567-e89b-42d3-a456-426614174000", CARD = "323e4567-e89b-42d3-a456-426614174000";
const calls: string[] = [];
const store: RecruitPipelineStore = {
  assign: async (_p, r, who) => { calls.push(`assign:${r}:${who}`); return r !== REQ ? { kind: "not_found" } : who === "company-person" ? { kind: "recruiter_ineligible" } : { kind: "assigned" }; },
  addCard: async (_p, r, who) => { calls.push(`add:${r}:${who}`); return r !== REQ ? { kind: "not_found" } : who === "again" ? { kind: "duplicate", cardId: CARD } : { kind: "added", cardId: CARD }; },
  move: async (_p, c, to) => { calls.push(`move:${c}:${to}`); return c !== CARD ? { kind: "not_found" } : to === "placed" ? { kind: "placement_refused", code: "work_unavailable" } : to === "suggested" ? { kind: "refused", stage: "contacted" } : { kind: "moved", stage: to }; },
  view: async (_p, r) => r !== REQ ? null : {
    request: { id: REQ, org_name: "Co", store_name: "Avenues <x>", position_title: "Cashier", headcount: 2, status: "filling", assigned_recruiter_principal_id: "rec", recruiter_name: "Rami", assigned_at: "2026-11-17T10:00:00.000Z" },
    cards: [{ id: CARD, person_principal_id: "p1", person_name: "Noor <b>", stage: "contacted", updated_at: "2026-11-17T10:00:00.000Z" }],
    events: [{ card_id: CARD, from_stage: null, to_stage: "suggested", actor_name: "Rami", at: "2026-11-17T10:00:00.000Z" }],
    canAssign: true, canMove: true, recruiters: [{ principal_id: "rec", name: "Rami" }],
  },
};
const service = createRecruitPipeline({ sessions: { get: async (id) => (id === SESSION ? { id, personId: "staff" } : undefined) }, store });

async function call(path: string, o: { body?: string; method?: string; headers?: Record<string, string>; html?: boolean } = {}) {
  const req = Readable.from(o.body ? [o.body] : []) as IncomingMessage;
  req.url = path; req.method = o.method ?? "GET";
  req.headers = { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-studenthub_session=${SESSION}`, ...o.headers };
  let status = 0, payload = "", headers: Record<string, string> = {}, page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number, h: Record<string, string>) { status = code; headers = h; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitPipeline(req, fake as unknown as ServerResponse, service, ORIGIN, (s, _t, body) => { page = { status: s, body }; }, o.html ?? false);
  return { handled, status: page?.status ?? status, headers, json: payload ? JSON.parse(payload) as unknown : undefined, page };
}
const post = (value: unknown) => ({ body: JSON.stringify(value), method: "POST" });

test("REC2_HTTP assign, add and move answer by outcome; refusals reveal nothing", async () => {
  calls.length = 0;
  assert.deepEqual((await call(`/recruit/staff/requests/${REQ}/assign`, post({ recruiterId: "rec" }))).json, { requestId: REQ, recruiterId: "rec" });
  assert.deepEqual((await call(`/recruit/staff/requests/${REQ}/assign`, post({ recruiterId: "company-person" }))).json, { error: "recruiter_ineligible" });
  assert.deepEqual((await call(`/recruit/staff/requests/${REQ}/cards`, post({ personId: "p1" }))).json, { cardId: CARD, created: true });
  assert.deepEqual((await call(`/recruit/staff/requests/${REQ}/cards`, post({ personId: "again" }))).json, { cardId: CARD, created: false });
  assert.deepEqual((await call(`/recruit/staff/cards/${CARD}/move`, post({ to: "offered" }))).json, { cardId: CARD, stage: "offered" });
  assert.deepEqual((await call(`/recruit/staff/cards/${CARD}/move`, post({ to: "suggested" }))).json, { error: "move_not_allowed", stage: "contacted" });
  assert.deepEqual((await call(`/recruit/staff/cards/${CARD}/move`, post({ to: "placed" }))).json, { error: "placement_refused", code: "work_unavailable" });
  assert.deepEqual((await call(`/recruit/staff/cards/${CARD}/move`, post({ to: "hired" }))).json, { error: "invalid_request" });
  assert.deepEqual((await call(`/recruit/staff/cards/${CARD}/move`, post({ to: "offered", extra: 1 }))).json, { error: "invalid_request" });
  const other = "423e4567-e89b-42d3-a456-426614174000";
  for (const path of [`/recruit/staff/requests/${other}/assign`, `/recruit/staff/requests/${other}/cards`]) assert.deepEqual((await call(path, post(path.endsWith("assign") ? { recruiterId: "rec" } : { personId: "p" }))).json, { error: "not_found" });
  assert.deepEqual((await call(`/recruit/staff/cards/${other}/move`, post({ to: "offered" }))).json, { error: "not_found" });
  assert.deepEqual((await call(`/recruit/staff/requests/${other}`)).json, { error: "not_found" });
  calls.length = 0;
  assert.equal((await call(`/recruit/staff/cards/${CARD}/move`, { ...post({ to: "offered" }), headers: { origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await call(`/recruit/staff/cards/${CARD}/move`, { ...post({ to: "offered" }), headers: { cookie: "" } })).status, 401);
  assert.equal((await call(`/recruit/staff/cards/${CARD}/move`)).status, 404);
  assert.deepEqual(calls, []);
  assert.equal((await call("/recruit/staff/requests")).handled, false, "the staff list belongs to the requests module");
});

test("REC2_HTTP_PAGE the staff page shows stages, names, recruiter and moves, escaped; forms return to the page", async () => {
  const page = (await call(`/recruit/staff/requests/${REQ}`, { html: true })).page!;
  assert.equal(page.status, 200);
  for (const text of ["Noor &lt;b&gt;", "Avenues &lt;x&gt;", "Recruiter: Rami", "Contacted (1)", "Placed (0)", 'value="interviewing"', `name="requestId" value="${REQ}"`]) assert.ok(page.body.includes(text), text);
  assert.equal(page.body.includes("<b>"), false);
  const moved = await call(`/recruit/staff/cards/${CARD}/move`, { body: `requestId=${REQ}&to=offered`, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, html: true });
  assert.deepEqual([moved.status, moved.headers.location], [303, `/recruit/staff/requests/${REQ}`]);
  const added = await call(`/recruit/staff/requests/${REQ}/cards`, { body: "personId=p9", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, html: true });
  assert.deepEqual([added.status, added.headers.location], [303, `/recruit/staff/requests/${REQ}`]);
  const refused = await call(`/recruit/staff/cards/${CARD}/move`, { body: `requestId=${REQ}&to=placed`, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, html: true });
  assert.equal(refused.page?.status, 409);
});
