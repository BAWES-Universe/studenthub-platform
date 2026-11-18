import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StaffMessageResult } from "../../../../packages/comms/src/staff-messages.js";
import { STAFF_MESSAGE_BODY_MAX } from "../../../../packages/comms/src/staff-messages.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * Staff sends a document request or a message to one person (legacy types 12 to 14):
 * GET /workspace/people/<person>/message shows the form, POST sends it. Only StudentHub
 * staff see either; anyone else, signed out included, gets the same not found. The form carries a fresh send key, so a
 * double submit or a retried request is answered `already_sent` and writes nothing.
 */
export interface StaffMessagesHttpService {
  isStaff(principalId: string): Promise<boolean>;
  send(senderPrincipalId: string, input: { recipientPrincipalId: string; kind: string; body?: string | null; sendKey: string }): Promise<StaffMessageResult>;
}

const PATH = /^\/workspace\/people\/([^/]+)\/message$/, PERSON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, LIMIT = 8192;
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const cookie = (v: string | undefined) => v?.split(";").map(x => x.trim()).find(x => x.startsWith("__Host-studenthub_session="))?.slice(26);
const NOT_FOUND = { status: "not_found" } as const;

function reply(req: IncomingMessage, res: ServerResponse, status: number, body: Record<string, unknown>, title: string, message: string, extra = ""): true {
  if (wantsHtml(req.headers.accept)) writeHtml(res, status, pageDocument(title, `<main><h1>${esc(title)}</h1><p>${esc(message)}</p>${extra}</main>`), { "cache-control": "no-store" });
  else { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); }
  return true;
}

async function form(req: IncomingMessage): Promise<URLSearchParams | null> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") || Number(req.headers["content-length"]) > LIMIT) { req.resume(); return null; }
  req.setEncoding("utf8"); let raw = "";
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > LIMIT) return null; }
  const params = new URLSearchParams(raw), keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some(k => !["kind", "body", "send_key"].includes(k))) return null;
  return params;
}

function formPage(path: string): string {
  return `<main><h1>Message this person</h1><p>They will see it in their notifications.</p><form method="post" action="${esc(path)}"><input type="hidden" name="send_key" value="${randomUUID()}"><fieldset><legend>What to send</legend><label><input type="radio" name="kind" value="profile_photo_request" required> Ask for a profile photo</label><label><input type="radio" name="kind" value="civil_id_request"> Ask for their civil ID</label><label><input type="radio" name="kind" value="message"> Send a message</label></fieldset><label>Message (only for "Send a message", up to ${STAFF_MESSAGE_BODY_MAX} characters) <textarea name="body" maxlength="${STAFF_MESSAGE_BODY_MAX}"></textarea></label><button type="submit">Send</button></form></main>`;
}

export async function handleStaffMessages(req: IncomingMessage, res: ServerResponse, service: StaffMessagesHttpService | undefined, origin: string | undefined,
  authorize: (session: string) => Promise<string | undefined>): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://gateway.invalid").pathname, match = path.match(PATH);
  if (!match) return false;
  let recipient: string;
  try { recipient = decodeURIComponent(match[1]!); } catch { req.resume(); return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found."); }
  if (!service || !PERSON.test(recipient)) { req.resume(); return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found."); }
  const session = cookie(req.headers.cookie), sender = session ? await authorize(session) : undefined;
  if (!sender) { req.resume(); return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found."); }
  let staff = false; try { staff = await service.isStaff(sender); } catch { /* treated as not staff */ }
  if (!staff) { req.resume(); return reply(req, res, 404, NOT_FOUND, "Not found", "The page could not be found."); }
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
