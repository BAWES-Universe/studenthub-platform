import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitInvitations, handleRecruitInvitations, type RecruitInvitationsStore } from "../src/recruit/invitations-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "d".repeat(43);
const INV = "823e4567-e89b-42d3-a456-426614174000", OTHER = "923e4567-e89b-42d3-a456-426614174000";
const row = (id = INV, status: "sent" | "accepted" = "sent") => ({ id, request_id: "223e4567-e89b-42d3-a456-426614174000", status, org_name: "Sultan <Co> & Sons", store_name: "Store <One>", position_title: "Cashier <x>", position_type: "part_time", period_start: "2026-12-01", period_end: "2026-12-31", compensation_text: "3 < 4 KWD/h", pay_model: "hourly", location: "Mall & plaza", created_at: "2026-11-17T10:00:00.000Z" } as const);

function setup(rows = [row()], options: { session?: boolean; throws?: boolean } = {}) {
  const calls: string[] = [];
  const store: RecruitInvitationsStore = {
    mine: async (p) => { calls.push(`mine:${p}`); if (options.throws) throw new Error("private"); return rows; },
    answer: async () => { calls.push("answer"); return { kind: "not_found" }; }, withdraw: async () => { calls.push("withdraw"); return { kind: "not_found" }; },
    invite: async () => { calls.push("invite"); return { kind: "not_found" }; }, forRequest: async () => { calls.push("forRequest"); return null; },
  };
  const service = createRecruitInvitations({ sessions: { get: async (s) => options.session === false || s !== SESSION ? undefined : { id: s, personId: "person-one" } }, store });
  return { service, calls };
}

async function call(service: ReturnType<typeof createRecruitInvitations> | undefined, path: string, options: { method?: string; html?: boolean; cookie?: string } = {}) {
  const req = Readable.from([]) as IncomingMessage; req.url = path; req.method = options.method ?? "GET"; req.headers = { cookie: options.cookie ?? `__Host-studenthub_session=${SESSION}`, accept: options.html ? "text/html" : "application/json" };
  let status = 0, payload = "", contentType = "", page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number, headers: Record<string, string>) { status = code; contentType = headers["content-type"] ?? ""; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitInvitations(req, fake as unknown as ServerResponse, service, ORIGIN, (s, _t, body) => { page = { status: s, body }; }, options.html ?? false);
  return { handled, status: page?.status ?? status, body: page?.body ?? payload, json: payload ? JSON.parse(payload) as unknown : undefined, contentType };
}

test("INVDET_SHOW a held invitation is rendered completely and returned as its InvitationView", async () => {
  const { service, calls } = setup();
  const page = await call(service, `/recruit/invitations/${INV}`, { html: true });
  assert.equal(page.status, 200, "INVDET_SHOW HTML detail is successful");
  for (const value of ["Store &lt;One&gt;", "Cashier &lt;x&gt;", "Part time", "2026-12-01 to 2026-12-31", "Mall &amp; plaza", "Pay: 3 &lt; 4 KWD/h (Hourly)", "New", `<time datetime="2026-11-17T10:00:00.000Z">`, "href=\"/recruit/invitations\""]) assert.ok(page.body.includes(value), `INVDET_SHOW renders escaped detail: ${value}`);
  assert.ok(page.body.includes("Sultan &lt;Co&gt; &amp; Sons"), "INVDET_SHOW company name is escaped");
  assert.equal(page.body.includes("Sultan <Co>"), false, "INVDET_SHOW company name is escaped");
  const json = await call(service, `/recruit/invitations/${INV}`);
  assert.equal(json.contentType, "application/json", "INVDET_SHOW JSON content type");
  assert.deepEqual(json.json, { invitation: { invitationId: INV, status: "sent", company: "Sultan <Co> & Sons", store: "Store <One>", positionTitle: "Cashier <x>", positionType: "part_time", period: { start: "2026-12-01", end: "2026-12-31" }, pay: "3 < 4 KWD/h", payModel: "hourly", location: "Mall & plaza", invitedAt: "2026-11-17T10:00:00.000Z", canAnswer: true } }, "INVDET_SHOW JSON uses invitationView");
  assert.deepEqual(calls, ["mine:person-one", "mine:person-one"]);
});

