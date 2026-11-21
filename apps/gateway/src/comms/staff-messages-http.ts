import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StaffMessageResult } from "../../../../packages/comms/src/staff-messages.js";
import { STAFF_MESSAGE_BODY_MAX } from "../../../../packages/comms/src/staff-messages.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";
import type { IdCardsHttpService } from "../reports/id-cards-http.js";

/**
 * Staff sends a document request or a message to one person (legacy types 12 to 14):
 * GET /workspace/people/<person>/message shows the form, POST sends it. Only StudentHub
 * staff see either; anyone else, signed out included, gets the same not found. The form carries a fresh send key, so a
 * double submit or a retried request is answered `already_sent` and writes nothing.
 *
 * GET /workspace/people/<person>/emails is the person's email delivery log for staff (contract
 * C-2): each email's class, state and attempts with their closed outcome codes. It never shows
 * the address or the text, which the log does not read.
 *
 * GET /workspace/morning-summary is today's morning summary for staff (contract P-2): each
 * counter with its number, or "not available" while its source has not landed, read fresh
 * with the same values the 08:00 email carries. POST turns that email on or off for the
 * staff member themself.
 */
export interface StaffDeliveryLogEntry {
  readonly id: string; readonly emailClass: string; readonly state: string; readonly createdAt: Date; readonly sentAt: Date | null;
  readonly attempts: readonly { readonly attempt: number; readonly outcome: string; readonly failureCode: string | null; readonly at: Date }[];
}
export interface StaffMessagesHttpService {
  isStaff(principalId: string): Promise<boolean>;
  send(senderPrincipalId: string, input: { recipientPrincipalId: string; kind: string; body?: string | null; sendKey: string }): Promise<StaffMessageResult>;
  deliveryLog?(recipientPrincipalId: string, offset: number, limit: number): Promise<{ rows: readonly StaffDeliveryLogEntry[]; total: number } | null>;
  morningSummary?: {
    today(viewer: string): Promise<{ readonly day: string; readonly subscribed: boolean; readonly rows: readonly { readonly key: string; readonly label: string; readonly value: number | null; readonly waitsOn: string | null }[] } | undefined>;
    subscribe(viewer: string, on: boolean): Promise<boolean>;
  };
  /** S8 ID cards, sharing this composition's pool. */
  idCards?: IdCardsHttpService;
}

const PATH = /^\/workspace\/people\/([^/]+)\/(message|emails)$/, SUMMARY_PATH = "/workspace/morning-summary", LOG_PAGE = 50, PERSON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, LIMIT = 8192;
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const cookie = (v: string | undefined) => v?.split(";").map(x => x.trim()).find(x => x.startsWith("__Host-studenthub_session="))?.slice(26);
const NOT_FOUND = { status: "not_found" } as const;

function reply(req: IncomingMessage, res: ServerResponse, status: number, body: Record<string, unknown>, title: string, message: string, extra = ""): true {
  if (wantsHtml(req.headers.accept)) writeHtml(res, status, pageDocument(title, `<main><h1>${esc(title)}</h1><p>${esc(message)}</p>${extra}</main>`), { "cache-control": "no-store" });
  else { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); }
  return true;
}

async function form(req: IncomingMessage, allowed: readonly string[] = ["kind", "body", "send_key"]): Promise<URLSearchParams | null> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") || Number(req.headers["content-length"]) > LIMIT) { req.resume(); return null; }
  req.setEncoding("utf8"); let raw = "";
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > LIMIT) return null; }
  const params = new URLSearchParams(raw), keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(k => !allowed.includes(k))) return null;
  return params;
}

function formPage(path: string): string {
  return `<main><h1>Message this person</h1><p>They will see it in their notifications.</p><form method="post" action="${esc(path)}"><input type="hidden" name="send_key" value="${randomUUID()}"><fieldset><legend>What to send</legend><label><input type="radio" name="kind" value="profile_photo_request" required> Ask for a profile photo</label><label><input type="radio" name="kind" value="civil_id_request"> Ask for their civil ID</label><label><input type="radio" name="kind" value="message"> Send a message</label></fieldset><label>Message (only for "Send a message", up to ${STAFF_MESSAGE_BODY_MAX} characters) <textarea name="body" maxlength="${STAFF_MESSAGE_BODY_MAX}"></textarea></label><button type="submit">Send</button></form></main>`;
}

