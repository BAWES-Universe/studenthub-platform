import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitPeopleSearch, handleRecruitPeopleSearch, type RecruitPeopleSearchStore } from "../src/recruit/search-http.js";

const SESSION = "f".repeat(43), AREA = "723e4567-e89b-42d3-a456-426614174000";
const seen: unknown[] = [];
const store: RecruitPeopleSearchStore = {
  search: async (p, query) => {
    seen.push(query);
    return p !== "staff" ? null : {
      total: 30,
      rows: [{ principal_id: "p1", name: "Noor <b>", arabic_name: "نور", objective: "Retail <i>", availability: "active", gender: "female", driving_licence: true, area_name: "Salmiya", nationality_name: "Kuwait", universities: ["KU"], complete: false }],
      facets: [{ facet: "area", value: AREA, label: "Salmiya <x>", count: 4 }, { facet: "gender", value: "female", label: null, count: 3 }],
    };
  },
};
const service = createRecruitPeopleSearch({ sessions: { get: async (id) => (id === SESSION ? { id, personId: "staff" } : id === "c".repeat(43) ? { id, personId: "company" } : undefined) }, store });

async function call(path: string, o: { method?: string; cookie?: string; html?: boolean } = {}) {
  const req = Readable.from([]) as IncomingMessage;
  req.url = path; req.method = o.method ?? "GET";
  req.headers = { cookie: `__Host-studenthub_session=${o.cookie ?? SESSION}` };
  let status = 0, payload = "", page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number) { status = code; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitPeopleSearch(req, fake as unknown as ServerResponse, service, (s, _t, body) => { page = { status: s, body }; }, o.html ?? false);
  return { handled, status: page?.status ?? status, json: payload ? JSON.parse(payload) as Record<string, unknown> : undefined, page };
}

test("REC3_HTTP a search passes repeated facets, answers people and facets; bad queries, other people and other methods are refused", async () => {
  seen.length = 0;
  const r = await call(`/recruit/staff/people?q=noor&area=${AREA}&gender=female&gender=male&page=2`);
  assert.equal(r.status, 200);
  assert.deepEqual(seen[0], { q: "noor", area: [AREA], nationality: [], university: [], availability: [], drivingLicence: [], gender: ["female", "male"], includeIncomplete: false, page: 2 });
  assert.deepEqual([r.json!.total, r.json!.page, r.json!.pageSize, (r.json!.people as { name: string }[])[0]!.name], [30, 2, 25, "Noor <b>"]);
  assert.deepEqual((r.json!.facets as Record<string, { value: string; count: number; selected: boolean }[]>).gender, [{ value: "female", label: "Female", count: 3, selected: true }, { value: "male", label: "Male", count: 0, selected: true }]);
  seen.length = 0;
  assert.deepEqual((await call("/recruit/staff/people?sort=name")).json, { error: "invalid_request" });
  assert.deepEqual((await call("/recruit/staff/people?area=nope")).json, { error: "invalid_request" });
  assert.deepEqual(seen, [], "a bad query reaches no store");
  assert.deepEqual((await call("/recruit/staff/people", { cookie: "c".repeat(43) })).json, { error: "not_found" });
  assert.equal((await call("/recruit/staff/people", { cookie: "x" })).status, 401);
  assert.equal((await call("/recruit/staff/people", { method: "POST" })).status, 404);
  assert.equal((await call("/recruit/staff/peoples")).handled, false);
});

test("REC3_HTTP_PAGE the page escapes people and facets, keeps choices ticked and links pages with the same search", async () => {
  const page = (await call(`/recruit/staff/people?q=noor&area=${AREA}&page=2`, { html: true })).page!;
  assert.equal(page.status, 200);
  for (const text of ["Noor &lt;b&gt;", "Retail &lt;i&gt;", "Salmiya &lt;x&gt;", "(profile incomplete)", `value="${AREA}" checked`, "30 people", "Page 2 of 2", `href="/recruit/staff/people?q=noor&amp;area=${AREA}"`, 'value="noor"']) assert.ok(page.body.includes(text) || page.body.includes(text.replace("&amp;", "&")), text);
  assert.equal(page.body.includes("<b>"), false);
  assert.equal((await call("/recruit/staff/people", { html: true, cookie: "c".repeat(43) })).page?.status, 404);
});
