import type { IncomingMessage, ServerResponse } from "node:http";
import type { CertificateEntry } from "../../../../packages/reports/src/certificates.js";
import { longDate } from "../../../../packages/reports/src/id-card-pdf.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * S8 experience certificates on the web (legacy "Certificate of Appreciation").
 *
 * GET /profile/certificates lists the person's own store assignments with a PDF for each;
 * GET /profile/certificates/<assignment>.pdf is one of them. GET /workspace/certificates?person=<id>
 * is the same list for StudentHub staff, for anyone; GET /workspace/certificates/<assignment>.pdf
 * is one of those. Someone who is not staff gets the same not found on the staff paths whatever
 * they ask for, and a person gets the same not found for someone else's assignment as for one
 * that does not exist.
 */
export interface CertificatesHttpService {
  own(personId: string): Promise<{ readonly name: string | null; readonly rows: readonly CertificateEntry[] }>;
  staffList(viewer: string, personId: string): Promise<{ readonly name: string | null; readonly rows: readonly CertificateEntry[] } | undefined>;
  pdf(viewer: string, assignmentId: string): Promise<Buffer | undefined>;
}

export const OWN_CERTIFICATES_PATH = "/profile/certificates", STAFF_CERTIFICATES_PATH = "/workspace/certificates";
const OWN_PDF = /^\/profile\/certificates\/([0-9a-f-]{36})\.pdf$/, STAFF_PDF = /^\/workspace\/certificates\/([0-9a-f-]{36})\.pdf$/;
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body)); return true;
}
function reply(req: IncomingMessage, res: ServerResponse, status: number, body: Record<string, unknown>, title: string, message: string, extra = ""): true {
  if (wantsHtml(req.headers.accept)) { writeHtml(res, status, pageDocument(title, `<main><h1>${esc(title)}</h1><p>${esc(message)}</p>${extra}</main>`), { "cache-control": "no-store" }); return true; }
  return json(res, status, body);
}
const notFound = (req: IncomingMessage, res: ServerResponse) => reply(req, res, 404, { status: "not_found" }, "Not found", "The page could not be found.");
function pdf(res: ServerResponse, bytes: Buffer): true {
  res.writeHead(200, { "content-type": "application/pdf", "content-disposition": "attachment; filename=\"studenthub-experience-certificate.pdf\"", "content-length": String(bytes.length),
    "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(bytes); return true;
}

function listHtml(title: string, intro: string, list: { readonly name: string | null; readonly rows: readonly CertificateEntry[] }, pdfPath: (id: string) => string, empty: string): string {
  const rows = list.rows.map(r => `<tr><td>${esc(r.company)}</td><td>${esc(r.store)}</td><td>${esc(longDate(r.startDate))}</td><td>${esc(r.ongoing ? "Still working" : longDate(r.until))}</td><td><a href="${esc(pdfPath(r.assignmentId))}">Certificate (PDF)</a></td></tr>`).join("");
  return `<main><h1>${esc(title)}</h1><p>${esc(intro)}</p>${list.rows.length
    ? `<table><thead><tr><th>Company</th><th>Store</th><th>From</th><th>To</th><th>Certificate</th></tr></thead><tbody>${rows}</tbody></table><p>A certificate for work that is still going on is dated to today.</p>`
    : `<p>${esc(empty)}</p>`}</main>`;
}
const entryJson = (r: CertificateEntry) => ({ assignmentId: r.assignmentId, company: r.company, store: r.store, startDate: r.startDate, endDate: r.endDate, until: r.until, ongoing: r.ongoing });

/** Handles the certificate paths; false for any other path. `viewer` is the signed-in person, if any. */
export async function handleCertificates(req: IncomingMessage, res: ServerResponse, service: CertificatesHttpService | undefined, path: string, viewer: () => Promise<string | undefined>,
  isStaff: (viewer: string) => Promise<boolean>): Promise<boolean> {
  const own = path === OWN_CERTIFICATES_PATH, ownPdf = OWN_PDF.exec(path), staff = path === STAFF_CERTIFICATES_PATH, staffPdf = STAFF_PDF.exec(path);
  if (!own && !ownPdf && !staff && !staffPdf) return false;
  req.resume();
  const person = service ? await viewer() : undefined;
  if (staff || staffPdf) {
    // Authorization first: everyone who is not staff gets the same not found, whatever the method.
    let allowed = false; if (person) try { allowed = await isStaff(person); } catch { /* treated as not staff */ }
    if (!service || !person || !allowed) return notFound(req, res);
    if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
    if (staffPdf) { const bytes = await service.pdf(person, staffPdf[1]!); return bytes ? pdf(res, bytes) : notFound(req, res); }
    const target = new URL(req.url ?? "/", "http://gateway.invalid").searchParams.get("person") ?? "";
    const list = target ? await service.staffList(person, target) : undefined;
    if (!list) return notFound(req, res);
    if (!wantsHtml(req.headers.accept)) return json(res, 200, { status: "ok", name: list.name, rows: list.rows.map(entryJson) });
    writeHtml(res, 200, pageDocument("Experience certificates", listHtml("Experience certificates", `Certificates of appreciation for ${list.name ?? "this person"}, one for each store they worked at.`, list,
      id => `${STAFF_CERTIFICATES_PATH}/${id}.pdf`, "This person has no store assignments that have started.")), { "cache-control": "no-store" });
    return true;
  }
  if (!service) return notFound(req, res);
  if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
  if (!person) return reply(req, res, 401, { status: "unauthenticated" }, "Sign in", "Sign in to download your certificates.", `<p><a href="/profile">Go to your profile</a></p>`);
  if (ownPdf) { const bytes = await service.pdf(person, ownPdf[1]!); return bytes ? pdf(res, bytes) : notFound(req, res); }
  const list = await service.own(person);
  if (!wantsHtml(req.headers.accept)) return json(res, 200, { status: "ok", rows: list.rows.map(entryJson) });
  writeHtml(res, 200, pageDocument("Your experience certificates", listHtml("Your experience certificates", "A certificate of appreciation for each store you worked at through StudentHub.", list,
    id => `${OWN_CERTIFICATES_PATH}/${id}.pdf`, "You have no store assignments yet. A certificate becomes available once you start working at a store.")), { "cache-control": "no-store" });
  return true;
}
