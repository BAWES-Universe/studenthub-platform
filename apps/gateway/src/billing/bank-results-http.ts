import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import type { BankResultApply, BankResultFileDetail, BankResultFileEntry, BankResultSubmit } from "@studenthub/db/billing";
import type { BankHoldReason, BankResultFormat, BankRowDecision } from "../../../../packages/billing/src/bank-results.js";
import { XLSX_MAX_BYTES, readXlsxCells } from "../../../../packages/billing/src/xlsx-cells.js";
import { sameOrigin, sessionCookie } from "../recruit/http-common.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * F5 bank result files (legacy `TransferController::actionImportExcel` and `actionMarkPaidAll`).
 *
 * GET /finance/bank-results lists uploaded files with an upload form. POST to the same path uploads
 * one .xlsx result file (multipart `format` aub|kfh and `file`); the same content twice opens the
 * first upload. GET /finance/bank-results/<id> shows what applying the file would do (a preview in
 * the same locked transaction, rolled back) or, once applied, the decision recorded for each row.
 * POST /finance/bank-results/<id>/apply applies it once.
 *
 * Only StudentHub's own finance users (a finance grant on an operator organization) reach any of
 * this; everyone else, a company's finance users included, gets not found before any file is read.
 * Posts must come from the gateway origin. No money moves here: rows mark pay lines paid.
 */
export const BANK_RESULTS_PATH = "/finance/bank-results";
export interface BankResultsStore {
  files(actor: { principalId: string; actingAs: boolean }): Promise<readonly BankResultFileEntry[] | null>;
  file(actor: { principalId: string; actingAs: boolean }, fileId: string): Promise<BankResultFileDetail | null>;
  submit(actor: { principalId: string; actingAs: boolean }, input: { format: BankResultFormat; contentSha256: string; cells: ReturnType<typeof readXlsxCells> & object }): Promise<BankResultSubmit>;
  preview(actor: { principalId: string; actingAs: boolean }, fileId: string): Promise<BankResultApply>;
  apply(actor: { principalId: string; actingAs: boolean }, fileId: string): Promise<BankResultApply>;
}
export interface BankResultsHttp {
  viewer(sessionId: string | undefined): Promise<string | undefined>;
  /** StudentHub finance only; decided again per transfer inside apply. */
  allowed(viewer: string): Promise<boolean>;
  readonly origin: string | undefined;
  files(viewer: string): Promise<readonly BankResultFileEntry[] | null>;
  file(viewer: string, fileId: string): Promise<BankResultFileDetail | null>;
  submit(viewer: string, format: BankResultFormat, bytes: Buffer): Promise<BankResultSubmit | { readonly kind: "unreadable" }>;
  preview(viewer: string, fileId: string): Promise<BankResultApply>;
  apply(viewer: string, fileId: string): Promise<BankResultApply>;
}

export function createBankResultsHttp(ports: { sessions: Pick<SessionStore, "get">; store: BankResultsStore; allowed(viewer: string): Promise<boolean>; origin: string | undefined }): BankResultsHttp {
  const actor = (principalId: string) => ({ principalId, actingAs: false });
  return {
    async viewer(sessionId) {
      return sessionId ? (await ports.sessions.get(sessionId))?.personId : undefined;
    },
    allowed: (viewer) => ports.allowed(viewer),
    origin: ports.origin || undefined,
    files: (viewer) => ports.store.files(actor(viewer)),
    file: (viewer, id) => ports.store.file(actor(viewer), id),
    async submit(viewer, format, bytes) {
      const cells = readXlsxCells(bytes);
      if (!cells) return { kind: "unreadable" };
      return ports.store.submit(actor(viewer), { format, contentSha256: createHash("sha256").update(bytes).digest("hex"), cells });
    },
    preview: (viewer, id) => ports.store.preview(actor(viewer), id),
    apply: (viewer, id) => ports.store.apply(actor(viewer), id),
  };
}

