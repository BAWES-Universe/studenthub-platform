import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitJobs, handleRecruitJobs, type RecruitJobsStore } from "../src/recruit/jobs-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "j".repeat(43), STAFF = "q".repeat(43);
const REQ = "223e4567-e89b-42d3-a456-426614174000", JOB = "a23e4567-e89b-42d3-a456-426614174000", APP = "b23e4567-e89b-42d3-a456-426614174000";
const calls: string[] = [];
const row = { id: JOB, request_id: REQ, org_name: "Sultan <Co>", store_name: "Avenues", area_id: null, area_name: "Hawalli", position: "Cashier <x>", position_ar: null, description: "Hi <script>", description_ar: null, hours_per_day: 6, days_per_week: 5,
  compensation_type: "hourly", compensation_amount: "3 KWD", compensation_description: null, compensation_description_ar: null, min_age: 18, max_age: null, gender: "female" as const, available_from: null, available_to: null,
  status: "active" as const, skills: ["Arabic"], created_at: "2026-11-17T10:00:00.000Z", application_status: null, applications: 2 };
const store: RecruitJobsStore = {
  create: async (p, f) => { calls.push(`create:${p}:${f.position}:${f.skills.join("|")}`); return p === "staff" ? { kind: "saved", jobId: JOB } : { kind: "not_found" }; },
  update: async (p, id, f) => { calls.push(`update:${p}:${id}:${f.status}`); return f.areaId ? { kind: "area_invalid" } : { kind: "saved", jobId: id }; },
  board: async (p, q) => { calls.push(`board:${p}:${q.q}:${q.applied}:${q.page}`); return { jobs: [row], total: 30 }; },
  get: async (p, id) => id !== JOB ? null : { job: row, staff: p === "staff" },
  apply: async (_p, id, note) => { calls.push(`apply:${id}:${note}`); return id !== JOB ? { kind: "not_found" } : note === "again" ? { kind: "duplicate", applicationId: APP } : note === "late" ? { kind: "job_closed" } : { kind: "applied", applicationId: APP }; },
  staffList: async (p) => p === "staff" ? [row] : null,
  applications: async (p) => p === "staff" ? [{ id: APP, person_principal_id: "p1", person_name: "Noor <b>", status: "interested", note: "Monday <ok>", created_at: "2026-11-17T10:00:00.000Z", decided_at: null }] : null,
  decide: async (p, id, to) => p !== "staff" || id !== APP ? { kind: "not_found" } : to === "shortlisted" ? { kind: "decided", status: to } : { kind: "refused", status: "rejected" },
};
const sessions = { get: async (id: string) => (id === SESSION ? { id, personId: "me" } : id === STAFF ? { id, personId: "staff" } : undefined) };
const service = createRecruitJobs({ sessions, store });