test("INVDET_ACTIONS detail offers all and only the actions allowed by the invitation", async () => {
  const open = (await call(setup([row()]).service, `/recruit/invitations/${INV}`, { html: true })).body;
  for (const action of ["accept", "decline", "seen"]) assert.ok(open.includes(`action="/recruit/invitations/${INV}/${action}"`), `INVDET_ACTIONS ${action} uses the real escaped id`);
  const closed = (await call(setup([row(INV, "accepted")]).service, `/recruit/invitations/${INV}`, { html: true })).body;
  assert.equal(closed.includes(`<form`), false, "INVDET_ACTIONS closed invitation has no answer forms");
});

test("INVDET_MINE absent, unknown, and malformed ids reveal the same not-found response", async () => {
  const { service, calls } = setup([row(OTHER)]);
  const paths = [INV, "123e4567-e89b-42d3-a456-426614174000", "malformed"];
  const json = await Promise.all(paths.map((id) => call(service, `/recruit/invitations/${id}`)));
  for (const result of json) { assert.equal(result.status, 404, "INVDET_MINE unavailable id is 404"); assert.deepEqual(result.json, { error: "not_found" }, "INVDET_MINE unavailable JSON reveals nothing"); }
  assert.equal(new Set(json.map((r) => r.body)).size, 1, "INVDET_MINE JSON bodies are byte-identical");
  const pages = await Promise.all(paths.map((id) => call(service, `/recruit/invitations/${id}`, { html: true })));
  assert.equal(new Set(pages.map((r) => r.body)).size, 1, "INVDET_MINE HTML bodies are byte-identical");
  assert.ok(calls.every((c) => c === "mine:person-one"), "INVDET_MINE reads only mine");
});

test("INVDET_DENY authorization, methods, availability, and failures preserve safe handler behavior", async () => {
  const denied = setup([row()], { session: false });
  assert.deepEqual((await call(denied.service, `/recruit/invitations/${INV}`)).json, { error: "unauthorized" }, "INVDET_DENY JSON has unauthorized error");
  assert.equal((await call(denied.service, `/recruit/invitations/${INV}`, { html: true })).status, 401, "INVDET_DENY HTML is 401");
  assert.deepEqual(denied.calls, [], "INVDET_DENY no-session does not read the store");
  assert.equal((await call(setup().service, `/recruit/invitations/${INV}`, { method: "POST" })).handled, false, "INVDET_DENY bare detail POST falls through");
  assert.equal((await call(setup().service, `/recruit/invitations/${INV}`, { method: "HEAD" })).status, 200, "INVDET_DENY HEAD is served");
  assert.equal((await call(undefined, `/recruit/invitations/${INV}`)).status, 503, "INVDET_DENY missing service is unavailable");
  const unavailable = setup([row()], { throws: true });
  const failed = await call(unavailable.service, `/recruit/invitations/${INV}`);
  assert.deepEqual(failed.json, { error: "recruit_unavailable" }, "INVDET_DENY store failure is sanitized");
  assert.equal(failed.body.includes("private"), false, "INVDET_DENY failure leaks no stack or data");
  assert.equal((await call(setup().service, "/recruit/invitations/not/a/detail")).handled, false, "INVDET_DENY unrelated path falls through");
});

test("INVDET_PASSTHROUGH existing list and answer paths remain assigned to their original flows", async () => {
  const { service, calls } = setup();
  assert.equal((await call(service, "/recruit/invitations")).status, 200, "INVDET_PASSTHROUGH list is still served");
  for (const action of ["accept", "decline", "seen"]) assert.equal((await call(service, `/recruit/invitations/${INV}/${action}`, { method: "POST" })).handled, true, `INVDET_PASSTHROUGH ${action} remains matched`);
  assert.equal((await call(service, `/recruit/invitations/${INV}`, { method: "PATCH" })).handled, false, "INVDET_PASSTHROUGH detail mutations fall through");
  assert.ok(calls.includes("mine:person-one"), "INVDET_PASSTHROUGH list still uses mine");
});

test("INVDET_UNAVAILABLE a mine failure returns only the standard unavailable response", async () => {
  const { service, calls } = setup([row()], { throws: true });
  const json = await call(service, `/recruit/invitations/${INV}`);
  assert.deepEqual(json.json, { error: "recruit_unavailable" }, "INVDET_UNAVAILABLE JSON is sanitized");
  const page = await call(service, `/recruit/invitations/${INV}`, { html: true });
  assert.equal(page.status, 503, "INVDET_UNAVAILABLE HTML is 503");
  assert.equal(page.body.includes("private"), false, "INVDET_UNAVAILABLE HTML leaks no failure");
  assert.deepEqual(calls, ["mine:person-one", "mine:person-one"], "INVDET_UNAVAILABLE reads only mine");
});
