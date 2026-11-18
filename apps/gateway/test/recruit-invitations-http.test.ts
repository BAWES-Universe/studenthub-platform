import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitInvitations, handleRecruitInvitations, type RecruitInvitationsStore } from "../src/recruit/invitations-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "g".repeat(43);
const REQ = "223e4567-e89b-42d3-a456-426614174000", INV = "823e4567-e89b-42d3-a456-426614174000", CARD = "323e4567-e89b-42d3-a456-426614174000";
const calls: string[] = [];
const store: RecruitInvitationsStore = {
  invite: async (_p, r, who) => { calls.push(`invite:${r}:${who}`); return r !== REQ ? { kind: "not_found" } : who === "again" ? { kind: "duplicate", invitationId: INV } : who === "late" ? { kind: "request_not_open" } : { kind: "invited", invitationId: INV }; },
  answer: async (p, id, to) => { calls.push(`answer:${p}:${id}:${to}`); return id !== INV ? { kind: "not_found" } : to === "declined" ? { kind: "refused", status: "accepted" } : { kind: "done", status: to, cardId: to === "accepted" ? CARD : null }; },
  withdraw: async (_p, id) => { calls.push(`withdraw:${id}`); return id !== INV ? { kind: "not_found" } : { kind: "done", status: "withdrawn", cardId: null }; },
  mine: async () => [
    { id: INV, request_id: REQ, status: "sent", org_name: "Sultan <Co>", store_name: "Avenues", position_title: "Cashier <x>", position_type: "part_time", period_start: "2026-12-01", period_end: "2026-12-31", compensation_text: "3 KWD/h", pay_model: "hourly", location: null, created_at: "2026-11-17T10:00:00.000Z" },
    { id: "old", request_id: REQ, status: "declined", org_name: "Other", store_name: "Mall", position_title: "Sales", position_type: "full_time", period_start: null, period_end: null, compensation_text: "Salary", pay_model: null, location: null, created_at: "2026-11-01T10:00:00.000Z" },
  ],
  forRequest: async (_p, r) => r !== REQ ? null : [{ id: INV, person_principal_id: "p1", person_name: "Noor <b>", status: "seen", created_at: "2026-11-17T10:00:00.000Z", answered_at: null }],
};
const service = createRecruitInvitations({ sessions: { get: async (id) => (id === SESSION ? { id, personId: "me" } : undefined) }, store });

async function call(path: string, o: { body?: string; method?: string; headers?: Record<string, string>; html?: boolean } = {}) {
  const req = Readable.from(o.body ? [o.body] : []) as IncomingMessage;
  req.url = path; req.method = o.method ?? "GET";
  req.headers = { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-studenthub_session=${SESSION}`, ...o.headers };
  let status = 0, payload = "", headers: Record<string, string> = {}, page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number, h: Record<string, string>) { status = code; headers = h; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitInvitations(req, fake as unknown as ServerResponse, service, ORIGIN, (s, _t, body) => { page = { status: s, body }; }, o.html ?? false);
  return { handled, status: page?.status ?? status, headers, json: payload ? JSON.parse(payload) as unknown : undefined, page };
}
const post = (value: unknown) => ({ body: JSON.stringify(value), method: "POST" });
const form = (body = "") => ({ body, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, html: true });

test("REC4_HTTP people answer their own invitations; staff invite and withdraw; refusals reveal nothing", async () => {
  calls.length = 0;
  const mine = (await call("/recruit/invitations")).json as { invitations: { invitationId: string; canAnswer: boolean; period: unknown }[] };
  assert.deepEqual(mine.invitations.map((i) => [i.invitationId, i.canAnswer]), [[INV, true], ["old", false]]);
  assert.deepEqual((await call(`/recruit/invitations/${INV}/accept`, post({}))).json, { invitationId: INV, status: "accepted", cardId: CARD });
  assert.deepEqual((await call(`/recruit/invitations/${INV}/decline`, post({}))).json, { error: "invitation_closed", status: "accepted" });
  assert.deepEqual((await call(`/recruit/invitations/${REQ}/seen`, post({}))).json, { error: "not_found" });
  assert.deepEqual((await call(`/recruit/staff/requests/${REQ}/invitations`, post({ personId: "p1" }))).json, { invitationId: INV, created: true });
  assert.deepEqual((await call(`/recruit/staff/requests/${REQ}/invitations`, post({ personId: "again" }))).json, { invitationId: INV, created: false });
  assert.deepEqual((await call(`/recruit/staff/requests/${REQ}/invitations`, post({ personId: "late" }))).json, { error: "request_not_open" });
  assert.deepEqual((await call(`/recruit/staff/requests/${REQ}/invitations`, post({ personId: "p1", extra: 1 }))).json, { error: "invalid_request" });
  assert.deepEqual((await call(`/recruit/staff/invitations/${INV}/withdraw`, post({}))).json, { invitationId: INV, status: "withdrawn" });
  assert.deepEqual((await call(`/recruit/staff/requests/${CARD}/invitations`)).json, { error: "not_found" });
  assert.deepEqual(calls, [`answer:me:${INV}:accepted`, `answer:me:${INV}:declined`, `answer:me:${REQ}:seen`, `invite:${REQ}:p1`, `invite:${REQ}:again`, `invite:${REQ}:late`, `withdraw:${INV}`]);
  calls.length = 0;
  assert.equal((await call(`/recruit/invitations/${INV}/accept`, { ...post({}), headers: { origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await call(`/recruit/invitations/${INV}/accept`, { ...post({}), headers: { cookie: "" } })).status, 401);
  assert.equal((await call(`/recruit/invitations/${INV}/accept`)).status, 404);
  assert.equal((await call("/recruit/invitations", post({}))).status, 404);
  assert.deepEqual(calls, []);
  assert.equal((await call("/recruit/invitationsx")).handled, false);
});

test("REC4_HTTP_PAGE the Invitations page shows company, store, period and pay, escaped, with answers only on open ones; forms come back", async () => {
  const page = (await call("/recruit/invitations", { html: true })).page!;
  for (const text of ["Sultan &lt;Co&gt;", "Cashier &lt;x&gt;", "2026-12-01 to 2026-12-31", "Pay: 3 KWD/h (Hourly)", "Part time", "Mark as seen", `/recruit/invitations/${INV}/accept`]) assert.ok(page.body.includes(text), text);
  assert.equal(page.body.includes("/recruit/invitations/old/accept"), false, "a declined invitation offers no answer");
  const accepted = await call(`/recruit/invitations/${INV}/accept`, form());
  assert.deepEqual([accepted.status, accepted.headers.location], [303, "/recruit/invitations"]);
  const staffPage = (await call(`/recruit/staff/requests/${REQ}/invitations`, { html: true })).page!;
  for (const text of ["Noor &lt;b&gt;", "Seen", `/recruit/staff/invitations/${INV}/withdraw`, `name="requestId" value="${REQ}"`]) assert.ok(staffPage.body.includes(text), text);
  const invited = await call(`/recruit/staff/requests/${REQ}/invitations`, form("personId=p2"));
  assert.deepEqual([invited.status, invited.headers.location], [303, `/recruit/staff/requests/${REQ}/invitations`]);
  const withdrawn = await call(`/recruit/staff/invitations/${INV}/withdraw`, form(`requestId=${REQ}`));
  assert.deepEqual([withdrawn.status, withdrawn.headers.location], [303, `/recruit/staff/requests/${REQ}/invitations`]);
  assert.equal((await call(`/recruit/invitations/${INV}/decline`, form())).page?.status, 409);
});
