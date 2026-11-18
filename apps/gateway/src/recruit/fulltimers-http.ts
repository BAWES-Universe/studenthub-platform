import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { FULLTIMER_GENDERS, FULLTIMER_PAGE_SIZE, isRecruitId, parseFulltimer, parseFulltimerQuery, type FulltimerFields } from "../../../../packages/recruit/src/index.js";
import { BAD, NOT_FOUND, UNAUTHORIZED, decodeSegment, errorPage, html, readBody, redirect, sameOrigin, sendJson, sessionCookie, type RecruitPageWriter, type RecruitResult } from "./http-common.js";

// Recruit R9: full-timers (staff and recruiters of the operator only).
//   GET  /recruit/staff/fulltimers                 list (?q=, ?currency=, ?tag=, ?archived=1, ?page=, ?request= to suggest) and the new form
//   POST /recruit/staff/fulltimers                 create
//   GET  /recruit/staff/fulltimers/<id>            record, its requests and the edit form
//   POST /recruit/staff/fulltimers/<id>            update
//   POST /recruit/staff/fulltimers/<id>/(archive|restore)

type WriteResult = { kind: "saved"; fulltimerId: string } | { kind: "not_found" } | { kind: "duplicate"; field: "name" | "phone"; fulltimerId: string } | { kind: "reference_invalid"; field: string };
export interface FulltimerRow {
  readonly id: string; readonly name: string; readonly phone: string | null; readonly email: string | null; readonly nationality_id: string | null; readonly nationality_name: string | null; readonly country_id: string | null; readonly country_name: string | null;
  readonly area_id: string | null; readonly area_name: string | null; readonly university_id: string | null; readonly university_name: string | null; readonly latitude: string | null; readonly longitude: string | null;
  readonly gender: "male" | "female" | "other" | null; readonly birth_date: string | null; readonly employed: boolean | null; readonly driving_licence: boolean | null; readonly current_salary: string | null; readonly expected_salary: string | null;
  readonly currency_code: string; readonly tags: readonly string[]; readonly skills: readonly string[]; readonly experience: readonly string[]; readonly legacy_cv_reference: string | null; readonly archived_at: string | Date | null;
}
export interface RecruitFulltimersStore {
  create(principalId: string, input: FulltimerFields): Promise<WriteResult>;
  update(principalId: string, fulltimerId: string, input: FulltimerFields): Promise<WriteResult>;
  archive(principalId: string, fulltimerId: string, archived: boolean): Promise<WriteResult>;
  list(principalId: string, query: { q: string | null; currency: string; tag: string | null; archived: boolean; page: number }): Promise<{ rows: readonly FulltimerRow[]; total: number } | null>;
  get(principalId: string, fulltimerId: string): Promise<{ fulltimer: FulltimerRow; cards: readonly { card_id: string; request_id: string; position_title: string; org_name: string; stage: string }[] } | null>;
}
export interface FulltimerView {
  readonly fulltimerId: string; readonly name: string; readonly phone: string | null; readonly email: string | null;
  readonly nationality: { id: string; name: string | null } | null; readonly country: { id: string; name: string | null } | null; readonly area: { id: string; name: string | null } | null; readonly university: { id: string; name: string | null } | null;
  readonly location: { latitude: number; longitude: number } | null; readonly gender: string | null; readonly birthDate: string | null; readonly employed: boolean | null; readonly drivingLicence: boolean | null;
  readonly currentSalary: string | null; readonly expectedSalary: string | null; readonly currencyCode: string; readonly tags: readonly string[]; readonly skills: readonly string[]; readonly experience: readonly string[];
  readonly cvReference: string | null; readonly archived: boolean;
}
export interface RecruitFulltimers {
  list(session: string | undefined, params: URLSearchParams): Promise<RecruitResult<{ fulltimers: readonly FulltimerView[]; total: number; page: number; pageSize: number; requestId: string | null; query: Record<string, string> }>>;
  get(session: string | undefined, fulltimerId: string): Promise<RecruitResult<{ fulltimer: FulltimerView; requests: readonly { cardId: string; requestId: string; positionTitle: string; company: string; stage: string }[] }>>;
  save(session: string | undefined, fulltimerId: string | null, body: unknown): Promise<RecruitResult<{ fulltimerId: string }>>;
  archive(session: string | undefined, fulltimerId: string, archived: boolean): Promise<RecruitResult<{ fulltimerId: string; archived: boolean }>>;
}

