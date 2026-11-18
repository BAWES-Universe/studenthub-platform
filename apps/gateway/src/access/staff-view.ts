import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import {
  REASON_MAX,
  mayOpenAccessAdmin,
  mayViewAs,
  parseStaffViewRequest,
  viewOpen,
  type AccessReadStore,
  type StaffViewStore,
} from "../../../../packages/access/src/index.js";
import { escapeHtml, readForm, sessionCookie } from "./admin-access.js";

/**
 * Access lane A9: staff view a person's account read-only for 15 minutes.
 *
 * GET  /admin/access/people/{id}/view   the person's My profile as they see it, while a view is open;
 *                                        otherwise the form to start one
 * POST /admin/access/people/{id}/view   start a view, with a reason
 *
 * The page is rendered from the person's own profile read, then every form,
 * script and link is taken out, so nothing on it can act: staff never hold a
 * session as the person. Callers without the right get the unknown-path 404.
 */
export interface StaffViewPorts {
  readonly sessions: Pick<SessionStore, "get">;
  readonly reads: Pick<AccessReadStore, "callerGrants" | "person">;
  readonly views: StaffViewStore;
  /** The person's My profile document as they would see it, or undefined when it cannot be read. */
  readonly render?: (targetPrincipalId: string) => Promise<string | undefined>;
  readonly operatorOrgIds?: readonly string[];
  readonly now?: () => Date;
}

export type StaffViewWriter = (status: number, title: string, body: string) => void;

const VIEW = /^\/admin\/access\/people\/([^/]+)\/view$/;

/** Takes every form, script and link out of a rendered document, and puts the banner first in the body. */
export function readOnlyDocument(document: string, banner: string): string {
  return document
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<form\b[\s\S]*?<\/form>/gi, "")
    .replace(/<(input|button|textarea|select)\b[^>]*>/gi, "")
    .replace(/<a\b[^>]*>/gi, "<span>")
    .replace(/<\/a>/gi, "</span>")
    .replace(/<body([^>]*)>/i, `<body$1>${banner}`);
}

const timeText = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export async function handleStaffView(
  req: IncomingMessage,
  res: ServerResponse,
  ports: StaffViewPorts | undefined,
  origin: string | undefined,
  write: StaffViewWriter,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://gateway.invalid").pathname;
  const match = VIEW.exec(path);
  if (!match || !ports || (req.method !== "GET" && req.method !== "POST")) return false;
  let targetId: string;
  try { targetId = decodeURIComponent(match[1]!); } catch { return false; }
  const session = sessionCookie(req.headers.cookie);
  const caller = session ? (await ports.sessions.get(session))?.personId : undefined;
  if (!caller) return false;
  const callerGrants = await ports.reads.callerGrants(caller);
  if (!mayOpenAccessAdmin(callerGrants, ports.operatorOrgIds)) return false;
  const person = await ports.reads.person(targetId);
  if (!person) return false;
  const name = person.displayName ?? person.email ?? "This person";
  const back = `/admin/access/people/${encodeURIComponent(targetId)}`;
  const here = `${back}/view`;
  const allowed = mayViewAs(caller, targetId, callerGrants, await ports.views.grantsOf(targetId), ports.operatorOrgIds);
  const e = escapeHtml;
  const page = (status: number, heading: string, text: string, form = "") =>
    write(status, "View as", `<main id="main" class="error-page"><div class="eyebrow">STUDENTHUB STAFF</div><h1>${e(heading)}</h1><p>${e(text)}</p>${form}<p><a class="text-link" href="${e(back)}">← Back to ${e(name)}’s access</a></p></main>`);

  if (req.method === "POST") {
    if (!origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {
      req.resume();
      page(400, "Nothing was started.", "Start the view from this page.");
      return true;
    }
    const form = await readForm(req);
    const request = form && Object.keys(form).every((key) => key === "targetPrincipalId" || key === "reason") ? parseStaffViewRequest(form) : undefined;
    if (!request || request.targetPrincipalId !== targetId) {
      page(400, "Nothing was started.", "Give a reason of 3 to 500 characters.");
      return true;
    }
    if (!allowed) {
      page(403, "Nothing was started.", caller === targetId ? "You can’t view your own account as staff." : "Only an administrator can view the account of someone who works for StudentHub.");
      return true;
    }
    // The store decides again on both people's grants inside the write, so a
    // right lost (or a pause) since the checks above starts nothing.
    const started = await ports.views.start(caller, request, (callerNow, targetNow) =>
      mayOpenAccessAdmin(callerNow, ports.operatorOrgIds) && mayViewAs(caller, targetId, callerNow, targetNow, ports.operatorOrgIds));
    if (!started) {
      page(403, "Nothing was started.", "Your access changed. Go back and try again.");
      return true;
    }
    res.writeHead(303, { location: here, "cache-control": "no-store" });
    res.end();
    return true;
  }

  const open = allowed ? await ports.views.open(caller, targetId) : null;
  if (!open || !viewOpen(open, (ports.now ?? (() => new Date()))())) {
    const form = allowed
      ? `<form method="post" action="${e(here)}"><input type="hidden" name="targetPrincipalId" value="${e(targetId)}"><label for="view-reason">Why do you need to see this account? (kept with the view)</label><textarea id="view-reason" name="reason" minlength="3" maxlength="${REASON_MAX}" required></textarea><button class="button primary" type="submit">View as ${e(name)} for 15 minutes</button></form>`
      : "";
    page(200, `View ${name}’s account`, allowed
      ? `You’ll see ${name}’s profile as they see it, read-only, for 15 minutes. ${name} will see that StudentHub staff opened a view of their account on today’s date. Nothing can be changed from the view.`
      : caller === targetId ? "You can’t view your own account as staff." : "Only an administrator can view the account of someone who works for StudentHub.", form);
    return true;
  }
  const document = ports.render ? await ports.render(targetId).catch(() => undefined) : undefined;
  if (!document) {
    page(503, "This profile couldn’t be loaded.", "Try again in a moment. The view stays open until it ends.");
    return true;
  }
  if (!viewOpen(open, (ports.now ?? (() => new Date()))())) {
    page(200, "This view has ended.", "Views last 15 minutes. Start a new one from this person’s access page if you still need it.");
    return true;
  }
  const banner = `<section class="notice context-notice" role="status"><strong>Viewing as ${e(name)}, read-only, until ${e(timeText(open.expiresAt))}.</strong> <a class="text-link" href="${e(back)}">End and go back</a></section>`;
  // The banner keeps its link: it is added after the links are taken out.
  const html = readOnlyDocument(document, "\u0000BANNER\u0000").replace("\u0000BANNER\u0000", () => banner);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    "x-frame-options": "DENY", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(html);
  return true;
}
