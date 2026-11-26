import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { BankResultApply, BankResultFileDetail, BankResultSubmit } from "@studenthub/db/billing";
import { createBankResultsHttp, handleBankResults, uploadForm, type BankResultsStore } from "../src/billing/bank-results-http.js";

// Synthetic people, files, references and line ids only.
const FIN = "f".repeat(43), COMPANY_FIN = "c".repeat(43);
const ORIGIN = "https://studenthub.example";
const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const PENDING: BankResultFileDetail = { fileId: ID, format: "aub", status: "pending", rowCount: 2, uploadedBy: "fin", uploadedAt: "2026-11-25T10:00:00.000Z", appliedBy: null, appliedAt: null, decisions: [] };
const PREVIEW: BankResultApply = { kind: "applied", completedTransferIds: ["T1"], decisions: [
  { kind: "pay", rowNumber: 3, lineId: "L-1", transferId: "T1", reference: "REF-1" },
  { kind: "hold", rowNumber: 4, reason: "reference_conflict", lineIds: ["L-2", "<L-3>"] }] };

async function xlsx(rows: string[][]): Promise<Buffer> {
  const { default: writeExcelFile } = await import("write-excel-file/node");
  return Buffer.from(await writeExcelFile(rows.map(r => r.map(value => ({ value, type: String }))) as never, { sheet: "R" }).toBuffer());
}
const AUB = () => xlsx([[""], ["Status", "Status Description", "Debit Narrative", "Credit Narrative"], ["SUCCESS", "REF-1", "x", "L-1"]]);

async function rig(t: TestContext) {
  const calls: string[] = [];
  let file: BankResultFileDetail | null = PENDING;
  const store: BankResultsStore = {
    async files(actor) { calls.push(`files:${actor.principalId}`); return file ? [file] : []; },
    async file(actor, id) { calls.push(`file:${actor.principalId}:${id}`); return id === ID ? file : null; },
    async submit(actor, input): Promise<BankResultSubmit> {
      calls.push(`submit:${actor.principalId}:${actor.actingAs}:${input.format}:${input.contentSha256.length}:${JSON.stringify(input.cells[2])}`);
      return { kind: "submitted", fileId: ID };
    },
    async preview(actor, id) { calls.push(`preview:${actor.principalId}:${id}`); return PREVIEW; },
    async apply(actor, id) {
      calls.push(`apply:${actor.principalId}:${id}`);
      if (file?.status === "applied") return { kind: "refused", code: "already_applied" };
      file = { ...PENDING, status: "applied", appliedBy: "fin", appliedAt: "2026-11-25T11:00:00.000Z", decisions: [{ rowNumber: 3, kind: "pay", reason: null, lineIds: ["L-1"], reference: "REF-1" }] };
      return PREVIEW;
    },
  };
  const sessions = { get: async (id: string) => ({ [FIN]: { personId: "fin" }, [COMPANY_FIN]: { personId: "company-fin" } } as Record<string, { personId: string }>)[id] as never };
  const service = createBankResultsHttp({ sessions, store, origin: ORIGIN, allowed: async (viewer) => { calls.push(`allowed:${viewer}`); return viewer === "fin"; } });
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
  assert.match(page, new RegExp(`action="/finance/bank-results/${ID}/apply"`));
  const applied = await x.call(`/finance/bank-results/${ID}/apply`, { session: FIN, method: "POST", accept: "text/html", type: "application/x-www-form-urlencoded", body: "" });
  assert.equal(applied.status, 303);
  const after = await (await x.call(`/finance/bank-results/${ID}`, { session: FIN, accept: "text/html" })).text();
  assert.match(after, /Applied 2026-11-25 11:00 UTC/); assert.match(after, /Marks the line paid/); assert.doesNotMatch(after, /Apply this file/);
  assert.equal((await x.call(`/finance/bank-results/${ID}/apply`, { session: FIN, method: "POST" })).status, 409);
  assert.deepEqual(x.calls.filter(c => c.startsWith("preview") || c.startsWith("apply")), [`preview:fin:${ID}`, `apply:fin:${ID}`, `apply:fin:${ID}`], "an applied file is not previewed");
});

test("BANK_HTTP_GATE a company's finance user, a signed-out caller and another origin reach nothing, before any file is read", async (t) => {
  const x = await rig(t);
  for (const path of ["/finance/bank-results", `/finance/bank-results/${ID}`]) {
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
  assert.equal((await x.upload(FIN, "swift", await AUB())).status, 400);
  assert.equal((await x.call("/finance/bank-results", { session: FIN, method: "POST", type: "application/json", body: "{}" })).status, 400);
  assert.deepEqual(x.calls.filter(c => c.startsWith("submit")), []);
  const b = "XyZ", part = (name: string, body: string, filename?: string) => `--${b}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n\r\n${body}\r\n`;
  assert.deepEqual(uploadForm(Buffer.from(`${part("format", "kfh")}${part("file", "data", "a.xlsx")}--${b}--\r\n`), `multipart/form-data; boundary=${b}`), { format: "kfh", file: Buffer.from("data") });
  assert.equal(uploadForm(Buffer.from(`${part("format", "kfh")}${part("format", "aub")}${part("file", "data", "a.xlsx")}--${b}--\r\n`), `multipart/form-data; boundary=${b}`), undefined, "a repeated field");
  assert.equal(uploadForm(Buffer.from(`${part("format", "kfh")}${part("note", "x")}${part("file", "data", "a.xlsx")}--${b}--\r\n`), `multipart/form-data; boundary=${b}`), undefined, "an unknown field");
  assert.equal(uploadForm(Buffer.from(`${part("format", "kfh")}${part("file", "", "a.xlsx")}--${b}--\r\n`), `multipart/form-data; boundary=${b}`), undefined, "an empty file");
});
