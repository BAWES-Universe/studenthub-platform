import type { IncomingMessage } from "node:http";
import {
  ORGANIZATION_FIELD_CONTRACT, ORGANIZATION_PROFILE_FIELDS, ORGANIZATION_PROFILE_SOURCES,
  type OrganizationField, type OrganizationFieldName, type OrganizationProfileField,
} from "@studenthub/organizations";
import type { ActionToken } from "@studenthub/safe-write-contract";
import type { GatewayRouteContext } from "../routes/context.js";
import { ORGANIZATION_PAGE_RESERVED, organizationPageOrgId } from "./overview-page.js";

// The company owner's browser page over the existing organization profile safe write.
// Every decision about who may write, what may be written and how the token is
// checked stays in login.organizationProfile; this page only renders and relays.
const PAGE = /^\/organization\/([^/]+)\/edit(?:\/(preview|confirm))?$/;
const BODY_LIMIT = 32_768;
const TOKEN_KEYS = ["changeSetDigest", "expectedBeforeDigest", "expiresAt", "issuedAt", "mac", "principalRef", "tokenId"] as const;
const CONFLICT = "The company changed while you were reviewing. Open it again and retry.";
const READ_FIELD = Object.fromEntries(Object.entries(ORGANIZATION_PROFILE_SOURCES).map(([read, field]) => [field, read])) as
  Readonly<Record<OrganizationProfileField, keyof typeof ORGANIZATION_PROFILE_SOURCES>>;

type Fields = Readonly<Record<OrganizationFieldName, OrganizationField<unknown>>>;
type Owner = { readonly status: 200; readonly fields: Fields | undefined; readonly registryName: string } | { readonly status: 401 | 404 | 503 };

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

function profileField(value: string | undefined): value is OrganizationProfileField {
  return value !== undefined && (ORGANIZATION_PROFILE_FIELDS as readonly string[]).includes(value);
}

function label(field: OrganizationProfileField): string {
  return ORGANIZATION_FIELD_CONTRACT[READ_FIELD[field]].label;
}

function readValue(fields: Fields | undefined, field: OrganizationProfileField): string {
  const read = fields?.[READ_FIELD[field]];
  return read?.state === "available" && read.value !== null && read.value !== undefined ? String(read.value) : "";
}

function editPath(orgId: string): string {
  return `/organization/${encodeURIComponent(orgId)}/edit`;
}

function refuse(ctx: GatewayRouteContext, status: 401 | 404): boolean {
  ctx.request.resume();
  ctx.writeHtml(ctx.response, status, ctx.renderError(status, ctx.login));
  return true;
}

function plain(ctx: GatewayRouteContext, status: number, title: string, message: string, orgId?: string): boolean {
  ctx.request.resume();
  const back = orgId ? `<a class="text-link" href="${escapeHtml(editPath(orgId))}">Back to company details</a>` : "";
  ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, `<main id="main" class="error-page"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${back}</main>`));
  return true;
}

function unavailable(ctx: GatewayRouteContext, orgId?: string): boolean {
  return plain(ctx, 503, "Editing unavailable", "Editing is unavailable right now. Nothing was changed. Please try again later.", orgId);
}

function invalid(ctx: GatewayRouteContext, orgId?: string): boolean {
  return plain(ctx, 400, "The change wasn’t saved", "That change can’t be saved. Check the value and try again.", orgId);
}

/** The service's answer, as a page. Refusals keep the service's status. */
function failed(ctx: GatewayRouteContext, status: number, orgId: string): boolean {
  if (status === 401 || status === 404) return refuse(ctx, status);
  if (status === 409) return plain(ctx, 409, "The change wasn’t saved", CONFLICT, orgId);
  if (status === 503) return unavailable(ctx, orgId);
  return plain(ctx, status === 403 ? 403 : 400, "The change wasn’t saved", "That change can’t be saved. Check the value and try again.", orgId);
}

