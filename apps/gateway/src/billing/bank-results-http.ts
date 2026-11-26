import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import type { BankResultApply, BankResultFileDetail, BankResultFileEntry, BankResultHeldRow, BankResultSubmit, BankResultTransferStatus } from "@studenthub/db/billing";
import type { BankCell, BankHoldReason, BankResultFormat, BankRowDecision } from "../../../../packages/billing/src/bank-results.js";
import { XLSX_MAX_BYTES, XLSX_MAX_FIELD_CHARS, readXlsxCells } from "../../../../packages/billing/src/xlsx-cells.js";
import { MAX_BANK_RESULT_ROWS } from "../../../../packages/billing/src/bank-results.js";
import { sameOrigin, sessionCookie } from "../recruit/http-common.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * F5 bank result files (legacy `TransferController::actionImportExcel` and `actionMarkPaidAll`).
 *
 * GET /finance/bank-results lists uploaded files with an upload form. POST to the same path uploads
 * one .xlsx result file (multipart `format` aub|kfh and `file`); the same content twice opens the
 * first upload. GET /finance/bank-results/<id> shows what applying the file would do (a preview in
 * the same locked transaction, rolled back) or, once applied, the decision recorded for each row.
 * POST /finance/bank-results/<id>/apply (form field `review`, the identity of the preview shown) applies
 * it once, and only if applying it would still do exactly what was reviewed; otherwise nothing is
 * written and the fresh review is shown (409).
 *
 * GET /finance/bank-results/held lists the held rows of the applied files, newest first, 100 a page
 * (`?page=N`, with a link to the older page while one exists), with the lines each names and whether
 * they are paid now. GET /finance/bank-results/transfers/<id> shows each line of
 * one transfer: paid with which bank reference and file, and every held or failed row naming it.
 * These are how Finance finds held and paid lines from the ordinary records.
 *
 * Only StudentHub's own finance users (a finance grant on an operator organization) reach any of
 * this; everyone else, a company's finance users included, gets not found before any file is read.
 * Posts must come from the gateway origin. No money moves here: rows mark pay lines paid.
 *
 * Gate before real-file use: the reader is tested against workbooks generated from the bank-file
 * contract's decoded AUB/KFH matrices, not against native files from the banks (the contract marks
 * native workbook fidelity NOT_ESTABLISHED). Apply is therefore OFF unless the deployment sets
 * `applyEnabled` (gateway env BILLING_BANK_RESULTS_APPLY=on), which is only to be set once a sanitized
 * native AUB result file and KFH transfer report have been read and checked by this reader. Upload,
 * preview and history work while it is off.
 * Preview is a dry run of apply in one transaction that is rolled back: it stays safe only while
 * every effect of apply (paid flags, confirmations, lifecycle completion and its effects) is
 * transactional, with nothing sent outside the database.
 */
export const BANK_RESULTS_PATH = "/finance/bank-results";
export interface BankResultsStore {
  files(actor: { principalId: string; actingAs: boolean }): Promise<readonly BankResultFileEntry[] | null>;
  file(actor: { principalId: string; actingAs: boolean }, fileId: string): Promise<BankResultFileDetail | null>;
  held(actor: { principalId: string; actingAs: boolean }, page: number): Promise<{ readonly rows: readonly BankResultHeldRow[]; readonly more: boolean } | null>;
  transfer(actor: { principalId: string; actingAs: boolean }, transferId: string): Promise<BankResultTransferStatus | null>;
  submit(actor: { principalId: string; actingAs: boolean }, input: { format: BankResultFormat; contentSha256: string; cells: BankCell[][] }): Promise<BankResultSubmit>;
  preview(actor: { principalId: string; actingAs: boolean }, fileId: string): Promise<BankResultApply>;
  apply(actor: { principalId: string; actingAs: boolean }, fileId: string, reviewId: string): Promise<BankResultApply>;
}
export interface BankResultsHttp {
  viewer(sessionId: string | undefined): Promise<string | undefined>;
  /** StudentHub finance only; decided again per transfer inside apply. */
  allowed(viewer: string): Promise<boolean>;
  readonly origin: string | undefined;
  /** False until native bank files are checked: the page shows no apply, and an apply is refused before the store. */
  readonly applyEnabled: boolean;
  files(viewer: string): Promise<readonly BankResultFileEntry[] | null>;
  file(viewer: string, fileId: string): Promise<BankResultFileDetail | null>;
  held(viewer: string, page: number): Promise<{ readonly rows: readonly BankResultHeldRow[]; readonly more: boolean } | null>;
  transfer(viewer: string, transferId: string): Promise<BankResultTransferStatus | null>;
  submit(viewer: string, format: BankResultFormat, bytes: Buffer): Promise<BankResultSubmit | { readonly kind: "workbook_refused"; readonly code: "unreadable" | "too_many_rows" | "too_large" }>;
  preview(viewer: string, fileId: string): Promise<BankResultApply>;
  /** Applies only the reviewed outcome; a changed outcome comes back as a fresh review with nothing written. */
  apply(viewer: string, fileId: string, reviewId: string): Promise<BankResultApply>;
}

