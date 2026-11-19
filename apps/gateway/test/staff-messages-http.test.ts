import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { StaffMessagesService, type StaffMessageDraft, type StaffMessageStoreResult } from "../../../packages/comms/src/staff-messages.js";
import { handleStaffMessages, type StaffDeliveryLogEntry } from "../src/comms/staff-messages-http.js";
import { ROUTES } from "../src/routes/index.js";

const ORIGIN = "https://studenthub.example", STAFF = "staff-1", PERSON = "person-1", KEY = "6f1c2a4e-8b7d-4c3a-9e2f-1a2b3c4d5e6f";

async function rig(t: TestContext, staff = new Set([STAFF]), log: StaffDeliveryLogEntry[] | undefined = undefined) {
  const drafts: StaffMessageDraft[] = [];
  const store = { async send(draft: StaffMessageDraft): Promise<StaffMessageStoreResult> {
    const prior = drafts.find(d => d.sendKey === draft.sendKey);
    if (prior) return prior.recipientPrincipalId === draft.recipientPrincipalId && prior.kind === draft.kind ? { status: "already_sent", id: "m-1" } : { status: "send_key_conflict" };
    if (draft.recipientPrincipalId === "missing") return { status: "recipient_not_found" };
    drafts.push(draft); return { status: "sent", id: "m-1" };
  } };
  const authority = { async isStaff(id: string) { return staff.has(id); } };
  const service = new StaffMessagesService(store, authority);
  const logCalls: [string, number, number][] = [];
  const http = { isStaff: authority.isStaff, send: service.send.bind(service),
    ...(log ? { deliveryLog: async (person: string, offset: number, limit: number) => { logCalls.push([person, offset, limit]); return person === "missing" ? null : { rows: log.slice(offset, offset + limit), total: log.length }; } } : {}) };
  const server = createServer(async (req, res) => {
    const handled = await handleStaffMessages(req, res, http, ORIGIN, async session => session === "s-staff" ? STAFF : session === "s-person" ? PERSON : undefined);
    if (!handled) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, fields: Record<string, string>, session = "s-staff", headers: Record<string, string> = {}) => fetch(base + path, { method: "POST",
    headers: { cookie: `__Host-studenthub_session=${session}`, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers }, body: new URLSearchParams(fields).toString() });
  const get = (path: string, session = "s-staff", accept = "text/html") => fetch(base + path, { headers: { cookie: `__Host-studenthub_session=${session}`, accept } });
  return { drafts, post, get, logCalls };
}

test("COMMS_STAFF_SEND_HTTP the send route is registered with the gateway routes", () => {
  assert.ok(ROUTES.some(route => route.name === "staff-messages"));
});

test("COMMS_STAFF_SEND_HTTP staff open the form and send each of the three kinds to a person", async (t) => {
  const x = await rig(t);
  const page = await x.get(`/workspace/people/${PERSON}/message`);
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const kind of ["profile_photo_request", "civil_id_request", "message"]) assert.match(html, new RegExp(`value="${kind}"`));
  assert.match(html, /name="send_key" value="[0-9a-f-]{36}"/);
  const keys = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  assert.equal((await x.post(`/workspace/people/${PERSON}/message`, { kind: "profile_photo_request", send_key: keys[0]! })).status, 201);
  assert.equal((await x.post(`/workspace/people/${PERSON}/message`, { kind: "civil_id_request", send_key: keys[1]! })).status, 201);
  const sent = await x.post(`/workspace/people/${PERSON}/message`, { kind: "message", body: "  Bring your contract ", send_key: keys[2]! });
  assert.equal(sent.status, 201);
  assert.deepEqual(await sent.json(), { status: "sent", id: "m-1" });
  assert.deepEqual(x.drafts.map(d => [d.senderPrincipalId, d.recipientPrincipalId, d.kind, d.body]), [
    [STAFF, PERSON, "profile_photo_request", null], [STAFF, PERSON, "civil_id_request", null], [STAFF, PERSON, "message", "Bring your contract"]]);
});

test("COMMS_STAFF_SEND_HTTP a repeat submit is already_sent; a reused key, bad input and unknown person are refused", async (t) => {
  const x = await rig(t), path = `/workspace/people/${PERSON}/message`;
  assert.equal((await x.post(path, { kind: "civil_id_request", send_key: KEY })).status, 201);
  const again = await x.post(path, { kind: "civil_id_request", send_key: KEY });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { status: "already_sent", id: "m-1" });
  assert.equal((await x.post(path, { kind: "profile_photo_request", send_key: KEY })).status, 409);
  const invalid = await x.post(path, { kind: "message", body: "", send_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { status: "invalid", field: "body" });
  assert.equal((await x.post(path, { kind: "civil_id_request", send_key: "not-a-uuid" })).status, 400);
  assert.equal((await x.post(path, { kind: "civil_id_request", send_key: KEY, extra: "x" })).status, 400);
  assert.equal((await x.post("/workspace/people/missing/message", { kind: "civil_id_request", send_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })).status, 404);
  assert.equal(x.drafts.length, 1);
});

