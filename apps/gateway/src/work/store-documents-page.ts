import type { GatewayRouteContext } from "../routes/context.js";
import { kuwaitDate } from "../../../../packages/work/src/index.js";
import { LifecycleError } from "../../../../packages/private-documents/src/candidate-lifecycle.js";
import { STORE_DELIVERY_PATH, StoreDocuments, type StoreDocumentAuditPort } from "../../../../packages/private-documents/src/store-delivery.js";
import { writeNotFound } from "../shell/error-pages.js";

/**
 * A store manager's view of one placed person's documents (matrix M-05).
 *
 * GET  /workspace/stores/<storeId>/candidates/<personId>/documents lists the photo and the CV: on file or
 *      not, format and size. No contents, no link issued, nothing recorded.
 * POST /workspace/stores/<storeId>/candidates/<personId>/documents/<type>/open issues one 60-second signed
 *      link, audited, and redirects to it.
 * GET  /workspace/stores/documents/delivery?t=... delivers it, re-checking sight and auditing again.
 *
 * Sight: the caller's own live store manager access opens the store (placements.forManagedStore), and the
 * person must be working there now or starting later. Civil ID images are never offered (decision D1).
 * Everyone else, another store, an ended placement and an unknown person get the unknown-path 404.
 */
const LIST = /^\/workspace\/stores\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/candidates\/([^/]+)\/documents$/;
const OPEN = /^\/workspace\/stores\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/candidates\/([^/]+)\/documents\/([^/]+)\/open$/;
const PERSON_ID = /^[A-Za-z0-9._:@-]{1,256}$/;
const NAMES: Readonly<Record<string, string>> = { "personal-photo": "Personal photo", resume: "CV" };
const FORMATS: Readonly<Record<string, string>> = { "application/pdf": "PDF", "image/png": "PNG image", "image/jpeg": "JPEG image" };
const size = (bytes: number) => bytes < 1024 ? `${bytes} bytes` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function sessionCookie(value: string | undefined): string | undefined {
  for (const item of value?.split(";") ?? []) {
    const [key, ...parts] = item.trim().split("=");
    const candidate = parts.join("=");
    if (key === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(candidate)) return candidate;
  }
  return undefined;
}

function unavailable(ctx: GatewayRouteContext): boolean {
  ctx.writeHtml(ctx.response, 503, ctx.pageDocument("Documents unavailable", '<main id="main" class="error-page"><h1>Documents unavailable</h1><p>Please try again later.</p></main>'));
  return true;
}
const notFound = (ctx: GatewayRouteContext) => { ctx.request.resume(); writeNotFound(ctx.request, ctx.response); return true; };
const decode = (segment: string) => { try { const value = decodeURIComponent(segment); return PERSON_ID.test(value) ? value : undefined; } catch { return undefined; } };

/** True when the request has no body. Never destroys the request, so a refusal still reaches the client. */
function emptyBody(ctx: GatewayRouteContext): Promise<boolean> {
  return new Promise((resolve) => {
    let bytes = 0;
    const done = (empty: boolean) => { ctx.request.off("data", data).off("end", end).off("error", failed); resolve(empty); };
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024) done(false); };
    const end = () => done(bytes === 0), failed = () => done(false);
    ctx.request.on("data", data).on("end", end).on("error", failed);
  });
}

/** The person's placements at a store the viewer manages, working now or starting later. */
export function storeSight(work: NonNullable<GatewayRouteContext["login"]>["work"], now: () => Date = () => new Date()) {
  return {
    async maySee(viewer: string, subject: string, storeId: string): Promise<boolean> {
      const placements = await work!.placements.forManagedStore(viewer, storeId, subject);
      const today = kuwaitDate(now());
      return Boolean(placements?.some((a) => a.personId === subject && (a.endDate === null || a.endDate >= today)));
    },
  };
}

function delivery(ctx: GatewayRouteContext): StoreDocuments | undefined {
  const work = ctx.login?.work, audit: StoreDocumentAuditPort | undefined = ctx.login?.storeDocumentViews;
  return ctx.documents && work && audit ? new StoreDocuments({ documents: ctx.documents, sight: storeSight(work), audit }) : undefined;
}
const refused = (error: unknown) => error instanceof LifecycleError && error.status === 403;