export function createBankResultsHttp(ports: { sessions: Pick<SessionStore, "get">; store: BankResultsStore; allowed(viewer: string): Promise<boolean>; origin: string | undefined; applyEnabled?: boolean }): BankResultsHttp {
  const actor = (principalId: string) => ({ principalId, actingAs: false });
  return {
    async viewer(sessionId) {
      return sessionId ? (await ports.sessions.get(sessionId))?.personId : undefined;
    },
    allowed: (viewer) => ports.allowed(viewer),
    origin: ports.origin || undefined,
    applyEnabled: ports.applyEnabled === true,
    files: (viewer) => ports.store.files(actor(viewer)),
    file: (viewer, id) => ports.store.file(actor(viewer), id),
    held: (viewer, page) => ports.store.held(actor(viewer), page),
    transfer: (viewer, id) => ports.store.transfer(actor(viewer), id),
    async submit(viewer, format, bytes) {
      const read = readXlsxCells(bytes);
      if (read.kind === "refused") return { kind: "workbook_refused", code: read.code };
      return ports.store.submit(actor(viewer), { format, contentSha256: createHash("sha256").update(bytes).digest("hex"), cells: read.cells });
    },
    preview: (viewer, id) => ports.store.preview(actor(viewer), id),
    apply: (viewer, id, reviewId) => ports.store.apply(actor(viewer), id, reviewId),
  };
}

const FILE = /^\/finance\/bank-results\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const APPLY = /^\/finance\/bank-results\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/apply$/;
const HELD = `${BANK_RESULTS_PATH}/held`;
/** `page` absent is 1; otherwise one plain positive integer, and no other query parameter. */
export function pageOf(query: URLSearchParams): number | undefined {
  const keys = [...query.keys()];
  if (!keys.length) return 1;
  if (keys.length !== 1 || keys[0] !== "page") return undefined;
  const value = query.get("page")!;
  return /^[1-9][0-9]{0,5}$/.test(value) ? Number(value) : undefined;
}
const TRANSFER = /^\/finance\/bank-results\/transfers\/([^/]+)$/;
/** The transfer id in a transfer page path, decoded as the links on these pages encode it; undefined when it is not one. */
export function transferIdOf(segment: string): string | undefined {
  let id: string;
  try { id = decodeURIComponent(segment); } catch { return undefined; }
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : undefined;
}
const transferHref = (id: string) => `${BANK_RESULTS_PATH}/transfers/${encodeURIComponent(id)}`;
const UPLOAD_LIMIT = XLSX_MAX_BYTES + 16 * 1024;
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const FORMAT_NAME: Readonly<Record<BankResultFormat, string>> = { aub: "AUB result file", kfh: "KFH transfer report" };
const HOLD: Readonly<Record<BankHoldReason, string>> = {
  rejected_row: "The row could not be read (status, amount or line missing or unknown).",
  unmatched: "No line waiting for payment matches this row.",
  ambiguous: "More than one line matches; choose by hand.",
  amount_mismatch: "The amount differs from the line.",
  currency_mismatch: "The currency differs from the line.",
  already_paid: "The line is already paid.",
  line_listed_twice: "Another row in this file is for the same line.",
  reference_conflict: "This bank reference is already used for another line or another row.",
  missing_reference: "The row has no bank reference.",
  paid_line_failed: "The bank reports a failure for a line already marked paid.",
};
type Shown = { rowNumber: number; kind: BankRowDecision["kind"]; reason: string | null; lineIds: readonly string[] };
const KIND: Readonly<Record<BankRowDecision["kind"], string>> = { pay: "Marks the line paid", unpay: "Failed: the line stays unpaid", duplicate: "Already recorded from an earlier file", hold: "Held for a person" };

