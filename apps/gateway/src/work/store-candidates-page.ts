import type { GatewayRouteContext } from "../routes/context.js";
import { ASSIGNMENT_LIST_LIMIT, kuwaitDate, type Assignment } from "../../../../packages/work/src/index.js";
import { longDate } from "../../../../packages/reports/src/id-card-pdf.js";
import { writeNotFound } from "../shell/error-pages.js";
import { EMPLOYER_LINK_TTL_MS } from "../../../../packages/private-documents/src/employer-delivery.js";

/**
 * A store manager's candidates (matrix M-02). Read only.
 *
 * GET /workspace/stores/<storeId>/candidates lists the people placed at a store the caller manages, those
 * working there now first; GET /workspace/stores/<storeId>/candidates/<personId> shows one of them with each
 * placement at that store. Both read the work lane's placements through `placements.forManagedStore`, which
 * only the caller's own live store manager access opens. Everyone else (company roles and staff have the
 * company's candidates page), another store, and a person never placed at the store get the same not found
 * as an unknown path. A page shows the person's name, the store and the placement dates only: no profile,
 * contact, document, contract or pay field. The read returns the newest ASSIGNMENT_LIST_LIMIT placements; a
 * page holding that many says it may be missing older ones. The store page (M-01) links the list.
 *
 * GET /workspace/stores/<storeId>/candidates/<personId>/documents (matrix M-05) behind the same gate shows the
 * documents an employer may already receive for that person: the recruit area's signed, expiring, audited
 * links (EmployerDocuments), issued through the recruit request behind one of the person's placements at this
 * store. Sight is the recruit area's own (a store reader with a live link to the person on that request); this
 * page adds no permission and reads no document itself. Placements with no recruit request have no link.
 */
const PAGE = /^\/workspace\/stores\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/candidates(?:\/([^/]+)(\/documents)?)?$/;
/** At most this many of the person's recruit requests are tried for document links, newest placement first. */
const DOCUMENT_REQUESTS = 5;
const DOCUMENT_LABELS: Readonly<Record<string, string>> = { "personal-photo": "Photo", resume: "CV", "civil-id-front": "Civil ID (front)", "civil-id-back": "Civil ID (back)" };
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
  // Not found is the shared unknown-path answer, byte for byte.
  if (status === 404) writeNotFound(ctx.request, ctx.response);
  else ctx.writeHtml(ctx.response, status, ctx.renderError(status, ctx.login));
  return true;
}

function unavailable(ctx: GatewayRouteContext): boolean {
  ctx.writeHtml(ctx.response, 503, ctx.pageDocument("Candidates unavailable", '<main id="main" class="error-page"><h1>Candidates unavailable</h1><p>Please try again later.</p></main>'));
  return true;
}

const placedNow = (a: Assignment, today: string) => a.startDate <= today && (a.endDate === null || a.endDate >= today);
const period = (a: Assignment) => a.endDate === null ? `From ${longDate(a.startDate)}` : `${longDate(a.startDate)} to ${longDate(a.endDate)}`;
const status = (a: Assignment, today: string) => placedNow(a, today) ? "Working now" : a.startDate > today ? "Starts later" : "Ended";
const latestFirst = (a: Assignment, b: Assignment) => b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id);

interface Person { readonly id: string; readonly name: string; readonly placements: readonly Assignment[]; readonly now: boolean }

