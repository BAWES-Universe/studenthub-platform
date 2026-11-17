import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitRequests, handleRecruitRequests, type RecruitRequestsStore } from "../src/recruit/requests-http.js";
import { decodeRequestCursor, type RequestRow } from "../../../packages/recruit/src/index.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "d".repeat(43);
const STORE = "123e4567-e89b-42d3-a456-426614174000", REQ = "223e4567-e89b-42d3-a456-426614174000";
const calls: string[] = [];

const row = (i: number, over: Partial<RequestRow> = {}): RequestRow => ({
  id: `${String(i).padStart(8, "0")}-e89b-42d3-a456-426614174000`, org_id: "co", org_name: "Co <b>", store_id: STORE, store_name: "Avenues",
  position_title: `Cashier ${i}`, description: "Front till", compensation_text: "3 KWD", position_type: "part_time", headcount: 2,
  period_start: null, period_end: null, pay_model: null, gender: "any", location: null, priority: 0, status: "open", close_reason: null,
  assigned: false, created_at: "2026-11-17T10:00:00.000Z", updated_at: "2026-11-17T11:00:00.000Z", cursor_at: `2026-11-17T10:00:00.${String(i).padStart(6, "0")}Z`, ...over,
});

const store: RecruitRequestsStore = {
  stores: async (_p, o) => { calls.push(`stores:${o}`); return o === "refused" ? null : [{ store_id: STORE, name: "Avenues" }]; },
  create: async (_p, o, f) => { calls.push(`create:${o}:${f.positionTitle}:${f.draft}`); return o === "refused" ? { kind: "not_found" } : { kind: "created", requestId: REQ }; },
  transition: async (_p, id, to, reason) => { calls.push(`transition:${id}:${to}:${reason}`); return id === REQ ? (to === "draft" ? { kind: "refused", status: "open" } : { kind: "transitioned", status: to }) : { kind: "not_found" }; },
  get: async (_p, id) => { calls.push(`get:${id}`); return id === REQ ? { request: row(1, { id: REQ, position_title: "<script>x</script>", description: "a\n<i>b</i>" }), events: [{ from_status: null, to_status: "open", close_reason: null, actor_name: "Dana <x>", at: "2026-11-17T10:00:00.000Z" }], canTransition: true } : null; },
  listCompany: async (_p, o, q) => { calls.push(`company:${o}:${q.status ?? ""}:${q.cursor?.id ?? ""}:${q.limit}`); return o === "refused" ? null : Array.from({ length: o === "big" ? 51 : 2 }, (_, i) => row(i + 1)); },
  listStaff: async (_p, q) => { calls.push(`staff:${q.status ?? ""}:${q.limit}`); return q.status === "filled" ? null : [row(1)]; },
};
const service = createRecruitRequests({ sessions: { get: async (id) => (id === SESSION ? { id, personId: "person" } : undefined) }, store });

