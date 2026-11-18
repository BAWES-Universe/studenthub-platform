import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import {
  PEOPLE_SEARCH_PAGE_SIZE, facetView, parsePeopleSearch, searchPersonView, searchQueryString,
  type FacetValue, type PeopleSearchQuery, type SearchFacet, type SearchFacetRow, type SearchPersonRow, type SearchPersonView,
} from "../../../../packages/recruit/src/index.js";
import { BAD, NOT_FOUND, UNAUTHORIZED, errorPage, html, sendJson, sessionCookie, type RecruitPageWriter, type RecruitResult } from "./http-common.js";

// Recruit R3: GET /recruit/staff/people searches people looking for work (JSON or HTML).
// Facets repeat their key (?area=a&area=b); the page is a plain GET form, so a search is a link.

export interface RecruitPeopleSearchStore {
  search(principalId: string, query: PeopleSearchQuery): Promise<{ rows: readonly SearchPersonRow[]; total: number; facets: readonly SearchFacetRow[] } | null>;
}
export interface PeopleSearchBody {
  readonly people: readonly SearchPersonView[]; readonly total: number; readonly page: number; readonly pageSize: number;
  readonly facets: Readonly<Record<SearchFacet, readonly FacetValue[]>>; readonly query: PeopleSearchQuery;
}
export interface RecruitPeopleSearch { search(session: string | undefined, params: URLSearchParams): Promise<RecruitResult<PeopleSearchBody>> }

export function createRecruitPeopleSearch(p: { sessions: Pick<SessionStore, "get">; store: RecruitPeopleSearchStore }): RecruitPeopleSearch {
  return {
    async search(s, params) {
      const id = s ? (await p.sessions.get(s))?.personId : undefined;
      if (!id) return UNAUTHORIZED;
      const raw: Record<string, string[]> = {};
      for (const [k, v] of params) (raw[k] ??= []).push(v);
      const query = parsePeopleSearch(raw);
      if (!query) return BAD;
      const r = await p.store.search(id, query);
      if (!r) return NOT_FOUND;
      return { status: 200, body: { people: r.rows.map(searchPersonView), total: r.total, page: query.page, pageSize: PEOPLE_SEARCH_PAGE_SIZE, facets: facetView(r.facets, query), query } };
    },
  };
}

const FACET_TITLE: Readonly<Record<SearchFacet, string>> = { availability: "Availability", area: "Area", nationality: "Nationality", university: "University", gender: "Gender", drivingLicence: "Driving licence" };
const ORDER: readonly SearchFacet[] = ["availability", "area", "nationality", "university", "gender", "drivingLicence"];

export function renderPeopleSearch(body: PeopleSearchBody): string {
  const facet = (name: SearchFacet) => {
    const values = body.facets[name];
    if (!values.length) return "";
    const boxes = values.map((v) => `<li><label><input type="checkbox" name="${name}" value="${html(v.value)}"${v.selected ? " checked" : ""}> ${html(v.label)} <span class="muted">(${v.count})</span></label></li>`).join("");
    return `<fieldset><legend>${FACET_TITLE[name]}</legend><ul class="plain">${boxes}</ul></fieldset>`;
  };
  const person = (v: SearchPersonView) => {
    const facts = [v.availability === "active" ? "Actively looking" : "Open to offers", v.area, v.nationality, ...v.universities, v.drivingLicence === true ? "Driving licence" : null].filter((x): x is string => Boolean(x));
    return `<li><p><strong>${html(v.name ?? "Unnamed person")}</strong>${v.arabicName ? ` <span dir="rtl" lang="ar">${html(v.arabicName)}</span>` : ""}${v.complete ? "" : ` <span class="muted">(profile incomplete)</span>`}</p>${v.objective ? `<p>${html(v.objective)}</p>` : ""}<p class="muted">${facts.map(html).join(" · ")}</p><p class="muted">Person id (to invite or add to a pipeline): <code>${html(v.personId)}</code></p></li>`;
  };
  const pages = Math.max(1, Math.ceil(body.total / body.pageSize));
  const link = (page: number, label: string) => `<a class="text-link" href="/recruit/staff/people${searchQueryString(body.query, page) ? `?${searchQueryString(body.query, page)}` : ""}">${label}</a>`;
  const paging = pages > 1 ? `<p>${body.page > 1 ? link(body.page - 1, "Previous") : ""} Page ${body.page} of ${pages} ${body.page < pages ? link(body.page + 1, "Next") : ""}</p>` : "";
  const results = body.people.length ? `<ol>${body.people.map(person).join("")}</ol>` : "<p>No one matches this search.</p>";
  return `<main id="main" class="profile-main"><h1>Find people<span class="accent">.</span></h1><form method="get" action="/recruit/staff/people"><p><label for="q">Name</label> <input id="q" name="q" maxlength="200" value="${html(body.query.q)}"> <button class="button primary" type="submit">Search</button></p><p><label><input type="checkbox" name="includeIncomplete" value="1"${body.query.includeIncomplete ? " checked" : ""}> Include incomplete profiles</label></p>${ORDER.map(facet).join("")}<p><button class="button" type="submit">Apply filters</button> <a class="text-link" href="/recruit/staff/people">Clear</a></p></form><section><h2>${body.total} ${body.total === 1 ? "person" : "people"}</h2>${results}${paging}</section></main>`;
}

export async function handleRecruitPeopleSearch(req: IncomingMessage, res: ServerResponse, s: RecruitPeopleSearch | undefined, write: RecruitPageWriter, wantsHtml: boolean): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/recruit/staff/people") return false;
  const back = { href: "/recruit/staff/requests", label: "Back to requests" };
  if (req.method !== "GET") { sendJson(res, NOT_FOUND); return true; }
  try {
    if (!s) { wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } }); return true; }
    const r = await s.search(sessionCookie(req.headers.cookie), url.searchParams);
    if (!wantsHtml) sendJson(res, r);
    else if (r.status === 200) write(200, "Find people", renderPeopleSearch(r.body));
    else errorPage(write, r.status, back);
  } catch {
    if (!res.headersSent) wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } });
    else res.destroy();
  }
  return true;
}
