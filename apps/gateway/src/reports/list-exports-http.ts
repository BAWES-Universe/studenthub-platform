import type { IncomingMessage, ServerResponse } from "node:http";
import { CATALOGUE_LIST_KINDS } from "../../../../packages/exports/src/catalogue-list-export.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * GET /workspace/lists: the staff page with the admin country and university list exports
 * (legacy `country/download-list-excel` and `university/download-list-excel`). Each button
 * posts to `/exports/<kind>`, the export service's one request route, which checks the staff
 * grant again at request and at download, gives a 15-minute link and audits the export.
 * Anyone else, signed out included, gets not found.
 */
export const LISTS_PATH = "/workspace/lists";
const cookie = (v: string | undefined) => v?.split(";").map(x => x.trim()).find(x => x.startsWith("__Host-studenthub_session="))?.slice(26);

export async function handleListExports(req: IncomingMessage, res: ServerResponse, isStaff: ((session: string) => Promise<boolean>) | undefined): Promise<boolean> {
  if (new URL(req.url ?? "/", "http://gateway.invalid").pathname !== LISTS_PATH) return false;
  req.resume();
  if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
  const session = cookie(req.headers.cookie);
  let staff = false; try { staff = Boolean(session && isStaff && await isStaff(session)); } catch { /* treated as not staff */ }
  if (!staff) {
    if (wantsHtml(req.headers.accept)) writeHtml(res, 404, pageDocument("Not found", "<main><h1>Not found</h1><p>The page could not be found.</p></main>"), { "cache-control": "no-store" });
    else { res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" }); res.end(JSON.stringify({ error: "not_found" })); }
    return true;
  }
  const button = (kind: string, label: string) => `<form method="post" action="/exports/${kind}"><button class="button" type="submit">${label}</button></form>`;
  writeHtml(res, 200, pageDocument("Lists", `<main><h1>Lists</h1><p>Each export has every active entry with how many people chose it. The download link works for 15 minutes.</p><h2>Countries</h2><p>Counted by nationality.</p>${button(CATALOGUE_LIST_KINDS.country, "Export countries")}<h2>Universities</h2>${button(CATALOGUE_LIST_KINDS.university, "Export universities")}</main>`), { "cache-control": "no-store" });
  return true;
}
