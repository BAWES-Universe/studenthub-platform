import type { IncomingMessage, ServerResponse } from "node:http";
import { ID_CARD_BATCH_MAX, ID_CARD_PAGE_SIZE, ID_CARD_VIEWS } from "../../../../packages/reports/src/id-cards.js";
import type { IdCardAction, IdCardListRow, IdCardView, IdCardWriteResult, OwnIdCard } from "../../../../packages/reports/src/id-cards.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * S8 ID cards on the web.
 *
 * GET /workspace/id-cards is the staff page (legacy staff "Candidate ID cards"): who is
 * assigned and has no card, whose card has expired, and every card issued, with a name
 * search. POST issues or renews cards for the people ticked, all or nothing, each valid three
 * months from today. Only StudentHub staff see the page; anyone else, signed out included,
 * gets the same not found whatever the method.
 *
 * GET /profile/id-card is the person's own card: name, card number, company, store and the
 * date it is valid until, or a note that they have no card yet.
 */
export interface IdCardsHttpService {
  isStaff(principalId: string): Promise<boolean>;
  list(viewer: string, view: IdCardView, name: string | null, page: number): Promise<{ readonly rows: readonly IdCardListRow[]; readonly total: number; readonly today: string } | undefined>;
  write(viewer: string, action: IdCardAction, people: readonly string[]): Promise<IdCardWriteResult>;
  own(personId: string): Promise<(OwnIdCard & { readonly valid: boolean }) | undefined>;
}

export const ID_CARDS_PATH = "/workspace/id-cards", OWN_ID_CARD_PATH = "/profile/id-card";
const LIMIT = 16384;
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const cookie = (v: string | undefined) => v?.split(";").map(x => x.trim()).find(x => x.startsWith("__Host-studenthub_session="))?.slice(26);
const VIEW_LABELS: Record<IdCardView, string> = { needs: "Need a card", expired: "Expired", issued: "All cards" };
const REFUSALS: Record<string, string> = { unknown_person: "is not a StudentHub account", not_assigned: "is not assigned to a store", no_card: "has no card to renew" };

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body)); return true;
}
function reply(req: IncomingMessage, res: ServerResponse, status: number, body: Record<string, unknown>, title: string, message: string, extra = ""): true {
  if (wantsHtml(req.headers.accept)) { writeHtml(res, status, pageDocument(title, `<main><h1>${esc(title)}</h1><p>${esc(message)}</p>${extra}</main>`), { "cache-control": "no-store" }); return true; }
  return json(res, status, body);
}
const notFound = (req: IncomingMessage, res: ServerResponse) => reply(req, res, 404, { status: "not_found" }, "Not found", "The page could not be found.");

/** The form body: `action` once and `person` once per person ticked, nothing else. */
async function form(req: IncomingMessage): Promise<{ action: string; people: string[] } | null> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") || Number(req.headers["content-length"]) > LIMIT) { req.resume(); return null; }
  req.setEncoding("utf8"); let raw = "";
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > LIMIT) return null; }
  const params = new URLSearchParams(raw), actions = params.getAll("action");
  if ([...params.keys()].some(k => k !== "action" && k !== "person") || actions.length !== 1) return null;
  return { action: actions[0]!, people: params.getAll("person") };
}

