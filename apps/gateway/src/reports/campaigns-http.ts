import type { IncomingMessage, ServerResponse } from "node:http";
import { CAMPAIGN_FIELDS, type CampaignField, type CampaignInput, type CampaignRefusal, type CampaignsPage } from "../../../../packages/reports/src/campaigns.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * GET /communications/campaigns: the marketing campaigns page (contract A-22, the UTM half), for
 * StudentHub staff only. Everyone else gets the same not found, whatever the method. POST there
 * (same origin only) creates, updates or retires a campaign by its `action` field. Signups and
 * revenue show as not available, never 0, until the access and pay lanes land.
 */
export interface CampaignsHttpService {
  campaignsPage(viewer: string): Promise<CampaignsPage | undefined>;
  campaignCreate(viewer: string, input: CampaignInput): Promise<{ id: string } | { refused: CampaignRefusal } | undefined>;
  campaignUpdate(viewer: string, id: string, input: CampaignInput): Promise<true | { refused: CampaignRefusal } | undefined>;
  campaignRetire(viewer: string, id: string): Promise<true | { refused: CampaignRefusal } | undefined>;
}

export const CAMPAIGNS_PATH = "/communications/campaigns";
const STATISTICS_PATH = "/workspace/statistics";
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const REFUSAL: { readonly [K in CampaignRefusal]: string } = {
  invalid_source: "The source is required and must be at most 100 characters.",
  invalid_medium: "The medium is required and must be at most 100 characters.",
  invalid_campaign: "The campaign is required and must be at most 100 characters.",
  invalid_content: "The content must be at most 100 characters.",
  invalid_term: "The term must be at most 100 characters.",
  invalid_investment: "The investment must be a number with at most 9 digits and 3 decimal places, and cannot be negative.",
  duplicate: "A live campaign already has those UTM values.",
  unknown: "That campaign no longer exists.",
  retired: "That campaign has been retired and cannot change.",
};
const LABEL: { readonly [K in CampaignField]: string } = {
  utmSource: "Source", utmMedium: "Medium", utmCampaign: "Campaign", utmContent: "Content", utmTerm: "Term",
};
const REQUIRED: readonly CampaignField[] = ["utmSource", "utmMedium", "utmCampaign"];

function notFound(req: IncomingMessage, res: ServerResponse): true {
  if (wantsHtml(req.headers.accept)) { writeHtml(res, 404, pageDocument("Not found", `<main><h1>Not found</h1><p>The page could not be found.</p></main>`), { "cache-control": "no-store" }); return true; }
  res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify({ status: "not_found" })); return true;
}
function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body)); return true;
}

function fields(values: Partial<Record<CampaignField, string | null>>, investment: string): string {
  return CAMPAIGN_FIELDS.map(f => `<label>${esc(LABEL[f])}${REQUIRED.includes(f) ? "" : " (optional)"} `
    + `<input name="${f}" maxlength="100" value="${esc(values[f] ?? "")}"${REQUIRED.includes(f) ? " required" : ""}></label>`).join(" ")
    + ` <label>Investment (KWD) <input name="investment" inputmode="decimal" value="${esc(investment)}"></label>`;
}

function campaignsHtml(page: CampaignsPage, alert?: string): string {
  const missing = page.missing.map(m => `<li>${esc(m.label)}: Not available <small>(waits on ${esc(m.waitsOn)})</small></li>`).join("");
  const rows = page.campaigns.map(c => {
    const cells = CAMPAIGN_FIELDS.map(f => `<td>${c[f] === null ? "<small>—</small>" : esc(c[f]!)}</td>`).join("");
    const edit = c.retired ? "<small>Retired</small>" : `<details><summary>Edit</summary><form method="post" action="${CAMPAIGNS_PATH}">`
      + `<input type="hidden" name="action" value="update"><input type="hidden" name="id" value="${esc(c.id)}">`
      + fields(c, c.investment) + ` <button type="submit">Save</button></form>`
      + `<form method="post" action="${CAMPAIGNS_PATH}"><input type="hidden" name="action" value="retire"><input type="hidden" name="id" value="${esc(c.id)}"><button type="submit">Retire</button></form></details>`;
    return `<tr${c.retired ? ` class="retired"` : ""}>${cells}<td>${esc(c.investment)}</td><td>${c.clicks.recent}</td><td>${c.clicks.total}</td><td>${edit}</td></tr>`;
  }).join("");
  return `<main><h1>Marketing campaigns</h1><p>UTM campaigns staff tag links with, as of ${esc(page.day)} (Kuwait time). `
    + `Recent clicks are the last ${page.clickDays} days.</p>`
    + (alert ? `<p role="alert">${esc(alert)}</p>` : "")
    + `<p>Also tracked in legacy, waiting on other lanes:</p><ul>${missing}</ul>`
    + (page.campaigns.length ? `<table><thead><tr>${CAMPAIGN_FIELDS.map(f => `<th scope="col">${esc(LABEL[f])}</th>`).join("")}`
      + `<th scope="col">Investment</th><th scope="col">Clicks (${page.clickDays}d)</th><th scope="col">Clicks (all)</th><th scope="col"></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p>No campaigns yet.</p>`)
    + `<h2>New campaign</h2><form method="post" action="${CAMPAIGNS_PATH}"><input type="hidden" name="action" value="create">`
    + fields({}, "") + ` <button type="submit">Create</button></form>`
    + `<p><a href="${STATISTICS_PATH}">Back to statistics</a></p></main>`;
}