const ref = (id: string | null, name: string | null) => (id ? { id, name } : null);
export function fulltimerView(r: FulltimerRow): FulltimerView {
  return {
    fulltimerId: r.id, name: r.name, phone: r.phone, email: r.email, nationality: ref(r.nationality_id, r.nationality_name), country: ref(r.country_id, r.country_name), area: ref(r.area_id, r.area_name), university: ref(r.university_id, r.university_name),
    location: r.latitude !== null && r.longitude !== null ? { latitude: Number(r.latitude), longitude: Number(r.longitude) } : null, gender: r.gender, birthDate: r.birth_date, employed: r.employed, drivingLicence: r.driving_licence,
    currentSalary: r.current_salary, expectedSalary: r.expected_salary, currencyCode: r.currency_code, tags: [...r.tags], skills: [...r.skills], experience: [...r.experience], cvReference: r.legacy_cv_reference, archived: r.archived_at !== null,
  };
}
const kuwaitToday = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuwait", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
function written(r: WriteResult): RecruitResult<{ fulltimerId: string }> {
  if (r.kind === "saved") return { status: 200, body: { fulltimerId: r.fulltimerId } };
  if (r.kind === "not_found") return NOT_FOUND;
  if (r.kind === "duplicate") return { status: 409, body: { error: "duplicate", field: r.field, fulltimerId: r.fulltimerId } };
  return { status: 400, body: { error: "reference_invalid", field: r.field } };
}

export function createRecruitFulltimers(p: { sessions: Pick<SessionStore, "get">; store: RecruitFulltimersStore; now?: () => Date }): RecruitFulltimers {
  const principal = async (s: string | undefined) => (s ? (await p.sessions.get(s))?.personId : undefined);
  return {
    async list(s, params) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      const raw: Record<string, string | string[]> = {};
      for (const [k, v] of params) raw[k] = k in raw ? [raw[k] as string, v].flat() : v;
      const query = parseFulltimerQuery(raw);
      const request = typeof raw.request === "string" ? raw.request : undefined;
      if (!query || (request !== undefined && !isRecruitId(request))) return BAD;
      const r = await p.store.list(id, query);
      if (!r) return NOT_FOUND;
      const echo: Record<string, string> = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "page") as [string, string][]);
      return { status: 200, body: { fulltimers: r.rows.map(fulltimerView), total: r.total, page: query.page, pageSize: FULLTIMER_PAGE_SIZE, requestId: request?.toLowerCase() ?? null, query: echo } };
    },
    async get(s, fulltimerId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(fulltimerId)) return NOT_FOUND;
      const r = await p.store.get(id, fulltimerId.toLowerCase());
      if (!r) return NOT_FOUND;
      return { status: 200, body: { fulltimer: fulltimerView(r.fulltimer), requests: r.cards.map((c) => ({ cardId: c.card_id, requestId: c.request_id, positionTitle: c.position_title, company: c.org_name, stage: c.stage })) } };
    },
    async save(s, fulltimerId, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (fulltimerId !== null && !isRecruitId(fulltimerId)) return NOT_FOUND;
      const fields = parseFulltimer(body, kuwaitToday((p.now ?? (() => new Date()))()));
      if (!fields) return BAD;
      return written(fulltimerId === null ? await p.store.create(id, fields) : await p.store.update(id, fulltimerId.toLowerCase(), fields));
    },
    async archive(s, fulltimerId, archived) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(fulltimerId)) return NOT_FOUND;
      const r = written(await p.store.archive(id, fulltimerId.toLowerCase(), archived));
      return r.status === 200 ? { status: 200, body: { fulltimerId: r.body.fulltimerId, archived } } : r;
    },
  };
}

