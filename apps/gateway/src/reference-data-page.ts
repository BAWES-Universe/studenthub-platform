import { CatalogueError, CATALOGUE_TYPES, type CatalogueType } from "@studenthub/reference-catalogue";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import type { GatewayRouteContext } from "./routes/context.js";

const LABELS: Readonly<Record<CatalogueType, string>> = {
  country: "Countries", currency: "Currencies", bank: "Banks", tag: "Tags", brand: "Brands", mall: "Malls",
  university: "Universities", major: "Majors", degree: "Degrees", "degree-group": "Degree groups", area: "Areas",
};

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function sessionCookie(value: string | undefined): string | undefined {
  for (const item of value?.split(";") ?? []) {
    const [key, ...parts] = item.trim().split("=");
    const candidate = parts.join("=");
    if (key === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(candidate)) return candidate;
  }
  return undefined;
}

function plain(ctx: GatewayRouteContext, status: 400 | 401 | 404): boolean {
  ctx.writeHtml(ctx.response, status, ctx.renderError(status, ctx.login));
  return true;
}

function unavailable(ctx: GatewayRouteContext): boolean {
  ctx.writeHtml(ctx.response, 503, ctx.pageDocument("Reference data unavailable", '<main id="main" class="error-page"><h1>Reference data unavailable</h1><p>Reference data is unavailable right now.</p></main>'));
  return true;
}

export async function handleReferenceDataPage(ctx: GatewayRouteContext): Promise<boolean> {
  if (!ctx.login?.navigation) return false;
  const url = new URL(ctx.request.url ?? "/", "http://gateway.invalid");
  const match = /^\/reference-data(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(url.pathname);
  if (!match || (ctx.request.method !== "GET" && ctx.request.method !== "HEAD")) return false;

  let navigation;
  try { navigation = await ctx.login.navigation.open(sessionCookie(ctx.request.headers.cookie), new URLSearchParams()); }
  catch { return unavailable(ctx); }
  if (navigation.status === 401) return plain(ctx, 401);
  if (navigation.status !== 200) return navigation.status === 503 ? unavailable(ctx) : plain(ctx, 404);
  const allowed = navigation.body.contexts.some((context) =>
    (context.role === "staff" || context.role === "admin") && DEFAULT_OPERATOR_ORG_IDS.includes(context.orgId));
  if (!allowed) return plain(ctx, 404);

  const rawType = match[1];
  const id = match[2];
  const type = CATALOGUE_TYPES.find((candidate) => candidate === rawType);
  if (rawType !== undefined && !type) return plain(ctx, 404);
  if (type === undefined) {
    if (url.searchParams.size !== 0) return plain(ctx, 400);
    if (!ctx.catalogue) return unavailable(ctx);
    const links = CATALOGUE_TYPES.map((catalogue) => `<li><a href="/reference-data/${catalogue}">${LABELS[catalogue]}</a></li>`).join("");
    ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Reference data", `<main id="main" class="profile-main"><h1>Reference data</h1><ul>${links}</ul></main>`));
    return true;
  }

  if (id !== undefined) {
    if (url.searchParams.size !== 0) return plain(ctx, 400);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return plain(ctx, 404);
    if (!ctx.catalogue) return unavailable(ctx);
    try {
      const item = await ctx.catalogue.resolveHistorical(type, id);
      if (!item) return plain(ctx, 404);
      const removed = item.status === "deleted";
      const escapedName = escapeHtml(String(item.name));
      const details = `<dl><dt>Code</dt><dd>${escapeHtml(item.code ?? "None")}</dd><dt>State</dt><dd>${removed ? "Removed" : "Active"}</dd><dt>Created</dt><dd>${escapeHtml(item.createdAt)}</dd><dt>Updated</dt><dd>${escapeHtml(item.updatedAt)}</dd>${removed ? `<dt>Removed</dt><dd>${escapeHtml(item.deletedAt)}</dd>` : ""}</dl>`;
      ctx.writeHtml(ctx.response, 200, ctx.pageDocument(item.name, `<main id="main" class="profile-main"><nav aria-label="Breadcrumb"><a href="/reference-data">Reference data</a></nav><p><a href="/reference-data/${type}">Back to ${LABELS[type]}</a></p><h1>${escapedName}</h1>${details}</main>`));
    } catch (error) {
      if (error instanceof CatalogueError && error.code === "invalid_catalogue_id") return plain(ctx, 404);
      return unavailable(ctx);
    }
    return true;
  }

  const cursors = url.searchParams.getAll("cursor");
  if (url.searchParams.size > 1 || [...url.searchParams.keys()].some((key) => key !== "cursor") || cursors.length > 1 || (cursors.length === 1 && !cursors[0])) return plain(ctx, 400);
  if (!ctx.catalogue) return unavailable(ctx);
  try {
    const page = await ctx.catalogue.list(type, { cursor: cursors[0], pageSize: 50 });
    const rows = page.items.map((item) => `<tr><th scope="row">${escapeHtml(item.name)}</th><td>${escapeHtml(item.code ?? "None")}</td></tr>`).join("");
    const listing = rows ? `<table><thead><tr><th>Name</th><th>Code</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No entries yet.</p>";
    const next = page.nextCursor ? `<p><a href="/reference-data/${type}?cursor=${encodeURIComponent(page.nextCursor)}">Next page</a></p>` : "";
    const label = LABELS[type];
    ctx.writeHtml(ctx.response, 200, ctx.pageDocument(label, `<main id="main" class="profile-main"><nav aria-label="Breadcrumb"><a href="/reference-data">Reference data</a></nav><h1>${label}</h1>${listing}${next}</main>`));
  } catch (error) {
    if (error instanceof CatalogueError && error.code === "invalid_cursor") return plain(ctx, 400);
    return unavailable(ctx);
  }
  return true;
}
