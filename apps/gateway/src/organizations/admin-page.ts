import type { IncomingMessage } from "node:http";
import {
  ORGANIZATION_FIELD_CONTRACT,
  type OrganizationField, type OrganizationFieldName, type OrganizationStatusEventRow,
} from "@studenthub/organizations";
import type { ActionToken } from "@studenthub/safe-write-contract";
import type { GatewayRouteContext } from "../routes/context.js";
import { writeNotFound } from "../shell/error-pages.js";
import { organizationPageOrgId } from "./overview-page.js";

// The staff and admin browser page over the existing company safe writes: status
// override, approved to hire, commercial terms and deletion. Who may write, which
// values are allowed and how the token is checked all stay in the services; this
// page only renders and relays.
const PAGE = /^\/workspace\/companies\/([^/]+)\/admin(?:\/(preview|confirm))?$/;
const BODY_LIMIT = 32_768;
const TOKEN_KEYS = ["changeSetDigest", "expectedBeforeDigest", "expiresAt", "issuedAt", "mac", "principalRef", "tokenId"] as const;
const CONFLICT = "The company changed while you were reviewing. Open it again and retry.";
const ROLES = ["admin", "staff"] as const;
type OperatorRole = typeof ROLES[number];

type AdminField = "status" | "approved_to_hire" | "hourly_rate" | "bonus_commission" | "currency_code" | "deletion";
type Service = "organizationStatus" | "organizationApprovedToHire" | "organizationCommercialTerms" | "organizationDeletion";
const FIELDS: Readonly<Record<AdminField, { readonly service: Service; readonly read?: OrganizationFieldName; readonly label: string; readonly adminOnly: boolean }>> = {
  status: { service: "organizationStatus", read: "statusOverride", label: ORGANIZATION_FIELD_CONTRACT.statusOverride.label, adminOnly: false },
  approved_to_hire: { service: "organizationApprovedToHire", read: "approvedToHire", label: ORGANIZATION_FIELD_CONTRACT.approvedToHire.label, adminOnly: false },
  hourly_rate: { service: "organizationCommercialTerms", read: "hourlyRate", label: ORGANIZATION_FIELD_CONTRACT.hourlyRate.label, adminOnly: true },
  bonus_commission: { service: "organizationCommercialTerms", read: "bonusCommission", label: ORGANIZATION_FIELD_CONTRACT.bonusCommission.label, adminOnly: true },
  currency_code: { service: "organizationCommercialTerms", read: "currencyCode", label: ORGANIZATION_FIELD_CONTRACT.currencyCode.label, adminOnly: true },
  deletion: { service: "organizationDeletion", label: "Delete company", adminOnly: true },
};
const ORDER = Object.keys(FIELDS) as AdminField[];
const STATUS_NAMES: Readonly<Record<string, string>> = { active: "Active", under_review: "Under review", inactive: "Inactive" };
const BLOCKERS: Readonly<Record<string, string>> = {
  live_sub_organizations: "It still has sub-organizations.",
  live_pay_contracts: "It still has live pay contracts.",
  member_grants: "People still have access to it.",
  live_stores: "It still has stores.",
};

type Fields = Readonly<Record<OrganizationFieldName, OrganizationField<unknown>>>;
type StatusHistory = readonly OrganizationStatusEventRow[] | { readonly kind: "unavailable" } | undefined;
type Operator =
  | { readonly status: 200; readonly role: OperatorRole; readonly fields: Fields; readonly name: string; readonly statusHistory: StatusHistory }
  | { readonly status: 401 | 404 | 503 };
type Relay = { preview(session: string | undefined, body: unknown): Promise<{ readonly status: number; readonly body: unknown }>;
  confirm(session: string | undefined, body: unknown): Promise<{ readonly status: number; readonly body: unknown }> };

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

function adminField(value: string | undefined): value is AdminField {
  return value !== undefined && Object.hasOwn(FIELDS, value);
}

function adminPath(orgId: string): string {
  return `/workspace/companies/${encodeURIComponent(orgId)}/admin`;
}

/**
 * Admin-only fields are refused to staff here, before any service is called. The services
 * still make their own decision; this only keeps the page from relaying what it never offers.
 */
function mayChange(operator: { readonly role: OperatorRole }, field: AdminField): boolean {
  return operator.role === "admin" || !FIELDS[field].adminOnly;
}

function service(ctx: GatewayRouteContext, field: AdminField): Relay | undefined {
  return ctx.login?.[FIELDS[field].service] as Relay | undefined;
}