const GENDER: Readonly<Record<string, string>> = { male: "Male", female: "Female", other: "Other" };
const STAGE: Readonly<Record<string, string>> = { suggested: "Suggested", contacted: "Contacted", interviewing: "Interviewing", offered: "Offered", placed: "Placed", withdrawn: "Withdrawn" };

function form(action: string, v: FulltimerView | null): string {
  const val = (x: string | number | null | undefined) => html(x === null || x === undefined ? "" : String(x));
  const input = (name: string, label: string, value: string | number | null | undefined, extra = "") => `<p><label for="${name}">${label}</label> <input id="${name}" name="${name}" value="${val(value)}"${extra}></p>`;
  const lines = (name: string, label: string, value: readonly string[] | undefined) => `<p><label for="${name}">${label}</label><br><textarea id="${name}" name="${name}" rows="3">${val(value?.join("\n"))}</textarea></p>`;
  const choice = (name: string, label: string, value: boolean | null | undefined) => `<p><label for="${name}">${label}</label> <select id="${name}" name="${name}"><option value=""${value == null ? " selected" : ""}>Not known</option><option value="true"${value === true ? " selected" : ""}>Yes</option><option value="false"${value === false ? " selected" : ""}>No</option></select></p>`;
  return `<form method="post" action="${action}">${input("name", "Name", v?.name, ' required maxlength="255"')}${input("phone", "Phone", v?.phone, ' maxlength="40" inputmode="tel"')}${input("email", "Email", v?.email, ' type="email" maxlength="254"')}
<p><label for="gender">Gender</label> <select id="gender" name="gender"><option value="">Not given</option>${FULLTIMER_GENDERS.map((g) => `<option value="${g}"${v?.gender === g ? " selected" : ""}>${GENDER[g]}</option>`).join("")}</select></p>
${input("birthDate", "Birth date", v?.birthDate, ' type="date"')}${choice("employed", "Employed now", v?.employed)}${choice("drivingLicence", "Driving licence", v?.drivingLicence)}
${input("nationalityId", "Nationality id", v?.nationality?.id, ' maxlength="36"')}${input("countryId", "Country id", v?.country?.id, ' maxlength="36"')}${input("areaId", "Area id", v?.area?.id, ' maxlength="36"')}${input("universityId", "University id", v?.university?.id, ' maxlength="36"')}
${input("latitude", "Latitude", v?.location?.latitude, ' inputmode="decimal" maxlength="12"')}${input("longitude", "Longitude", v?.location?.longitude, ' inputmode="decimal" maxlength="12"')}
${input("currentSalary", "Current salary", v?.currentSalary, ' maxlength="64"')}${input("expectedSalary", "Expected salary", v?.expectedSalary, ' maxlength="64"')}${input("currencyCode", "Currency", v?.currencyCode ?? "KWD", ' maxlength="3" required')}
${lines("tags", "Tags (comma or one per line)", v?.tags)}${lines("skills", "Skills", v?.skills)}${lines("experience", "Experience (one per line)", v?.experience)}${input("cvReference", "CV file reference", v?.cvReference, ' maxlength="1024"')}
<button class="button primary" type="submit">Save</button></form>`;
}