// The largest valid form: five 100-unit fields of 3-byte characters, each byte percent-encoded (9 characters a unit), plus the id, investment, action and keys.
const LIMIT = 8192;
const KEYS = new Set<string>(["action", "id", ...CAMPAIGN_FIELDS, "investment"]);
interface Body { action: string; id: string | null; input: CampaignInput }
/** The POST body, or null when it is not a single well-formed urlencoded form of the known keys. */
async function body(req: IncomingMessage): Promise<Body | null> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") || Number(req.headers["content-length"]) > LIMIT) { req.resume(); return null; }
  req.setEncoding("utf8"); let raw = "";
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > LIMIT) return null; }
  const params = new URLSearchParams(raw), keys = [...params.keys()];
  if (keys.some(k => !KEYS.has(k)) || new Set(keys).size !== keys.length) return null;
  const action = params.get("action");
  if (action !== "create" && action !== "update" && action !== "retire") return null;
  const input: CampaignInput = {};
  for (const f of CAMPAIGN_FIELDS) if (params.has(f)) (input as Record<string, string>)[f] = params.get(f)!;
  if (params.has("investment")) (input as { investment?: string }).investment = params.get("investment")!;
  return { action, id: params.get("id"), input };
}

/** Handles the campaigns path; false for any other path. `viewer` is the signed-in person, `origin` this gateway's for the POST same-origin check. */
export async function handleCampaigns(req: IncomingMessage, res: ServerResponse, service: CampaignsHttpService | undefined, path: string,
  viewer: () => Promise<string | undefined>, isStaff: (viewer: string) => Promise<boolean>, origin?: string): Promise<boolean> {
  if (path !== CAMPAIGNS_PATH) return false;
  const posting = req.method === "POST";
  if (!posting) req.resume();
  const person = service ? await viewer() : undefined;
  // Authorization first: everyone who is not staff gets the same not found, whatever the method.
  let allowed = false; if (person) try { allowed = await isStaff(person); } catch { /* treated as not staff */ }
  if (!service || !person || !allowed) { if (posting) req.resume(); return notFound(req, res); }
  if (posting) {
    if (!req.headers.origin || !origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); return json(res, 403, { status: "forbidden" }); }
    const form = await body(req);
    if (!form) return json(res, 400, { status: "invalid", field: "form" });
    const result = form.action === "create" ? await service.campaignCreate(person, form.input)
      : form.action === "update" ? await service.campaignUpdate(person, form.id ?? "", form.input)
      : await service.campaignRetire(person, form.id ?? "");
    if (result === undefined) return notFound(req, res);
    if (typeof result === "object" && "refused" in result) {
      if (!wantsHtml(req.headers.accept)) return json(res, 400, { status: "invalid", field: result.refused });
      const page = await service.campaignsPage(person);
      if (!page) return notFound(req, res);
      writeHtml(res, 400, pageDocument("Marketing campaigns", campaignsHtml(page, REFUSAL[result.refused])), { "cache-control": "no-store" });
      return true;
    }
    if (wantsHtml(req.headers.accept)) { res.writeHead(303, { location: CAMPAIGNS_PATH, "cache-control": "no-store" }); res.end(); return true; }
    return json(res, form.action === "create" ? 201 : 200, form.action === "create" ? { status: "ok", ...(result as { id: string }) } : { status: "ok" });
  }
  if (req.method !== "GET") { res.writeHead(405, { allow: "GET, POST" }); res.end(); return true; }
  const page = await service.campaignsPage(person);
  if (!page) return notFound(req, res);
  if (!wantsHtml(req.headers.accept)) return json(res, 200, { status: "ok", ...page });
  writeHtml(res, 200, pageDocument("Marketing campaigns", campaignsHtml(page)), { "cache-control": "no-store" });
  return true;
}