/** A stored or submitted value in words. Empty and "none" both mean the value is cleared. */
function shown(field: AdminField, value: unknown): string {
  if (field === "deletion") return value === "deleted" ? "Deleted" : "Not deleted";
  if (value === null || value === undefined || value === "" || value === "none") return "Not set";
  if (field === "status") return STATUS_NAMES[String(value)] ?? String(value);
  if (field === "approved_to_hire") return value === true || value === "true" || value === 1 || value === "1" ? "Yes" : "No";
  if (field === "bonus_commission") return `${String(value)}%`;
  return String(value);
}

function current(fields: Fields, field: AdminField): unknown {
  const read = FIELDS[field].read;
  const value = read ? fields[read] : undefined;
  return value?.state === "available" ? value.value : null;
}

/** 401 asks for sign-in; 404 is byte-for-byte the gateway's unknown-path answer. */
function refuse(ctx: GatewayRouteContext, status: 401 | 404): boolean {
  ctx.request.resume();
  if (status === 404) writeNotFound(ctx.request, ctx.response);
  else ctx.writeHtml(ctx.response, status, ctx.renderError(status, ctx.login));
  return true;
}

function plain(ctx: GatewayRouteContext, status: number, title: string, message: string, orgId?: string, extra = ""): boolean {
  ctx.request.resume();
  const back = orgId ? `<a class="text-link" href="${escapeHtml(adminPath(orgId))}">Back to company admin</a>` : "";
  ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, `<main id="main" class="error-page"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${extra}${back}</main>`));
  return true;
}

function unavailable(ctx: GatewayRouteContext, orgId?: string): boolean {
  return plain(ctx, 503, "Company admin unavailable", "Company admin is unavailable right now. Nothing was changed. Please try again later.", orgId);
}

function invalid(ctx: GatewayRouteContext, orgId?: string): boolean {
  return plain(ctx, 400, "The change wasn’t saved", "That change can’t be saved. Check the value and try again.", orgId);
}

/** The service's answer, as a page. Refusals keep the service's status. */
function failed(ctx: GatewayRouteContext, result: { readonly status: number; readonly body: unknown }, orgId: string): boolean {
  const status = result.status;
  if (status === 401 || status === 404) return refuse(ctx, status);
  const body = result.body as { readonly error?: unknown; readonly blockers?: unknown };
  if (status === 409 && body?.error === "deletion_blocked" && Array.isArray(body.blockers)) {
    const reasons = body.blockers.map((blocker) => `<li>${escapeHtml(BLOCKERS[String(blocker)] ?? "Something still depends on it.")}</li>`).join("");
    return plain(ctx, 409, "This company can’t be deleted yet", "Nothing was changed.", orgId, `<ul class="deletion-blockers">${reasons}</ul>`);
  }
  if (status === 409) return plain(ctx, 409, "The change wasn’t saved", CONFLICT, orgId);
  if (status === 503) return unavailable(ctx, orgId);
  return plain(ctx, status === 403 ? 403 : 400, "The change wasn’t saved", "That change can’t be saved. Check the value and try again.", orgId);
}

/**
 * The operator check: the navigation open for the admin, then the staff, context, on every request.
 * StudentHub's own operator organizations read as not found in the organization repository, so they 404 here too.
 */
async function openOperator(ctx: GatewayRouteContext, session: string | undefined, orgId: string): Promise<Operator> {
  const navigation = ctx.login?.navigation;
  if (!navigation) return { status: 503 };
  for (const role of ROLES) {
    let result;
    try { result = await navigation.open(session, new URLSearchParams({ org_id: orgId, role })); } catch { return { status: 503 }; }
    if (result.status === 401) return { status: 401 };
    if (result.status === 503) return { status: 503 };
    if (result.status !== 200 || result.body.active?.orgId !== orgId || result.body.active.role !== role
      || !result.body.organization || result.body.organization.kind === "not_applicable") continue;
    if (result.body.organization.kind === "unavailable") return { status: 503 };
    const view = result.body.organization.view;
    const fields = view.fields as unknown as Fields;
    const name = fields.legalName.state === "available" ? String(fields.legalName.value) : view.registryName;
    return { status: 200, role, fields, name, statusHistory: result.body.statusHistory };
  }
  return { status: 404 };
}

async function readForm(request: IncomingMessage, allowed: readonly string[]): Promise<Record<string, string> | undefined> {
  if (Number(request.headers["content-length"]) > BODY_LIMIT) { request.resume(); return undefined; }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > BODY_LIMIT) { request.resume(); return undefined; }
    chunks.push(bytes);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {
    if (!allowed.includes(key) || Object.hasOwn(out, key)) return undefined;
    out[key] = value;
  }
  return Object.keys(out).length === allowed.length ? out : undefined;
}

