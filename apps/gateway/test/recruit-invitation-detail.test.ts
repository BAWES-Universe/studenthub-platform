import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitInvitations, handleRecruitInvitations, type RecruitInvitationsStore } from "../src/recruit/invitations-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "s".repeat(43);
const INV = "823e4567-e89b-42d3-a456-426614174000", OTHER = "923e4567-e89b-42d3-a456-426614174000";
const calls: string[] = [];
const row = (id = INV, status: "sent" | "accepted" = "sent") => ({ id, request_id: "223e4567-e89b-42d3-a456-426614174000", status, org_name: "Sultan <Co> & Sons", store_name: "Store <One>", position_title: "Cashier <lead>", position_type: "part_time", period_start: "2026-12-01", period_end: "2026-12-31", compensation_text: "3 < 4 KWD/h", pay_model: "hourly", location: "Mall & Sea", created_at: "2026-11-17T10:00:00.000Z" } as const);
let mineRows: readonly ReturnType<typeof row>[] = [row()];
let mineThrows = false;
const store: RecruitInvitationsStore = {
  mine: async (person) => { calls.push(`mine:${person}`); if (mineThrows) throw new Error("private"); return mineRows; },
  answer: async (p, id, to) => { calls.push(`answer:${p}:${id}:${to}`); return { kind: "done", status: to, cardId: null }; },
  invite: async () => { calls.push("invite"); return { kind: "not_found" }; },
  withdraw: async () => { calls.push("withdraw"); return { kind: "not_found" }; },
  forRequest: async () => { calls.push("forRequest"); return null; },
};
const sessions = { get: async (id: string) => id === SESSION ? { id, personId: "me" } : undefined };
const service = createRecruitInvitations({ sessions, store });

async function call(path: string, options: { method?: string; html?: boolean; cookie?: string; unavailable?: boolean } = {}) {
  const req = Readable.from([]) as IncomingMessage;
  req.url = path; req.method = options.method ?? "GET";
  req.headers = { accept: options.html ? "text/html" : "application/json", cookie: options.cookie ?? `__Host-studenthub_session=${SESSION}`, origin: ORIGIN };
  let status = 0, payload = "", page: { status: number; body: string } | undefined;
  const response = { headersSent: false, writeHead(code: number) { status = code; response.headersSent = true; return response; }, end(chunk?: string) { payload = chunk ?? ""; return response; }, destroy() { return response; } };
  const handled = await handleRecruitInvitations(req, response as unknown as ServerResponse, options.unavailable ? undefined : service, ORIGIN, (s, _title, body) => { page = { status: s, body }; }, options.html ?? false);
  return { handled, status: page?.status ?? status, body: page?.body ?? payload, json: payload ? JSON.parse(payload) as unknown : undefined };
}

test("INVDET_SHOW one owned invitation is rendered and returned through invitationView", async () => {
  calls.length = 0; mineRows = [row()];
  const shown = await call(`/recruit/invitations/${INV}`, { html: true });
  assert.equal(shown.status, 200);
  for (const value of ["Sultan &lt;Co&gt; &amp; Sons", "Store &lt;One&gt;", "Cashier &lt;lead&gt;", "Part time", "2026-12-01 to 2026-12-31", "Mall &amp; Sea", "Pay: 3 &lt; 4 KWD/h (Hourly)", "New", `<time datetime="2026-11-17T10:00:00.000Z">`, "href=\"/recruit/invitations\""]) assert.ok(shown.body.includes(value), `INVDET_SHOW renders escaped detail: ${value}`);
  const json = await call(`/recruit/invitations/${INV}`);
  assert.deepEqual(json.json, { invitation: { invitationId: INV, status: "sent", company: "Sultan <Co> & Sons", store: "Store <One>", positionTitle: "Cashier <lead>", positionType: "part_time", period: { start: "2026-12-01", end: "2026-12-31" }, pay: "3 < 4 KWD/h", payModel: "hourly", location: "Mall & Sea", invitedAt: "2026-11-17T10:00:00.000Z", canAnswer: true } });
  assert.deepEqual(calls, ["mine:me", "mine:me"]);
  assert.equal((await call(`/recruit/invitations/${INV}`, { method: "HEAD" })).status, 200);
});

test("INVDET_ACTIONS detail offers only permitted answer actions", async () => {
  mineRows = [row()];
  const open = (await call(`/recruit/invitations/${INV}`, { html: true })).body;
  for (const action of ["accept", "decline", "seen"]) assert.ok(open.includes(`action="/recruit/invitations/${INV}/${action}"`), `INVDET_ACTIONS open invitation has ${action} form`);
  mineRows = [row(INV, "accepted")];
  const closed = (await call(`/recruit/invitations/${INV}`, { html: true })).body;
  assert.equal(closed.includes("<form"), false, "INVDET_ACTIONS closed invitation has no answer form");
});

test("INVDET_MINE missing, unknown and malformed ids are indistinguishable and read nothing else", async () => {
  calls.length = 0; mineRows = [row(OTHER)];
  const paths = [`/recruit/invitations/${INV}`, "/recruit/invitations/123e4567-e89b-42d3-a456-426614174000", "/recruit/invitations/not-an-id"];
  const json = await Promise.all(paths.map((path) => call(path)));
  assert.deepEqual(json.map((r) => [r.status, r.body]), [[404, '{"error":"not_found"}'], [404, '{"error":"not_found"}'], [404, '{"error":"not_found"}']], "INVDET_MINE all JSON misses are identical 404s");
  const pages = await Promise.all(paths.map((path) => call(path, { html: true })));
  assert.equal(pages.every((r) => r.status === 404 && r.body === pages[0]!.body && r.body.includes("This isn’t available to you.")), true, "INVDET_MINE all HTML misses are identical 404s");
  assert.equal(calls.every((c) => c === "mine:me"), true, "INVDET_MINE only mine is read");
});

test("INVDET_DENY requires a session and bare writes fall through while answer paths remain", async () => {
  mineRows = [row()]; calls.length = 0;
  assert.deepEqual([(await call(`/recruit/invitations/${INV}`, { cookie: "" })).status, (await call(`/recruit/invitations/${INV}`, { cookie: "", html: true })).status], [401, 401]);
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await call(`/recruit/invitations/${INV}`, { method })).handled, false, `INVDET_DENY ${method} bare detail falls through`);
  assert.equal((await call(`/recruit/invitations/${INV}/accept`, { method: "POST" })).handled, true);
});

test("INVDET_PASSTHROUGH existing paths and unavailable behavior stay intact", async () => {
  mineRows = [row()];
  assert.equal((await call("/recruit/invitations")).status, 200);
  assert.equal((await call(`/recruit/invitations/${INV}/seen`, { method: "POST" })).handled, true);
  assert.equal((await call(`/recruit/invitations/${INV}`, { unavailable: true })).status, 503);
  assert.equal((await call(`/recruit/invitations/${INV}`, { unavailable: true, method: "PATCH" })).handled, false);
});

test("INVDET_UNAVAILABLE mine failures return a private 503", async () => {
  mineThrows = true;
  try {
    const json = await call(`/recruit/invitations/${INV}`), page = await call(`/recruit/invitations/${INV}`, { html: true });
    assert.deepEqual([json.status, json.json], [503, { error: "recruit_unavailable" }]);
    assert.equal(page.status === 503 && !page.body.includes("private") && !page.body.includes("Sultan"), true, "INVDET_UNAVAILABLE reveals no failure or invitation data");
  } finally { mineThrows = false; }
});
