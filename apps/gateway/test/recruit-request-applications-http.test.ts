import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitRequestApplications, handleRecruitRequestApplications, type RecruitRequestApplicationsStore } from "../src/recruit/request-applications-http.js";
import type { OpenRequestRow } from "../../../packages/recruit/src/index.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "a".repeat(43);
const REQ = "223e4567-e89b-42d3-a456-426614174000", CLOSED = "323e4567-e89b-42d3-a456-426614174000", APP = "a23e4567-e89b-42d3-a456-426614174000", CARD = "c23e4567-e89b-42d3-a456-426614174000";
const calls: string[] = [];
const row: OpenRequestRow = { id: REQ, org_name: "Sultan <Co>", store_name: "Avenues", position_title: "Cashier <c>", description: "Day <shifts>", position_type: "part_time", compensation_text: "3 KWD <h>",
  pay_model: "hourly", period_start: "2026-12-01", period_end: "2026-12-31", location: null, status: "open", created_at: "2026-11-17T08:00:00Z", application_id: null, application_status: null };
const store: RecruitRequestApplicationsStore = {
  board: async (p, q) => { calls.push(`board:${p}:${q.q}:${q.positionType}:${q.applied}:${q.page}`); return p === "company" ? null : { requests: [row], total: 26 }; },
  openRequest: async (_p, id) => (id === REQ ? row : null),
  apply: async (p, id) => { calls.push(`apply:${p}:${id}`); return id === REQ ? { kind: "applied", applicationId: APP } : id === CLOSED ? { kind: "request_not_open" } : { kind: "not_found" }; },
  forRequest: async (p, id) => (id === REQ && p !== "stranger" ? { canDecide: p === "company", applications: [{ id: APP, person_principal_id: "noor", person_name: "Noor <n>", status: "applied", created_at: "2026-11-17T09:00:00Z", decided_at: null, card_id: null }] } : null),
  decide: async (p, id, to) => { calls.push(`decide:${p}:${id}:${to}`); return p === "company" ? { kind: "decided", status: to, cardId: to === "accepted" ? CARD : null } : { kind: "not_found" }; },
};
let who = "noor";
const service = createRecruitRequestApplications({ sessions: { get: async (id) => (id === SESSION ? { id, personId: who } : undefined) }, store });

async function call(path: string, o: { body?: string; method?: string; headers?: Record<string, string>; html?: boolean } = {}) {
  const req = Readable.from(o.body ? [o.body] : []) as IncomingMessage;
  req.url = path; req.method = o.method ?? "GET";
  req.headers = { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-studenthub_session=${SESSION}`, ...o.headers };
  let status = 0, payload = "", headers: Record<string, string> = {}, page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number, h: Record<string, string>) { status = code; headers = h; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitRequestApplications(req, fake as unknown as ServerResponse, service, ORIGIN, (s, _t, body) => { page = { status: s, body }; }, o.html ?? false);
  return { handled, status: page?.status ?? status, headers, json: payload ? JSON.parse(payload) as Record<string, unknown> : undefined, page };
}
const post = (value: unknown) => ({ body: JSON.stringify(value), method: "POST" });
const form = (body: string) => ({ body, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, html: true });

test("REC7B_HTTP people browse and apply; the company decides; strangers see nothing; posts need the origin", async () => {
  calls.length = 0; who = "noor";
  const board = (await call("/recruit/open-requests?q=cash&type=part_time&page=2")).json!;
  assert.deepEqual([board.total, board.page, board.pageSize, (board.requests as { canApply: boolean }[])[0]!.canApply], [26, 2, 25, true]);
  assert.equal(calls[0], "board:noor:cash:part_time:false:2");
  assert.equal((await call("/recruit/open-requests?gender=male")).status, 400, "no gender filter");
  who = "company";
  assert.equal((await call("/recruit/open-requests")).status, 404, "the open-request board is for candidates");
  who = "noor";
  assert.equal((await call(`/recruit/open-requests/${CLOSED}`)).status, 404);
  assert.deepEqual((await call(`/recruit/open-requests/${REQ}/apply`, post({}))).json, { applicationId: APP, created: true });
  assert.deepEqual((await call(`/recruit/open-requests/${CLOSED}/apply`, post({}))).json, { error: "request_not_open" });
  assert.equal((await call(`/recruit/open-requests/${REQ}/apply`, post({ note: "x" }))).status, 400);
  assert.equal((await call(`/recruit/open-requests/${REQ}/apply`)).status, 404, "applying is a POST");
  assert.equal((await call(`/recruit/open-requests/${REQ}/apply`, { ...post({}), headers: { origin: "https://evil.example" } })).status, 403);
  who = "stranger";
  assert.equal((await call(`/recruit/requests/${REQ}/applications`)).status, 404);
  assert.equal((await call(`/recruit/request-applications/${APP}/accept`, post({}))).status, 404);
  who = "company";
  assert.deepEqual((await call(`/recruit/requests/${REQ}/applications`)).json!.canDecide, true);
  assert.deepEqual((await call(`/recruit/request-applications/${APP}/accept`, post({}))).json, { applicationId: APP, status: "accepted", cardId: CARD });
  assert.equal((await call("/recruit/open-requestsx")).handled, false);
  assert.equal((await call(`/recruit/requests/${REQ}`)).handled, false, "the request page stays with the requests handler");
});

test("REC7B_HTTP_PAGE pages escape every value; deciders get buttons, readers do not; forms redirect back", async () => {
  who = "noor";
  const list = (await call("/recruit/open-requests?type=part_time", { html: true })).page!.body;
  for (const text of ["Cashier &lt;c&gt;", "Sultan &lt;Co&gt;", "type=part_time&amp;page=2", 'value="part_time" selected']) assert.ok(list.includes(text), text);
  const one = (await call(`/recruit/open-requests/${REQ}`, { html: true })).page!.body;
  for (const text of ["Day &lt;shifts&gt;", "3 KWD &lt;h&gt;", "(Hourly)", `action="/recruit/open-requests/${REQ}/apply"`]) assert.ok(one.includes(text), text);
  const applied = await call(`/recruit/open-requests/${REQ}/apply`, form(""));
  assert.deepEqual([applied.status, applied.headers.location], [303, `/recruit/open-requests/${REQ}`]);
  who = "company";
  const decider = (await call(`/recruit/requests/${REQ}/applications`, { html: true })).page!.body;
  assert.ok(decider.includes("Noor &lt;n&gt;") && decider.includes(`/recruit/request-applications/${APP}/accept`));
  who = "staff";
  assert.equal((await call(`/recruit/requests/${REQ}/applications`, { html: true })).page!.body.includes("/accept"), false, "staff read only");
  who = "company";
  const decided = await call(`/recruit/request-applications/${APP}/reject`, form(`requestId=${REQ}`));
  assert.deepEqual([decided.status, decided.headers.location], [303, `/recruit/requests/${REQ}/applications`]);
});