function option(value: string, label: string, selected: string): string {
  return `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function fieldForm(ctx: GatewayRouteContext, orgId: string, fields: Fields, field: AdminField, origin: boolean): string {
  const off = !origin || !service(ctx, field) ? " disabled" : "";
  const id = `admin-${field}`;
  const value = current(fields, field);
  const text = value === null || value === undefined ? "" : String(value);
  let input: string;
  if (field === "status") {
    input = `<select id="${id}" name="value"${off}>${option("none", "Not set", text || "none")}${Object.entries(STATUS_NAMES).map(([key, name]) => option(key, name, text)).join("")}</select>`;
  } else if (field === "approved_to_hire") {
    const yes = shown(field, value) === "Yes" ? "true" : "false";
    input = `<select id="${id}" name="value"${off}>${option("true", "Yes", yes)}${option("false", "No", yes)}</select>`;
  } else if (field === "deletion") {
    return `<form method="post" action="${escapeHtml(`${adminPath(orgId)}/preview`)}" data-field="deletion"><input type="hidden" name="field" value="deletion"><input type="hidden" name="value" value="deleted"><p>Deleting a company is only allowed once it has no sub-organizations, live pay contracts, stores or people with access.</p><button class="button" type="submit"${off}>Review deletion</button></form>`;
  } else {
    const max = field === "currency_code" ? 3 : 17;
    input = `<input id="${id}" name="value" type="text" maxlength="${max}" value="${escapeHtml(text)}"${off}><span class="field-meta">Leave empty to clear.</span>`;
  }
  return `<form method="post" action="${escapeHtml(`${adminPath(orgId)}/preview`)}" data-field="${field}"><input type="hidden" name="field" value="${field}"><label for="${id}">${escapeHtml(FIELDS[field].label)}</label>${input}<button class="button" type="submit"${off}>Preview change</button></form>`;
}

function historySection(history: StatusHistory): string {
  if (history === undefined) return "";
  if ("kind" in history) return '<section class="notice org-notice" role="status"><strong>Status history couldn’t be loaded.</strong></section>';
  const status = (value: string | null) => value === null ? "Not set" : STATUS_NAMES[value] ?? value;
  const items = history.slice(0, 5).map((event) => {
    const occurred = new Date(event.occurred_at).toISOString();
    return `<li>${escapeHtml(status(event.from_status))} → ${escapeHtml(status(event.to_status))} <time datetime="${escapeHtml(occurred)}">${escapeHtml(occurred.slice(0, 10))}</time></li>`;
  }).join("");
  return `<section aria-labelledby="status-history-title"><h2 id="status-history-title">Status history</h2>${items ? `<ol>${items}</ol>` : "<p>No status changes recorded.</p>"}</section>`;
}

async function adminPage(ctx: GatewayRouteContext, orgId: string, query: URLSearchParams): Promise<boolean> {
  // The page takes no query. It shows only what is stored now, never a notice a link could forge.
  if (query.size > 0) return invalid(ctx);
  const operator = await openOperator(ctx, sessionCookie(ctx.request.headers.cookie), orgId);
  if (operator.status !== 200) return operator.status === 503 ? unavailable(ctx) : refuse(ctx, operator.status);
  const { fields, role } = operator;
  const origin = Boolean(ctx.login?.web?.origin);
  const visible = ORDER.filter((field) => mayChange(operator, field));
  const off = !origin || visible.some((field) => !service(ctx, field))
    ? '<section class="notice" role="status"><strong>Some changes are unavailable right now.</strong></section>' : "";
  const forms = visible.map((field) => fieldForm(ctx, orgId, fields, field, origin)).join("");
  const effective = `<div><dt>${escapeHtml(ORGANIZATION_FIELD_CONTRACT.status.label)}</dt><dd class="read-only">${escapeHtml(shown("status", fields.status.state === "available" ? fields.status.value : null))}</dd></div>`;
  const workspace = `/workspace?${new URLSearchParams({ org_id: orgId, role })}`;
  const body = `<main id="main" class="profile-main"><h1>Company admin</h1><p class="field-meta">${escapeHtml(operator.name)}</p>${off}<dl class="profile-fields">${effective}</dl>${forms}${historySection(operator.statusHistory)}<a class="text-link" href="${escapeHtml(workspace)}">Account manager and company details</a></main>`;
  ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Company admin", body));
  return true;
}

/** The submitted value as the service takes it: an empty box clears the value. */
function submitted(field: AdminField, value: string): string {
  return value === "" && field !== "status" && field !== "approved_to_hire" && field !== "deletion" ? "none" : value;
}

async function previewChange(ctx: GatewayRouteContext, orgId: string, operator: Extract<Operator, { readonly status: 200 }>): Promise<boolean> {
  const values = await readForm(ctx.request, ["field", "value"]);
  if (!values || !adminField(values.field)) return invalid(ctx, orgId);
  const field = values.field;
  if (!mayChange(operator, field)) return refuse(ctx, 404);
  const relay = service(ctx, field);
  if (!relay) return unavailable(ctx, orgId);
  const value = submitted(field, values.value!);
  const result = await relay.preview(sessionCookie(ctx.request.headers.cookie), { orgId, field, value });
  if (result.status !== 200) return failed(ctx, result, orgId);
  const reviewed = result.body as { readonly changes: readonly { readonly before: unknown }[]; readonly token: ActionToken };
  const before = reviewed.changes[0] ? reviewed.changes[0].before : current(operator.fields, field);
  const hidden = [["orgId", orgId], ["field", field], ["value", value],
    ...TOKEN_KEYS.map((key) => [`token.${key}`, reviewed.token[key]] as const)]
    .map(([name, item]) => `<input type="hidden" name="${name}" value="${escapeHtml(item)}">`).join("");
  const warning = field === "deletion"
    ? `<p class="deletion-warning">This deletes ${escapeHtml(operator.name)}. Nothing changes until you confirm.</p>`
    : "<p>Nothing changes until you confirm.</p>";
  const body = `<main id="main" class="profile-main"><h1>Review company change</h1><p class="field-meta">${escapeHtml(operator.name)}</p>${warning}<dl class="profile-fields"><div><dt>Field</dt><dd class="field-label">${escapeHtml(FIELDS[field].label)}</dd></div><div><dt>Current value</dt><dd class="current-value">${escapeHtml(shown(field, before))}</dd></div><div><dt>New value</dt><dd class="new-value">${escapeHtml(shown(field, value))}</dd></div></dl><form method="post" action="${escapeHtml(`${adminPath(orgId)}/confirm`)}">${hidden}<button class="button primary" type="submit">${field === "deletion" ? "Delete company" : "Save change"}</button></form><a class="text-link" href="${escapeHtml(adminPath(orgId))}">Cancel</a></main>`;
  ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Review company change", body));
  return true;
}

async function confirmChange(ctx: GatewayRouteContext, orgId: string, operator: Extract<Operator, { readonly status: 200 }>): Promise<boolean> {
  const values = await readForm(ctx.request, ["orgId", "field", "value", ...TOKEN_KEYS.map((key) => `token.${key}`)]);
  if (!values || values.orgId !== orgId || !adminField(values.field)) return invalid(ctx, orgId);
  const field = values.field;
  if (!mayChange(operator, values.field)) return refuse(ctx, 404);
  const relay = service(ctx, field);
  if (!relay) return unavailable(ctx, orgId);
  const token = Object.fromEntries(TOKEN_KEYS.map((key) => [key, values[`token.${key}`]]));
  const confirmed = await relay.confirm(sessionCookie(ctx.request.headers.cookie), { orgId, field, value: values.value, token });
  if (confirmed.status !== 200) return failed(ctx, confirmed, orgId);
  // A deleted company has no admin page left to return to.
  const location = field === "deletion" ? "/workspace" : adminPath(orgId);
  ctx.response.writeHead(303, { location, "cache-control": "no-store" });
  ctx.response.end();
  return true;
}

export async function handleOrganizationAdminPage(ctx: GatewayRouteContext): Promise<boolean> {
  const requestUrl = new URL(ctx.request.url ?? "/", "http://gateway.invalid");
  const match = PAGE.exec(requestUrl.pathname);
  if (!match) return false;
  const action = match[2];
  const method = ctx.request.method;
  if (action ? method !== "POST" : method !== "GET" && method !== "HEAD") return false;
  const orgId = organizationPageOrgId(match[1]!);
  try {
    if (!action) return orgId ? await adminPage(ctx, orgId, requestUrl.searchParams) : refuse(ctx, 404);
    const origin = ctx.login?.web?.origin;
    if (!origin) return unavailable(ctx);
    // Checked before anything else is read, the body included.
    if (ctx.request.headers.origin !== origin || ctx.request.headers["sec-fetch-site"] === "cross-site") {
      return plain(ctx, 403, "The change wasn’t saved", "This change must be made from StudentHub itself.");
    }
    if (!orgId) return refuse(ctx, 404);
    const operator = await openOperator(ctx, sessionCookie(ctx.request.headers.cookie), orgId);
    if (operator.status !== 200) return operator.status === 503 ? unavailable(ctx, orgId) : refuse(ctx, operator.status);
    const contentType = ctx.request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") return invalid(ctx, orgId);
    return action === "preview" ? await previewChange(ctx, orgId, operator) : await confirmChange(ctx, orgId, operator);
  } catch {
    if (!ctx.response.headersSent) return unavailable(ctx, orgId);
    ctx.response.destroy();
    return true;
  }
}