export async function handleStoreDocumentsPage(ctx: GatewayRouteContext): Promise<boolean> {
  const url = new URL(ctx.request.url ?? "/", "http://gateway.invalid");
  const method = ctx.request.method;
  if (url.pathname === STORE_DELIVERY_PATH) {
    if (method !== "GET" && method !== "HEAD") return false;
    const session = sessionCookie(ctx.request.headers.cookie);
    if (!session) { ctx.writeHtml(ctx.response, 401, ctx.renderError(401, ctx.login)); return true; }
    const service = delivery(ctx);
    if (!service) return unavailable(ctx);
    try {
      const out = await service.deliver(session, ctx.request.url!);
      ctx.response.writeHead(200, out.headers);
      ctx.response.end(method === "HEAD" ? undefined : out.bytes);
    } catch (error) { return refused(error) ? notFound(ctx) : unavailable(ctx); }
    return true;
  }
  const list = method === "GET" || method === "HEAD" ? LIST.exec(url.pathname) : null;
  const open = method === "POST" ? OPEN.exec(url.pathname) : null;
  if (!list && !open) return false;

  if (open) {
    // Same origin, before the session or the body is read.
    const origin = ctx.login?.web?.origin;
    if (!origin || ctx.request.headers.origin !== origin || ctx.request.headers["sec-fetch-site"] === "cross-site") {
      ctx.request.resume();
      ctx.writeHtml(ctx.response, 403, ctx.pageDocument("Documents", "<main id=\"main\" class=\"error-page\"><h1>Documents</h1><p>This document must be opened from StudentHub itself.</p></main>"));
      return true;
    }
  }
  const match = (list ?? open)!;
  const storeId = match[1]!, personId = decode(match[2]!);
  if (!personId || url.search !== "") return notFound(ctx);
  const session = sessionCookie(ctx.request.headers.cookie);
  if (!session) { ctx.request.resume(); ctx.writeHtml(ctx.response, 401, ctx.renderError(401, ctx.login)); return true; }
  const service = delivery(ctx);
  if (!service) { ctx.request.resume(); return unavailable(ctx); }

  if (open) {
    if (!await emptyBody(ctx)) { ctx.response.setHeader("connection", "close"); return notFound(ctx); }
    try {
      const link = await service.issue(session, personId, storeId, decodeURIComponent(open[3]!));
      ctx.response.writeHead(303, { location: link.url, "cache-control": "no-store", "referrer-policy": "no-referrer" });
      ctx.response.end();
    } catch (error) { return refused(error) || error instanceof URIError ? notFound(ctx) : unavailable(ctx); }
    return true;
  }

  try {
    const documents = await service.documents(session, personId, storeId);
    const work = ctx.login!.work!;
    const [names, stores] = await Promise.all([
      work.personNames ? work.personNames([personId]) : new Map<string, string>(),
      work.storeNames ? work.storeNames([storeId]) : new Map<string, string>(),
    ]);
    const name = names.get(personId) ?? "Unnamed person", store = stores.get(storeId) ?? "Your store";
    const base = `/workspace/stores/${storeId}`, person = `${base}/candidates/${encodeURIComponent(personId)}`;
    const rows = documents.map((doc) => "missing" in doc
      ? `<tr><th scope="row">${NAMES[doc.type]}</th><td>Missing</td><td>—</td><td>—</td><td></td></tr>`
      : `<tr><th scope="row">${NAMES[doc.type]}</th><td>On file</td><td>${esc(FORMATS[doc.mime] ?? "Other")}</td><td>${esc(size(doc.size))}</td><td><form method="post" action="${esc(`${person}/documents/${doc.type}/open`)}"><button class="text-link" type="submit">Open</button></form></td></tr>`).join("");
    const body = `<main id="main" class="profile-main"><nav aria-label="Breadcrumb"><a href="/workspace/my-stores">My stores</a> › <a href="${base}">${esc(store)}</a> › <a href="${base}/candidates">Candidates</a> › <a href="${esc(person)}">${esc(name)}</a></nav>`
      + `<h1>Documents for ${esc(name)}</h1><table><thead><tr><th scope="col">Document</th><th scope="col">State</th><th scope="col">Format</th><th scope="col">Size</th><th scope="col">Open</th></tr></thead><tbody>${rows}</tbody></table>`
      + `<p>A document opens for one minute and each opening is recorded. Civil ID images are not shown to stores.</p></main>`;
    ctx.writeHtml(ctx.response, 200, ctx.pageDocument(`Documents: ${name}`, body));
  } catch (error) { return refused(error) ? notFound(ctx) : unavailable(ctx); }
  return true;
}