function decisionsTable(rows: readonly Shown[]): string {
  if (!rows.length) return "<p>The file has no rows.</p>";
  return `<table><thead><tr><th>Row</th><th>Outcome</th><th>Line</th><th>Why held</th></tr></thead><tbody>${rows.map(r =>
    `<tr><td>${r.rowNumber}</td><td>${esc(KIND[r.kind])}</td><td>${esc(r.lineIds.join(", "))}</td><td>${r.reason ? esc(HOLD[r.reason as BankHoldReason] ?? r.reason) : ""}</td></tr>`).join("")}</tbody></table>`;
}
function listHtml(files: readonly BankResultFileEntry[]): string {
  const rows = files.map(f => `<tr><td><a href="${BANK_RESULTS_PATH}/${f.fileId}">${esc(f.uploadedAt.slice(0, 16).replace("T", " "))}</a></td><td>${esc(FORMAT_NAME[f.format])}</td><td>${f.rowCount}</td><td>${f.status === "applied" ? "Applied" : "Not applied yet"}</td></tr>`).join("");
  return `<main><h1>Bank result files</h1><p>Upload the result file the bank returns after a salary transfer. Nothing is marked paid until you review the file and apply it.</p><p><a href="${HELD}">Held bank rows</a></p>`
    + `<form method="post" enctype="multipart/form-data" action="${BANK_RESULTS_PATH}"><label>Bank <select name="format"><option value="aub">${FORMAT_NAME.aub}</option><option value="kfh">${FORMAT_NAME.kfh}</option></select></label> `
    + `<label>File <input type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label> <button>Upload</button></form>`
    + (files.length ? `<table><thead><tr><th>Uploaded (UTC)</th><th>Bank</th><th>Rows</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No files uploaded yet.</p>") + "</main>";
}
const when = (iso: string) => esc(iso.slice(0, 16).replace("T", " "));
const holdText = (reason: string | null) => (reason ? esc(HOLD[reason as BankHoldReason] ?? reason) : "");
function heldHtml(held: readonly BankResultHeldRow[], page: number, more: boolean): string {
  const rows = held.map(h => `<tr><td><a href="${BANK_RESULTS_PATH}/${h.fileId}">${when(h.appliedAt)}</a></td><td>${esc(FORMAT_NAME[h.format])}</td><td>${h.rowNumber}</td>`
    + `<td>${holdText(h.reason)}</td><td>${esc(h.reference ?? "")}</td><td>${h.lines.length ? h.lines.map(l =>
      `<a href="${esc(transferHref(l.transferId))}#line-${esc(l.lineId)}">${esc(l.lineId)}</a> (${l.paid ? "paid" : "unpaid"})`).join("<br>") : "No line found"}</td></tr>`).join("");
  return `<main><h1>Held bank rows</h1><p>Rows of applied bank result files that were held for a person. A held row changed nothing; settle the line it names by hand or with a corrected file.</p>`
    + (held.length ? `<table><thead><tr><th>Applied (UTC)</th><th>Bank</th><th>Row</th><th>Why held</th><th>Bank reference</th><th>Lines</th></tr></thead><tbody>${rows}</tbody></table>` : page > 1 ? "<p>No older held rows.</p>" : "<p>No rows are held.</p>")
    + `<p>${page > 1 ? `<a href="${HELD}${page > 2 ? `?page=${page - 1}` : ""}">Newer held rows</a> ` : ""}${more ? `<a href="${HELD}?page=${page + 1}">Older held rows</a>` : ""}</p>`
    + `<p><a href="${BANK_RESULTS_PATH}">All bank result files</a></p></main>`;
}
function transferHtml(t: BankResultTransferStatus): string {
  const rows = t.lines.map(l => {
    const paid = l.payment ? `Paid: bank reference ${esc(l.payment.reference ?? "none")}, <a href="${BANK_RESULTS_PATH}/${l.payment.fileId}">file</a> row ${l.payment.rowNumber}, ${when(l.payment.recordedAt)} UTC`
      : l.paid ? "Paid (not from a bank result file)" : "Unpaid";
    const notes = l.rows.map(r => `<a href="${BANK_RESULTS_PATH}/${r.fileId}">${when(r.appliedAt)}</a> row ${r.rowNumber}: ${r.kind === "hold" ? `held. ${holdText(r.reason)}` : `the bank reported a failure${r.reference ? ` (${esc(r.reference)})` : ""}.`}`).join("<br>");
    return `<tr id="line-${esc(l.lineId)}"><td>${esc(l.lineId)}</td><td>${esc(l.personId)}</td><td>${esc(l.currency)} ${esc(l.amount)}</td><td>${paid}</td><td>${notes}</td></tr>`;
  }).join("");
  return `<main><h1>Transfer pay status</h1><p>Transfer ${esc(t.transferId)}, company ${esc(t.companyId)}, ${esc(t.status)}.</p>`
    + (t.lines.length ? `<table><thead><tr><th>Line</th><th>Person</th><th>Amount</th><th>Paid</th><th>Held or failed rows</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>The transfer has no lines.</p>")
    + `<p><a href="${HELD}">Held bank rows</a> · <a href="${BANK_RESULTS_PATH}">All bank result files</a></p></main>`;
}
function fileHtml(file: BankResultFileDetail, preview: BankResultApply | null, applyEnabled: boolean): string {
  const head = `<main><h1>Bank result file</h1><p>${esc(FORMAT_NAME[file.format])}, uploaded ${esc(file.uploadedAt.slice(0, 16).replace("T", " "))} UTC, ${file.rowCount} rows.</p>`;
  const back = `<p><a href="${BANK_RESULTS_PATH}">All bank result files</a></p></main>`;
  if (file.status === "applied") return `${head}<p>Applied ${esc((file.appliedAt ?? "").slice(0, 16).replace("T", " "))} UTC.</p>${decisionsTable(file.decisions)}${back}`;
  if (!preview || (preview.kind !== "review" && preview.kind !== "changed")) return `${head}<p>You can't settle the transfers in this file.</p>${back}`;
  const changed = preview.kind === "changed" ? `<p role="alert">What this file would do changed since you reviewed it, so nothing was applied. Review it again below.</p>` : "";
  const pays = preview.decisions.filter(d => d.kind === "pay").length;
  const shown = preview.decisions.map(d => ({ rowNumber: d.rowNumber, kind: d.kind, reason: d.kind === "hold" ? d.reason : null, lineIds: d.kind === "hold" ? d.lineIds : [d.lineId] }));
  return `${head}${changed}<p>Applying this file marks ${pays} ${pays === 1 ? "line" : "lines"} paid and completes ${preview.completedTransferIds.length} ${preview.completedTransferIds.length === 1 ? "transfer" : "transfers"}. Held rows change nothing.</p>`
    + decisionsTable(shown) + (applyEnabled
      ? `<form method="post" action="${BANK_RESULTS_PATH}/${file.fileId}/apply"><input type="hidden" name="review" value="${esc(preview.reviewId)}"><button>Apply this file</button></form>`
      : `<p>Applying bank result files is not switched on yet. Nothing is marked paid from this page until it is.</p>`) + back;
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(body)); return true;
}
function reply(req: IncomingMessage, res: ServerResponse, status: number, error: string, title: string, message: string): true {
  if (wantsHtml(req.headers.accept)) { writeHtml(res, status, pageDocument(title, `<main><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="${BANK_RESULTS_PATH}">Bank result files</a></p></main>`), { "cache-control": "no-store" }); return true; }
  return json(res, status, { error });
}
const notFound = (req: IncomingMessage, res: ServerResponse) => reply(req, res, 404, "not_found", "Not found", "The page could not be found.");
const unavailable = (req: IncomingMessage, res: ServerResponse) => reply(req, res, 503, "bank_results_unavailable", "Unavailable", "Bank result files are not available right now.");
const seeOther = (res: ServerResponse, location: string): true => { res.writeHead(303, { location, "cache-control": "no-store" }); res.end(); return true; };

