import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { BankResultApply, BankResultFileDetail, BankResultHeldRow, BankResultSubmit, BankResultTransferStatus } from "@studenthub/db/billing";
import { AUB_RESULT_COLUMNS } from "../../../packages/billing/src/bank-results.js";
import { createBankResultsHttp, handleBankResults, reviewOf, transferIdOf, uploadForm, type BankResultsStore } from "../src/billing/bank-results-http.js";

// Synthetic people, files, references and line ids only.
const FIN = "f".repeat(43), COMPANY_FIN = "c".repeat(43);
const ORIGIN = "https://studenthub.example";
const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const PENDING: BankResultFileDetail = { fileId: ID, format: "aub", status: "pending", rowCount: 2, uploadedBy: "fin", uploadedAt: "2026-11-25T10:00:00.000Z", appliedBy: null, appliedAt: null, decisions: [] };
const REVIEW = "a".repeat(64), FRESH = "b".repeat(64);
const PREVIEW: Extract<BankResultApply, { kind: "review" }> = { kind: "review", reviewId: REVIEW, completedTransferIds: ["T1"], decisions: [
  { kind: "pay", rowNumber: 3, lineId: "L-1", transferId: "T1", reference: "REF-1" },
  { kind: "hold", rowNumber: 4, reason: "reference_conflict", lineIds: ["L-2", "<L-3>"] }] };

const HELD: BankResultHeldRow[] = [
  { fileId: ID, format: "kfh", appliedAt: "2026-11-25T11:00:00.000Z", rowNumber: 4, reason: "ambiguous", reference: "REF-<9>", lines: [{ lineId: "L-2", transferId: "T:1", paid: false }, { lineId: "L-3", transferId: "T1", paid: true }] },
  { fileId: ID, format: "aub", appliedAt: "2026-11-25T11:00:00.000Z", rowNumber: 5, reason: "unmatched", reference: null, lines: [] }];
const STATUS: BankResultTransferStatus = { transferId: "T1", companyId: "P", status: "distributing", lines: [
  { lineId: "L-1", personId: "w1", amount: "120.500", currency: "KWD", paid: true, payment: { reference: "REF-1", fileId: ID, rowNumber: 3, recordedAt: "2026-11-25T11:00:00.000Z" }, rows: [] },
  { lineId: "L-2", personId: "w2", amount: "80.000", currency: "KWD", paid: false, payment: null, rows: [
    { fileId: ID, rowNumber: 4, kind: "hold", reason: "amount_mismatch", reference: "REF-2", appliedAt: "2026-11-25T11:00:00.000Z" },
    { fileId: ID, rowNumber: 6, kind: "unpay", reason: null, reference: "Account closed", appliedAt: "2026-11-25T11:00:00.000Z" }] },
  { lineId: "L-4", personId: "w4", amount: "5.000", currency: "KWD", paid: true, payment: null, rows: [] }] };
async function xlsx(rows: string[][]): Promise<Buffer> {
  const { default: writeExcelFile } = await import("write-excel-file/node");
  return Buffer.from(await writeExcelFile(rows.map(r => r.map(value => ({ value, type: String }))) as never, { sheet: "R" }).toBuffer());
}
const AUB_FIRST = ["Status", "Status Description", "Debit Narrative", "Credit Narrative"];
const AUB_HEAD = [...AUB_FIRST, ...AUB_RESULT_COLUMNS.filter((c) => !AUB_FIRST.includes(c))];
const AUB = () => xlsx([[""], AUB_HEAD, ["SUCCESS", "REF-1", "x", "L-1"]]);

