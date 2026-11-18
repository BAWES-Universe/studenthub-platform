import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { JOB_GENDERS, JOB_PAGE_SIZE, JOB_STATUSES, isRecruitId, jobView, parseApplication, parseJob, parseJobQuery, type ApplicationStatus, type JobFields, type JobRow, type JobStatus, type JobView } from "../../../../packages/recruit/src/index.js";
import { BAD, NOT_FOUND, UNAUTHORIZED, decodeSegment, errorPage, html, readBody, redirect, sameOrigin, sendJson, sessionCookie, when, type RecruitPageWriter, type RecruitResult } from "./http-common.js";

// Recruit R7: job board (legacy, decision SHU-207).
//   GET  /recruit/jobs                         active jobs, ?q=, ?applied=1 for "My applications", ?page=
//   GET  /recruit/jobs/<id>                    one job
//   POST /recruit/jobs/<id>/apply              {note}
//   GET  /recruit/staff/jobs                   staff list (?status=, ?request=) and the new-job form
//   POST /recruit/staff/jobs                   create
//   GET  /recruit/staff/jobs/<id>              edit form and applications
//   POST /recruit/staff/jobs/<id>              update
//   POST /recruit/staff/applications/<id>/(shortlist|reject)

export interface RecruitJobsStore {
  create(principalId: string, input: JobFields): Promise<{ kind: "saved"; jobId: string } | { kind: "not_found" } | { kind: "area_invalid" }>;
  update(principalId: string, jobId: string, input: JobFields): Promise<{ kind: "saved"; jobId: string } | { kind: "not_found" } | { kind: "area_invalid" }>;
  board(personId: string, query: { q: string | null; applied: boolean; page: number }): Promise<{ jobs: readonly (JobRow & { area_id: string | null })[]; total: number } | null>;
  get(principalId: string, jobId: string): Promise<{ job: JobRow & { area_id: string | null; applications: number }; staff: boolean } | null>;
  apply(personId: string, jobId: string, note: string | null): Promise<{ kind: "applied"; applicationId: string } | { kind: "not_found" } | { kind: "job_closed" } | { kind: "duplicate"; applicationId: string }>;
  staffList(principalId: string, filter: { status: JobStatus | null; requestId: string | null }): Promise<readonly (JobRow & { area_id: string | null; applications: number })[] | null>;
  applications(principalId: string, jobId: string): Promise<readonly { id: string; person_principal_id: string; person_name: string | null; status: ApplicationStatus; note: string | null; created_at: string | Date; decided_at: string | Date | null }[] | null>;
  decide(principalId: string, applicationId: string, to: ApplicationStatus): Promise<{ kind: "decided"; status: ApplicationStatus } | { kind: "not_found" } | { kind: "refused"; status: ApplicationStatus }>;
}
export interface StaffJobView extends JobView { readonly requestId: string; readonly areaId: string | null; readonly applications: number }
export interface ApplicationView { readonly applicationId: string; readonly personId: string; readonly personName: string | null; readonly status: ApplicationStatus; readonly note: string | null; readonly appliedAt: string; readonly decidedAt: string | null }
export interface RecruitJobs {
  board(session: string | undefined, params: URLSearchParams): Promise<RecruitResult<{ jobs: readonly JobView[]; total: number; page: number; pageSize: number; q: string | null; applied: boolean }>>;
  job(session: string | undefined, jobId: string): Promise<RecruitResult<{ job: JobView | StaffJobView; staff: boolean }>>;
  apply(session: string | undefined, jobId: string, body: unknown): Promise<RecruitResult<{ applicationId: string; created: boolean }>>;
  staffList(session: string | undefined, params: URLSearchParams): Promise<RecruitResult<{ jobs: readonly StaffJobView[]; requestId: string | null }>>;
  save(session: string | undefined, jobId: string | null, body: unknown): Promise<RecruitResult<{ jobId: string }>>;
  staffJob(session: string | undefined, jobId: string): Promise<RecruitResult<{ job: StaffJobView; applications: readonly ApplicationView[] }>>;
  decide(session: string | undefined, applicationId: string, to: "shortlisted" | "rejected"): Promise<RecruitResult<{ applicationId: string; status: ApplicationStatus }>>;
}

const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();
const staffView = (row: JobRow & { area_id: string | null; applications: number }): StaffJobView => ({ ...jobView(row), requestId: row.request_id, areaId: row.area_id, applications: row.applications });