/** Reads at most `limit` bytes; undefined past it. */
async function bytes(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  if (Number(req.headers["content-length"]) > limit) { req.resume(); return undefined; }
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    const b = Buffer.from(c);
    if ((n += b.length) > limit) { req.resume(); return undefined; }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
const WORKBOOK_REFUSED: Readonly<Record<"unreadable" | "too_many_rows" | "too_large", string>> = {
  unreadable: "The file is not an .xlsx workbook that can be read, or its rows or cells are out of order or repeated.",
  too_many_rows: `The file has more rows than a bank result file can have. Split it and upload each part.`,
  too_large: `A cell or the whole sheet holds more text than a bank result file can have (at most ${XLSX_MAX_FIELD_CHARS} characters a cell).`,
};
/** The review identity an apply approves: `review=<64 hex>` as a form, or `{"review":"<64 hex>"}` as JSON. */
export function reviewOf(body: Buffer | undefined, contentType: string | undefined): string | undefined {
  if (!body) return undefined;
  let review: unknown;
  if (contentType?.startsWith("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(body.toString("utf8"));
    if ([...form.keys()].some((k) => k !== "review") || form.getAll("review").length !== 1) return undefined;
    review = form.get("review");
  } else if (contentType?.startsWith("application/json")) {
    try { const parsed = JSON.parse(body.toString("utf8")); review = parsed && typeof parsed === "object" && Object.keys(parsed).length === 1 ? parsed.review : undefined; } catch { return undefined; }
  }
  return typeof review === "string" && /^[0-9a-f]{64}$/u.test(review) ? review : undefined;
}
/** Exactly the fields `format` and `file` of a multipart form; anything else is refused. */
export function uploadForm(body: Buffer, contentType: string | undefined): { format: BankResultFormat; file: Buffer } | undefined {
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"]{1,70})"|([!#$%&'*+.^_`|~0-9A-Za-z-]{1,70}))$/.exec(contentType ?? "");
  if (!match) return undefined;
  const boundary = Buffer.from(`--${match[1] ?? match[2]}`), divider = Buffer.from("\r\n\r\n");
  if (!body.subarray(0, boundary.length).equals(boundary)) return undefined;
  let at = boundary.length, format: string | undefined, file: Buffer | undefined;
  for (;;) {
    if (body.subarray(at, at + 2).toString() === "--") break;
    if (body.subarray(at, at + 2).toString() !== "\r\n") return undefined;
    const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), boundary]), at + 2);
    if (next < 0) return undefined;
    const section = body.subarray(at + 2, next); at = next + 2 + boundary.length;
    const split = section.indexOf(divider);
    if (split < 0 || split > 1024) return undefined;
    const disposition = section.subarray(0, split).toString("latin1").split("\r\n").find(h => h.toLowerCase().startsWith("content-disposition:")) ?? "";
    const name = /;\s*name="([^"]*)"/.exec(disposition)?.[1], filename = /;\s*filename="([^"]*)"/.exec(disposition)?.[1];
    const data = section.subarray(split + divider.length);
    if (name === "format" && filename === undefined && format === undefined) format = data.toString("utf8");
    else if (name === "file" && filename !== undefined && file === undefined) file = data;
    else return undefined;
  }
  return (format === "aub" || format === "kfh") && file && file.length ? { format, file } : undefined;
}