/** The owner check: the navigation open for the org-owner context, on every request. */
async function openOwner(ctx: GatewayRouteContext, session: string | undefined, orgId: string): Promise<Owner> {
  const navigation = ctx.login?.navigation;
  if (!navigation) return { status: 503 };
  const role = "org-owner";
  let result;
  try { result = await navigation.open(session, new URLSearchParams({ org_id: orgId, role })); } catch { return { status: 503 }; }
  if (result.status === 401) return { status: 401 };
  if (result.status === 503) return { status: 503 };
  if (result.status !== 200 || result.body.active?.orgId !== orgId || result.body.active.role !== role
    || !result.body.organization || result.body.organization.kind === "not_applicable") return { status: 404 };
  if (result.body.organization.kind === "unavailable") return { status: 200, fields: undefined, registryName: result.body.active.organizationName };
  const view = result.body.organization.view;
  return { status: 200, fields: view.fields as unknown as Fields, registryName: view.registryName };
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

function fieldForm(orgId: string, field: OrganizationProfileField, value: string, disabled: boolean): string {
  const name = field === "name_en" || field === "name_ar";
  const id = `edit-${field}`;
  const off = disabled ? " disabled" : "";
  const input = field === "description_en" || field === "description_ar"
    ? `<textarea id="${id}" name="value" maxlength="2000" rows="5"${off}>${escapeHtml(value)}</textarea>`
    : `<input id="${id}" name="value" type="text" maxlength="${name ? 255 : 2000}" value="${escapeHtml(value)}"${off}>`;
  return `<form method="post" action="${escapeHtml(`${editPath(orgId)}/preview`)}" data-field="${field}"><input type="hidden" name="field" value="${field}"><label for="${id}">${escapeHtml(label(field))}</label>${input}<button class="button" type="submit"${off}>Preview change</button></form>`;
}

async function editPage(ctx: GatewayRouteContext, orgId: string, query: URLSearchParams): Promise<boolean> {
  const saved = query.getAll("saved");
  if (query.size > 1 || [...query.keys()].some((key) => key !== "saved") || saved.length > 1
    || (saved.length === 1 && !profileField(saved[0]))) return invalid(ctx);
  const owner = await openOwner(ctx, sessionCookie(ctx.request.headers.cookie), orgId);
  if (owner.status !== 200) return owner.status === 503 ? unavailable(ctx) : refuse(ctx, owner.status);
  if (!owner.fields) return unavailable(ctx);
  const fields = owner.fields;
  const disabled = !ctx.login?.organizationProfile || !ctx.login.web?.origin;
  const legal = fields.legalName.state === "available" ? String(fields.legalName.value) : owner.registryName;
  const savedField = saved[0] as OrganizationProfileField | undefined;
  const notice = savedField
    ? `<section class="notice" role="status"><strong>Saved.</strong> <span>${escapeHtml(label(savedField))}: <span class="saved-value">${escapeHtml(readValue(fields, savedField))}</span></span></section>` : "";
  const off = disabled ? '<section class="notice" role="status"><strong>Editing is unavailable right now.</strong></section>' : "";
  const forms = ORGANIZATION_PROFILE_FIELDS.map((field) => fieldForm(orgId, field, readValue(fields, field), disabled)).join("");
  const body = `<main id="main" class="profile-main"><h1>Edit company details</h1>${notice}${off}<dl class="profile-fields"><div><dt>${escapeHtml(ORGANIZATION_FIELD_CONTRACT.legalName.label)}</dt><dd class="read-only">${escapeHtml(legal)}</dd></div></dl>${forms}<a class="text-link" href="/organization/${escapeHtml(encodeURIComponent(orgId))}">Back to company</a></main>`;
  ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Edit company details", body));
  return true;
}

async function previewChange(ctx: GatewayRouteContext, orgId: string, owner: Extract<Owner, { readonly status: 200 }>): Promise<boolean> {
  const profile = ctx.login!.organizationProfile!;
  const values = await readForm(ctx.request, ["field", "value"]);
  if (!values || !profileField(values.field)) return invalid(ctx, orgId);
  const field = values.field;
  const result = await profile.preview(sessionCookie(ctx.request.headers.cookie), { orgId, field, value: values.value });
  if (result.status !== 200) return failed(ctx, result.status, orgId);
  const reviewed = result.body as { readonly changes: readonly { readonly before: unknown }[]; readonly token: ActionToken };
  const before = reviewed.changes[0]?.before;
  const current = typeof before === "string" ? before : readValue(owner.fields, field);
  const next = values.value!;
  const hidden = [["orgId", orgId], ["field", field], ["value", next],
    ...TOKEN_KEYS.map((key) => [`token.${key}`, reviewed.token[key]] as const)]
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join("");
  const body = `<main id="main" class="profile-main"><h1>Review company change</h1><dl class="profile-fields"><div><dt>Field</dt><dd class="field-label">${escapeHtml(label(field))}</dd></div><div><dt>Current value</dt><dd class="current-value">${escapeHtml(current)}</dd></div><div><dt>New value</dt><dd class="new-value">${escapeHtml(next)}</dd></div></dl><form method="post" action="${escapeHtml(`${editPath(orgId)}/confirm`)}">${hidden}<button class="button primary" type="submit">Save change</button></form><a class="text-link" href="${escapeHtml(editPath(orgId))}">Cancel</a></main>`;
  ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Review company change", body));
  return true;
}

async function confirmChange(ctx: GatewayRouteContext, orgId: string): Promise<boolean> {
  const profile = ctx.login!.organizationProfile!;
  const values = await readForm(ctx.request, ["orgId", "field", "value", ...TOKEN_KEYS.map((key) => `token.${key}`)]);
  if (!values || values.orgId !== orgId || !profileField(values.field)) return invalid(ctx, orgId);
  const field = values.field;
  const token = Object.fromEntries(TOKEN_KEYS.map((key) => [key, values[`token.${key}`]]));
  const confirmed = await profile.confirm(sessionCookie(ctx.request.headers.cookie), { orgId, field, value: values.value, token });
  if (confirmed.status !== 200) return failed(ctx, confirmed.status, orgId);
  ctx.response.writeHead(303, { location: `${editPath(orgId)}?${new URLSearchParams({ saved: field })}`, "cache-control": "no-store" });
  ctx.response.end();
  return true;
}

export async function handleOrganizationEditPage(ctx: GatewayRouteContext): Promise<boolean> {
  const requestUrl = new URL(ctx.request.url ?? "/", "http://gateway.invalid");
  const match = PAGE.exec(requestUrl.pathname);
  if (!match) return false;
  const action = match[2];
  const method = ctx.request.method;
  if (action ? method !== "POST" : method !== "GET" && method !== "HEAD") return false;
  let decoded: string | undefined;
  try { decoded = decodeURIComponent(match[1]!); } catch { decoded = undefined; }
  if (decoded && ORGANIZATION_PAGE_RESERVED.includes(decoded)) return false;
  const orgId = organizationPageOrgId(match[1]!);
  try {
    if (!action) return orgId ? await editPage(ctx, orgId, requestUrl.searchParams) : refuse(ctx, 404);
    const origin = ctx.login?.web?.origin;
    if (!origin) return unavailable(ctx);
    // Checked before anything else is read, the body included.
    if (ctx.request.headers.origin !== origin || ctx.request.headers["sec-fetch-site"] === "cross-site") {
      return plain(ctx, 403, "The change wasn’t saved", "This change must be made from StudentHub itself.");
    }
    if (!orgId) return refuse(ctx, 404);
    const owner = await openOwner(ctx, sessionCookie(ctx.request.headers.cookie), orgId);
    if (owner.status !== 200) return owner.status === 503 ? unavailable(ctx, orgId) : refuse(ctx, owner.status);
    if (!ctx.login?.organizationProfile) return unavailable(ctx, orgId);
    const contentType = ctx.request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") return invalid(ctx, orgId);
    return action === "preview" ? await previewChange(ctx, orgId, owner) : await confirmChange(ctx, orgId);
  } catch {
    if (!ctx.response.headersSent) return unavailable(ctx, orgId);
    ctx.response.destroy();
    return true;
  }
}
