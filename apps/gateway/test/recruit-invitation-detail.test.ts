import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { InvitationRow } from "../../../packages/recruit/src/index.js";
import { createRecruitInvitations, handleRecruitInvitations, type RecruitInvitationsStore } from "../src/recruit/invitations-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "s".repeat(43);
const INV = "823e4567-e89b-42d3-a456-426614174000", OTHER = "923e4567-e89b-42d3-a456-426614174000";
const row = { id: INV, request_id: "223e4567-e89b-42d3-a456-426614174000", status: "sent" as const, org_name: "Co <script>", store_name: "Store & Sons", position_title: "Role > all", position_type: "part_time", period_start: "2026-12-01", period_end: "2026-12-31", compensation_text: "5 < 6 KWD", pay_model: "hourly", location: "Kuwait & remote", created_at: "2026-11-17T10:00:00.000Z" };
let rows: InvitationRow[] = [row], throwMine = false;
const calls: string[] = [];
const store: RecruitInvitationsStore = {
  mine: async (p) => { calls.push(`mine:${p}`); if (throwMine) throw new Error("private"); return rows; },
  answer: async () => { calls.push("answer"); return { kind: "not_found" }; },
  invite: async () => { calls.push("invite"); return { kind: "not_found" }; },
  withdraw: async () => { calls.push("withdraw"); return { kind: "not_found" }; },
  forRequest: async () => { calls.push("forRequest"); return null; },
};
const sessions = { get: async (id: string) => id === SESSION ? { id, personId: "mine" } : undefined };
const service = createRecruitInvitations({ sessions, store });

async function call(path: string, o: { method?: string; html?: boolean; cookie?: string; active?: boolean } = {}) {
  const req = Readable.from([]) as IncomingMessage; req.url = path; req.method = o.method ?? "GET";
  req.headers = { accept: o.html ? "text/html" : "application/json", cookie: o.cookie ?? `__Host-studenthub_session=${SESSION}` };
  let status = 0, payload = "", page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number) { status = code; fake.headersSent = true; return fake; }, end(value?: string) { payload = value ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitInvitations(req, fake as unknown as ServerResponse, o.active === false ? undefined : service, ORIGIN, (s, _t, body) => { page = { status: s, body }; }, o.html ?? false);
  return { handled, status: page?.status ?? status, body: page?.body ?? payload, json: payload ? JSON.parse(payload) as unknown : undefined };
}

test("INVDET_SHOW a person's invitation detail renders escaped HTML and the InvitationView JSON", async () => {
  rows = [row]; calls.length = 0;
  const page = await call(`/recruit/invitations/${INV}`, { html: true });
  assert.equal(page.body.includes("Co <script>"), false, "INVDET_SHOW company name is escaped");
  for (const value of ["Co &lt;script&gt;", "Store &amp; Sons", "Role &gt; all", "Part time", "2026-12-01 to 2026-12-31", "Kuwait &amp; remote", "Pay: 5 &lt; 6 KWD (Hourly)", "New", `<time datetime="2026-11-17T10:00:00.000Z">`, `href="/recruit/invitations"`]) assert.ok(page.body.includes(value), `INVDET_SHOW includes ${value}`);
  const json = await call(`/recruit/invitations/${INV.toUpperCase()}`);
  assert.equal(json.status, 200); assert.deepEqual((json.json as { invitation: { invitationId: string; canAnswer: boolean } }).invitation, { invitationId: INV, status: "sent", company: "Co <script>", store: "Store & Sons", positionTitle: "Role > all", positionType: "part_time", period: { start: "2026-12-01", end: "2026-12-31" }, pay: "5 < 6 KWD", payModel: "hourly", location: "Kuwait & remote", invitedAt: "2026-11-17T10:00:00.000Z", canAnswer: true });
  assert.deepEqual(calls, ["mine:mine", "mine:mine"]);
});

test("INVDET_ACTIONS detail offers only valid invitation actions", async () => {
  rows = [row];
  const open = (await call(`/recruit/invitations/${INV}`, { html: true })).body;
  for (const action of ["accept", "decline", "seen"]) assert.ok(open.includes(`/recruit/invitations/${INV}/${action}`), `INVDET_ACTIONS ${action} form uses the invitation id`);
  rows = [{ ...row, status: "accepted" as const }];
  const closed = (await call(`/recruit/invitations/${INV}`, { html: true })).body;
  assert.equal(closed.includes(`<form method="post" action="/recruit/invitations/`), false, "INVDET_ACTIONS closed invitation has no answer form");
});

test("INVDET_MINE missing, foreign and malformed ids are indistinguishable and read no other store method", async () => {
  rows = [row]; calls.length = 0;
  const absent = await call(`/recruit/invitations/${OTHER}`), malformed = await call("/recruit/invitations/not-an-id");
  rows = []; const foreign = await call(`/recruit/invitations/${INV}`);
  assert.deepEqual([absent.status, malformed.status, foreign.status], [404, 404, 404], "INVDET_MINE every unavailable id is 404");
  assert.equal(absent.body, malformed.body, "INVDET_MINE malformed and absent JSON bodies match"); assert.equal(absent.body, foreign.body, "INVDET_MINE foreign and absent JSON bodies match");
  rows = [row]; const h1 = await call(`/recruit/invitations/${OTHER}`, { html: true }), h2 = await call("/recruit/invitations/bad", { html: true }); rows = []; const h3 = await call(`/recruit/invitations/${INV}`, { html: true });
  assert.deepEqual([h1.status, h2.status, h3.status], [404, 404, 404], "INVDET_MINE unavailable HTML is 404");
  assert.equal(h1.body, h2.body); assert.equal(h1.body, h3.body); assert.ok(calls.every((c) => c === "mine:mine"), "INVDET_MINE reads only mine");
});

test("INVDET_DENY detail authentication, methods and subpaths retain their boundaries", async () => {
  rows = [row];
  assert.deepEqual((await call(`/recruit/invitations/${INV}`, { cookie: "" })).json, { error: "unauthorized" });
  assert.equal((await call(`/recruit/invitations/${INV}`, { cookie: "", html: true })).status, 401);
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await call(`/recruit/invitations/${INV}`, { method })).handled, false, `INVDET_DENY ${method} falls through`);
  assert.equal((await call(`/recruit/invitations/${INV}/accept`, { method: "GET" })).handled, true);
  assert.equal((await call(`/recruit/invitations/${INV}`, { method: "HEAD" })).status, 200);
});

test("INVDET_PASSTHROUGH existing paths remain matched and unavailable detail matches the list", async () => {
  assert.equal((await call("/recruit/invitations")).handled, true);
  for (const path of [`/recruit/invitations/${INV}/accept`, `/recruit/invitations/${INV}/decline`, `/recruit/invitations/${INV}/seen`, `/recruit/staff/requests/${INV}/invitations`, `/recruit/staff/invitations/${INV}/withdraw`]) assert.equal((await call(path, { method: "POST" })).handled, true, `INVDET_PASSTHROUGH ${path}`);
  assert.deepEqual((await call(`/recruit/invitations/${INV}`, { active: false })).json, { error: "recruit_unavailable" });
});

test("INVDET_UNAVAILABLE a failed mine read exposes only service unavailable", async () => {
  throwMine = true;
  try { assert.deepEqual((await call(`/recruit/invitations/${INV}`)).json, { error: "recruit_unavailable" }); assert.equal((await call(`/recruit/invitations/${INV}`, { html: true })).status, 503); }
  finally { throwMine = false; }
});
