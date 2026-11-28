import type { IncomingMessage } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import type { PersonLifecycle, PostgresPersonLifecycleStore } from "@studenthub/db/access";
import type { GatewayRoute, GatewayRouteContext } from "./routes/context.js";
import type { PeopleDirectoryPage } from "./people-directory.js";
import { personShell, wantsHtml } from "./web-ui.js";
import { FormTooLarge, readForm } from "./work/pages.js";
import { writeNotFound } from "./shell/error-pages.js";

/**
 * A-02 slice 1: staff warn and tag a person.
 *
 * Legacy benchmark, BAWES-Universe/studenthub@55119d3: staff/modules/v1/controllers/CandidateController.php
 * (actionWarnCandidate, actionUpdateWarning, actionCandidateWarnings, actionAddTag, actionUpdateTags), the staff
 * app's candidate-warning form (title required) and candidate-tags page (tag and reason required).
 *
 * GET  /workspace/people/<person>/lifecycle               the person's warnings and live tags
 * POST /workspace/people/<person>/warnings                a new warning; the person is emailed its title and message
 * POST /workspace/people/<person>/warnings/<id>           a correction (needs the version it was read at)
 * POST /workspace/people/<person>/tags                    a tag with its reason
 * POST /workspace/people/<person>/tags/<id>/remove        removes one live tag
 *
 * Operator staff and admin only, through the People gate and again inside the store's transaction. Anyone else,
 * a bad id or no such person gets the unknown-path 404. Companies and the person never see this page.
 */

type Store = Pick<PostgresPersonLifecycleStore, "read" | "warn" | "correctWarning" | "addTag" | "removeTag">;
export interface PersonLifecycleHttp { readonly sessions: Pick<SessionStore, "get">; readonly store: Store }

export const LIFECYCLE_LIMITS = { title: 100, message: 5000, tag: 128, reason: 1000 } as const;
/** Each character can take 12 bytes once UTF-8 and form encoded. */
const FORM_LIMIT = (LIFECYCLE_LIMITS.title + LIFECYCLE_LIMITS.message) * 12 + 1024;
const DONE: Readonly<Record<string, string>> = { warned: "Warning saved. The person is emailed its title and message.", corrected: "Warning corrected. The earlier wording is kept.", tagged: "Tag added.", removed: "Tag removed." };

const PAGE = /^\/workspace\/people\/([^/]+)\/lifecycle$/;
const WARN = /^\/workspace\/people\/([^/]+)\/warnings$/, CORRECT = /^\/workspace\/people\/([^/]+)\/warnings\/([^/]+)$/;
const TAG = /^\/workspace\/people\/([^/]+)\/tags$/, UNTAG = /^\/workspace\/people\/([^/]+)\/tags\/([^/]+)\/remove$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const decoded = (segment: string) => { try { return decodeURIComponent(segment); } catch { return undefined; } };
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const when = (iso: string) => `${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuwait" }).format(new Date(iso))} Kuwait time`;
const sessionCookie = (value: string | undefined) => value?.split(";").map((x) => x.trim()).find((x) => x.startsWith("__Host-studenthub_session="))?.slice(26);
/** Trimmed text of 1..max characters, else undefined. */
const text = (value: string | undefined, max: number) => { const t = value?.trim(); return t && [...t].length <= max ? t : undefined; };

type Person = { principalId: string; name: string; active: { orgId: string; role: "staff" | "admin" } };
type Gate = { kind: "ok"; person: Person; actorId: string } | { kind: "status"; status: 401 | 404 | 503 };

/** The People gate (operator staff or admin, the person exists), then the session's own principal for the store. */
async function gate(people: PeopleDirectoryPage | undefined, service: PersonLifecycleHttp | undefined, session: string | undefined, principalId: string | undefined): Promise<Gate> {
  if (!service || !people?.person || principalId === undefined) return { kind: "status", status: 404 };
  const result = await people.person(session, principalId);
  if (result.status !== 200) return { kind: "status", status: result.status };
  const actor = session ? await service.sessions.get(session) : undefined;
  if (!actor) return { kind: "status", status: 401 };
  const { person, active } = result.body;
  return { kind: "ok", actorId: actor.personId, person: { principalId: person.principalId, name: person.name ?? person.universeName ?? "Unnamed", active } };
}

