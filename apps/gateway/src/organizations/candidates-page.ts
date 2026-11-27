import type { GatewayRouteContext } from "../routes/context.js";
import { ASSIGNMENT_LIST_LIMIT, kuwaitDate, type Assignment } from "../../../../packages/work/src/index.js";
import { longDate } from "../../../../packages/reports/src/id-card-pdf.js";
import { ORGANIZATION_PAGE_RESERVED, organizationPageOrgId } from "./overview-page.js";

/**
 * A company's candidates (matrix O-07). Read only.
 *
 * GET /organization/<orgId>/candidates lists the people placed at the company's stores, those working there now
 * first; GET /organization/<orgId>/candidates/<personId> shows one of them with each placement at the company.
 * Both read the work lane's placements through `placements.forOrganization`, which decides who may see them:
 * StudentHub staff, and the company's owners and recruiters (sub-companies only with a subtree grant). Everyone
 * else, and a person never placed at the company, gets the same not found. A page shows the person's name, the
 * store and the placement dates only: no profile, contact, document or pay field. The read returns the newest
 * ASSIGNMENT_LIST_LIMIT placements (the detail asks for that one person's); a page holding that many says it may
 * be missing older ones. The company overview links the list.
 */
const PAGE = /^\/organization\/([^/]+)\/candidates(?:\/([^/]+))?$/;
const PERSON_ID = /^[A-Za-z0-9._:@-]{1,256}$/;

const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function sessionCookie(value: string | undefined): string | undefined {
  for (const item of value?.split(";") ?? []) {
    const [key, ...parts] = item.trim().split("=");
    const candidate = parts.join("=");
    if (key === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(candidate)) return candidate;
  }
  return undefined;
}

function error(ctx: GatewayRouteContext, status: 400 | 401 | 404): boolean {
  ctx.writeHtml(ctx.response, status, ctx.renderError(status, ctx.login));
  return true;
}

function unavailable(ctx: GatewayRouteContext): boolean {
  ctx.writeHtml(ctx.response, 503, ctx.pageDocument("Candidates unavailable", '<main id="main" class="error-page"><h1>Candidates unavailable</h1><p>Please try again later.</p></main>'));
  return true;
}

const placedNow = (a: Assignment, today: string) => a.startDate <= today && (a.endDate === null || a.endDate >= today);
const period = (a: Assignment) => a.endDate === null ? `From ${longDate(a.startDate)}` : `${longDate(a.startDate)} to ${longDate(a.endDate)}`;
const latestFirst = (a: Assignment, b: Assignment) => b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id);

interface Person { readonly id: string; readonly name: string; readonly placements: readonly Assignment[]; readonly now: boolean }

export async function handleOrganizationCandidatesPage(ctx: GatewayRouteContext): Promise<boolean> {
  const requestUrl = new URL(ctx.request.url ?? "/", "http://gateway.invalid");
  const match = PAGE.exec(requestUrl.pathname);
  if (!match || (ctx.request.method !== "GET" && ctx.request.method !== "HEAD")) return false;
  if (requestUrl.searchParams.size !== 0) return error(ctx, 400);
  let decoded: string | undefined;
  try { decoded = decodeURIComponent(match[1]!); } catch { return error(ctx, 404); }
  if (ORGANIZATION_PAGE_RESERVED.includes(decoded)) return error(ctx, 404);
  const orgId = organizationPageOrgId(match[1]!);
  if (!orgId) return error(ctx, 404);
  let personId: string | undefined;
  if (match[2] !== undefined) {
    try { personId = decodeURIComponent(match[2]); } catch { return error(ctx, 404); }
    if (!PERSON_ID.test(personId)) return error(ctx, 404);
  }
  const work = ctx.login?.work;
  if (!work) return unavailable(ctx);
  try {
    const session = sessionCookie(ctx.request.headers.cookie);
    const viewer = session ? await work.personFor(session) : undefined;
    if (!viewer) return error(ctx, 401);
    const all = await work.placements.forOrganization(viewer, orgId, undefined, personId);
    if (!all) return error(ctx, 404);
    const shown = personId === undefined ? all : all.filter((a) => a.personId === personId);
    if (personId !== undefined && shown.length === 0) return error(ctx, 404);
    // The read returns the newest ASSIGNMENT_LIST_LIMIT placements; holding that many means older ones may be missing.
    const capped = all.length >= ASSIGNMENT_LIST_LIMIT;
    const [names, stores] = await Promise.all([
      work.personNames ? work.personNames([...new Set(shown.map((a) => a.personId))]) : new Map<string, string>(),
      work.storeNames ? work.storeNames([...new Set(shown.map((a) => a.storeId))]) : new Map<string, string>(),
    ]);
    const today = kuwaitDate(new Date());
    const storeName = (a: Assignment) => stores.get(a.storeId) ?? "Store";
    const base = `/organization/${encodeURIComponent(orgId)}`;
    const byPerson = new Map<string, Assignment[]>();
    for (const a of shown) byPerson.set(a.personId, [...(byPerson.get(a.personId) ?? []), a]);
    const people: Person[] = [...byPerson].map(([id, placements]) => ({ id, name: names.get(id) ?? "Unnamed person", placements: [...placements].sort(latestFirst), now: placements.some((a) => placedNow(a, today)) }))
      .sort((a, b) => Number(b.now) - Number(a.now) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const crumbs = (extra = "") => `<nav aria-label="Breadcrumb"><a href="${base}">Company</a>${extra}</nav>`;
    if (personId !== undefined) {
      const person = people[0]!;
      const rows = person.placements.map((a) => `<tr><th scope="row">${esc(storeName(a))}</th><td>${esc(period(a))}</td><td>${placedNow(a, today) ? "Working now" : a.startDate > today ? "Starts later" : "Ended"}</td></tr>`).join("");
      const body = `<main id="main" class="profile-main">${crumbs(`<a href="${base}/candidates">Candidates</a>`)}<h1>${esc(person.name)}</h1>`
        + `<h2>Placements at this company</h2>${capped ? `<p role="status">Only the ${ASSIGNMENT_LIST_LIMIT} most recent placements are shown; older ones are not listed here.</p>` : ""}<table><thead><tr><th>Store</th><th>Period</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></main>`;
      ctx.writeHtml(ctx.response, 200, ctx.pageDocument(person.name, body));
      return true;
    }
    const rows = people.map((p) => {
      const current = p.placements.filter((a) => placedNow(a, today)), latest = current.length ? current : [p.placements[0]!];
      return `<tr><th scope="row"><a href="${base}/candidates/${esc(encodeURIComponent(p.id))}">${esc(p.name)}</a></th>`
        + `<td>${esc([...new Set(latest.map(storeName))].join(", "))}</td><td>${esc(p.now ? "Working now" : period(p.placements[0]!))}</td></tr>`;
    }).join("");
    const listing = rows ? `<table><thead><tr><th>Person</th><th>Store</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No one has been placed at this company yet.</p>";
    ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Candidates", `<main id="main" class="profile-main">${crumbs()}<h1>Candidates</h1><p>People placed at this company's stores, those working now first.</p>${capped ? `<p role="status">This list is built from the ${ASSIGNMENT_LIST_LIMIT} most recent placements, so people placed only before them are not listed, and older placements are left out.</p>` : ""}${listing}</main>`));
    return true;
  } catch {
    return unavailable(ctx);
  }
}