export function createRecruitJobs(p: { sessions: Pick<SessionStore, "get">; store: RecruitJobsStore }): RecruitJobs {
  const principal = async (s: string | undefined) => (s ? (await p.sessions.get(s))?.personId : undefined);
  return {
    async board(s, params) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      const raw: Record<string, string | string[]> = {};
      for (const [k, v] of params) raw[k] = k in raw ? [raw[k] as string, v].flat() : v;
      const query = parseJobQuery(raw);
      if (!query) return BAD;
      const r = await p.store.board(id, query);
      if (!r) return NOT_FOUND;
      return { status: 200, body: { jobs: r.jobs.map(jobView), total: r.total, page: query.page, pageSize: JOB_PAGE_SIZE, q: query.q, applied: query.applied } };
    },
    async job(s, jobId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(jobId)) return NOT_FOUND;
      const r = await p.store.get(id, jobId.toLowerCase());
      if (!r) return NOT_FOUND;
      return { status: 200, body: { job: r.staff ? staffView(r.job) : jobView(r.job), staff: r.staff } };
    },
    async apply(s, jobId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(jobId)) return NOT_FOUND;
      const fields = parseApplication(body);
      if (!fields) return BAD;
      const r = await p.store.apply(id, jobId.toLowerCase(), fields.note);
      if (r.kind === "applied") return { status: 200, body: { applicationId: r.applicationId, created: true } };
      if (r.kind === "duplicate") return { status: 200, body: { applicationId: r.applicationId, created: false } };
      return r.kind === "not_found" ? NOT_FOUND : { status: 409, body: { error: "job_closed" } };
    },
    async staffList(s, params) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      const status = params.get("status"), request = params.get("request");
      if ([...params.keys()].some((k) => k !== "status" && k !== "request") || params.getAll("status").length > 1 || params.getAll("request").length > 1) return BAD;
      if ((status !== null && !(JOB_STATUSES as readonly string[]).includes(status)) || (request !== null && !isRecruitId(request))) return BAD;
      const rows = await p.store.staffList(id, { status: status as JobStatus | null, requestId: request?.toLowerCase() ?? null });
      return rows ? { status: 200, body: { jobs: rows.map(staffView), requestId: request?.toLowerCase() ?? null } } : NOT_FOUND;
    },
    async save(s, jobId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (jobId !== null && !isRecruitId(jobId)) return NOT_FOUND;
      const fields = parseJob(body);
      if (!fields) return BAD;
      const r = jobId === null ? await p.store.create(id, fields) : await p.store.update(id, jobId.toLowerCase(), fields);
      if (r.kind === "saved") return { status: 200, body: { jobId: r.jobId } };
      return r.kind === "not_found" ? NOT_FOUND : { status: 400, body: { error: "area_invalid" } };
    },
    async staffJob(s, jobId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(jobId)) return NOT_FOUND;
      const [job, applications] = await Promise.all([p.store.get(id, jobId.toLowerCase()), p.store.applications(id, jobId.toLowerCase())]);
      if (!job?.staff || !applications) return NOT_FOUND;
      return { status: 200, body: { job: staffView(job.job), applications: applications.map((a) => ({ applicationId: a.id, personId: a.person_principal_id, personName: a.person_name, status: a.status, note: a.note, appliedAt: iso(a.created_at), decidedAt: a.decided_at ? iso(a.decided_at) : null })) } };
    },
    async decide(s, applicationId, to) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(applicationId)) return NOT_FOUND;
      const r = await p.store.decide(id, applicationId.toLowerCase(), to);
      if (r.kind === "decided") return { status: 200, body: { applicationId: applicationId.toLowerCase(), status: r.status } };
      return r.kind === "not_found" ? NOT_FOUND : { status: 409, body: { error: "application_decided", status: r.status } };
    },
  };
}

const APPLICATION: Readonly<Record<ApplicationStatus, string>> = { interested: "Applied", shortlisted: "Shortlisted", rejected: "Not selected" };
const STATUS: Readonly<Record<JobStatus, string>> = { draft: "Draft", active: "Published", closed: "Closed" };
const GENDER: Readonly<Record<string, string>> = { any: "Anyone", male: "Male", female: "Female", other: "Other" };