function listPage(view: IdCardView, name: string | null, page: number, list: { readonly rows: readonly IdCardListRow[]; readonly total: number; readonly today: string }, notice = ""): string {
  const query = (v: IdCardView, p = 1) => `${ID_CARDS_PATH}?view=${v}${name ? `&name=${encodeURIComponent(name)}` : ""}${p > 1 ? `&page=${p}` : ""}`;
  const tabs = ID_CARD_VIEWS.map(v => v === view ? `<strong>${VIEW_LABELS[v]}</strong>` : `<a href="${esc(query(v))}">${VIEW_LABELS[v]}</a>`).join(" · ");
  const search = `<form method="get" action="${ID_CARDS_PATH}"><input type="hidden" name="view" value="${view}"><label>Name <input type="search" name="name" maxlength="100" value="${esc(name ?? "")}"></label><button type="submit">Search</button></form>`;
  const rows = list.rows.map(r => `<tr><td><input type="checkbox" name="person" value="${esc(r.personId)}" aria-label="Select ${esc(r.name ?? r.personId)}"></td><td>${esc(r.name ?? "No name")}</td><td>${esc(r.employeeId ?? "")}</td><td>${esc(r.placement ? `${r.placement.company}, ${r.placement.store}` : "Not assigned")}</td><td>${r.cardNumber === null ? "No card" : `${r.cardNumber}`}</td><td>${esc(r.expiresOn ? `${r.expiresOn}${r.expiresOn < list.today ? " (expired)" : ""}` : "")}</td></tr>`).join("");
  const action = view === "needs" ? `<button type="submit" name="action" value="issue">Issue cards</button>` : `<button type="submit" name="action" value="renew">Renew cards</button>`;
  const pages = Math.max(1, Math.ceil(list.total / ID_CARD_PAGE_SIZE));
  const nav = `${page > 1 ? `<a href="${esc(query(view, page - 1))}">Previous</a> ` : ""}${page < pages ? `<a href="${esc(query(view, page + 1))}">Next</a>` : ""}`;
  const table = list.total ? `<form method="post" action="${ID_CARDS_PATH}"><table><thead><tr><th>Select</th><th>Name</th><th>Employee ID</th><th>Company and store</th><th>Card</th><th>Valid until</th></tr></thead><tbody>${rows}</tbody></table><p>Up to ${ID_CARD_BATCH_MAX} at a time. Each card is valid for three months from today.</p>${action}</form><p>${nav}</p>`
    : `<p>${view === "needs" ? "Everyone assigned to a store has a card." : view === "expired" ? "No assigned person has an expired card." : "No cards have been issued yet."}</p>`;
  return `<main><h1>ID cards</h1>${notice}<p>${tabs}</p>${search}<p>${list.total} ${list.total === 1 ? "person" : "people"}.</p>${table}</main>`;
}

async function staffPage(req: IncomingMessage, res: ServerResponse, service: IdCardsHttpService, viewer: string, origin: string | undefined): Promise<true> {
  if (req.method === "POST") {
    if (!req.headers.origin || !origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); return reply(req, res, 403, { status: "forbidden" }, "Not saved", "We could not verify this request."); }
    const body = await form(req);
    const action = body?.action === "issue" || body?.action === "renew" ? body.action : undefined;
    if (!body || !action) return reply(req, res, 400, { status: "invalid" }, "Not saved", "The request was not valid.");
    if (body.people.length === 0) return reply(req, res, 400, { status: "invalid", field: "person" }, "Not saved", "Tick at least one person.", `<p><a href="${ID_CARDS_PATH}">Back to ID cards</a></p>`);
    const result = await service.write(viewer, action, body.people);
    if (result.status === "not_found") return notFound(req, res);
    if (result.status === "invalid") return reply(req, res, 400, { status: "invalid" }, "Not saved", `Tick between 1 and ${ID_CARD_BATCH_MAX} people, each once.`, `<p><a href="${ID_CARDS_PATH}">Back to ID cards</a></p>`);
    if (result.status === "refused") {
      if (!wantsHtml(req.headers.accept)) return json(res, 409, { status: "refused", refusals: result.refusals });
      const items = result.refusals.map(r => `<li>${esc(r.personId)} ${esc(REFUSALS[r.code] ?? r.code)}</li>`).join("");
      writeHtml(res, 409, pageDocument("Not saved", `<main><h1>Not saved</h1><p>No card was ${action === "issue" ? "issued" : "renewed"}, because:</p><ul>${items}</ul><p><a href="${ID_CARDS_PATH}">Back to ID cards</a></p></main>`), { "cache-control": "no-store" });
      return true;
    }
    return reply(req, res, 200, { status: "ok", action, count: result.count, expiresOn: result.expiresOn }, "Saved",
      `${result.count} ${result.count === 1 ? "card" : "cards"} ${action === "issue" ? "issued" : "renewed"}, valid until ${result.expiresOn}.`, `<p><a href="${ID_CARDS_PATH}?view=issued">See all cards</a></p>`);
  }
  if (req.method !== "GET") { req.resume(); res.writeHead(405, { allow: "GET, POST" }); res.end(); return true; }
  req.resume();
  const url = new URL(req.url ?? "/", "http://gateway.invalid"), rawView = url.searchParams.get("view") ?? "needs", rawPage = url.searchParams.get("page"), rawName = url.searchParams.get("name");
  const view = (ID_CARD_VIEWS as readonly string[]).includes(rawView) ? rawView as IdCardView : undefined;
  const page = rawPage === null ? 1 : /^[1-9][0-9]{0,5}$/.test(rawPage) ? Number(rawPage) : 0;
  if (!view || !page || (rawName !== null && rawName.length > 100)) return reply(req, res, 400, { status: "invalid" }, "Not shown", "The list could not be shown.");
  const name = rawName?.trim() || null, list = await service.list(viewer, view, name, page);
  if (!list) return notFound(req, res);
  if (!wantsHtml(req.headers.accept)) return json(res, 200, { status: "ok", view, page, total: list.total, today: list.today, rows: list.rows });
  writeHtml(res, 200, pageDocument("ID cards", listPage(view, name, page, list)), { "cache-control": "no-store" });
  return true;
}

