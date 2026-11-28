import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitInterviews, handleRecruitInterviews, type RecruitInterviews, type RecruitInterviewsStore } from "../src/recruit/interviews-http.js";
import { renderRequestList } from "../src/recruit/requests-http.js";

// A-11 the staff interviews page. Synthetic people and companies only.
const SESSION = "k".repeat(43), STAFF = "t".repeat(43);
const REQ = "223e4567-e89b-42d3-a456-426614174000";
const row = (id: string, person: string | null, orgId: string, company: string, at: string, outcome: "passed" | "not_passed" | "no_show" | null, rating: number | null) => ({
  id, request_id: REQ, position_title: "Cashier <Evening>", org_id: orgId, org_name: company, store_name: "Avenues <A>", person_name: person, scheduled_at: at, duration_minutes: 45,
  mode: "video" as const, status: outcome ? "completed" as const : "scheduled" as const, outcome, rating,
});
const PAGES: Record<number, ReturnType<typeof row>[]> = {
  1: [row("i-3", "Noor <Synthetic>", "org-b", "Beta <Co>", "2026-12-03T09:00:00.000Z", null, null), row("i-2", null, "org-a", "Alpha", "2026-12-02T06:30:00.000Z", "not_passed", 2)],
  2: [row("i-1", "Badr", "org-a", "Alpha", "2026-11-20T10:00:00.000Z", "no_show", null)],
};
const calls: string[] = [];
let failing = false;
const store = {
  forStaff: async (p: string, page: number) => { calls.push(`${p}:${page}`); if (failing) throw new Error("database down"); return p !== "staff" ? null : { page, more: page === 1, interviews: PAGES[page] ?? [] }; },
} as unknown as RecruitInterviewsStore;
const sessions = { get: async (id: string) => (id === SESSION ? { id, personId: "owner" } : id === STAFF ? { id, personId: "staff" } : undefined) };
const service = createRecruitInterviews({ sessions, store });

async function call(path: string, o: { method?: string; html?: boolean; session?: string; service?: RecruitInterviews } = {}) {
  const req = Readable.from([]) as IncomingMessage;
  req.url = path; req.method = o.method ?? "GET";
  req.headers = { cookie: `__Host-studenthub_session=${o.session ?? STAFF}` };
  let status = 0, payload = "", page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number) { status = code; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitInterviews(req, fake as unknown as ServerResponse, "service" in o ? o.service : service, "https://studenthub.example.invalid", (s, _t, body) => { page = { status: s, body }; }, o.html ?? true);
  return { handled, status: page?.status ?? status, json: payload ? JSON.parse(payload) as Record<string, unknown> : undefined, body: page?.body ?? "" };
}
const rowsOf = (html: string) => [...html.matchAll(/<tr><th scope="row">(.*?)<\/tr>/g)].map((m) => m[1]!);

test("RECSTAFFINT_LIST staff see every company's interviews, latest first, with the outcome and rating; never a note", async () => {
  calls.length = 0;
  const r = await call("/recruit/staff/interviews");
  assert.equal(r.status, 200);
  assert.deepEqual(rowsOf(r.body), [
    `Noor &lt;Synthetic&gt;</th><td><a class="text-link" href="/organization/org-b">Beta &lt;Co&gt;</a></td><td><a class="text-link" href="/recruit/requests/${REQ}/interviews">Cashier &lt;Evening&gt;</a></td><td>Avenues &lt;A&gt;</td><td>2026-12-03 12:00 (Kuwait) · 45 min · Video</td><td>Scheduled</td><td></td>`,
    `Unnamed person</th><td><a class="text-link" href="/organization/org-a">Alpha</a></td><td><a class="text-link" href="/recruit/requests/${REQ}/interviews">Cashier &lt;Evening&gt;</a></td><td>Avenues &lt;A&gt;</td><td>2026-12-02 09:30 (Kuwait) · 45 min · Video</td><td>Completed</td><td>Not passed · 2/5</td>`], "rows escaped, latest first");
  assert.match(r.body, /<nav aria-label="Pages"><a href="\/recruit\/staff\/interviews\?page=2">Earlier interviews<\/a><\/nav>/, "the first page links earlier interviews");
  const json = (await call("/recruit/staff/interviews", { html: false })).json as { interviews: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(json.interviews[0]!).sort(), ["company", "durationMinutes", "interviewId", "kuwaitTime", "mode", "orgId", "outcome", "personName", "positionTitle", "rating", "requestId", "status", "store"], "no note or location field");
  assert.deepEqual(calls, ["staff:1", "staff:1"]);
});

test("RECSTAFFINT_PAGES page two lists older interviews and links back; past the end says so", async () => {
  calls.length = 0;
  const two = await call("/recruit/staff/interviews?page=2");
  assert.deepEqual(rowsOf(two.body).map((r) => r.slice(0, r.indexOf("</th>"))), ["Badr"], "page two lists the older interviews");
  assert.match(two.body, /<td>Completed<\/td><td>Did not attend<\/td>/);
  assert.match(two.body, /<nav aria-label="Pages"><a href="\/recruit\/staff\/interviews">Later interviews<\/a><\/nav>/, "page two links back to the first page");
  const three = await call("/recruit/staff/interviews?page=3");
  assert.match(three.body, /<p>No more interviews\.<\/p><nav aria-label="Pages"><a href="\/recruit\/staff\/interviews\?page=2">Later interviews<\/a><\/nav>/, "past the end says so");
  assert.deepEqual(calls, ["staff:2", "staff:3"]);
});

test("RECSTAFFINT_DENY sign in first; anyone but staff gets not found; bad input is refused before any read", async () => {
  calls.length = 0;
  assert.equal((await call("/recruit/staff/interviews", { session: "x" })).status, 401, "sign in first");
  assert.equal((await call("/recruit/staff/interviews", { session: SESSION })).status, 404, "a company owner is not staff");
  const before = calls.length;
  for (const query of ["?x=1", "?page=0", "?page=01", "?page=abc", "?page=1&page=2", "?page=1234567"]) assert.equal((await call(`/recruit/staff/interviews${query}`)).status, 400, query);
  assert.equal(calls.length, before, "bad input never reads interviews");
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await call("/recruit/staff/interviews", { method })).handled, false, `${method} is not this page`);
  assert.equal((await call("/recruit/staff/interviews/x")).handled, false);
});

test("RECSTAFFINT_UNAVAILABLE no service or a failing read is unavailable, never an empty list", async () => {
  assert.equal((await call("/recruit/staff/interviews", { service: undefined })).status, 503, "no service is unavailable");
  failing = true;
  try { assert.equal((await call("/recruit/staff/interviews")).status, 503, "a failing read is unavailable"); } finally { failing = false; }
});

test("RECSTAFFINT_JOURNEY the staff request list links All interviews; the company list does not", async () => {
  const page = { requests: [], status: null, nextCursor: null } as never;
  assert.match(renderRequestList("All requests", page, "/recruit/staff/requests", {}, undefined, "/recruit/staff/requests"), /<a class="text-link" href="\/recruit\/staff\/interviews">All interviews<\/a>/, "the staff list links the page");
  assert.doesNotMatch(renderRequestList("Requests", page, "/recruit/requests", { org: "org-a" }), /staff\/interviews/, "a company list does not");
});
