import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitFulltimers, handleRecruitFulltimers, type FulltimerRow, type RecruitFulltimersStore } from "../src/recruit/fulltimers-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "f".repeat(43);
const FT = "c23e4567-e89b-42d3-a456-426614174000", OTHER = "e23e4567-e89b-42d3-a456-426614174000", REQ = "223e4567-e89b-42d3-a456-426614174000";
const calls: string[] = [];
const row: FulltimerRow = { id: FT, name: "Fahad <b>", phone: "+96599991234", email: null, nationality_id: null, nationality_name: null, country_id: null, country_name: null, area_id: "523e4567-e89b-42d3-a456-426614174000", area_name: "Hawalli <x>", university_id: null, university_name: null,
  latitude: "29.375900", longitude: "47.977400", gender: "male", birth_date: "1995-04-01", employed: false, driving_licence: true, current_salary: null, expected_salary: "600", currency_code: "KWD", tags: ["sales"], skills: ["Arabic"], experience: ["Cashier <2y>"], legacy_cv_reference: null, archived_at: null };
const store: RecruitFulltimersStore = {
  create: async (p, f) => { calls.push(`create:${p}:${f.name}:${f.phone}:${f.tags.join("|")}:${f.employed}`); return f.name === "Dup" ? { kind: "duplicate", field: "name", fulltimerId: OTHER } : { kind: "saved", fulltimerId: FT }; },
  update: async (_p, id) => (id === FT ? { kind: "saved", fulltimerId: FT } : { kind: "not_found" }),
  archive: async (_p, id, archived) => { calls.push(`archive:${id}:${archived}`); return id === FT ? { kind: "saved", fulltimerId: FT } : { kind: "not_found" }; },
  list: async (p, q) => { calls.push(`list:${p}:${q.q}:${q.currency}:${q.tag}:${q.archived}:${q.page}`); return p === "staff" ? { rows: [row], total: 51 } : null; },
  get: async (p, id) => (p === "staff" && id === FT ? { fulltimer: row, cards: [{ card_id: "c1", request_id: REQ, position_title: "Manager <m>", org_name: "Sultan Co", stage: "placed" }] } : null),
};
let who = "staff";
const service = createRecruitFulltimers({ sessions: { get: async (id) => (id === SESSION ? { id, personId: who } : undefined) }, store, now: () => new Date("2026-11-17T12:00:00Z") });

async function call(path: string, o: { body?: string; method?: string; headers?: Record<string, string>; html?: boolean } = {}) {
  const req = Readable.from(o.body ? [o.body] : []) as IncomingMessage;
  req.url = path; req.method = o.method ?? "GET";
  req.headers = { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-studenthub_session=${SESSION}`, ...o.headers };
  let status = 0, payload = "", headers: Record<string, string> = {}, page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number, h: Record<string, string>) { status = code; headers = h; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitFulltimers(req, fake as unknown as ServerResponse, service, ORIGIN, (s, _t, body) => { page = { status: s, body }; }, o.html ?? false);
  return { handled, status: page?.status ?? status, headers, json: payload ? JSON.parse(payload) as Record<string, unknown> : undefined, page };
}
const post = (value: unknown) => ({ body: JSON.stringify(value), method: "POST" });
const form = (body: string) => ({ body, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, html: true });

test("REC9_HTTP staff list, create, edit and archive full-timers; duplicates name the existing record; others see nothing", async () => {
  calls.length = 0; who = "staff";
  const list = (await call("/recruit/staff/fulltimers?q=fahad&currency=usd&page=2")).json!;
  assert.deepEqual([list.total, list.page, list.pageSize, (list.fulltimers as { location: unknown }[])[0]!.location], [51, 2, 50, { latitude: 29.3759, longitude: 47.9774 }]);
  assert.equal(calls[0], "list:staff:fahad:USD:null:false:2");
  assert.equal((await call("/recruit/staff/fulltimers?request=nope")).status, 400);
  assert.deepEqual((await call("/recruit/staff/fulltimers", post({ name: "Fahad", phone: "+965 9999 1234", tags: "a, b", employed: "false" }))).json, { fulltimerId: FT });
  assert.equal(calls.at(-1), "create:staff:Fahad:+96599991234:a|b:false");
  assert.deepEqual((await call("/recruit/staff/fulltimers", post({ name: "Dup" }))).json, { error: "duplicate", field: "name", fulltimerId: OTHER });
  assert.equal((await call("/recruit/staff/fulltimers", post({ name: "A", birthDate: "2026-11-18" }))).status, 400, "no birth date after today in Kuwait");
  assert.deepEqual((await call(`/recruit/staff/fulltimers/${OTHER}`, post({ name: "A" }))).json, { error: "not_found" });
  assert.deepEqual((await call(`/recruit/staff/fulltimers/${FT}/archive`, post({}))).json, { fulltimerId: FT, archived: true });
  assert.deepEqual((await call(`/recruit/staff/fulltimers/${FT}/restore`, post({}))).json, { fulltimerId: FT, archived: false });
  assert.equal(((await call(`/recruit/staff/fulltimers/${FT}`)).json!.requests as unknown[]).length, 1);
  who = "company";
  assert.equal((await call("/recruit/staff/fulltimers")).status, 404);
  assert.equal((await call(`/recruit/staff/fulltimers/${FT}`)).status, 404);
  who = "staff";
  assert.equal((await call(`/recruit/staff/fulltimers/${FT}/archive`)).status, 404, "archiving is a POST");
  assert.equal((await call("/recruit/staff/fulltimers", { ...post({ name: "A" }), headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/recruit/staff/fulltimersx")).handled, false);
});

test("REC9_HTTP_PAGE pages escape every value; from a request each person gets a suggest button; forms redirect to the record", async () => {
  who = "staff";
  const list = (await call(`/recruit/staff/fulltimers?request=${REQ}`, { html: true })).page!.body;
  for (const text of ["Fahad &lt;b&gt;", `action="/recruit/staff/requests/${REQ}/cards"`, `name="fulltimerId" value="${FT}"`, "expects 600 KWD", `request=${REQ}&amp;page=2`]) assert.ok(list.includes(text), text);
  const one = (await call(`/recruit/staff/fulltimers/${FT}`, { html: true })).page!.body;
  for (const text of ["Hawalli &lt;x&gt;", "Cashier &lt;2y&gt;", "Manager &lt;m&gt;", "Placed", "Archive", 'name="experience"']) assert.ok(one.includes(text), text);
  const saved = await call("/recruit/staff/fulltimers", form("name=Fahad&phone=&email=&gender=male&employed=&drivingLicence=true&currencyCode=KWD&tags=sales&skills=&experience=&cvReference="));
  assert.deepEqual([saved.status, saved.headers.location], [303, `/recruit/staff/fulltimers/${FT}`]);
  const dup = await call("/recruit/staff/fulltimers", form("name=Dup"));
  assert.equal(dup.page!.status, 409);
  for (const text of ["A full-timer with this name already exists.", `href="/recruit/staff/fulltimers/${OTHER}"`]) assert.ok(dup.page!.body.includes(text), text);
  const cleared = await call("/recruit/staff/fulltimers?q=&tag=&currency=", { html: true });
  assert.equal(cleared.page!.status, 200, "a cleared Currency box still searches");
});