test("COMMS_STAFF_SEND_HTTP people who are not staff and signed-out callers get the same not found; cross-site posts cannot send", async (t) => {
  const x = await rig(t), path = `/workspace/people/${PERSON}/message`;
  assert.equal((await x.get(path, "s-person")).status, 404);
  assert.equal((await x.post(path, { kind: "civil_id_request", send_key: KEY }, "s-person")).status, 404);
  // Signed-out and unknown-session callers get the same not found as signed-in non-staff, so the route is not revealed.
  const nonStaff = await x.post(path, { kind: "civil_id_request", send_key: KEY }, "s-person");
  for (const session of ["nobody", ""]) {
    const signedOut = await x.post(path, { kind: "civil_id_request", send_key: KEY }, session);
    assert.equal(signedOut.status, 404);
    assert.deepEqual(await signedOut.json(), { status: "not_found" });
    assert.equal((await x.get(path, session)).status, 404);
  }
  assert.deepEqual(await nonStaff.json(), { status: "not_found" });
  assert.equal((await x.post(path, { kind: "civil_id_request", send_key: KEY }, "s-staff", { origin: "https://evil.example" })).status, 403);
  assert.equal((await x.post(path, { kind: "civil_id_request", send_key: KEY }, "s-staff", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal(x.drafts.length, 0);
});

test("COMMS_STAFF_SEND_HTTP other paths are left to the next route", async (t) => {
  const x = await rig(t);
  assert.equal((await x.get("/workspace/people")).status, 418);
  assert.equal((await x.get(`/workspace/people/${PERSON}`)).status, 418);
});

const entry = (n: number): StaffDeliveryLogEntry => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, emailClass: "civil_id.result", state: "sent",
  createdAt: new Date("2026-11-19T06:00:00Z"), sentAt: new Date("2026-11-19T06:05:00Z"),
  attempts: [{ attempt: 1, outcome: "failed", failureCode: "provider_timeout", at: new Date("2026-11-19T06:00:30Z") }, { attempt: 2, outcome: "sent", failureCode: null, at: new Date("2026-11-19T06:05:00Z") }] });

test("COMMS_EMAIL_DELIVERY_LOG_HTTP staff see a person's emails with each try, and no address or text", async (t) => {
  const x = await rig(t, undefined, Array.from({ length: 51 }, (_, i) => entry(i + 1)));
  const path = `/workspace/people/${PERSON}/emails`;
  const json = await x.get(path, "s-staff", "application/json");
  assert.equal(json.status, 200);
  const body = await json.json() as { status: string; page: number; total: number; emails: { attempts: unknown[] }[] };
  assert.deepEqual({ status: body.status, page: body.page, total: body.total, count: body.emails.length }, { status: "ok", page: 1, total: 51, count: 50 });
  assert.deepEqual(body.emails[0], { id: entry(1).id, emailClass: "civil_id.result", state: "sent", createdAt: "2026-11-19T06:00:00.000Z", sentAt: "2026-11-19T06:05:00.000Z",
    attempts: [{ attempt: 1, outcome: "failed", failureCode: "provider_timeout", at: "2026-11-19T06:00:30.000Z" }, { attempt: 2, outcome: "sent", failureCode: null, at: "2026-11-19T06:05:00.000Z" }] });
  const page2 = await x.get(`${path}?page=2`, "s-staff", "application/json");
  assert.equal(((await page2.json()) as { emails: unknown[] }).emails.length, 1);
  assert.deepEqual(x.logCalls, [[PERSON, 0, 50], [PERSON, 50, 50]]);
  const html = await (await x.get(path)).text();
  assert.match(html, /Civil ID result/);
  assert.match(html, /provider_timeout/);
  assert.match(html, /Addresses and email text are not shown/);
  assert.match(html, /href="\/workspace\/people\/person-1\/emails\?page=2">Older</);
  for (const bad of ["0", "-1", "x", "1.5", "1234567"]) assert.equal((await x.get(`${path}?page=${bad}`, "s-staff", "application/json")).status, 400, bad);
  assert.equal((await x.get("/workspace/people/missing/emails", "s-staff", "application/json")).status, 404);
  assert.equal((await x.post(path, { kind: "civil_id_request", send_key: KEY })).status, 405);
});

test("COMMS_EMAIL_DELIVERY_LOG_HTTP non-staff and signed-out callers get the same not found, and nothing is read", async (t) => {
  const x = await rig(t, undefined, [entry(1)]), path = `/workspace/people/${PERSON}/emails`;
  for (const session of ["s-person", "nobody", ""]) {
    const res = await x.get(path, session, "application/json");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { status: "not_found" });
  }
  assert.deepEqual(x.logCalls, []);
  const empty = await rig(t, undefined, []);
  assert.match(await (await empty.get(path)).text(), /No emails to this person yet/);
  const unwired = await rig(t);
  assert.equal((await unwired.get(path, "s-staff", "application/json")).status, 404);
});

test("COMMS_STAFF_SEND_HTTP the production login runtime carries the staff send service", async () => {
  const { createRuntimeLoginFromEnv } = await import("../src/login-runtime.js");
  const runtime = createRuntimeLoginFromEnv({
    DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/synthetic",
    OIDC_ISSUER: "https://identity.test.invalid/", OIDC_CLIENT_ID: "synthetic", OIDC_CLIENT_SECRET: "synthetic",
    OIDC_CALLBACK_URL: "https://studenthub.test.invalid/login/callback",
    OIDC_AUTHORIZATION_URL: "https://identity.test.invalid/authorize", OIDC_TOKEN_URL: "https://identity.test.invalid/token",
    OIDC_JWKS_URL: "https://identity.test.invalid/jwks", LOGIN_ALLOWED_RETURN_URLS: "https://studenthub.test.invalid/profile",
  })!;
  const staffMessages = (runtime.application as { staffMessages?: { isStaff: unknown; send: unknown; deliveryLog?: unknown; morningSummary?: { today: unknown; subscribe: unknown } } }).staffMessages;
  assert.equal(typeof staffMessages?.isStaff, "function");
  assert.equal(typeof staffMessages?.send, "function");
  assert.equal(typeof staffMessages?.deliveryLog, "function");
  assert.equal(typeof staffMessages?.morningSummary?.today, "function");
  assert.equal(typeof staffMessages?.morningSummary?.subscribe, "function");
  await runtime.close();
});