async function call(path: string, o: { body?: string; method?: string; headers?: Record<string, string>; html?: boolean; session?: string } = {}) {
  const req = Readable.from(o.body ? [o.body] : []) as IncomingMessage;
  req.url = path; req.method = o.method ?? "GET";
  req.headers = { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-studenthub_session=${o.session ?? SESSION}`, ...o.headers };
  let status = 0, payload = "", headers: Record<string, string> = {}, page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number, h: Record<string, string>) { status = code; headers = h; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitJobs(req, fake as unknown as ServerResponse, service, ORIGIN, (s, _t, body) => { page = { status: s, body }; }, o.html ?? false);
  return { handled, status: page?.status ?? status, headers, json: payload ? JSON.parse(payload) as Record<string, unknown> : undefined, page };
}
const post = (value: unknown, session?: string) => ({ body: JSON.stringify(value), method: "POST", ...(session ? { session } : {}) });
const form = (body: string, session?: string) => ({ body, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, html: true, ...(session ? { session } : {}) });

test("REC7_HTTP people browse and apply once; staff publish and decide; refusals reveal nothing", async () => {
  calls.length = 0;
  const board = (await call("/recruit/jobs?q=cash&page=2")).json!;
  assert.deepEqual([board.total, board.page, board.pageSize, (board.jobs as { canApply: boolean }[])[0]!.canApply], [30, 2, 25, true]);
  assert.equal(calls[0], "board:me:cash:false:2");
  assert.equal((await call("/recruit/jobs?applied=yes")).status, 400);
  assert.deepEqual((await call(`/recruit/jobs/${JOB}/apply`, post({ note: "Hi" }))).json, { applicationId: APP, created: true });
  assert.deepEqual((await call(`/recruit/jobs/${JOB}/apply`, post({ note: "again" }))).json, { applicationId: APP, created: false });
  assert.deepEqual((await call(`/recruit/jobs/${JOB}/apply`, post({ note: "late" }))).json, { error: "job_closed" });
  assert.equal((await call(`/recruit/jobs/${JOB}/apply`, post({ note: "x", extra: 1 }))).status, 400);
  assert.equal((await call(`/recruit/jobs/${JOB}/apply`)).status, 404, "applying is a POST");
  assert.equal(((await call(`/recruit/jobs/${JOB}`)).json!.job as Record<string, unknown>).applications, undefined, "people never see application counts");
  assert.equal(((await call(`/recruit/jobs/${JOB}`, { session: STAFF })).json!.job as Record<string, unknown>).applications, 2);
  assert.equal((await call("/recruit/staff/jobs")).status, 404);
  assert.equal((await call("/recruit/staff/jobs?status=open", { session: STAFF })).status, 400);
  assert.deepEqual((await call("/recruit/staff/jobs", post({ requestId: REQ, position: "Cashier", skills: ["Arabic", "Arabic"] }, STAFF))).json, { jobId: JOB });
  assert.equal(calls.at(-1), "create:staff:Cashier:Arabic");
  assert.equal((await call("/recruit/staff/jobs", post({ requestId: REQ, position: "Cashier" }))).status, 404);
  assert.deepEqual((await call(`/recruit/staff/jobs/${JOB}`, post({ requestId: REQ, position: "Cashier", areaId: REQ }, STAFF))).json, { error: "area_invalid" });
  assert.deepEqual((await call(`/recruit/staff/applications/${APP}/shortlist`, post({}, STAFF))).json, { applicationId: APP, status: "shortlisted" });
  assert.deepEqual((await call(`/recruit/staff/applications/${APP}/reject`, post({}, STAFF))).json, { error: "application_decided", status: "rejected" });
  assert.equal((await call(`/recruit/staff/applications/${APP}/shortlist`, post({}))).status, 404);
  assert.equal((await call("/recruit/jobs", { session: "x" })).status, 401);
  assert.equal((await call(`/recruit/jobs/${JOB}/apply`, { ...post({}), headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/recruit/jobsx")).handled, false);
});

test("REC7_HTTP_PAGE pages escape every value; criteria read as preferences; forms redirect to the job", async () => {
  const board = (await call("/recruit/jobs", { html: true })).page!.body;
  for (const text of ["Cashier &lt;x&gt;", "Sultan &lt;Co&gt;", 'href="/recruit/jobs?page=2"', "My applications"]) assert.ok(board.includes(text), text);
  const job = (await call(`/recruit/jobs/${JOB}`, { html: true })).page!.body;
  for (const text of ["Hi &lt;script&gt;", "<dt>Preferred age</dt><dd>18 to any</dd>", "<dt>Preferred</dt><dd>Female</dd>", 'action="/recruit/jobs/' + JOB + '/apply"']) assert.ok(job.includes(text), text);
  const applied = await call(`/recruit/jobs/${JOB}/apply`, form("note=Monday"));
  assert.deepEqual([applied.status, applied.headers.location], [303, `/recruit/jobs/${JOB}`]);
  const staff = (await call(`/recruit/staff/jobs/${JOB}`, { html: true, session: STAFF })).page!.body;
  for (const text of ["Noor &lt;b&gt;", "Monday &lt;ok&gt;", "Shortlist", 'name="jobId" value="' + JOB + '"', 'name="skills"']) assert.ok(staff.includes(text), text);
  const saved = await call("/recruit/staff/jobs", form(`requestId=${REQ}&position=Cashier&skills=Arabic%0AEnglish&status=active&gender=any`, STAFF));
  assert.deepEqual([saved.status, saved.headers.location], [303, `/recruit/staff/jobs/${JOB}`]);
  const decided = await call(`/recruit/staff/applications/${APP}/shortlist`, form(`jobId=${JOB}`, STAFF));
  assert.deepEqual([decided.status, decided.headers.location], [303, `/recruit/staff/jobs/${JOB}`]);
  const prefilled = (await call(`/recruit/staff/jobs?request=${REQ}`, { html: true, session: STAFF })).page!.body;
  assert.ok(prefilled.includes(`name="requestId" value="${REQ}"`));
});