export function renderPersonLifecycle(ctx: GatewayRouteContext, person: Person, lifecycle: PersonLifecycle, notice?: { kind: "done" | "error"; text: string }): string {
  const base = `/workspace/people/${encodeURIComponent(person.principalId)}`;
  const by = (name: string | null) => esc(name ?? "Unknown");
  const warnings = lifecycle.warnings.map((w) => `<li class="profile-card"><h3>${esc(w.title)}</h3><p class="warning-message">${esc(w.message)}</p><p class="field-meta">By ${by(w.created_by_name)}, ${esc(when(w.created_at))}${w.updated_at ? `. Corrected by ${by(w.updated_by_name)}, ${esc(when(w.updated_at))}` : ""}</p>`
    + `<details><summary>Correct this warning</summary><form method="post" action="${esc(`${base}/warnings/${w.id}`)}"><input type="hidden" name="version" value="${w.version}">`
    + `<label>Title<input name="title" required maxlength="${LIFECYCLE_LIMITS.title}" value="${esc(w.title)}"></label><label>Message<textarea name="message" required maxlength="${LIFECYCLE_LIMITS.message}">${esc(w.message)}</textarea></label>`
    + `<p class="field-meta">A correction is not emailed. The earlier wording is kept.</p><button type="submit">Save correction</button></form></details></li>`).join("");
  const tags = lifecycle.tags.map((t) => `<li class="profile-card"><strong>${esc(t.tag)}</strong>${t.reason ? `<p>${esc(t.reason)}</p>` : ""}<p class="field-meta">By ${by(t.created_by_name)}, ${esc(when(t.created_at))}</p>`
    + `<form method="post" action="${esc(`${base}/tags/${t.id}/remove`)}"><button class="text-link" type="submit">Remove tag</button></form></li>`).join("");
  const banner = notice ? `<section class="notice" role="${notice.kind === "error" ? "alert" : "status"}"><p>${esc(notice.text)}</p></section>` : "";
  const main = `<div class="profile-heading"><h1>Warnings and tags for ${esc(person.name)}</h1></div>${banner}`
    + `<section aria-labelledby="warnings"><h2 id="warnings">Warnings</h2>${warnings ? `<ol class="person-warnings">${warnings}</ol>` : '<p class="empty-contexts">No warnings.</p>'}`
    + `<form method="post" action="${esc(`${base}/warnings`)}"><h3>Warn this person</h3><label>Title<input name="title" required maxlength="${LIFECYCLE_LIMITS.title}" value="Not appearing for interview"></label>`
    + `<label>Message<textarea name="message" required maxlength="${LIFECYCLE_LIMITS.message}"></textarea></label><p class="field-meta">The person is emailed this title and message.</p><button type="submit">Send warning</button></form></section>`
    + `<section aria-labelledby="tags"><h2 id="tags">Tags</h2>${tags ? `<ul class="person-tags">${tags}</ul>` : '<p class="empty-contexts">No tags.</p>'}`
    + `<form method="post" action="${esc(`${base}/tags`)}"><h3>Add a tag</h3><label>Tag<input name="tag" required maxlength="${LIFECYCLE_LIMITS.tag}"></label><label>Reason<textarea name="reason" required maxlength="${LIFECYCLE_LIMITS.reason}"></textarea></label><button type="submit">Add tag</button></form></section>`
    + `<p class="field-meta">Only StudentHub staff see warnings and tags. Companies and the person do not.</p><a class="text-link" href="${esc(base)}">Back to ${esc(person.name)}</a>`;
  return personShell(`Warnings and tags: ${person.name}`, { ...person.active, organizationName: "StudentHub" }, ctx.login!, main);
}

function status(ctx: GatewayRouteContext, code: 401 | 404 | 503): true {
  if (code === 404) writeNotFound(ctx.request, ctx.response);
  else ctx.writeHtml(ctx.response, code, ctx.renderError(code, ctx.login), {}, true);
  return true;
}

/** The page again with a refusal: the form was invalid (400), or the warning or tag changed meanwhile (409). */
async function refuse(ctx: GatewayRouteContext, service: PersonLifecycleHttp, g: Extract<Gate, { kind: "ok" }>, code: 400 | 409, message: string): Promise<true> {
  const lifecycle = await service.store.read(g.actorId, g.person.principalId);
  if (!lifecycle) return status(ctx, 404);
  ctx.writeHtml(ctx.response, code, renderPersonLifecycle(ctx, g.person, lifecycle, { kind: "error", text: message }), {}, true);
  return true;
}

function sameOrigin(ctx: GatewayRouteContext): boolean {
  const origin = ctx.login?.web?.origin;
  return Boolean(origin) && ctx.request.headers.origin === origin && ctx.request.headers["sec-fetch-site"] !== "cross-site";
}

async function form(request: IncomingMessage, allowed: readonly string[]): Promise<Record<string, string> | "too_large" | undefined> {
  try { return await readForm(request, allowed, FORM_LIMIT); } catch (error) { if (error instanceof FormTooLarge) return "too_large"; throw error; }
}