function facts(v: JobView): string {
  const pay = [v.compensation.amount, v.compensation.type].filter(Boolean).join(" ");
  const schedule = [v.hoursPerDay ? `${v.hoursPerDay} hours a day` : null, v.daysPerWeek ? `${v.daysPerWeek} days a week` : null].filter(Boolean).join(", ");
  const period = v.availableFrom || v.availableTo ? `${v.availableFrom ?? "now"} to ${v.availableTo ?? "open"}` : null;
  const age = v.criteria.minAge || v.criteria.maxAge ? `${v.criteria.minAge ?? "any"} to ${v.criteria.maxAge ?? "any"}` : null;
  const row = (label: string, value: string | null) => (value ? `<div><dt>${label}</dt><dd>${html(value)}</dd></div>` : "");
  return `<dl>${row("Company", `${v.company} · ${v.store}`)}${row("Area", v.area)}${row("Pay", pay || null)}${row("Pay details", v.compensation.description)}${row("Schedule", schedule || null)}${row("Period", period)}${row("Preferred age", age)}${v.criteria.gender !== "any" ? row("Preferred", GENDER[v.criteria.gender] ?? v.criteria.gender) : ""}${row("Skills", v.skills.join(", ") || null)}</dl>`;
}

export function renderBoard(b: { jobs: readonly JobView[]; total: number; page: number; pageSize: number; q: string | null; applied: boolean }): string {
  const qs = (page: number) => new URLSearchParams({ ...(b.q ? { q: b.q } : {}), ...(b.applied ? { applied: "1" } : {}), ...(page > 1 ? { page: String(page) } : {}) }).toString();
  const item = (v: JobView) => `<li><h2><a class="text-link" href="/recruit/jobs/${html(v.jobId)}">${html(v.position)}</a>${v.application ? ` <span class="badge">${APPLICATION[v.application]}</span>` : ""}${v.status === "closed" ? ' <span class="badge">Closed</span>' : ""}</h2><p>${html(v.company)} · ${html(v.store)}${v.area ? ` · ${html(v.area)}` : ""}</p></li>`;
  const pages = b.total > b.page * b.pageSize || b.page > 1 ? `<nav aria-label="Pages">${b.page > 1 ? `<a class="text-link" href="/recruit/jobs?${html(qs(b.page - 1))}">Previous</a> ` : ""}${b.total > b.page * b.pageSize ? `<a class="text-link" href="/recruit/jobs?${html(qs(b.page + 1))}">Next</a>` : ""}</nav>` : "";
  return `<main id="main" class="profile-main"><h1>${b.applied ? "My applications" : "Jobs"}<span class="accent">.</span></h1><p>${b.applied ? '<a class="text-link" href="/recruit/jobs">Browse jobs</a>' : '<a class="text-link" href="/recruit/jobs?applied=1">My applications</a>'}</p><form method="get" action="/recruit/jobs" role="search">${b.applied ? '<input type="hidden" name="applied" value="1">' : ""}<label for="q">Search</label> <input id="q" name="q" maxlength="100" value="${html(b.q ?? "")}"> <button class="button" type="submit">Search</button></form>${b.jobs.length ? `<ol class="plain">${b.jobs.map(item).join("")}</ol>` : `<p>${b.applied ? "You have not applied to a job yet." : "No jobs match right now."}</p>`}${pages}</main>`;
}

export function renderJob(v: JobView, staff: boolean): string {
  const apply = v.canApply ? `<form method="post" action="/recruit/jobs/${html(v.jobId)}/apply"><p><label for="note">Note (optional)</label><br><textarea id="note" name="note" maxlength="2000" rows="3"></textarea></p><button class="button primary" type="submit">Apply</button></form>`
    : v.application ? `<p><span class="badge">${APPLICATION[v.application]}</span></p>` : "<p>This job is not taking applications.</p>";
  return `<main id="main" class="profile-main"><h1>${html(v.position)}<span class="accent">.</span></h1>${v.positionAr ? `<p lang="ar" dir="rtl">${html(v.positionAr)}</p>` : ""}${facts(v)}${v.description ? `<p style="white-space:pre-wrap">${html(v.description)}</p>` : ""}${v.descriptionAr ? `<p lang="ar" dir="rtl" style="white-space:pre-wrap">${html(v.descriptionAr)}</p>` : ""}${apply}<p>${staff ? `<a class="text-link" href="/recruit/staff/jobs/${html(v.jobId)}">Manage this job</a> · ` : ""}<a class="text-link" href="/recruit/jobs">All jobs</a></p></main>`;
}

