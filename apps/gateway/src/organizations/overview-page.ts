import {
  ORGANIZATION_FIELD_CONTRACT,
  ORGANIZATION_FIELDS_BY_AUDIENCE,
  type OrganizationField,
  type OrganizationFieldName,
} from "@studenthub/organizations";
import type { Role } from "@studenthub/contracts";
import type { GatewayRouteContext } from "../routes/context.js";

export const ORGANIZATION_PAGE_RESERVED: readonly string[] = Object.freeze([
  "onboarding", "create", "assigned-companies", "profile", "status", "commercial-terms",
  "approved-to-hire", "notes", "brands", "stores", "deletion", "account-manager",
]);

const ORG_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const PAGE = /^\/organization\/([^/]+)$/;
const ROLE_ORDER: readonly Role[] = ["org-owner", "recruiter", "staff", "admin"];

export function organizationPageOrgId(segment: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(segment); } catch { return undefined; }
  return ORG_ID.test(decoded) && !ORGANIZATION_PAGE_RESERVED.includes(decoded) ? decoded : undefined;
}

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

const formatters: Readonly<Partial<Record<OrganizationFieldName, (value: unknown) => string>>> = {
  status: (value) => ({ active: "Active", under_review: "Under review", inactive: "Inactive" })[String(value)] ?? String(value),
  statusOverride: (value) => ({ active: "Active", under_review: "Under review", inactive: "Inactive" })[String(value)] ?? String(value),
  approvedToHire: (value) => value ? "Yes" : "No",
  bonusCommission: (value) => `${String(value)}%`,
};

function fieldText(name: OrganizationFieldName, field: OrganizationField<unknown>): string {
  if (field.state === "unavailable") return '<span class="missing" data-state="unavailable">Unavailable</span>';
  return escapeHtml((formatters[name] ?? String)(field.value));
}

function error(ctx: GatewayRouteContext, status: 400 | 401 | 404): boolean {
  ctx.writeHtml(ctx.response, status, ctx.renderError(status, ctx.login));
  return true;
}

function unavailable(ctx: GatewayRouteContext): boolean {
  ctx.writeHtml(ctx.response, 503, ctx.pageDocument("Company unavailable", '<main id="main" class="error-page"><h1>Company unavailable</h1><p>Please try again later.</p></main>'));
  return true;
}

export async function handleOrganizationOverviewPage(ctx: GatewayRouteContext): Promise<boolean> {
  const requestUrl = new URL(ctx.request.url ?? "/", "http://gateway.invalid");
  const match = PAGE.exec(requestUrl.pathname);
  if (!match || (ctx.request.method !== "GET" && ctx.request.method !== "HEAD")) return false;
  const orgId = organizationPageOrgId(match[1]!);
  if (!orgId) return error(ctx, 404);
  const roles = requestUrl.searchParams.getAll("role");
  if (requestUrl.searchParams.size > 1 || roles.length > 1
    || [...requestUrl.searchParams.keys()].some((key) => key !== "role")
    || (roles.length === 1 && !roles[0])) return error(ctx, 400);
  const navigation = ctx.login?.navigation;
  if (!navigation) return unavailable(ctx);
  const session = sessionCookie(ctx.request.headers.cookie);
  let contexts;
  try { contexts = await navigation.open(session, new URLSearchParams()); } catch { return unavailable(ctx); }
  if (contexts.status === 401) return error(ctx, 401);
  if (contexts.status !== 200) return unavailable(ctx);
  const requestedRole = roles[0];
  const role = requestedRole ?? ROLE_ORDER.find((candidate) => contexts.body.contexts.some((item) => item.orgId === orgId && item.role === candidate));
  if (!role || !ROLE_ORDER.includes(role as Role)
    || !contexts.body.contexts.some((item) => item.orgId === orgId && item.role === role)) return error(ctx, 404);
  let result;
  try { result = await navigation.open(session, new URLSearchParams({ org_id: orgId, role })); } catch { return unavailable(ctx); }
  if (result.status === 503) return unavailable(ctx);
  if (result.status !== 200 || result.body.active?.orgId !== orgId || result.body.active.role !== role
    || !result.body.organization || result.body.organization.kind === "not_applicable") return error(ctx, 404);
  if (result.body.organization.kind === "unavailable") {
    ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Company", '<main id="main"><section class="notice org-notice" role="status"><strong>Company details couldn’t be loaded.</strong></section></main>'));
    return true;
  }
  const view = result.body.organization.view;
  const fields = view.fields as unknown as Readonly<Record<OrganizationFieldName, OrganizationField<unknown>>>;
  const heading = fields.legalName.state === "available" ? String(fields.legalName.value) : view.registryName;
  const rows = ORGANIZATION_FIELDS_BY_AUDIENCE[view.audience].map((name) =>
    `<div><dt>${escapeHtml(ORGANIZATION_FIELD_CONTRACT[name].label)}</dt><dd>${fieldText(name, fields[name])}</dd></div>`).join("");
  const base = `/organization/${encodeURIComponent(orgId)}`;
  const actions = `${role === "org-owner" ? `<a href="${base}/edit">Edit company details</a>` : ""}<a href="${base}/stores">Stores</a>`;
  const children = result.body.subOrganizations?.kind === "found" && result.body.subOrganizations.subOrganizations.length
    ? `<section aria-labelledby="sub-organizations"><h2 id="sub-organizations">Sub-organizations</h2><ul>${result.body.subOrganizations.subOrganizations.map((child) => `<li><a href="/organization/${encodeURIComponent(child.orgId)}">${escapeHtml(child.registryName)}</a></li>`).join("")}</ul></section>` : "";
  const body = `<main id="main" class="profile-main"><h1>${escapeHtml(heading)}</h1><nav aria-label="Company actions">${actions}</nav><dl class="profile-fields">${rows}</dl>${children}</main>`;
  ctx.writeHtml(ctx.response, 200, ctx.pageDocument(heading, body));
  return true;
}
