import type { GatewayRouteContext } from "../routes/context.js";
import { isOrganizationStoreId, type OrganizationStoreView } from "@studenthub/organizations";
import { ORGANIZATION_PAGE_RESERVED, organizationPageOrgId } from "./overview-page.js";

const PAGE = /^\/organization\/([^/]+)\/stores(?:\/([^/]+))?$/;

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

function error(ctx: GatewayRouteContext, status: 400 | 401 | 404): boolean {
  ctx.writeHtml(ctx.response, status, ctx.renderError(status, ctx.login));
  return true;
}

function unavailable(ctx: GatewayRouteContext): boolean {
  ctx.writeHtml(ctx.response, 503, ctx.pageDocument("Stores unavailable", '<main id="main" class="error-page"><h1>Stores unavailable</h1><p>Please try again later.</p></main>'));
  return true;
}

function isStore(value: unknown): value is OrganizationStoreView {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const reference = (item: unknown) => item === null || (!!item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string" && typeof (item as Record<string, unknown>).name === "string");
  return typeof row.storeId === "string" && typeof row.name === "string" && (row.location === null || typeof row.location === "string") && reference(row.brand) && reference(row.mall);
}

export async function handleOrganizationStoresPage(ctx: GatewayRouteContext): Promise<boolean> {
  const requestUrl = new URL(ctx.request.url ?? "/", "http://gateway.invalid");
  const match = PAGE.exec(requestUrl.pathname);
  if (!match || (ctx.request.method !== "GET" && ctx.request.method !== "HEAD")) return false;
  if (requestUrl.searchParams.size !== 0) return error(ctx, 400);
  let decoded: string | undefined;
  try { decoded = decodeURIComponent(match[1]!); } catch { return error(ctx, 404); }
  if (ORGANIZATION_PAGE_RESERVED.includes(decoded)) return error(ctx, 404);
  const orgId = organizationPageOrgId(match[1]!);
  if (!orgId) return error(ctx, 404);
  let storeId: string | undefined;
  if (match[2] !== undefined) {
    try { storeId = decodeURIComponent(match[2]); } catch { return error(ctx, 404); }
    if (!isOrganizationStoreId(storeId)) return error(ctx, 404);
    storeId = storeId.toLowerCase();
  }
  const service = ctx.login?.organizationStores;
  if (!service) return unavailable(ctx);
  let result;
  try { result = await service.list(sessionCookie(ctx.request.headers.cookie), orgId); } catch { return unavailable(ctx); }
  if (result.status === 401) return error(ctx, 401);
  if (result.status === 503) return unavailable(ctx);
  if (result.status !== 200) return error(ctx, 404);
  const stores = (result.body as { stores?: unknown }).stores;
  if (!Array.isArray(stores) || !stores.every(isStore)) return unavailable(ctx);
  const base = `/organization/${encodeURIComponent(orgId)}`;
  if (storeId !== undefined) {
    const store = stores.find((candidate) => candidate.storeId === storeId);
    if (!store) return error(ctx, 404);
    const body = `<main id="main" class="profile-main"><nav aria-label="Breadcrumb"><a href="${base}">Company</a><a href="${base}/stores">Stores</a></nav><h1>${escapeHtml(store.name)}</h1><dl class="profile-fields"><div><dt>Location</dt><dd>${escapeHtml(store.location ?? "None")}</dd></div><div><dt>Brand</dt><dd>${escapeHtml(store.brand?.name ?? "None")}</dd></div><div><dt>Mall</dt><dd>${escapeHtml(store.mall?.name ?? "None")}</dd></div></dl></main>`;
    ctx.writeHtml(ctx.response, 200, ctx.pageDocument(store.name, body));
    return true;
  }
  const rows = stores.map((store) => `<tr><th scope="row">${escapeHtml(store.name)}</th><td>${escapeHtml(store.location ?? "None")}</td><td>${escapeHtml(store.brand?.name ?? "None")}</td><td>${escapeHtml(store.mall?.name ?? "None")}</td></tr>`).join("");
  const listing = rows ? `<table><thead><tr><th>Store</th><th>Location</th><th>Brand</th><th>Mall</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No stores yet.</p>";
  const body = `<main id="main" class="profile-main"><nav aria-label="Breadcrumb"><a href="${base}">Company</a></nav><h1>Stores</h1>${listing}</main>`;
  ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Stores", body));
  return true;
}
