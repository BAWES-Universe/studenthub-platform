import type { IncomingMessage } from "node:http";
import { ORGANIZATION_NOTE_FIELDS, ORGANIZATION_NOTE_POLICY, type OrganizationNoteType, type OrganizationNoteView } from "@studenthub/organizations";
import type { ActionToken } from "@studenthub/safe-write-contract";
import type { GatewayRouteContext } from "../routes/context.js";
import { ORGANIZATION_PAGE_RESERVED, organizationPageOrgId } from "./overview-page.js";

const PAGE = /^\/organization\/([^/]+)\/notes(?:\/(preview|confirm))?$/;
const BODY_LIMIT = 32_768;
const TOKEN_KEYS = ["changeSetDigest", "expectedBeforeDigest", "expiresAt", "issuedAt", "mac", "principalRef", "tokenId"] as const;
const TYPE_LABEL: Readonly<Record<OrganizationNoteType, string>> = { internal_note: "Internal note", phone_call: "Phone call", email: "Email", meeting: "Meeting", interview: "Interview", task: "Task" };
const FIELD_TYPE: Readonly<Record<string, OrganizationNoteType>> = { note: "internal_note", note_phone_call: "phone_call", note_email: "email", note_meeting: "meeting", note_interview: "interview", note_task: "task" };
const CONFLICT = "This note was already saved or its preview expired. Open the notes again and retry.";

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

function error(ctx: GatewayRouteContext, status: 401 | 404): boolean {
  ctx.request.resume();
  ctx.writeHtml(ctx.response, status, ctx.renderError(status, ctx.login));
  return true;
}

function plain(ctx: GatewayRouteContext, status: number, title: string, message: string): boolean {
  ctx.request.resume();
  ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, `<main id="main" class="error-page"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>`));
  return true;
}

const unavailable = (ctx: GatewayRouteContext) => plain(ctx, 503, "Notes unavailable", "Notes are unavailable right now.");
const invalid = (ctx: GatewayRouteContext) => plain(ctx, 400, "Invalid note", "That note could not be processed.");

async function readForm(request: IncomingMessage, allowed: readonly string[]): Promise<Record<string, string> | undefined> {
  if (Number(request.headers["content-length"]) > BODY_LIMIT) { request.resume(); return undefined; }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk as Uint8Array);
    if ((size += bytes.length) > BODY_LIMIT) { request.resume(); return undefined; }
    chunks.push(bytes);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {
    if (!allowed.includes(key) || Object.hasOwn(out, key)) return undefined;
    out[key] = value;
  }
  return Object.keys(out).length === allowed.length ? out : undefined;
}

function notePath(orgId: string): string { return `/organization/${encodeURIComponent(orgId)}/notes`; }
function validField(value: string | undefined): value is typeof ORGANIZATION_NOTE_FIELDS[number] {
  return value !== undefined && (ORGANIZATION_NOTE_FIELDS as readonly string[]).includes(value);
}

function failed(ctx: GatewayRouteContext, status: number): boolean {
  if (status === 401 || status === 404) return error(ctx, status);
  if (status === 409) return plain(ctx, 409, "Note not saved", CONFLICT);
  if (status === 503) return unavailable(ctx);
  return invalid(ctx);
}

async function listPage(ctx: GatewayRouteContext, orgId: string, query: URLSearchParams): Promise<boolean> {
  const saved = query.getAll("saved");
  if (query.size > 1 || [...query.keys()].some((key) => key !== "saved") || saved.length > 1 || (saved.length === 1 && saved[0] !== "note")) return invalid(ctx);
  const service = ctx.login?.organizationNotes;
  if (!service) return unavailable(ctx);
  const result = await service.list(sessionCookie(ctx.request.headers.cookie), orgId);
  if (result.status !== 200) return failed(ctx, result.status);
  const notes = (result.body as { notes?: OrganizationNoteView[] }).notes;
  if (!Array.isArray(notes)) return unavailable(ctx);
  const listing = notes.length ? `<ol>${notes.map((note) => `<li><strong>${escapeHtml(TYPE_LABEL[note.noteType])}</strong> <time datetime="${escapeHtml(note.createdAt)}">${escapeHtml(note.createdAt)}</time><p>${escapeHtml(note.text)}</p></li>`).join("")}</ol>` : "<p>No notes yet.</p>";
  const options = ORGANIZATION_NOTE_FIELDS.map((field) => `<option value="${escapeHtml(field)}">${escapeHtml(TYPE_LABEL[FIELD_TYPE[field]!])}</option>`).join("");
  const base = notePath(orgId);
  const notice = saved.length ? '<section class="notice" role="status"><strong>Note saved.</strong></section>' : "";
  const body = `<main id="main" class="profile-main"><nav aria-label="Breadcrumb"><a href="/organization/${escapeHtml(encodeURIComponent(orgId))}">Company</a></nav><h1>Notes</h1>${notice}${listing}<section><h2>Add a note</h2><form method="post" action="${escapeHtml(`${base}/preview`)}"><label for="note-field">Type</label><select id="note-field" name="field">${options}</select><label for="note-value">Note</label><textarea id="note-value" name="value" maxlength="${ORGANIZATION_NOTE_POLICY.maxValueLength}"></textarea><button class="button" type="submit">Preview note</button></form></section></main>`;
  ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Notes", body));
  return true;
}