const CLASS_LABELS: Record<string, string> = { "account.notice": "Account notice", "civil_id.result": "Civil ID result", "staff.morning_summary": "Morning summary", "staff.firing_spike": "Firing spike", "recruit.invitation": "Job invitation", "person.birthday": "Birthday", "person.civil_id_expired": "Civil ID expired", "person.civil_id_expiring": "Civil ID expiring" };
const STATE_LABELS: Record<string, string> = { pending: "Waiting to send", sending: "Sending", sent: "Sent", failed: "Not delivered", not_sent: "Not sent", suppressed: "Switched off by the person" };
const iso = (d: Date | null) => d ? d.toISOString() : null;

async function deliveryLog(req: IncomingMessage, res: ServerResponse, service: StaffMessagesHttpService, recipient: string, rawPage: string | null): Promise<true> {
  req.resume();
  if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
  if (!service.deliveryLog) return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found.");
  const page = rawPage === null ? 1 : /^[1-9][0-9]{0,5}$/.test(rawPage) ? Number(rawPage) : 0;
  if (!page) return reply(req, res, 400, { status: "invalid", field: "page" }, "Not shown", "The page number is not valid.");
  const log = await service.deliveryLog(recipient, (page - 1) * LOG_PAGE, LOG_PAGE);
  if (!log) return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found.");
  const emails = log.rows.map(r => ({ id: r.id, emailClass: r.emailClass, state: r.state, createdAt: iso(r.createdAt), sentAt: iso(r.sentAt),
    attempts: r.attempts.map(a => ({ attempt: a.attempt, outcome: a.outcome, failureCode: a.failureCode, at: iso(a.at) })) }));
  if (!wantsHtml(req.headers.accept)) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ status: "ok", page, total: log.total, emails })); return true;
  }
  const rows = emails.map(e => `<tr><td>${esc(CLASS_LABELS[e.emailClass] ?? e.emailClass)}</td><td>${esc(STATE_LABELS[e.state] ?? e.state)}</td><td>${esc(e.createdAt ?? "")}</td><td>${esc(e.sentAt ?? "")}</td><td>${e.attempts.map(a => esc(`${a.attempt}: ${a.outcome}${a.failureCode ? ` (${a.failureCode})` : ""} at ${a.at}`)).join("<br>")}</td></tr>`).join("");
  const pages = Math.max(1, Math.ceil(log.total / LOG_PAGE)), base = `/workspace/people/${encodeURIComponent(recipient)}/emails`;
  const nav = `${page > 1 ? `<a href="${esc(base)}?page=${page - 1}">Newer</a> ` : ""}${page < pages ? `<a href="${esc(base)}?page=${page + 1}">Older</a>` : ""}`;
  const body = log.total ? `<table><thead><tr><th>Email</th><th>State</th><th>Queued</th><th>Sent</th><th>Attempts</th></tr></thead><tbody>${rows}</tbody></table><p>${nav}</p>` : `<p>No emails to this person yet.</p>`;
  writeHtml(res, 200, pageDocument("Emails to this person", `<main><h1>Emails to this person</h1><p>What was sent and how each try went. Addresses and email text are not shown.</p>${body}</main>`), { "cache-control": "no-store" });
  return true;
}