async function ownPage(req: IncomingMessage, res: ServerResponse, service: IdCardsHttpService, person: string | undefined): Promise<true> {
  req.resume();
  if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
  if (!person) return reply(req, res, 401, { status: "unauthenticated" }, "Sign in", "Sign in to see your ID card.", `<p><a href="/profile">Go to your profile</a></p>`);
  const card = await service.own(person);
  if (!wantsHtml(req.headers.accept)) return json(res, 200, card ? { status: "ok", card: { ...card, issuedAt: card.issuedAt.toISOString() } } : { status: "none" });
  if (!card) { writeHtml(res, 200, pageDocument("Your ID card", `<main><h1>Your ID card</h1><p>You do not have a StudentHub ID card yet. StudentHub staff issue one when you are assigned to a store.</p></main>`), { "cache-control": "no-store" }); return true; }
  const rows: [string, string][] = [["Name", card.name ?? "Not set"], ...(card.arabicName ? [["Arabic name", card.arabicName] as [string, string]] : []), ["Card number", String(card.cardNumber)],
    ...(card.employeeId ? [["Employee ID", card.employeeId] as [string, string]] : []), ["Company", card.placement?.company ?? "Not assigned"], ["Store", card.placement?.store ?? "Not assigned"], ["Valid until", card.expiresOn]];
  const status = card.valid ? `<p>This card is valid.</p>` : `<p role="alert">This card expired on ${esc(card.expiresOn)}. Ask StudentHub staff to renew it.</p>`;
  writeHtml(res, 200, pageDocument("Your ID card", `<main><h1>Your ID card</h1>${status}<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></main>`), { "cache-control": "no-store" });
  return true;
}

export async function handleIdCards(req: IncomingMessage, res: ServerResponse, service: IdCardsHttpService | undefined, origin: string | undefined,
  authorize: (session: string) => Promise<string | undefined>): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://gateway.invalid").pathname;
  if (path !== ID_CARDS_PATH && path !== OWN_ID_CARD_PATH) return false;
  const session = cookie(req.headers.cookie), viewer = service && session ? await authorize(session).catch(() => undefined) : undefined;
  if (path === OWN_ID_CARD_PATH) { if (!service) { req.resume(); return notFound(req, res); } return ownPage(req, res, service, viewer); }
  // Authorization comes first, so every caller who is not staff gets the same not found whatever the method.
  let staff = false; if (viewer) try { staff = await service!.isStaff(viewer); } catch { /* treated as not staff */ }
  if (!viewer || !staff) { req.resume(); return notFound(req, res); }
  return staffPage(req, res, service!, viewer, origin);
}