async function preview(ctx: GatewayRouteContext, orgId: string): Promise<boolean> {
  const values = await readForm(ctx.request, ["field", "value"]);
  if (!values || !validField(values.field) || values.value.trim().length === 0) return invalid(ctx);
  const result = await ctx.login!.organizationNotes!.preview(sessionCookie(ctx.request.headers.cookie), { orgId, field: values.field, value: values.value });
  if (result.status !== 200) return failed(ctx, result.status);
  const token = (result.body as { token: ActionToken }).token;
  const hidden = [["field", values.field], ["value", values.value], ...TOKEN_KEYS.map((key) => [`token.${key}`, token[key]] as const)]
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join("");
  const base = notePath(orgId);
  const body = `<main id="main" class="profile-main"><h1>Preview note</h1><dl><div><dt>Type</dt><dd>${escapeHtml(TYPE_LABEL[FIELD_TYPE[values.field]!])}</dd></div><div><dt>Note</dt><dd>${escapeHtml(values.value)}</dd></div></dl><form method="post" action="${escapeHtml(`${base}/confirm`)}">${hidden}<button class="button primary" type="submit">Save note</button></form><a class="text-link" href="${escapeHtml(base)}">Cancel</a></main>`;
  ctx.writeHtml(ctx.response, 200, ctx.pageDocument("Preview note", body));
  return true;
}

async function confirm(ctx: GatewayRouteContext, orgId: string): Promise<boolean> {
  const values = await readForm(ctx.request, ["field", "value", ...TOKEN_KEYS.map((key) => `token.${key}`)]);
  if (!values || !validField(values.field) || !values.value.trim()) return invalid(ctx);
  const token = Object.fromEntries(TOKEN_KEYS.map((key) => [key, values[`token.${key}`]]));
  const result = await ctx.login!.organizationNotes!.confirm(sessionCookie(ctx.request.headers.cookie), { orgId, field: values.field, value: values.value, token });
  if (result.status !== 200) return failed(ctx, result.status);
  ctx.response.writeHead(303, { location: `${notePath(orgId)}?saved=note`, "cache-control": "no-store" });
  ctx.response.end();
  return true;
}

export async function handleOrganizationNotesPage(ctx: GatewayRouteContext): Promise<boolean> {
  const requestUrl = new URL(ctx.request.url ?? "/", "http://gateway.invalid");
  const match = PAGE.exec(requestUrl.pathname);
  if (!match) return false;
  const action = match[2];
  if (action ? ctx.request.method !== "POST" : ctx.request.method !== "GET" && ctx.request.method !== "HEAD") return false;
  let decoded: string | undefined;
  try { decoded = decodeURIComponent(match[1]!); } catch { decoded = undefined; }
  if (decoded && ORGANIZATION_PAGE_RESERVED.includes(decoded)) return error(ctx, 404);
  const orgId = organizationPageOrgId(match[1]!);
  try {
    if (!action) return orgId ? await listPage(ctx, orgId, requestUrl.searchParams) : error(ctx, 404);
    const origin = ctx.login?.web?.origin;
    if (!origin || !ctx.login?.organizationNotes) return unavailable(ctx);
    if (ctx.request.headers.origin !== origin || ctx.request.headers["sec-fetch-site"] === "cross-site") return plain(ctx, 403, "Note not saved", "This note must be added from StudentHub itself.");
    if (!orgId) return error(ctx, 404);
    const contentType = ctx.request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") return invalid(ctx);
    return action === "preview" ? await preview(ctx, orgId) : await confirm(ctx, orgId);
  } catch {
    if (!ctx.response.headersSent) return unavailable(ctx);
    ctx.response.destroy();
    return true;
  }
}