export function renderFulltimers(b: { fulltimers: readonly FulltimerView[]; total: number; page: number; pageSize: number; requestId: string | null; query: Record<string, string> }): string {
  const qs = (extra: Record<string, string>) => new URLSearchParams({ ...b.query, ...extra }).toString();
  const suggest = (v: FulltimerView) => (b.requestId && !v.archived ? ` <form method="post" action="/recruit/staff/requests/${html(b.requestId)}/cards"><input type="hidden" name="fulltimerId" value="${html(v.fulltimerId)}"><button class="button" type="submit">Suggest to the request</button></form>` : "");
  const rows = b.fulltimers.map((v) => `<li><a class="text-link" href="/recruit/staff/fulltimers/${html(v.fulltimerId)}">${html(v.name)}</a>${v.phone ? ` · ${html(v.phone)}` : ""}${v.expectedSalary ? ` · expects ${html(v.expectedSalary)} ${html(v.currencyCode)}` : ""}${v.tags.length ? ` · ${v.tags.map(html).join(", ")}` : ""}${suggest(v)}</li>`).join("");
  const pages = `${b.page > 1 ? `<a class="text-link" href="/recruit/staff/fulltimers?${html(qs({ page: String(b.page - 1) }))}">Previous</a> ` : ""}${b.total > b.page * b.pageSize ? `<a class="text-link" href="/recruit/staff/fulltimers?${html(qs({ page: String(b.page + 1) }))}">Next</a>` : ""}`;
  return `<main id="main" class="profile-main"><h1>Full-timers<span class="accent">.</span></h1>${b.requestId ? `<p>Choose someone to suggest, or <a class="text-link" href="/recruit/staff/requests/${html(b.requestId)}">go back to the pipeline</a>.</p>` : ""}
<form method="get" action="/recruit/staff/fulltimers" role="search">${b.requestId ? `<input type="hidden" name="request" value="${html(b.requestId)}">` : ""}<label for="q">Search</label> <input id="q" name="q" maxlength="100" value="${html(b.query.q ?? "")}"> <label for="tag">Tag</label> <input id="tag" name="tag" maxlength="100" value="${html(b.query.tag ?? "")}"> <label for="currency">Currency</label> <input id="currency" name="currency" maxlength="3" value="${html(b.query.currency ?? "KWD")}"> <button class="button" type="submit">Search</button></form>
<p>${b.total} found. ${b.query.archived ? `<a class="text-link" href="/recruit/staff/fulltimers">Show current</a>` : `<a class="text-link" href="/recruit/staff/fulltimers?archived=1">Show archived</a>`}</p>${rows ? `<ol>${rows}</ol>` : "<p>No full-timers match.</p>"}${pages ? `<nav aria-label="Pages">${pages}</nav>` : ""}<h2>New full-timer</h2>${form("/recruit/staff/fulltimers", null)}</main>`;
}

export function renderFulltimer(v: FulltimerView, requests: readonly { cardId: string; requestId: string; positionTitle: string; company: string; stage: string }[]): string {
  const row = (label: string, value: string | null | undefined) => (value ? `<div><dt>${label}</dt><dd>${html(value)}</dd></div>` : "");
  const yes = (b: boolean | null) => (b === null ? null : b ? "Yes" : "No");
  const facts = [row("Phone", v.phone), row("Email", v.email), row("Gender", v.gender ? GENDER[v.gender] ?? v.gender : null), row("Birth date", v.birthDate), row("Employed now", yes(v.employed)), row("Driving licence", yes(v.drivingLicence)),
    row("Nationality", v.nationality?.name), row("Country", v.country?.name), row("Area", v.area?.name), row("University", v.university?.name), row("Current salary", v.currentSalary ? `${v.currentSalary} ${v.currencyCode}` : null),
    row("Expected salary", v.expectedSalary ? `${v.expectedSalary} ${v.currencyCode}` : null), row("Tags", v.tags.join(", ")), row("Skills", v.skills.join(", ")), row("CV file", v.cvReference)].join("");
  const toggle = `<form method="post" action="/recruit/staff/fulltimers/${html(v.fulltimerId)}/${v.archived ? "restore" : "archive"}"><button class="button" type="submit">${v.archived ? "Restore" : "Archive"}</button></form>`;
  const list = requests.map((r) => `<li><a class="text-link" href="/recruit/staff/requests/${html(r.requestId)}">${html(r.positionTitle)}</a> · ${html(r.company)} · ${html(STAGE[r.stage] ?? r.stage)}</li>`).join("");
  return `<main id="main" class="profile-main"><h1>${html(v.name)}<span class="accent">.</span>${v.archived ? ' <span class="badge">Archived</span>' : ""}</h1><dl>${facts}</dl>${v.experience.length ? `<h2>Experience</h2><ul>${v.experience.map((e) => `<li>${html(e)}</li>`).join("")}</ul>` : ""}
<h2>Requests</h2>${list ? `<ul>${list}</ul>` : "<p>Not suggested to a request yet.</p>"}${toggle}<h2>Edit</h2>${form(`/recruit/staff/fulltimers/${html(v.fulltimerId)}`, v)}<p><a class="text-link" href="/recruit/staff/fulltimers">All full-timers</a></p></main>`;
}

