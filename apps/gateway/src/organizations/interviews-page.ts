import type { GatewayRouteContext } from "../routes/context.js";
import { renderOrganizationInterviews } from "../recruit/interviews-http.js";
import { ORGANIZATION_PAGE_RESERVED, organizationPageOrgId } from "./overview-page.js";

/**
 * A company's interviews (matrix O-10). Read only.
 *
 * GET /organization/<orgId>/interviews lists every interview on the company's hiring requests, latest scheduled
 * first, 100 a page (`?page=2` and on). The recruit interviews store decides who may see it: StudentHub staff, and
 * the company's own readers on a live company (the same decision as a request's interviews page). Everyone else gets
 * the same not found. A row shows the person, the position (linking to that request's interviews page, where the
 * evaluation lives), the store, the Kuwait time, length and mode, the status and the outcome: never a rating, a
 * note or a location. People who paused their profile are left out for callers who are not StudentHub staff, as on
 * a request's page. The company overview links the page.
 */
const PAGE = /^\/organization\/([^/]+)\/interviews$/;
const PAGE_NUMBER = /^[1-9][0-9]{0,5}$/;

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
  ctx.writeHtml(ctx.response, 503, ctx.pageDocument("Interviews unavailable", '<main id="main" class="error-page"><h1>Interviews unavailable</h1><p>Please try again later.</p></main>'));
  return true;
}

export async function handleOrganizationInterviewsPage(ctx: GatewayRouteContext): Promise<boolean> {
  const requestUrl = new URL(ctx.request.url ?? "/", "http://gateway.invalid");
  const match = PAGE.exec(requestUrl.pathname);
  if (!match || (ctx.request.method !== "GET" && ctx.request.method !== "HEAD")) return false;
  const params = [...requestUrl.searchParams.keys()];
  if (params.some((key) => key !== "page") || params.length > 1) return error(ctx, 400);
  const rawPage = requestUrl.searchParams.get("page");
  if (rawPage !== null && !PAGE_NUMBER.test(rawPage)) return error(ctx, 400);
  const page = rawPage === null ? 1 : Number(rawPage);
  let decoded: string;
  try { decoded = decodeURIComponent(match[1]!); } catch { return error(ctx, 404); }
  if (ORGANIZATION_PAGE_RESERVED.includes(decoded)) return error(ctx, 404);
  const orgId = organizationPageOrgId(match[1]!);
  if (!orgId) return error(ctx, 404);
  const interviews = ctx.login?.recruitInterviews;
  if (!interviews?.organization) return unavailable(ctx);
  try {
    const result = await interviews.organization(sessionCookie(ctx.request.headers.cookie), orgId, page);
    if (result.status === 401) return error(ctx, 401);
    if (result.status !== 200) return error(ctx, 404);
    const body = result.body;
    const base = `/organization/${encodeURIComponent(orgId)}`;
    const table = renderOrganizationInterviews(body.interviews);
    const empty = page === 1 ? "<p>No interviews have been scheduled for this company yet.</p>" : "<p>No more interviews.</p>";
    const pager = [page > 1 ? `<a href="${base}/interviews${page === 2 ? "" : `?page=${page - 1}`}">Later interviews</a>` : "", body.more ? `<a href="${base}/interviews?page=${page + 1}">Earlier interviews</a>` : ""].filter(Boolean).join(" ");
    ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Interviews", `<main id="main" class="profile-main"><nav aria-label="Breadcrumb"><a href="${base}">Company</a></nav><h1>Interviews</h1>`
      + `<p>Every interview on ${esc(body.company)}'s hiring requests, latest first. Open a position for its evaluations.</p>${table || empty}${pager ? `<nav aria-label="Pages">${pager}</nav>` : ""}</main>`));
    return true;
  } catch {
    return unavailable(ctx);
  }
}