async function morningSummary(req: IncomingMessage, res: ServerResponse, service: StaffMessagesHttpService, viewer: string, origin: string | undefined): Promise<true> {
  const summary = service.morningSummary!;
  if (req.method === "POST") {
    if (!req.headers.origin || !origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); return reply(req, res, 403, { status: "forbidden" }, "Not saved", "We could not verify this request."); }
    const params = await form(req, ["email"]), email = params?.get("email");
    if (email !== "on" && email !== "off") return reply(req, res, 400, { status: "invalid", field: "email" }, "Not saved", "The request was not valid.");
    if (!(await summary.subscribe(viewer, email === "on"))) return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found.");
    if (wantsHtml(req.headers.accept)) { res.writeHead(303, { location: SUMMARY_PATH, "cache-control": "no-store" }); res.end(); return true; }
    return reply(req, res, 200, { status: "ok", subscribed: email === "on" }, "Saved", "Saved.");
  }
  req.resume();
  if (req.method !== "GET") { res.writeHead(405, { allow: "GET, POST" }); res.end(); return true; }
  const today = await summary.today(viewer);
  if (!today) return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found.");
  if (!wantsHtml(req.headers.accept)) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ status: "ok", day: today.day, subscribed: today.subscribed, counters: today.rows })); return true;
  }
  const rows = today.rows.map(r => `<tr><td>${esc(r.label)}</td><td>${r.value === null ? `Not available<br><small>Waits on ${esc(r.waitsOn ?? "its source")}</small>` : r.value}</td></tr>`).join("");
  const toggle = `<form method="post" action="${SUMMARY_PATH}"><input type="hidden" name="email" value="${today.subscribed ? "off" : "on"}"><p>${today.subscribed ? "You get this summary by email every morning at 8:00." : "You do not get this summary by email."}</p><button type="submit">${today.subscribed ? "Stop the morning email" : "Email me this every morning"}</button></form>`;
  writeHtml(res, 200, pageDocument("Morning summary", `<main><h1>Morning summary</h1><p>${esc(today.day)}, Kuwait time. These numbers are current as of now.</p><table><thead><tr><th>What needs attention</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table>${toggle}</main>`), { "cache-control": "no-store" });
  return true;
}

export async function handleStaffMessages(req: IncomingMessage, res: ServerResponse, service: StaffMessagesHttpService | undefined, origin: string | undefined,
  authorize: (session: string) => Promise<string | undefined>): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://gateway.invalid"), path = url.pathname, match = path.match(PATH);
  if (path === SUMMARY_PATH) {
    const session = cookie(req.headers.cookie), viewer = service?.morningSummary && session ? await authorize(session) : undefined;
    let staff = false; if (viewer) try { staff = await service!.isStaff(viewer); } catch { /* treated as not staff */ }
    if (!viewer || !staff) { req.resume(); return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found."); }
    return morningSummary(req, res, service!, viewer, origin);
  }
  if (!match) return false;
  let recipient: string;
  try { recipient = decodeURIComponent(match[1]!); } catch { req.resume(); return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found."); }
  if (!service || !PERSON.test(recipient)) { req.resume(); return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found."); }
  const session = cookie(req.headers.cookie), sender = session ? await authorize(session) : undefined;
  if (!sender) { req.resume(); return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found."); }
  let staff = false; try { staff = await service.isStaff(sender); } catch { /* treated as not staff */ }
  if (!staff) { req.resume(); return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found."); }
  if (match[2] === "emails") return deliveryLog(req, res, service, recipient, url.searchParams.get("page"));
  if (req.method === "GET") { writeHtml(res, 200, pageDocument("Message this person", formPage(path)), { "cache-control": "no-store" }); return true; }
  if (req.method !== "POST") { req.resume(); res.writeHead(405, { allow: "GET, POST" }); res.end(); return true; }
  if (!req.headers.origin || !origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); return reply(req, res, 403, { status: "forbidden" }, "Not sent", "We could not verify this request."); }
  const params = await form(req);
  if (!params) return reply(req, res, 400, { status: "invalid", field: "request" }, "Not sent", "The request was not valid.");
  const result = await service.send(sender, { recipientPrincipalId: recipient, kind: params.get("kind") ?? "", body: params.get("body"), sendKey: params.get("send_key") ?? "" });
  const back = `<p><a href="${esc(path)}">Send another</a></p>`;
  switch (result.status) {
    case "sent": return reply(req, res, 201, result, "Sent", "The person will see it in their notifications.", back);
    case "already_sent": return reply(req, res, 200, result, "Already sent", "This was already sent. Nothing new was sent.", back);
    case "invalid": return reply(req, res, 400, result, "Not sent", result.field === "body" ? `A message needs 1 to ${STAFF_MESSAGE_BODY_MAX} characters; a request has no message.` : "The request was not valid.", back);
    case "send_key_conflict": return reply(req, res, 409, result, "Not sent", "This form was already used for something else. Open it again to send.", back);
    case "recipient_not_found": case "forbidden": return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found.");
  }
}