const LIST = "/recruit/staff/fulltimers", ONE = /^\/recruit\/staff\/fulltimers\/([^/]+)$/, TOGGLE = /^\/recruit\/staff\/fulltimers\/([^/]+)\/(archive|restore)$/;

type DuplicateBody = { readonly error: "duplicate"; readonly field: "name" | "phone"; readonly fulltimerId: string };
const isDuplicate = (r: { readonly status: number; readonly body: unknown }): r is { status: 409; body: DuplicateBody } => r.status === 409 && (r.body as { error?: unknown }).error === "duplicate";

/** As legacy did, a refused duplicate names the record that already holds the name or phone. */
export function renderDuplicate(b: DuplicateBody): string {
  return `<main id="main" class="error-page"><h1>A full-timer with this ${b.field === "name" ? "name" : "phone number"} already exists.</h1><p><a class="text-link" href="/recruit/staff/fulltimers/${html(b.fulltimerId)}">Open the existing full-timer</a></p><p><a class="text-link" href="${LIST}">Back to full-timers</a></p></main>`;
}

export async function handleRecruitFulltimers(req: IncomingMessage, res: ServerResponse, s: RecruitFulltimers | undefined, origin: string | undefined, write: RecruitPageWriter, wantsHtml: boolean): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x"), path = url.pathname;
  const one = ONE.exec(path), toggle = TOGGLE.exec(path);
  if (path !== LIST && !one && !toggle) return false;
  const back = { href: LIST, label: "Back to full-timers" };
  try {
    if (!s || !origin) { wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } }); return true; }
    const session = sessionCookie(req.headers.cookie);
    if (req.method === "GET" && !toggle) {
      if (path === LIST) {
        const r = await s.list(session, url.searchParams);
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, "Full-timers", renderFulltimers(r.body)); else errorPage(write, r.status, back);
      } else {
        const r = await s.get(session, decodeSegment(one!));
        if (!wantsHtml) sendJson(res, r); else if (r.status === 200) write(200, r.body.fulltimer.name, renderFulltimer(r.body.fulltimer, r.body.requests)); else errorPage(write, r.status, back);
      }
      return true;
    }
    if (req.method !== "POST") { sendJson(res, NOT_FOUND); return true; }
    if (!sameOrigin(req, origin)) { req.resume(); sendJson(res, { status: 403, body: { error: "origin_rejected" } }); return true; }
    const body = await readBody(req, 32768);
    if (!body) { sendJson(res, BAD); return true; }
    const r: RecruitResult<{ fulltimerId: string }> = toggle ? await s.archive(session, decodeSegment(toggle), toggle[2] === "archive") : await s.save(session, one ? decodeSegment(one) : null, body.value);
    if (body.form) { if (r.status === 200) redirect(res, `/recruit/staff/fulltimers/${r.body.fulltimerId}`); else if (isDuplicate(r)) write(409, "Full-timers", renderDuplicate(r.body)); else errorPage(write, r.status, back); }
    else sendJson(res, r);
  } catch {
    if (!res.headersSent) wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } });
    else res.destroy();
  }
  return true;
}