const FILE = /^\/finance\/bank-results\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const APPLY = /^\/finance\/bank-results\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/apply$/;
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
  return `<main><h1>Bank result files</h1><p>Upload the result file the bank returns after a salary transfer. Nothing is marked paid until you review the file and apply it.</p>`
    + `<form method="post" enctype="multipart/form-data" action="${BANK_RESULTS_PATH}"><label>Bank <select name="format"><option value="aub">${FORMAT_NAME.aub}</option><option value="kfh">${FORMAT_NAME.kfh}</option></select></label> `
    + `<label>File <input type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label> <button>Upload</button></form>`
    + (files.length ? `<table><thead><tr><th>Uploaded (UTC)</th><th>Bank</th><th>Rows</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No files uploaded yet.</p>") + "</main>";
}
function fileHtml(file: BankResultFileDetail, preview: BankResultApply | null): string {
  const head = `<main><h1>Bank result file</h1><p>${esc(FORMAT_NAME[file.format])}, uploaded ${esc(file.uploadedAt.slice(0, 16).replace("T", " "))} UTC, ${file.rowCount} rows.</p>`;
  const back = `<p><a href="${BANK_RESULTS_PATH}">All bank result files</a></p></main>`;
  if (file.status === "applied") return `${head}<p>Applied ${esc((file.appliedAt ?? "").slice(0, 16).replace("T", " "))} UTC.</p>${decisionsTable(file.decisions)}${back}`;
  if (!preview || preview.kind !== "applied") return `${head}<p>You can't settle the transfers in this file.</p>${back}`;
  const pays = preview.decisions.filter(d => d.kind === "pay").length;
  const shown = preview.decisions.map(d => ({ rowNumber: d.rowNumber, kind: d.kind, reason: d.kind === "hold" ? d.reason : null, lineIds: d.kind === "hold" ? d.lineIds : [d.lineId] }));
  return `${head}<p>Applying this file marks ${pays} ${pays === 1 ? "line" : "lines"} paid and completes ${preview.completedTransferIds.length} ${preview.completedTransferIds.length === 1 ? "transfer" : "transfers"}. Held rows change nothing.</p>`
    + decisionsTable(shown) + `<form method="post" action="${BANK_RESULTS_PATH}/${file.fileId}/apply"><button>Apply this file</button></form>${back}`;
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
  if (!list && !file && !applying && !path.startsWith(`${BANK_RESULTS_PATH}/`)) return false;
  const post = req.method === "POST";
  try {
    if (!service) { req.resume(); return unavailable(req, res); }
    if (!list && !file && !applying) { req.resume(); return notFound(req, res); }
    const allowedMethods = applying ? "POST" : file ? "GET" : "GET, POST";
    if (!allowedMethods.split(", ").includes(req.method ?? "")) { req.resume(); res.writeHead(405, { allow: allowedMethods }); res.end(); return true; }
    // A write is refused from any other origin before the session or the body is looked at.
    if (post && (!service.origin || !sameOrigin(req, service.origin))) { req.resume(); return reply(req, res, 403, "forbidden", "Not allowed", "This request was not sent from StudentHub."); }
    const viewer = await service.viewer(sessionCookie(req.headers.cookie));
    if (!viewer) { req.resume(); return reply(req, res, 401, "unauthorized", "Sign in", "Sign in to see bank result files."); }
    if (!await service.allowed(viewer)) { req.resume(); return notFound(req, res); }
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
      if (result.kind === "unreadable") return reply(req, res, 422, "unreadable", "Not a workbook", "The file is not an .xlsx workbook that can be read.");
      if (result.kind === "refused") return reply(req, res, 422, result.code, "Not a bank result file", result.code === "missing_headers"
        ? `The file is missing the columns ${(result.missing ?? []).join(", ")}. Check the bank you chose.` : "The file has no rows to read.");
      if (wantsHtml(req.headers.accept)) return seeOther(res, `${BANK_RESULTS_PATH}/${result.fileId}`);
      return json(res, result.kind === "submitted" ? 201 : 200, result);
    }
    const id = (file ?? applying)![1]!;
    if (applying) {
      req.resume();
      const result = await service.apply(viewer, id);
      if (result.kind === "refused") return result.code === "already_applied"
        ? reply(req, res, 409, "already_applied", "Already applied", "This file was already applied.")
        : result.code === "forbidden" ? reply(req, res, 403, "forbidden", "Not allowed", "You can't settle the transfers in this file.") : notFound(req, res);
      if (wantsHtml(req.headers.accept) || req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return seeOther(res, `${BANK_RESULTS_PATH}/${id}`);
      return json(res, 200, result);
    }
    const detail = await service.file(viewer, id);
    if (!detail) return notFound(req, res);
    const preview = detail.status === "pending" ? await service.preview(viewer, id) : null;
    if (!wantsHtml(req.headers.accept)) return json(res, 200, { ...detail, ...(preview ? { preview } : {}) });
    writeHtml(res, 200, pageDocument("Bank result file", fileHtml(detail, preview)), { "cache-control": "no-store" }); return true;
  } catch {
    if (!res.headersSent) return unavailable(req, res);
    res.destroy(); return true;
  }
}