export async function handleStoreCandidatesPage(ctx: GatewayRouteContext): Promise<boolean> {
  const requestUrl = new URL(ctx.request.url ?? "/", "http://gateway.invalid");
  const match = PAGE.exec(requestUrl.pathname);
  if (!match || (ctx.request.method !== "GET" && ctx.request.method !== "HEAD")) return false;
  if (requestUrl.searchParams.size !== 0) return error(ctx, 400);
  const storeId = match[1]!;
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
    const shown = await work.placements.forManagedStore(viewer, storeId, personId);
    if (!shown) return error(ctx, 404);
    if (personId !== undefined && shown.length === 0) return error(ctx, 404);
    // The read returns the newest ASSIGNMENT_LIST_LIMIT placements; holding that many means older ones may be missing.
    const capped = shown.length >= ASSIGNMENT_LIST_LIMIT;
    const [names, stores] = await Promise.all([
      work.personNames ? work.personNames([...new Set(shown.map((a) => a.personId))]) : new Map<string, string>(),
      work.storeNames ? work.storeNames([storeId]) : new Map<string, string>(),
    ]);
    const today = kuwaitDate(new Date());
    const store = stores.get(storeId) ?? "Your store";
    const base = `/workspace/stores/${storeId}`;
    const byPerson = new Map<string, Assignment[]>();
    for (const a of shown) byPerson.set(a.personId, [...(byPerson.get(a.personId) ?? []), a]);
    const people: Person[] = [...byPerson].map(([id, placements]) => ({ id, name: names.get(id) ?? "Unnamed person", placements: [...placements].sort(latestFirst), now: placements.some((a) => placedNow(a, today)) }))
      .sort((a, b) => Number(b.now) - Number(a.now) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (match[3] !== undefined) return await documentsPage(ctx, session!, storeId, store, people[0]!);
    const crumbs = (extra = "") => `<nav aria-label="Breadcrumb"><a href="/workspace/my-stores">My stores</a> › <a href="${base}">${esc(store)}</a>${extra}</nav>`;
    if (personId !== undefined) {
      const person = people[0]!;
      const rows = person.placements.map((a) => `<tr><th scope="row">${esc(period(a))}</th><td>${status(a, today)}</td></tr>`).join("");
      const body = `<main id="main" class="profile-main">${crumbs(` › <a href="${base}/candidates">Candidates</a>`)}<h1>${esc(person.name)}</h1>`
        + `<h2>Placements at ${esc(store)}</h2>${capped ? `<p role="status">Only the ${ASSIGNMENT_LIST_LIMIT} most recent placements are shown; older ones are not listed here.</p>` : ""}<table><thead><tr><th>Period</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
        + `<p><a class="text-link" href="${base}/candidates/${esc(encodeURIComponent(person.id))}/documents">Documents</a></p></main>`;
      ctx.writeHtml(ctx.response, 200, ctx.pageDocument(person.name, body));
      return true;
    }
    const rows = people.map((p) => `<tr><th scope="row"><a href="${base}/candidates/${esc(encodeURIComponent(p.id))}">${esc(p.name)}</a></th>`
      + `<td>${esc(p.now ? "Working now" : period(p.placements[0]!))}</td></tr>`).join("");
    const listing = rows ? `<table><thead><tr><th>Person</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No one has been placed at this store yet.</p>";
    ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Candidates", `<main id="main" class="profile-main">${crumbs()}<h1>Candidates</h1><p>People placed at ${esc(store)}, those working now first.</p>${capped ? `<p role="status">This list is built from the ${ASSIGNMENT_LIST_LIMIT} most recent placements, so people placed only before them are not listed, and older placements are left out.</p>` : ""}${listing}</main>`));
    return true;
  } catch {
    return unavailable(ctx);
  }
}

async function documentsPage(ctx: GatewayRouteContext, session: string, storeId: string, store: string, person: Person): Promise<boolean> {
  const base = `/workspace/stores/${storeId}`, personPath = `${base}/candidates/${esc(encodeURIComponent(person.id))}`;
  const view = ctx.login?.recruitEmployerView;
  const employer = view && ctx.documents ? view.withDocuments(ctx.documents) : view;
  const requests = [...new Set(person.placements.map((a) => a.recruitRequestId).filter((id): id is string => id !== null))].slice(0, DOCUMENT_REQUESTS);
  let links: readonly { readonly type: string; readonly url: string }[] | null | undefined;
  for (const requestId of requests) {
    if (!employer) break;
    const result = await employer.person(session, requestId, person.id);
    if (result.status === 200) { links = result.body.documents; break; }
    if (result.status !== 404) throw new Error("documents unavailable");
  }
  const body = links === undefined ? "<p>No documents are shared for this person through this store. Documents come from the recruit request the person was placed through.</p>"
    : links === null ? "<p>Documents will appear here once secure document links are available.</p>"
    : links.length === 0 ? "<p>No documents on file.</p>"
    : `<ul>${links.map((l) => `<li><a class="text-link" href="${esc(l.url)}" rel="noreferrer">${esc(DOCUMENT_LABELS[l.type] ?? "Document")}</a></li>`).join("")}</ul><p>Each link works for you only and expires after ${EMPLOYER_LINK_TTL_MS / 60_000} minutes. Opening one is recorded.</p>`;
  ctx.writeHtml(ctx.response, 200, ctx.pageDocument(`${person.name}: documents`, `<main id="main" class="profile-main"><nav aria-label="Breadcrumb"><a href="/workspace/my-stores">My stores</a> › <a href="${base}">${esc(store)}</a> › <a href="${base}/candidates">Candidates</a> › <a href="${personPath}">${esc(person.name)}</a></nav><h1>Documents</h1>${body}</main>`));
  return true;
}