async function rig(t: TestContext, applyEnabled: boolean | "unset" = true) {
  const calls: string[] = [];
  let file: BankResultFileDetail | null = PENDING;
  const store: BankResultsStore = {
    async files(actor) { calls.push(`files:${actor.principalId}`); return file ? [file] : []; },
    async file(actor, id) { calls.push(`file:${actor.principalId}:${id}`); return id === ID ? file : null; },
    async held(actor) { calls.push(`held:${actor.principalId}:${actor.actingAs}`); return HELD; },
    async transfer(actor, id) { calls.push(`transfer:${actor.principalId}:${actor.actingAs}:${id}`); return id === "T1" ? STATUS : null; },
    async submit(actor, input): Promise<BankResultSubmit> {
      calls.push(`submit:${actor.principalId}:${actor.actingAs}:${input.format}:${input.contentSha256.length}:${JSON.stringify(input.cells[2])}`);
      return { kind: "submitted", fileId: ID };
    },
    async preview(actor, id) { calls.push(`preview:${actor.principalId}:${id}`); return PREVIEW; },
    async apply(actor, id, reviewId) {
      calls.push(`apply:${actor.principalId}:${id}:${reviewId.slice(0, 4)}`);
      if (file?.status === "applied") return { kind: "refused", code: "already_applied" };
      if (reviewId !== REVIEW) return { ...PREVIEW, kind: "changed", reviewId: FRESH, completedTransferIds: [] };
      file = { ...PENDING, status: "applied", appliedBy: "fin", appliedAt: "2026-11-25T11:00:00.000Z", decisions: [{ rowNumber: 3, kind: "pay", reason: null, lineIds: ["L-1"], reference: "REF-1" }] };
      return { ...PREVIEW, kind: "applied" };
    },
  };
  const sessions = { get: async (id: string) => ({ [FIN]: { personId: "fin" }, [COMPANY_FIN]: { personId: "company-fin" } } as Record<string, { personId: string }>)[id] as never };
  const service = createBankResultsHttp({ sessions, store, origin: ORIGIN, ...(applyEnabled === "unset" ? {} : { applyEnabled }), allowed: async (viewer) => { calls.push(`allowed:${viewer}`); return viewer === "fin"; } });
  const server = createServer(async (req, res) => { if (!await handleBankResults(req, res, service)) { res.writeHead(418); res.end(); } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: { session?: string; accept?: string; method?: string; origin?: string | null; body?: BodyInit; type?: string } = {}) =>
    fetch(base + path, { method: init.method ?? "GET", redirect: "manual", body: init.body ?? null, headers: {
      ...(init.session ? { cookie: `__Host-studenthub_session=${init.session}` } : {}), accept: init.accept ?? "application/json",
      ...(init.origin === null ? {} : { origin: init.origin ?? ORIGIN }), ...(init.type ? { "content-type": init.type } : {}) } });
  const upload = async (session: string, format: string, bytes: Buffer, origin?: string) => {
    const form = new FormData();
    form.set("format", format); form.set("file", new Blob([new Uint8Array(bytes)]), "result.xlsx");
    return call("/finance/bank-results", { session, method: "POST", body: form, accept: "text/html", ...(origin ? { origin } : {}) });
  };
  return { call, calls, upload };
}

test("BANK_HTTP_FLOW StudentHub finance uploads a workbook, reviews the preview, applies it once and sees the recorded rows", async (t) => {
  const x = await rig(t);
  const list = await x.call("/finance/bank-results", { session: FIN, accept: "text/html" });
  assert.equal(list.status, 200); assert.equal(list.headers.get("cache-control"), "no-store");
  assert.match(await list.text(), /enctype="multipart\/form-data"[\s\S]*name="format"[\s\S]*name="file"/);
  const up = await x.upload(FIN, "aub", await AUB());
  assert.equal(up.status, 303); assert.equal(up.headers.get("location"), `/finance/bank-results/${ID}`);
  assert.deepEqual(x.calls.filter(c => c.startsWith("submit")), [`submit:fin:false:aub:64:${JSON.stringify(["SUCCESS", "REF-1", "x", "L-1"])}`]);
  const page = await (await x.call(`/finance/bank-results/${ID}`, { session: FIN, accept: "text/html" })).text();
  assert.match(page, /marks 1 line paid and completes 1 transfer/);
  assert.match(page, /This bank reference is already used/); assert.match(page, /L-2, &lt;L-3&gt;/); assert.doesNotMatch(page, /<L-3>/);
  assert.match(page, new RegExp(`action="/finance/bank-results/${ID}/apply"><input type="hidden" name="review" value="${REVIEW}">`));
  const form = (review: string) => x.call(`/finance/bank-results/${ID}/apply`, { session: FIN, method: "POST", accept: "text/html", type: "application/x-www-form-urlencoded", body: `review=${review}` });
  const stale = await form("c".repeat(64));
  assert.equal(stale.status, 409, "a review that no longer matches applies nothing and shows the fresh review");
  const again = await stale.text();
  assert.match(again, /changed since you reviewed it/); assert.match(again, new RegExp(`name="review" value="${FRESH}"`)); assert.match(again, /completes 0 transfers/);
  assert.equal((await x.call(`/finance/bank-results/${ID}/apply`, { session: FIN, method: "POST", type: "application/x-www-form-urlencoded", body: "" })).status, 400, "no review, no apply");
  const applied = await form(REVIEW);
  assert.equal(applied.status, 303);
  const after = await (await x.call(`/finance/bank-results/${ID}`, { session: FIN, accept: "text/html" })).text();
  assert.match(after, /Applied 2026-11-25 11:00 UTC/); assert.match(after, /Marks the line paid/); assert.doesNotMatch(after, /Apply this file/);
  assert.equal((await x.call(`/finance/bank-results/${ID}/apply`, { session: FIN, method: "POST", type: "application/json", body: JSON.stringify({ review: REVIEW }) })).status, 409);
  assert.deepEqual(x.calls.filter(c => c.startsWith("preview") || c.startsWith("apply")),
    [`preview:fin:${ID}`, `apply:fin:${ID}:cccc`, `apply:fin:${ID}:aaaa`, `apply:fin:${ID}:aaaa`], "an applied file is not previewed; a missing review never reaches the store");
  assert.equal(reviewOf(Buffer.from(`review=${REVIEW}&review=${REVIEW}`), "application/x-www-form-urlencoded"), undefined, "one review only");
  assert.equal(reviewOf(Buffer.from(`review=${REVIEW}&x=1`), "application/x-www-form-urlencoded"), undefined);
  assert.equal(reviewOf(Buffer.from(`review=${REVIEW.toUpperCase()}`), "application/x-www-form-urlencoded"), undefined);
  assert.equal(reviewOf(Buffer.from(JSON.stringify({ review: REVIEW })), "application/json"), REVIEW);
});

test("BANK_HTTP_GATE a company's finance user, a signed-out caller and another origin reach nothing, before any file is read", async (t) => {
  const x = await rig(t);
  for (const path of ["/finance/bank-results", `/finance/bank-results/${ID}`, "/finance/bank-results/held", "/finance/bank-results/transfers/T1"]) {
    assert.equal((await x.call(path, { session: COMPANY_FIN })).status, 404, path);
    assert.equal((await x.call(path)).status, 401, path);
  }
  assert.equal((await x.upload(COMPANY_FIN, "aub", await AUB())).status, 404);
  assert.equal((await x.call(`/finance/bank-results/${ID}/apply`, { session: COMPANY_FIN, method: "POST" })).status, 404);
  assert.equal((await x.upload(FIN, "aub", await AUB(), "https://evil.example")).status, 403);
  assert.equal((await x.call(`/finance/bank-results/${ID}/apply`, { session: FIN, method: "POST", origin: null })).status, 403);
  assert.deepEqual(x.calls.filter(c => !c.startsWith("allowed")), [], "no store call for anyone refused");
  assert.equal((await x.call("/finance/bank-results/nope", { session: FIN })).status, 404);
  assert.equal((await x.call(`/finance/bank-results/${ID}`, { session: FIN, method: "POST" })).status, 405);
  assert.equal((await x.call("/finance/other", { session: FIN })).status, 418, "other paths are not claimed");
});

test("BANK_HTTP_INPUT a file that is not a readable workbook, a wrong bank layout or a malformed form is refused without storing", async (t) => {
  const x = await rig(t);
  assert.equal((await x.upload(FIN, "aub", Buffer.from("Status,Reference\nSUCCESS,REF-1\n"))).status, 422);
  const long = await x.upload(FIN, "aub", await xlsx([[""], AUB_HEAD, ["SUCCESS", "R".repeat(1025), "x", "L-1"]]));
  assert.equal(long.status, 422); assert.match(await long.text(), /at most 1024 characters a cell/);
  assert.equal((await x.upload(FIN, "swift", await AUB())).status, 400);
  assert.equal((await x.call("/finance/bank-results", { session: FIN, method: "POST", type: "application/json", body: "{}" })).status, 400);
  assert.deepEqual(x.calls.filter(c => c.startsWith("submit")), []);
  const b = "XyZ", part = (name: string, body: string, filename?: string) => `--${b}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n\r\n${body}\r\n`;
  assert.deepEqual(uploadForm(Buffer.from(`${part("format", "kfh")}${part("file", "data", "a.xlsx")}--${b}--\r\n`), `multipart/form-data; boundary=${b}`), { format: "kfh", file: Buffer.from("data") });
  assert.equal(uploadForm(Buffer.from(`${part("format", "kfh")}${part("format", "aub")}${part("file", "data", "a.xlsx")}--${b}--\r\n`), `multipart/form-data; boundary=${b}`), undefined, "a repeated field");
  assert.equal(uploadForm(Buffer.from(`${part("format", "kfh")}${part("note", "x")}${part("file", "data", "a.xlsx")}--${b}--\r\n`), `multipart/form-data; boundary=${b}`), undefined, "an unknown field");
  assert.equal(uploadForm(Buffer.from(`${part("format", "kfh")}${part("file", "", "a.xlsx")}--${b}--\r\n`), `multipart/form-data; boundary=${b}`), undefined, "an empty file");
});

test("BANK_HTTP_APPLY_OFF apply is off unless switched on: the page previews without an apply form and an apply is refused before the store", async (t) => {
  const x = await rig(t, "unset");
  const page = await (await x.call(`/finance/bank-results/${ID}`, { session: FIN, accept: "text/html" })).text();
  assert.match(page, /marks 1 line paid/, "preview still works");
  assert.doesNotMatch(page, /Apply this file|name="review"/);
  assert.match(page, /not switched on yet/);
  const refused = await x.call(`/finance/bank-results/${ID}/apply`, { session: FIN, method: "POST", type: "application/json", body: JSON.stringify({ review: REVIEW }) });
  assert.equal(refused.status, 409); assert.deepEqual(await refused.json(), { error: "apply_disabled" });
  assert.deepEqual(x.calls.filter(c => c.startsWith("apply")), [], "the store is never asked to apply");
  assert.equal((await x.upload(FIN, "aub", await AUB())).status, 303, "upload still works");
});

test("BANK_HTTP_HELD Finance sees every held row with why it was held and the current state of each line it names, linked to its transfer", async (t) => {
  const x = await rig(t);
  assert.match(await (await x.call("/finance/bank-results", { session: FIN, accept: "text/html" })).text(), /href="\/finance\/bank-results\/held">Held bank rows</);
  const page = await x.call("/finance/bank-results/held", { session: FIN, accept: "text/html" });
  assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  assert.match(html, /More than one line matches; choose by hand\./);
  assert.match(html, /REF-&lt;9&gt;/); assert.doesNotMatch(html, /REF-<9>/);
  assert.match(html, /<a href="\/finance\/bank-results\/transfers\/T%3A1#line-L-2">L-2<\/a> \(unpaid\)/);
  assert.match(html, /<a href="\/finance\/bank-results\/transfers\/T1#line-L-3">L-3<\/a> \(paid\)/);
  assert.match(html, /No line waiting for payment matches this row\.<\/td><td><\/td><td>No line found/);
  assert.deepEqual(await (await x.call("/finance/bank-results/held", { session: FIN })).json(), { held: HELD });
  assert.deepEqual(x.calls.filter(c => c.startsWith("held")), ["held:fin:false", "held:fin:false"]);
  assert.equal((await x.call("/finance/bank-results/held", { session: FIN, method: "POST" })).status, 405);
});

test("BANK_HTTP_TRANSFER Finance sees each line of a transfer: paid with which bank payment, or unpaid with every held or failed row", async (t) => {
  const x = await rig(t);
  const page = await x.call("/finance/bank-results/transfers/T1", { session: FIN, accept: "text/html" });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<tr id="line-L-1"><td>L-1<\/td><td>w1<\/td><td>KWD 120\.500<\/td><td>Paid: bank reference REF-1, <a href="\/finance\/bank-results\/[0-9a-f-]{36}">file<\/a> row 3/);
  assert.match(html, /<tr id="line-L-2">[\s\S]*?<td>Unpaid<\/td><td>[\s\S]*row 4: held\. The amount differs from the line\.[\s\S]*row 6: the bank reported a failure \(Account closed\)\./);
  assert.match(html, /<tr id="line-L-4">[\s\S]*?Paid \(not from a bank result file\)/);
  assert.deepEqual(await (await x.call("/finance/bank-results/transfers/T1", { session: FIN })).json(), STATUS);
  assert.equal((await x.call("/finance/bank-results/transfers/T2", { session: FIN })).status, 404, "a transfer the reader may not settle is not found");
  assert.equal((await x.call("/finance/bank-results/transfers/%3Cx%3E", { session: FIN })).status, 404);
  assert.equal((await x.call("/finance/bank-results/transfers/T1/x", { session: FIN })).status, 404);
  assert.equal((await x.call("/finance/bank-results/transfers/T%3A1", { session: FIN })).status, 404, "an encoded id is decoded before the store is asked");
  assert.equal((await x.call("/finance/bank-results/transfers/%E0%A4%A", { session: FIN })).status, 404, "a malformed escape is not found");
  assert.deepEqual(x.calls.filter(c => c.startsWith("transfer")), ["transfer:fin:false:T1", "transfer:fin:false:T1", "transfer:fin:false:T2", "transfer:fin:false:T:1"]);
  assert.equal(transferIdOf("T%3A1"), "T:1"); assert.equal(transferIdOf("T%201"), undefined); assert.equal(transferIdOf("%E0%A4%A"), undefined);
});