async function call(path: string, options: { body?: string; method?: string; headers?: Record<string, string>; html?: boolean } = {}) {
  const req = Readable.from(options.body ? [options.body] : []) as IncomingMessage;
  req.url = path; req.method = options.method ?? "GET";
  req.headers = { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-studenthub_session=${SESSION}`, ...options.headers };
  let status = 0, payload = "", headers: Record<string, string> = {}, page: { status: number; title: string; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number, h: Record<string, string>) { status = code; headers = h; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitRequests(req, fake as unknown as ServerResponse, service, ORIGIN, (s, title, body) => { page = { status: s, title, body }; }, options.html ?? false);
  return { handled, status: page?.status ?? status, headers, json: payload ? JSON.parse(payload) as Record<string, unknown> : undefined, page };
}
const json = (value: unknown) => ({ body: JSON.stringify(value), method: "POST" });
const valid = { storeId: STORE, positionTitle: " Cashier ", description: "d", compensationText: "c", positionType: "part_time", headcount: 2 };

test("REC1_HTTP_CREATE creates through JSON and the form, and refuses bad input before the store", async () => {
  calls.length = 0;
  assert.deepEqual((await call("/recruit/requests/create", json({ orgId: "co", request: valid }))).json, { requestId: REQ });
  assert.deepEqual((await call("/recruit/requests/create", json({ orgId: "co", request: { ...valid, headcount: 0 } }))).json, { error: "invalid_request" });
  assert.deepEqual((await call("/recruit/requests/create", json({ orgId: "co", request: valid, extra: 1 }))).json, { error: "invalid_request" });
  const form = new URLSearchParams({ orgId: "co", storeId: STORE, positionTitle: "Barista", description: "d", compensationText: "c", positionType: "full_time", headcount: "3", payModel: "", periodStart: "", periodEnd: "", gender: "any", location: "", priority: "0", draft: "on" });
  const created = await call("/recruit/requests/create", { body: form.toString(), method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, html: true });
  assert.equal(created.status, 303);
  assert.equal(created.headers.location, `/recruit/requests/${REQ}`);
  assert.deepEqual(calls, ["create:co:Cashier:false", "create:co:Barista:true"]);
});

test("REC1_HTTP_REFUSALS refused, unknown and other companies' requests answer the same 404; origin, session and method are checked first", async () => {
  calls.length = 0;
  const unknown = "323e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual((await call(`/recruit/requests/${unknown}`)).json, { error: "not_found" });
  assert.deepEqual((await call("/recruit/requests/not-an-id")).json, { error: "not_found" });
  assert.deepEqual((await call("/recruit/requests/create", json({ orgId: "refused", request: valid }))).json, { error: "not_found" });
  assert.deepEqual((await call(`/recruit/requests/${unknown}/transition`, json({ to: "filling" }))).json, { error: "not_found" });
  assert.deepEqual((await call("/recruit/requests?org=refused")).json, { error: "not_found" });
  assert.deepEqual((await call("/recruit/staff/requests?status=filled")).json, { error: "not_found" });
  calls.length = 0;
  assert.equal((await call("/recruit/requests/create", { ...json({ orgId: "co", request: valid }), headers: { origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await call("/recruit/requests/create", { ...json({ orgId: "co", request: valid }), headers: { cookie: "" } })).status, 401);
  assert.equal((await call("/recruit/requests/create")).status, 404);
  assert.equal((await call("/recruit/requests", { method: "DELETE" })).status, 404);
  assert.deepEqual(calls, [], "no store call for origin, session or method refusals");
  assert.equal((await call("/organization/stores/co")).handled, false, "other paths pass through");
});

test("REC1_HTTP_TRANSITION transitions answer the new status, a denied pair is a 409 with the current status", async () => {
  calls.length = 0;
  assert.deepEqual((await call(`/recruit/requests/${REQ.toUpperCase()}/transition`, json({ to: "closed", closeReason: "cancelled" }))).json, { requestId: REQ, status: "closed" });
  const denied = await call(`/recruit/requests/${REQ}/transition`, json({ to: "draft" }));
  assert.deepEqual([denied.status, denied.json], [409, { error: "transition_not_allowed", status: "open" }]);
  assert.deepEqual((await call(`/recruit/requests/${REQ}/transition`, json({ to: "closed" }))).json, { error: "invalid_request" });
  const viaForm = await call(`/recruit/requests/${REQ}/transition`, { body: "to=filling", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, html: true });
  assert.equal(viaForm.status, 303);
  assert.deepEqual(calls, [`transition:${REQ}:closed:cancelled`, `transition:${REQ}:draft:null`, `transition:${REQ}:filling:null`]);
});

test("REC1_READS lists page by 50 with a stable cursor, filter by status, and show title, store, headcount, status and last change", async () => {
  calls.length = 0;
  const first = await call("/recruit/requests?org=big&status=open");
  const body = first.json as { requests: { positionTitle: string; storeName: string; headcount: number; status: string; lastChange: string }[]; nextCursor: string };
  assert.equal(body.requests.length, 50);
  assert.deepEqual(Object.keys(body.requests[0]!).sort(), ["closeReason", "headcount", "lastChange", "orgId", "organizationName", "positionTitle", "requestId", "status", "storeName"]);
  assert.deepEqual(decodeRequestCursor(body.nextCursor), { createdAt: "2026-11-17T10:00:00.000050Z", id: row(50).id });
  await call(`/recruit/requests?org=big&cursor=${body.nextCursor}`);
  assert.equal((await call("/recruit/requests?org=co")).json?.nextCursor, null);
  assert.deepEqual((await call("/recruit/requests?org=co&status=archived")).json, { error: "invalid_request" });
  assert.deepEqual((await call("/recruit/requests?org=co&org=other")).json, { error: "invalid_request" });
  assert.deepEqual((await call("/recruit/requests?org=co&cursor=bad!")).json, { error: "invalid_request" });
  assert.equal(((await call("/recruit/staff/requests")).json as { requests: unknown[] }).requests.length, 1);
  assert.deepEqual(calls, ["company:big:open::51", `company:big::${row(50).id}:51`, "company:co:::51", "staff::51"]);
  const page = (await call("/recruit/requests?org=co", { html: true })).page!;
  assert.equal(page.status, 200);
  for (const text of ["Cashier 1", "Avenues", "Co &lt;b&gt;", "<td>2</td>", "Open", "2026-11-17 11:00", "/recruit/requests/new?org=co"]) assert.ok(page.body.includes(text), text);
});

test("REC1_HTTP_PAGE the request page escapes every value and shows the activity and allowed actions", async () => {
  const page = (await call(`/recruit/requests/${REQ}`, { html: true })).page!;
  assert.equal(page.status, 200);
  assert.equal(page.body.includes("<script>"), false);
  assert.equal(page.body.includes("<i>b</i>"), false);
  for (const text of ["&lt;script&gt;x&lt;/script&gt;", "a\n&lt;i&gt;b&lt;/i&gt;", "Created as Open", "by Dana &lt;x&gt;", "Move to Filling", "Close as cancelled", "Close as fulfilled"]) assert.ok(page.body.includes(text), text);
  const missing = (await call("/recruit/requests/323e4567-e89b-42d3-a456-426614174000", { html: true })).page!;
  assert.equal(missing.status, 404);
  const form = (await call("/recruit/requests/new?org=co", { html: true })).page!;
  assert.ok(form.body.includes(`<option value="${STORE}">Avenues</option>`));
  assert.equal((await call("/recruit/requests/new?org=refused", { html: true })).page!.status, 404);
});