export const personLifecycleRoute: GatewayRoute = { name: "person-lifecycle", handle: async (ctx) => {
  const method = ctx.request.method, url = new URL(ctx.request.url ?? "/", "http://gateway.invalid"), path = url.pathname;
  const page = method === "GET" || method === "HEAD" ? PAGE.exec(path) : null;
  const post = method === "POST" ? (UNTAG.exec(path) ?? CORRECT.exec(path) ?? WARN.exec(path) ?? TAG.exec(path)) : null;
  if (!page && !post) return false;
  const service = ctx.login?.lifecycle, session = sessionCookie(ctx.request.headers.cookie);
  if (page) {
    const done = url.searchParams.get("done");
    const queryOk = url.search === "" || (url.searchParams.size === 1 && done !== null && Object.hasOwn(DONE, done));
    const g = queryOk ? await gate(ctx.login?.people, service, session, decoded(page[1]!)) : { kind: "status" as const, status: 404 as const };
    if (g.kind !== "ok") return status(ctx, g.status);
    const lifecycle = await service!.store.read(g.actorId, g.person.principalId);
    if (!lifecycle) return status(ctx, 404);
    if (!wantsHtml(ctx.request.headers.accept)) {
      ctx.response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept" });
      ctx.response.end(JSON.stringify({ person: { principalId: g.person.principalId, name: g.person.name }, ...lifecycle }));
      return true;
    }
    ctx.writeHtml(ctx.response, 200, renderPersonLifecycle(ctx, g.person, lifecycle, done ? { kind: "done", text: DONE[done]! } : undefined), {}, true);
    return true;
  }
  // Same origin, checked before the session or the body is read.
  if (!sameOrigin(ctx)) {
    ctx.request.resume();
    ctx.writeHtml(ctx.response, 403, ctx.pageDocument("Warnings and tags", "<main id=\"main\"><h1>Warnings and tags</h1><p>This form must be sent from StudentHub itself.</p></main>"));
    return true;
  }
  const principalId = decoded(post![1]!), itemId = post![2] === undefined ? undefined : decoded(post![2]);
  if (url.search !== "" || (post![2] !== undefined && (itemId === undefined || !UUID.test(itemId)))) { ctx.request.resume(); return status(ctx, 404); }
  const g = await gate(ctx.login?.people, service, session, principalId);
  if (g.kind !== "ok") { ctx.request.resume(); return status(ctx, g.status); }
  const store = service!.store, person = g.person.principalId, back = `/workspace/people/${encodeURIComponent(person)}/lifecycle`;
  const redirect = (done: keyof typeof DONE & string): true => { ctx.response.writeHead(303, { location: `${back}?done=${done}`, "cache-control": "no-store" }); ctx.response.end(); return true; };
  const kind = UNTAG.test(path) ? "untag" : CORRECT.test(path) ? "correct" : WARN.test(path) ? "warn" : "tag";
  const fields = kind === "untag" ? [] : kind === "tag" ? ["tag", "reason"] : kind === "warn" ? ["title", "message"] : ["title", "message", "version"];
  const body = await form(ctx.request, fields);
  if (body === "too_large") return refuse(ctx, service!, g, 400, "That text is too long.");
  if (!body) return refuse(ctx, service!, g, 400, "Fill in every field.");
  if (kind === "untag") {
    const result = await store.removeTag(g.actorId, person, itemId!);
    return result.kind === "removed" ? redirect("removed") : refuse(ctx, service!, g, 409, "That tag was already removed.");
  }
  if (kind === "tag") {
    const tag = text(body.tag, LIFECYCLE_LIMITS.tag), reason = text(body.reason, LIFECYCLE_LIMITS.reason);
    if (!tag || !reason) return refuse(ctx, service!, g, 400, `A tag needs a name of up to ${LIFECYCLE_LIMITS.tag} characters and a reason of up to ${LIFECYCLE_LIMITS.reason}.`);
    const result = await store.addTag(g.actorId, person, { tag, reason });
    if (result.kind === "tagged") return redirect("tagged");
    return result.kind === "duplicate" ? refuse(ctx, service!, g, 409, "This person already has that tag.") : status(ctx, 404);
  }
  const title = text(body.title, LIFECYCLE_LIMITS.title), message = text(body.message, LIFECYCLE_LIMITS.message);
  if (!title || !message) return refuse(ctx, service!, g, 400, `A warning needs a title of up to ${LIFECYCLE_LIMITS.title} characters and a message of up to ${LIFECYCLE_LIMITS.message}.`);
  if (kind === "warn") {
    const result = await store.warn(g.actorId, person, { title, message });
    return result.kind === "warned" ? redirect("warned") : status(ctx, 404);
  }
  const version = /^[1-9]\d{0,8}$/.test(body.version ?? "") ? Number(body.version) : undefined;
  if (version === undefined) return refuse(ctx, service!, g, 400, "Open the page again and retry the correction.");
  const result = await store.correctWarning(g.actorId, person, itemId!, { title, message, expectedVersion: version });
  if (result.kind === "corrected") return redirect("corrected");
  return result.kind === "stale" ? refuse(ctx, service!, g, 409, "Someone corrected this warning meanwhile. Check the wording below and try again.") : status(ctx, 404);
} };