/** Handles the bank result paths; false for any other path. */
export async function handleBankResults(req: IncomingMessage, res: ServerResponse, service: BankResultsHttp | undefined): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://gateway.invalid").pathname;
  const list = path === BANK_RESULTS_PATH, file = list ? null : FILE.exec(path), applying = list || file ? null : APPLY.exec(path);
  const heldPage = path === HELD, transferPath = TRANSFER.exec(path), transfer = transferPath ? transferIdOf(transferPath[1]!) : undefined;
  const read = heldPage || transfer !== undefined;
  if (!list && !file && !applying && !path.startsWith(`${BANK_RESULTS_PATH}/`)) return false;
  const post = req.method === "POST";
  try {
    if (!service) { req.resume(); return unavailable(req, res); }
    if (!list && !file && !applying && !read) { req.resume(); return notFound(req, res); }
    const allowedMethods = applying ? "POST" : file || read ? "GET" : "GET, POST";
    if (!allowedMethods.split(", ").includes(req.method ?? "")) { req.resume(); res.writeHead(405, { allow: allowedMethods }); res.end(); return true; }
    // A write is refused from any other origin before the session or the body is looked at.
    if (post && (!service.origin || !sameOrigin(req, service.origin))) { req.resume(); return reply(req, res, 403, "forbidden", "Not allowed", "This request was not sent from StudentHub."); }
    const viewer = await service.viewer(sessionCookie(req.headers.cookie));
    if (!viewer) { req.resume(); return reply(req, res, 401, "unauthorized", "Sign in", "Sign in to see bank result files."); }
    if (!await service.allowed(viewer)) { req.resume(); return notFound(req, res); }
    if (heldPage) {
      const page = pageOf(new URL(req.url ?? "/", "http://gateway.invalid").searchParams);
      if (page === undefined) return notFound(req, res);
      const held = await service.held(viewer, page);
      if (!held) return notFound(req, res);
      if (!wantsHtml(req.headers.accept)) return json(res, 200, { held: held.rows, page, more: held.more });
      writeHtml(res, 200, pageDocument("Held bank rows", heldHtml(held.rows, page, held.more)), { "cache-control": "no-store" }); return true;
    }
    if (transfer) {
      const status = await service.transfer(viewer, transfer);
      if (!status) return notFound(req, res);
      if (!wantsHtml(req.headers.accept)) return json(res, 200, status);
      writeHtml(res, 200, pageDocument("Transfer pay status", transferHtml(status)), { "cache-control": "no-store" }); return true;
    }
    if (list && !post) {
      const files = await service.files(viewer);
      if (!files) return notFound(req, res);
      if (!wantsHtml(req.headers.accept)) return json(res, 200, { files });
      writeHtml(res, 200, pageDocument("Bank result files", listHtml(files)), { "cache-control": "no-store" }); return true;
    }
    if (list) {
      const body = await bytes(req, UPLOAD_LIMIT);
      if (!body) return reply(req, res, 413, "too_large", "File too large", `Upload a file of at most ${XLSX_MAX_BYTES / (1024 * 1024)} MB.`);
      const form = uploadForm(body, req.headers["content-type"]);
      if (!form) return reply(req, res, 400, "invalid_request", "Invalid upload", "Choose the bank and one .xlsx file.");
      const result = await service.submit(viewer, form.format, form.file);
      if (result.kind === "workbook_refused") return reply(req, res, 422, result.code, "Not a readable bank file", WORKBOOK_REFUSED[result.code]);
      if (result.kind === "refused") return reply(req, res, result.code === "forbidden" ? 403 : 422, result.code, "Not a bank result file", result.code === "missing_headers"
        ? `The file is missing the columns ${(result.missing ?? []).join(", ")}. Check the bank you chose.`
        : result.code === "duplicate_headers" ? `The file names the columns ${(result.missing ?? []).join(", ")} more than once.`
        : result.code === "too_many_rows" ? `The file has more than ${MAX_BANK_RESULT_ROWS} rows. Split it and upload each part.`
        : result.code === "no_rows" ? "The file has no rows to read." : "The file could not be read.");
      if (wantsHtml(req.headers.accept)) return seeOther(res, `${BANK_RESULTS_PATH}/${result.fileId}`);
      return json(res, result.kind === "submitted" ? 201 : 200, result);
    }
    const id = (file ?? applying)![1]!;
    if (applying) {
      if (!service.applyEnabled) { req.resume(); return reply(req, res, 409, "apply_disabled", "Not switched on", "Applying bank result files is not switched on yet."); }
      const reviewId = reviewOf(await bytes(req, 1024), req.headers["content-type"]);
      if (!reviewId) return reply(req, res, 400, "invalid_request", "Review the file first", "Open the file and review what applying it does, then apply it.");
      const result = await service.apply(viewer, id, reviewId);
      if (result.kind === "refused") return result.code === "already_applied"
        ? reply(req, res, 409, "already_applied", "Already applied", "This file was already applied.")
        : result.code === "forbidden" ? reply(req, res, 403, "forbidden", "Not allowed", "You can't settle the transfers in this file.") : notFound(req, res);
      if (result.kind === "changed") {
        // Nothing was written: show the fresh review to approve again.
        if (!wantsHtml(req.headers.accept)) return json(res, 409, { error: "review_changed", review: result });
        const detail = await service.file(viewer, id);
        if (!detail) return notFound(req, res);
        writeHtml(res, 409, pageDocument("Bank result file", fileHtml(detail, result, service.applyEnabled)), { "cache-control": "no-store" }); return true;
      }
      if (wantsHtml(req.headers.accept) || req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return seeOther(res, `${BANK_RESULTS_PATH}/${id}`);
      return json(res, 200, result);
    }
    const detail = await service.file(viewer, id);
    if (!detail) return notFound(req, res);
    const preview = detail.status === "pending" ? await service.preview(viewer, id) : null;
    if (!wantsHtml(req.headers.accept)) return json(res, 200, { ...detail, ...(preview ? { preview } : {}) });
    writeHtml(res, 200, pageDocument("Bank result file", fileHtml(detail, preview, service.applyEnabled)), { "cache-control": "no-store" }); return true;
  } catch {
    if (!res.headersSent) return unavailable(req, res);
    res.destroy(); return true;
  }
}
