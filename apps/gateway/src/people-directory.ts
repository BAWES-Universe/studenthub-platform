import type { AuthzStore } from "@studenthub/contracts";
import type { SessionStore } from "@studenthub/login-contract";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { PEOPLE_PAGE_SIZE, kuwaitDate, maskPhone, type PeopleCivilState, type PeopleDirectoryQuery, type PeopleDirectoryRow, type PeopleDirectoryStore, type PeopleWorkStatus } from "@studenthub/profile";

const PARAMETERS = new Set(["q", "status", "nationality", "civil", "details", "page"]);
const STATUSES = new Set<PeopleWorkStatus>(["not_looking", "active", "open_to_offers", "unset"]);
const CIVIL = new Set<PeopleCivilState>(["none", "waiting", "rejected", "expired", "checked", "recorded"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePeopleDirectoryQuery(parameters: URLSearchParams): PeopleDirectoryQuery | null {
  for (const key of new Set(parameters.keys())) if (!PARAMETERS.has(key) || parameters.getAll(key).length !== 1) return null;
  const query: { q?: string; status?: PeopleWorkStatus; nationality?: string; civil?: PeopleCivilState; details?: "complete" | "missing"; page: number } = { page: 1 };
  const q = parameters.get("q");
  if (q !== null && q !== "") { if (q.length > 100) return null; query.q = q; }
  const status = parameters.get("status");
  if (status) { if (!STATUSES.has(status as PeopleWorkStatus)) return null; query.status = status as PeopleWorkStatus; }
  const nationality = parameters.get("nationality");
  if (nationality) { if (!UUID.test(nationality)) return null; query.nationality = nationality.toLowerCase(); }
  const civil = parameters.get("civil");
  if (civil) { if (!CIVIL.has(civil as PeopleCivilState)) return null; query.civil = civil as PeopleCivilState; }
  const details = parameters.get("details");
  if (details) { if (details !== "complete" && details !== "missing") return null; query.details = details; }
  const page = parameters.get("page");
  if (page !== null) { if (!/^[1-9]\d{0,5}$/.test(page) || Number(page) > 999999) return null; query.page = Number(page); }
  return Object.freeze(query);
}

export async function isPeopleStaff(authz: Pick<AuthzStore, "listGrantsForPrincipal">, principalId: string): Promise<boolean> {
  const grants = await authz.listGrantsForPrincipal(principalId);
  return grants.some(grant => (grant.role === "staff" || grant.role === "admin") && grant.scope === "subtree"
    && (DEFAULT_OPERATOR_ORG_IDS as readonly string[]).includes(grant.orgId));
}

export type PeopleDirectoryResult = { readonly status: 200; readonly body: { readonly query: PeopleDirectoryQuery; readonly rows: readonly PeopleDirectoryRow[]; readonly total: number; readonly page: number; readonly pageSize: number; readonly countries?: readonly { readonly id: string; readonly name: string }[] } }
  | { readonly status: 400 | 401 | 404 | 503; readonly body: { readonly ok?: false; readonly error: string } };

export interface PeopleDirectoryPage {
  open(sessionId: string | undefined, parameters: URLSearchParams, html: boolean): Promise<PeopleDirectoryResult>;
  visible(sessionId: string | undefined): Promise<boolean>;
}

export function createPeopleDirectory(options: { sessions: Pick<SessionStore, "get">; authz: Pick<AuthzStore, "listGrantsForPrincipal">; store: PeopleDirectoryStore; choices: () => Promise<{ countries: readonly { id: string; name: string }[] }>; now?: () => Date }): PeopleDirectoryPage {
  return { async visible(sessionId) { try { const session=sessionId?await options.sessions.get(sessionId):undefined;return !!session&&await isPeopleStaff(options.authz,session.personId); } catch { return false; } }, async open(sessionId, parameters, html) {
    try {
      const session = sessionId ? await options.sessions.get(sessionId) : undefined;
      if (!session) return { status: 401, body: { error: "unauthorized" } };
      if (!await isPeopleStaff(options.authz, session.personId)) return { status: 404, body: { ok: false, error: "not_found" } };
      const query = parsePeopleDirectoryQuery(parameters);
      if (!query) return { status: 400, body: { error: "invalid_people_query" } };
      const today = kuwaitDate(options.now?.() ?? new Date());
      const [{ rows, total }, choices] = await Promise.all([options.store.page(query, today), html ? options.choices() : Promise.resolve(undefined)]);
      return { status: 200, body: { query, rows, total, page: query.page, pageSize: PEOPLE_PAGE_SIZE, ...(choices ? { countries: choices.countries } : {}) } };
    } catch { return { status: 503, body: { error: "directory_unavailable" } }; }
  } };
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const work = (value: PeopleDirectoryRow["workStatus"]) => value === "active" ? "Actively looking" : value === "open_to_offers" ? "Open to offers" : value === "not_looking" ? "Not looking right now" : "Not recorded";
const civil = (value: PeopleCivilState) => ({ none: "None", waiting: "Waiting", rejected: "Rejected", expired: "Expired", checked: "Checked", recorded: "Recorded" })[value];

export function peopleDirectoryJson(result: PeopleDirectoryResult): unknown {
  if (result.status !== 200) return result.body;
  return { rows: result.body.rows.map(row => ({ principalId: row.principalId, name: row.name ?? row.universeName ?? "Unnamed", arabicName: row.arabicName, workStatus: work(row.workStatus), nationality: row.nationality?.name ?? null, details: row.detailsMissing === 0 ? "Details complete" : `${row.detailsMissing} details missing`, civilIdState: civil(row.civilState), imported: row.imported, employeeId: row.employeeId, phone: row.phoneLast4 ? maskPhone(row.phoneLast4) : null })), total: result.body.total, page: result.body.page, pageSize: result.body.pageSize };
}

export function renderPeopleDirectory(result: PeopleDirectoryResult): string {
  if (result.status !== 200) return `<!doctype html><html><head><title>${result.status === 401 ? "Sign in" : "Not found"}</title></head><body><main><h1>${result.status === 401 ? "Sign in" : result.status === 400 ? "Invalid search" : "Not found"}</h1></main></body></html>`;
  const { query, rows, total, pageSize, countries = [] } = result.body;
  const option = (value: string, label: string, selected?: string) => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const form = `<form class="directory-filters" method="get" action="/workspace/people" role="search"><label>Search<input type="search" name="q" maxlength="100" value="${escapeHtml(query.q ?? "")}" placeholder="Name, employee ID, phone or profile link"></label><label>Work status<select name="status">${option("","Any status",query.status)}${option("active","Actively looking",query.status)}${option("open_to_offers","Open to offers",query.status)}${option("not_looking","Not looking right now",query.status)}${option("unset","Not recorded",query.status)}</select></label><label>Nationality<select name="nationality">${option("","Any nationality",query.nationality)}${countries.map(c=>option(c.id,c.name,query.nationality)).join("")}</select></label><label>Civil ID<select name="civil">${option("","Any state",query.civil)}${["none","waiting","rejected","expired","checked","recorded"].map(x=>option(x, civil(x as PeopleCivilState),query.civil)).join("")}</select></label><label>Details<select name="details">${option("","Any",query.details)}${option("complete","Details complete",query.details)}${option("missing","Details missing",query.details)}</select></label><button class="sign-out" type="submit">Search</button></form>`;
  const body = rows.map(row => `<tr><th scope="row">${escapeHtml(row.name ?? row.universeName ?? "Unnamed")}${row.arabicName ? `<span class="field-meta">${escapeHtml(row.arabicName)}</span>` : ""}${row.imported ? '<span class="badge">Imported</span>' : ""}${row.employeeId ? `<span class="field-meta">${escapeHtml(row.employeeId)}</span>` : ""}</th><td>${work(row.workStatus)}</td><td>${escapeHtml(row.nationality?.name ?? "Not recorded")}</td><td>${row.detailsMissing === 0 ? "Details complete" : `${row.detailsMissing} details missing`}</td><td>${civil(row.civilState)}</td><td>${row.phoneLast4 ? maskPhone(row.phoneLast4) : "Not recorded"}</td></tr>`).join("");
  const first = total ? (query.page - 1) * pageSize + 1 : 0, last = (query.page - 1) * pageSize + rows.length;
  const base = { ...(query.q ? { q: query.q } : {}), ...(query.status ? { status: query.status } : {}), ...(query.nationality ? { nationality: query.nationality } : {}), ...(query.civil ? { civil: query.civil } : {}), ...(query.details ? { details: query.details } : {}) };
  const pager = `${query.page > 1 ? `<a class="text-link" rel="prev" href="/workspace/people?${escapeHtml(String(new URLSearchParams({...base,page:String(query.page-1)})))}">← Previous</a>` : ""}${last < total ? `<a class="text-link" rel="next" href="/workspace/people?${escapeHtml(String(new URLSearchParams({...base,page:String(query.page+1)})))}">Next →</a>` : ""}`;
  const table = rows.length ? `<div class="directory-table"><table><caption>People ${first}–${last} of ${total}</caption><thead><tr><th>Name</th><th>Work status</th><th>Nationality</th><th>Details</th><th>Civil ID</th><th>Phone</th></tr></thead><tbody>${body}</tbody></table></div>` : `<p class="empty-contexts" role="status">${total ? "There are no more people on this page." : "No people match these filters."}</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>People · StudentHub</title><link rel="stylesheet" href="/assets/studenthub.css"></head><body><header class="topbar"><a class="brand" href="/">StudentHub</a><form action="/logout" method="post"><button class="sign-out">Sign out</button></form></header><div class="workspace"><aside class="sidebar"><nav aria-label="Workspace"><a class="nav-item" href="/profile">My profile</a><a class="nav-item" href="/workspace">Workspaces</a><a class="nav-item active" aria-current="page" href="/workspace/people">People</a></nav></aside><main id="main" class="profile-main"><div class="profile-heading"><div><div class="eyebrow">STAFF DIRECTORY</div><h1>People<span class="accent">.</span></h1><p>Everyone who has signed in to StudentHub.</p></div><span class="badge">Read-only</span></div>${form}${table}${pager ? `<nav class="pager" aria-label="Pages">${pager}</nav>` : ""}<section class="next-note"><p>Photo and ID images are checked on the person's page.</p><p>Until the final import, search, filters and details use values held in the platform.</p></section><footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div></body></html>`;
}