function jobForm(action: string, v: StaffJobView | null, requestId: string | null): string {
  const val = (x: string | number | null | undefined) => html(x === null || x === undefined ? "" : String(x));
  const input = (name: string, label: string, value: string | number | null | undefined, extra = "") => `<p><label for="${name}">${label}</label> <input id="${name}" name="${name}" value="${val(value)}"${extra}></p>`;
  const area = (name: string, label: string, value: string | null | undefined, max: number, extra = "") => `<p><label for="${name}">${label}</label><br><textarea id="${name}" name="${name}" maxlength="${max}" rows="4"${extra}>${val(value)}</textarea></p>`;
  const select = (name: string, label: string, options: readonly string[], labels: Readonly<Record<string, string>>, value: string) => `<p><label for="${name}">${label}</label> <select id="${name}" name="${name}">${options.map((o) => `<option value="${o}"${o === value ? " selected" : ""}>${labels[o] ?? o}</option>`).join("")}</select></p>`;
  return `<form method="post" action="${action}">${input("requestId", "Request id", v?.requestId ?? requestId, ' required maxlength="36"')}${input("position", "Position", v?.position, ' required maxlength="255"')}${input("positionAr", "Position (Arabic)", v?.positionAr, ' maxlength="255" dir="rtl"')}
${area("description", "Description", v?.description, 10000)}${area("descriptionAr", "Description (Arabic)", v?.descriptionAr, 10000, ' dir="rtl"')}${input("areaId", "Area id (optional)", v?.areaId, ' maxlength="36"')}
${input("hoursPerDay", "Hours a day", v?.hoursPerDay, ' inputmode="numeric" maxlength="2"')}${input("daysPerWeek", "Days a week", v?.daysPerWeek, ' inputmode="numeric" maxlength="1"')}${input("compensationType", "Pay type", v?.compensation.type, ' maxlength="64"')}${input("compensationAmount", "Pay amount", v?.compensation.amount, ' maxlength="255"')}
${area("compensationDescription", "Pay details", v?.compensation.description, 2000)}${area("compensationDescriptionAr", "Pay details (Arabic)", v?.compensation.descriptionAr, 2000, ' dir="rtl"')}${input("minAge", "Preferred minimum age", v?.criteria.minAge, ' inputmode="numeric" maxlength="2"')}${input("maxAge", "Preferred maximum age", v?.criteria.maxAge, ' inputmode="numeric" maxlength="2"')}
${select("gender", "Preferred (information only)", JOB_GENDERS, GENDER, v?.criteria.gender ?? "any")}${input("availableFrom", "Available from", v?.availableFrom, ' type="date"')}${input("availableTo", "Available to", v?.availableTo, ' type="date"')}${area("skills", "Skills (comma or one per line)", v?.skills.join("\n"), 3500)}
${select("status", "Status", JOB_STATUSES, STATUS, v?.status ?? "draft")}<button class="button primary" type="submit">Save job</button></form>`;
}

export function renderStaffJobs(jobs: readonly StaffJobView[], requestId: string | null): string {
  const rows = jobs.map((v) => `<li><a class="text-link" href="/recruit/staff/jobs/${html(v.jobId)}">${html(v.position)}</a> · ${html(v.company)} · ${html(v.store)} · ${STATUS[v.status]} · ${v.applications} applied</li>`).join("");
  return `<main id="main" class="profile-main"><h1>Jobs<span class="accent">.</span></h1><p>${JOB_STATUSES.map((s) => `<a class="text-link" href="/recruit/staff/jobs?status=${s}">${STATUS[s]}</a>`).join(" · ")} · <a class="text-link" href="/recruit/staff/jobs">All</a></p>${rows ? `<ol>${rows}</ol>` : "<p>No jobs yet.</p>"}<h2>New job</h2>${jobForm("/recruit/staff/jobs", null, requestId)}</main>`;
}

export function renderStaffJob(v: StaffJobView, applications: readonly ApplicationView[]): string {
  const action = (a: ApplicationView, to: "shortlist" | "reject", label: string) => `<form method="post" action="/recruit/staff/applications/${html(a.applicationId)}/${to}"><input type="hidden" name="jobId" value="${html(v.jobId)}"><button class="button" type="submit">${label}</button></form>`;
  const rows = applications.map((a) => `<li>${html(a.personName ?? "Unnamed person")} · ${APPLICATION[a.status]} · <time datetime="${html(a.appliedAt)}">${html(when(a.appliedAt))}</time>${a.note ? `<p style="white-space:pre-wrap">${html(a.note)}</p>` : ""}${a.status === "interested" ? action(a, "shortlist", "Shortlist") : ""}${a.status !== "rejected" ? action(a, "reject", "Reject") : ""}</li>`).join("");
  return `<main id="main" class="profile-main"><h1>${html(v.position)}<span class="accent">.</span></h1><p>${html(v.company)} · ${html(v.store)} · ${STATUS[v.status]} · <a class="text-link" href="/recruit/staff/requests/${html(v.requestId)}">Pipeline</a></p><h2>Applications</h2>${rows ? `<ol>${rows}</ol>` : "<p>No one has applied yet.</p>"}<h2>Edit</h2>${jobForm(`/recruit/staff/jobs/${html(v.jobId)}`, v, null)}<p><a class="text-link" href="/recruit/staff/jobs">All jobs</a></p></main>`;
}

const BOARD = "/recruit/jobs", JOB = /^\/recruit\/jobs\/([^/]+)$/, APPLY = /^\/recruit\/jobs\/([^/]+)\/apply$/, STAFF = "/recruit/staff/jobs", STAFF_JOB = /^\/recruit\/staff\/jobs\/([^/]+)$/, DECIDE = /^\/recruit\/staff\/applications\/([^/]+)\/(shortlist|reject)$/;

export async function handleRecruitJobs(req: IncomingMessage, res: ServerResponse, s: RecruitJobs | undefined, origin: string | undefined, write: RecruitPageWriter, wantsHtml: boolean): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x"), path = url.pathname;
  const job = JOB.exec(path), apply = APPLY.exec(path), staffJob = STAFF_JOB.exec(path), decide = DECIDE.exec(path);
  if (path !== BOARD && path !== STAFF && !job && !apply && !staffJob && !decide) return false;
  const back = path.startsWith("/recruit/staff/") ? { href: STAFF, label: "Back to jobs" } : { href: BOARD, label: "Back to jobs" };
  try {
    if (!s || !origin) { wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } }); return true; }
    const session = sessionCookie(req.headers.cookie);
    if (req.method === "GET" && !apply && !decide) {
      if (path === BOARD) {
        const r = await s.board(session, url.searchParams);
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, r.body.applied ? "My applications" : "Jobs", renderBoard(r.body)); else errorPage(write, r.status, back);
      } else if (job) {
        const r = await s.job(session, decodeSegment(job));
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, r.body.job.position, renderJob(r.body.job, r.body.staff)); else errorPage(write, r.status, back);
      } else if (path === STAFF) {
        const r = await s.staffList(session, url.searchParams);
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, "Jobs", renderStaffJobs(r.body.jobs, r.body.requestId)); else errorPage(write, r.status, back);
      } else {
        const r = await s.staffJob(session, decodeSegment(staffJob!));
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, r.body.job.position, renderStaffJob(r.body.job, r.body.applications)); else errorPage(write, r.status, back);
      }
      return true;
    }
    if (req.method !== "POST" || path === BOARD || job) { sendJson(res, NOT_FOUND); return true; }
    if (!sameOrigin(req, origin)) { req.resume(); sendJson(res, { status: 403, body: { error: "origin_rejected" } }); return true; }
    const body = await readBody(req, 65536);
    if (!body) { sendJson(res, BAD); return true; }
    let r: RecruitResult<unknown>, location: string;
    if (apply) {
      const jobId = decodeSegment(apply);
      r = await s.apply(session, jobId, body.value);
      location = `/recruit/jobs/${encodeURIComponent(jobId)}`;
    } else if (decide) {
      const jobId = body.form ? (body.value as Record<string, string>).jobId : undefined;
      r = await s.decide(session, decodeSegment(decide), decide[2] === "shortlist" ? "shortlisted" : "rejected");
      location = isRecruitId(jobId) ? `/recruit/staff/jobs/${jobId.toLowerCase()}` : STAFF;
    } else {
      r = await s.save(session, staffJob ? decodeSegment(staffJob) : null, body.value);
      location = r.status === 200 ? `/recruit/staff/jobs/${(r.body as { jobId: string }).jobId}` : STAFF;
    }
    if (body.form) { if (r.status === 200) redirect(res, location); else errorPage(write, r.status, back); }
    else sendJson(res, r);
  } catch {
    if (!res.headersSent) wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } });
    else res.destroy();
  }
  return true;
}
