import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { inflateSync } from "node:zlib";
import type { TransferInvoiceDocument, TransferStatement } from "@studenthub/db/billing";
import { createInvoicesHttp, handleInvoices, type TransferInvoiceReads } from "../src/billing/invoices-http.js";
import { invoiceBankInfo, invoicePdf } from "../src/billing/invoice-pdf.js";

// Synthetic companies and amounts only.
const FIN = "f".repeat(43), OTHER = "o".repeat(43);
const UNPAID: TransferInvoiceDocument = { invoiceNumber: "SH-2026-11-000001", transferId: "t-1", orgId: "C1", companyName: "Sultan <Center>", currencyCode: "KWD",
  invoiceDate: "2026-11-22", total: "12.500", lineCount: 3, status: "unpaid", paidOn: null, creditNumber: null, creditedOn: null, periodStart: "2026-10-01", periodEnd: "2026-10-31" };
const PAID: TransferInvoiceDocument = { ...UNPAID, invoiceNumber: "SH-2026-11-000002", orgId: "P", companyName: "Parent", status: "paid", paidOn: "2026-11-25", lineCount: 1 };
const STATEMENT = (from: string, to: string): TransferStatement => ({ orgId: "P", name: "Parent <Co>", from, to,
  currencies: [{ currencyCode: "KWD", opening: "5.000", invoiced: "12.500", paid: "5.000", credited: "0.000", closing: "12.500", members: [
    { orgId: "C1", companyName: "Sultan <Center>", opening: "0.000", invoiced: "12.500", paid: "0.000", credited: "0.000", closing: "12.500" },
    { orgId: "P", companyName: "Parent", opening: "5.000", invoiced: "0.000", paid: "5.000", credited: "0.000", closing: "0.000" }] }],
  entries: [{ date: "2026-11-22", kind: "invoice", invoiceNumber: "SH-2026-11-000001", creditNumber: null, orgId: "C1", companyName: "Sultan <Center>", currencyCode: "KWD", amount: "12.500" },
    { date: "2026-11-25", kind: "payment", invoiceNumber: "SH-2026-11-000002", creditNumber: null, orgId: "P", companyName: "Parent", currencyCode: "KWD", amount: "5.000" }] });
const BANK = { accountName: "Synthetic Account", bankName: "Synthetic Bank", iban: "KW00SYNT0000000000000000000000", accountNumber: "0000000000", swiftCode: "SYNTKWKW" };

/** Text drawn on the PDF's page, from its content stream. */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString("latin1"), out: string[] = [];
  for (const m of raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    const body = m[1]!; let text = body;
    try { text = inflateSync(Buffer.from(body, "latin1")).toString("latin1"); } catch { /* not compressed */ }
    for (const t of text.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)) out.push(t[1]!.replace(/\\([()\\])/g, "$1").replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))));
  }
  return out.join("\n");
}

async function rig(t: TestContext) {
  const calls: string[] = [];
  const reads: TransferInvoiceReads = {
    async listForOrganization(principal, orgId) { calls.push(`list:${principal}:${orgId}`); return principal === "fin" && orgId === "P" ? { orgId: "P", name: "Parent <Co>", invoices: [PAID, UNPAID] } : null; },
    async document(principal, orgId, number) { calls.push(`doc:${principal}:${orgId}:${number}`); return principal === "fin" && orgId === "P" ? [UNPAID, PAID].find(i => i.invoiceNumber === number) ?? null : null; },
    async statement(principal, orgId, from, to) { calls.push(`statement:${principal}:${orgId}:${from}:${to}`); return principal === "fin" && orgId === "P" ? STATEMENT(from, to) : null; },
  };
  // 22:30Z on 30 November is already 1 December in Kuwait.
  const service = createInvoicesHttp({ sessions: { get: async (id: string) => ({ [FIN]: { personId: "fin" }, [OTHER]: { personId: "other" } } as Record<string, { personId: string }>)[id] as never }, reads, bank: BANK,
    now: () => new Date("2026-11-30T22:30:00Z") });
  const server = createServer(async (req, res) => { if (!await handleInvoices(req, res, service)) { res.writeHead(418); res.end(); } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "application/json", method = "GET") =>
    fetch(base + path, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  return { call, calls };
}

test("INVOICES_HTTP a company reader lists its invoices as JSON or a page, with a PDF link for each", async (t) => {
  const x = await rig(t);
  const json = await (await x.call("/organization/invoices/P", FIN)).json() as { name: string; invoices: { invoiceNumber: string }[] };
  assert.deepEqual([json.name, json.invoices.map(i => i.invoiceNumber)], ["Parent <Co>", ["SH-2026-11-000002", "SH-2026-11-000001"]]);
  const page = await x.call("/organization/invoices/P", FIN, "text/html");
  assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  assert.match(html, /Parent &lt;Co&gt;/); assert.match(html, /Sultan &lt;Center&gt;/); assert.doesNotMatch(html, /<Center>/);
  assert.match(html, /href="\/organization\/invoices\/P\/SH-2026-11-000001\.pdf">Invoice \(PDF\)/);
  assert.match(html, /href="\/organization\/invoices\/P\/SH-2026-11-000002\.pdf">Receipt \(PDF\)/);
  assert.match(html, /Paid on 25 November 2026/); assert.match(html, /KWD 12\.500/);
});

test("INVOICES_HTTP an unpaid invoice downloads as an Invoice with bank details; a paid one as a Receipt without them", async (t) => {
  const x = await rig(t);
  const invoice = await x.call("/organization/invoices/P/SH-2026-11-000001.pdf", FIN, "*/*");
  assert.equal(invoice.status, 200); assert.equal(invoice.headers.get("content-type"), "application/pdf");
  assert.equal(invoice.headers.get("content-disposition"), 'attachment; filename="studenthub-invoice-SH-2026-11-000001.pdf"');
  const text = pdfText(Buffer.from(await invoice.arrayBuffer()));
  for (const line of ["Invoice", "Sultan <Center>", "Invoice number: SH-2026-11-000001", "Transfer number: t-1", "Issue date: 22 November 2026", "Payment terms: Due immediately",
    "Amount due in KWD: 12.500", "For time period: 1 October 2026 to 31 October 2026", "Amount Due for 3 interns", "KWD 12.500", "Khalid Al-Mutawa", "Bank Info", `IBAN: ${BANK.iban}`, `Swift: ${BANK.swiftCode}`]) {
    assert.ok(text.split("\n").includes(line), `invoice prints ${line}`);
  }
  const receipt = await x.call("/organization/invoices/P/SH-2026-11-000002.pdf", FIN, "*/*");
  assert.equal(receipt.headers.get("content-disposition"), 'attachment; filename="studenthub-receipt-SH-2026-11-000002.pdf"');
  const paid = pdfText(Buffer.from(await receipt.arrayBuffer())).split("\n");
  for (const line of ["Receipt", "Payment date: 25 November 2026", "Amount paid in KWD: 12.500", "Amount paid for 1 intern",
    "No payment is required. This is a confirmation that we have received the requested amount."]) assert.ok(paid.includes(line), `receipt prints ${line}`);
  for (const line of ["Payment terms: Due immediately", "Bank Info", "Invoice"]) assert.ok(!paid.includes(line), `receipt leaves out ${line}`);
});

test("INVOICES_HTTP sign in first; a refused reader, another company and a malformed number are the same not found", async (t) => {
  const x = await rig(t);
  assert.equal((await x.call("/organization/invoices/P")).status, 401);
  assert.equal((await x.call("/organization/invoices/P/SH-2026-11-000001.pdf", "x".repeat(43))).status, 401, "an unknown session");
  const refused = await x.call("/organization/invoices/P", OTHER), missing = await x.call("/organization/invoices/Nope", FIN);
  assert.equal(refused.status, 404); assert.deepEqual(await refused.text(), await missing.text());
  const theirs = await x.call("/organization/invoices/P/SH-2026-11-000001.pdf", OTHER), none = await x.call("/organization/invoices/P/SH-2026-11-000009.pdf", FIN);
  assert.equal(theirs.status, 404); assert.deepEqual(await theirs.text(), await none.text());
  const before = x.calls.length;
  for (const bad of ["LEGACY-1", "SH-2026-13-000001", "SH-2026-11-1", "..%2Fx"]) assert.equal((await x.call(`/organization/invoices/P/${bad}.pdf`, FIN)).status, 404, bad);
  assert.equal((await x.call("/organization/invoices/%E0%A4%A/SH-2026-11-000001.pdf", FIN)).status, 404, "a broken escape");
  assert.equal(x.calls.length, before, "malformed paths never reach the store");
  assert.equal((await x.call("/organization/invoices/P", FIN, "application/json", "POST")).status, 405);
  assert.equal((await x.call("/organization/invoices", FIN)).status, 418, "not this route's path");
  assert.equal((await x.call("/organization/invoices/P/extra/x", FIN)).status, 418);
});

test("INVOICES_HTTP unavailable without a service, and a store failure is a 503, not a leak", async (t) => {
  const server = createServer(async (req, res) => { if (!await handleInvoices(req, res, undefined)) { res.writeHead(418); res.end(); } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/organization/invoices/P`)).status, 503);
  const failing = createInvoicesHttp({ sessions: { get: async () => ({ personId: "fin" }) as never },
    reads: { listForOrganization: async () => { throw new Error("db down: secret"); }, document: async () => null, statement: async () => null } });
  const s2 = createServer(async (req, res) => { await handleInvoices(req, res, failing); });
  await new Promise<void>(r => s2.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => s2.close(() => r())));
  const r = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/organization/invoices/P`, { headers: { cookie: `__Host-studenthub_session=${FIN}` } });
  assert.equal(r.status, 503); assert.doesNotMatch(await r.text(), /secret/);
});

test("INVOICES_PDF bank info config: unset means none; anything malformed stops startup; a non-Latin name still prints", () => {
  assert.equal(invoiceBankInfo(undefined), undefined); assert.equal(invoiceBankInfo(" "), undefined);
  assert.deepEqual(invoiceBankInfo(JSON.stringify(BANK)), BANK);
  for (const bad of ["{", "[]", JSON.stringify({ ...BANK, extra: "x" }), JSON.stringify({ ...BANK, iban: "" }), JSON.stringify({ ...BANK, accountName: "حساب" })]) {
    assert.throws(() => invoiceBankInfo(bad), /BILLING_BANK_INFO/, bad);
  }
  const text = pdfText(invoicePdf({ ...UNPAID, companyName: "شركة" })).split("\n");
  assert.ok(text.includes("Company"), "an Arabic-only name falls back to a placeholder rather than an empty line");
  assert.ok(!text.includes("Bank Info"), "no bank block without config");
});

test("INVOICES_ROUTE the gateway's route table reaches the invoices handler; no earlier route takes its paths", async (t) => {
  const { ROUTES } = await import("../src/routes/index.js");
  const { runRoutes } = await import("../src/routes/context.js");
  const web = await import("../src/web-ui.js");
  const reads: TransferInvoiceReads = { listForOrganization: async () => ({ orgId: "P", name: "P", invoices: [UNPAID] }), document: async () => UNPAID,
    statement: async (_, __, from, to) => STATEMENT(from, to) };
  const invoices = createInvoicesHttp({ sessions: { get: async () => ({ personId: "fin" }) as never }, reads });
  const server = createServer(async (request, response) => {
    const ctx = { request, response, login: { invoices } as never, authz: undefined as never, documents: undefined, catalogue: undefined, profileRecords: undefined,
      organizationDocuments: undefined, writeHtml: web.writeHtml, pageDocument: web.pageDocument, renderError: web.renderError };
    if (!await runRoutes(ROUTES, ctx)) { response.writeHead(418); response.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers = { cookie: `__Host-studenthub_session=${FIN}` };
  const list = await fetch(`${base}/organization/invoices/P`, { headers });
  assert.equal(list.status, 200); assert.equal(((await list.json()) as { invoices: unknown[] }).invoices.length, 1);
  const pdf = await fetch(`${base}/organization/invoices/P/SH-2026-11-000001.pdf`, { headers });
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get("content-type"), "application/pdf");
  const statement = await fetch(`${base}/organization/P/statements`, { headers });
  assert.equal(statement.status, 200); assert.equal(((await statement.json()) as TransferStatement).currencies.length, 1);
});

test("STATEMENTS_HTTP a company reader sees its statement as JSON or a page; the default period is this Kuwait month to today", async (t) => {
  const x = await rig(t);
  const json = await (await x.call("/organization/P/statements", FIN)).json() as TransferStatement;
  assert.deepEqual([json.from, json.to, json.currencies[0]!.closing], ["2026-12-01", "2026-12-01", "12.500"]);
  await x.call("/organization/P/statements?from=2026-10-01&to=2026-11-30", FIN);
  await x.call("/organization/P/statements?from=2026-11-15", FIN);
  assert.deepEqual(x.calls, ["statement:fin:P:2026-12-01:2026-12-01", "statement:fin:P:2026-10-01:2026-11-30", "statement:fin:P:2026-11-15:2026-12-01"]);
  const page = await x.call("/organization/P/statements?from=2026-11-01&to=2026-11-30", FIN, "text/html");
  assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  for (const text of ["Parent &lt;Co&gt;, 1 November 2026 to 30 November 2026", "Sultan &lt;Center&gt;", "<th>Total</th><th>KWD 5.000</th><th>KWD 12.500</th><th>KWD 5.000</th><th>KWD 0.000</th><th>KWD 12.500</th>",
    "Invoice issued", "Payment received", "−KWD 5.000", 'href="/organization/invoices/P">Invoices']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<Center>/);
});

test("STATEMENTS_HTTP sign in first; a refused reader is not found; a bad period is refused before the store", async (t) => {
  const x = await rig(t);
  assert.equal((await x.call("/organization/P/statements")).status, 401);
  const refused = await x.call("/organization/P/statements", OTHER), missing = await x.call("/organization/Nope/statements", FIN);
  assert.equal(refused.status, 404); assert.deepEqual(await refused.text(), await missing.text());
  const before = x.calls.length;
  for (const bad of ["from=2026-11-31", "from=2026-12-02&to=2026-12-01", "from=2025-01-01&to=2026-11-30", "from=1999-12-31&to=2000-01-01", "to=yesterday", "from="]) {
    assert.equal((await x.call(`/organization/P/statements?${bad}`, FIN)).status, 400, bad);
  }
  assert.equal((await x.call("/organization/P/statements?from=2025-11-30&to=2026-11-30", FIN)).status, 200, "a leap-free year plus a day is the longest window");
  assert.equal(x.calls.length, before + 1, "bad periods never reach the store");
  assert.equal((await x.call("/organization/%E0%A4%A/statements", FIN)).status, 404);
  assert.equal((await x.call("/organization/P/statements", FIN, "application/json", "POST")).status, 405);
  assert.equal((await x.call("/organization/P/statements/x", FIN)).status, 418, "not this route's path");
});

test("STATEMENTS_ROUTE each path has one meaning: the invoice list of an organization named statements is never read as the statement of invoices", async (t) => {
  const x = await rig(t);
  await x.call("/organization/invoices/statements", FIN);
  await x.call("/organization/invoices/statements/SH-2026-11-000001.pdf", FIN);
  await x.call("/organization/statements/statements", FIN);
  assert.deepEqual(x.calls, ["list:fin:statements", "doc:fin:statements:SH-2026-11-000001", "statement:fin:statements:2026-12-01:2026-12-01"]);
});

test("CREDIT_NOTES_HTTP a credited invoice says so on the list, the statement and its PDF, which asks for no payment", async (t) => {
  const credited: TransferInvoiceDocument = { ...UNPAID, creditNumber: "SH-2026-11-000009", creditedOn: "2026-11-26" };
  const reads: TransferInvoiceReads = {
    listForOrganization: async () => ({ orgId: "P", name: "Parent", invoices: [credited] }),
    document: async () => credited,
    statement: async (_, __, from, to) => ({ orgId: "P", name: "Parent", from, to, currencies: [{ currencyCode: "KWD", opening: "0.000", invoiced: "12.500", paid: "0.000", credited: "12.500",
      closing: "0.000", members: [{ orgId: "C1", companyName: "Sultan", opening: "0.000", invoiced: "12.500", paid: "0.000", credited: "12.500", closing: "0.000" }] }],
      entries: [{ date: "2026-11-22", kind: "invoice", invoiceNumber: UNPAID.invoiceNumber, creditNumber: null, orgId: "C1", companyName: "Sultan", currencyCode: "KWD", amount: "12.500" },
        { date: "2026-11-26", kind: "credit", invoiceNumber: UNPAID.invoiceNumber, creditNumber: "SH-2026-11-000009", orgId: "C1", companyName: "Sultan", currencyCode: "KWD", amount: "12.500" }] }),
  };
  const service = createInvoicesHttp({ sessions: { get: async () => ({ personId: "fin" }) as never }, reads, bank: BANK });
  const server = createServer(async (req, res) => { await handleInvoices(req, res, service); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const get = async (path: string, accept = "text/html") => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { headers: { cookie: `__Host-studenthub_session=${FIN}`, accept } });
  assert.match(await (await get("/organization/invoices/P")).text(), /Unpaid, voided by credit note SH-2026-11-000009 on 26 November 2026/);
  const statement = await (await get("/organization/P/statements?from=2026-11-01&to=2026-11-30")).text();
  for (const text of ["<th>Credited</th>", "Credit note SH-2026-11-000009</td><td>SH-2026-11-000001", "−KWD 12.500", "<th>Total</th><th>KWD 0.000</th><th>KWD 12.500</th><th>KWD 0.000</th><th>KWD 12.500</th><th>KWD 0.000</th>"]) {
    assert.ok(statement.includes(text), text);
  }
  const lines = pdfText(Buffer.from(await (await get(`/organization/invoices/P/${UNPAID.invoiceNumber}.pdf`, "*/*")).arrayBuffer())).split("\n");
  for (const line of ["Voided by credit note SH-2026-11-000009 on 26 November 2026", "Voided by credit note SH-2026-11-000009 on 26 November 2026. No payment is required."]) assert.ok(lines.includes(line), line);
  for (const line of ["Amount invoiced in KWD: 12.500", "Amount invoiced for 3 interns"]) assert.ok(lines.includes(line), line);
  for (const line of ["Payment terms: Due immediately", "Bank Info", "Amount due in KWD: 12.500", "Amount Due for 3 interns"]) assert.ok(!lines.includes(line), `a credited invoice does not print ${line}`);
});

async function voidRig(t: TestContext) {
  const ORIGIN = "https://studenthub.example";
  const credits: { actorId: string; invoiceNumber: string; reason: string }[] = [], creditedNumbers = new Set<string>();
  // "co" (company finance) reads but never voids; "fin" (StudentHub finance) voids but does not read.
  const list = (orgId: string) => orgId === "P" ? { orgId: "P", name: "Parent", invoices: [PAID, UNPAID] } : null;
  const doc = (orgId: string, number: string) => orgId === "P" ? [UNPAID, PAID, DRAFT].find(i => i.invoiceNumber === number) ?? null : null;
  const reads: TransferInvoiceReads = {
    listForOrganization: async (principal, orgId) => principal === "co" ? list(orgId) : null,
    document: async (principal, orgId, number) => principal === "co" ? doc(orgId, number) : null,
    statement: async (principal, orgId, from, to) => principal === "co" && orgId === "P" ? STATEMENT(from, to) : null,
  };
  const voidReads = { listForOrganization: async (p: string, o: string) => p === "fin" ? list(o) : null,
    document: async (p: string, o: string, n: string) => p === "fin" ? doc(o, n) : null };
  const credit = { creditNumber: "SH-2026-11-000009", invoiceNumber: UNPAID.invoiceNumber, orgId: "C1", currencyCode: "KWD", creditDate: "2026-11-26", total: "12.500", reason: "Wrong hours", actorId: "fin" };
  const service = createInvoicesHttp({ sessions: { get: async (id: string) => ({ [FIN]: { personId: "fin" }, [OTHER]: { personId: "co" } } as Record<string, { personId: string }>)[id] as never }, reads,
    voids: { reads: voidReads, origin: ORIGIN, async credit(input) {
      credits.push(input);
      if (input.invoiceNumber === DRAFT.invoiceNumber) return { kind: "not_creditable" };
      const kind = creditedNumbers.has(input.invoiceNumber) ? "already_credited" : "credited"; creditedNumbers.add(input.invoiceNumber);
      return { kind, credit: { ...credit, reason: input.reason } };
    } } });
  const server = createServer(async (req, res) => { if (!await handleInvoices(req, res, service)) { res.writeHead(418); res.end(); } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: string, opts: { session?: string; origin?: string | null; type?: string; accept?: string; site?: string } = {}) => fetch(base + path, { method: "POST", redirect: "manual", body,
    headers: { "content-type": opts.type ?? "application/json", accept: opts.accept ?? "application/json", ...(opts.session === undefined ? { cookie: `__Host-studenthub_session=${FIN}` } : opts.session ? { cookie: `__Host-studenthub_session=${opts.session}` } : {}),
      ...(opts.origin === null ? {} : { origin: opts.origin ?? ORIGIN }), ...(opts.site ? { "sec-fetch-site": opts.site } : {}) } });
  const page = (session: string, path = "/organization/invoices/P", accept = "text/html") => fetch(`${base}${path}`, { headers: { cookie: `__Host-studenthub_session=${session}`, accept } });
  return { post, page, credits, base };
}
const VOID_PATH = `/organization/invoices/P/${UNPAID.invoiceNumber}/void`;
/** An unpaid invoice whose transfer the store finds not payable (a draft or cancelled). */
const DRAFT: TransferInvoiceDocument = { ...UNPAID, invoiceNumber: "SH-2026-11-000003" };

test("INVOICE_VOID_HTTP StudentHub finance voids with a reason; a second void answers the first credit note; a form post goes back to the list", async (t) => {
  const x = await voidRig(t);
  const first = await x.post(VOID_PATH, JSON.stringify({ reason: "  Wrong hours " }));
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { kind: "credited", credit: { creditNumber: "SH-2026-11-000009", invoiceNumber: UNPAID.invoiceNumber, orgId: "C1", currencyCode: "KWD", creditDate: "2026-11-26", total: "12.500", reason: "Wrong hours", actorId: "fin" } });
  assert.deepEqual(x.credits, [{ actorId: "fin", invoiceNumber: UNPAID.invoiceNumber, reason: "Wrong hours" }], "the reason is stored trimmed, the actor is the signed-in person");
  const again = await x.post(VOID_PATH, "reason=Again", { type: "application/x-www-form-urlencoded", accept: "text/html" });
  assert.equal(again.status, 303); assert.equal(again.headers.get("location"), "/organization/invoices/P");
  const json = await x.post(VOID_PATH, JSON.stringify({ reason: "Again" }));
  assert.equal(json.status, 200); assert.equal((await json.json() as { kind: string }).kind, "already_credited");
  const paid = await x.post(`/organization/invoices/P/${PAID.invoiceNumber}/void`, JSON.stringify({ reason: "Refund agreed" }));
  assert.equal(paid.status, 201, "a paid invoice is credited too");
  const wide = "界".repeat(500);
  const multibyte = await x.post(`/organization/invoices/P/${PAID.invoiceNumber}/void`, `reason=${encodeURIComponent(wide)}`, { type: "application/x-www-form-urlencoded", accept: "text/html" });
  assert.equal(multibyte.status, 303, "the longest reason in three-byte characters fits the form body limit");
  assert.equal(x.credits.at(-1)?.reason, wide);
  const refused = await x.post(`/organization/invoices/P/${DRAFT.invoiceNumber}/void`, JSON.stringify({ reason: "x" }));
  assert.equal(refused.status, 409); assert.deepEqual(await refused.json(), { error: "not_creditable" });
});

test("INVOICE_VOID_HTTP only StudentHub finance voids, and sees only the void list; company readers, strangers and cross-site posts are refused before the store", async (t) => {
  const x = await voidRig(t);
  const fin = await (await x.page(FIN)).text(), company = await (await x.page(OTHER)).text();
  assert.ok(fin.includes(`<form method="post" action="${VOID_PATH}">`), "StudentHub finance sees a void form per standing invoice");
  assert.ok(fin.includes("<th>Void</th>"));
  assert.ok(!fin.includes(".pdf") && !fin.includes("<th>Document</th>"), "voiding does not open the invoice documents");
  assert.equal((await x.page(FIN, `/organization/invoices/P/${UNPAID.invoiceNumber}.pdf`, "application/json")).status, 404, "nor a PDF");
  assert.equal((await x.page(FIN, "/organization/P/statements", "application/json")).status, 404, "nor the statement");
  // The void list shows exactly the void view, in JSON as on the page: no line count, payment or credit dates.
  const voidJson = await (await x.page(FIN, "/organization/invoices/P", "application/json")).json();
  const view = (i: TransferInvoiceDocument) => ({ invoiceNumber: i.invoiceNumber, transferId: i.transferId, orgId: i.orgId, companyName: i.companyName, currencyCode: i.currencyCode,
    invoiceDate: i.invoiceDate, total: i.total, status: i.status, creditNumber: i.creditNumber });
  assert.deepEqual(voidJson, { orgId: "P", name: "Parent", invoices: [view(PAID), view(UNPAID)] });
  assert.ok(!fin.includes(" on 25 November 2026"), "the page shows no payment date either");
  const readerJson = await (await x.page(OTHER, "/organization/invoices/P", "application/json")).json() as { invoices: Record<string, unknown>[] };
  assert.equal(readerJson.invoices[0]!.lineCount, PAID.lineCount, "a reader's list is unchanged");
  assert.equal(readerJson.invoices[0]!.paidOn, PAID.paidOn);
  assert.equal((await x.page(OTHER, "/organization/P/statements", "application/json")).status, 200, "the company still reads its statement");
  assert.ok(!company.includes("/void") && !company.includes("<th>Void</th>"), "a company's own finance user reads but sees no void");
  assert.ok(company.includes(`${UNPAID.invoiceNumber}.pdf`), "and keeps its PDF links");
  const cases: [string, Parameters<typeof x.post>[2], number, string][] = [
    ["company finance", { session: OTHER }, 404, "not_found"],
    ["signed out", { session: "" }, 401, "unauthorized"],
    ["another origin", { origin: "https://evil.example" }, 403, "forbidden"],
    ["no origin", { origin: null }, 403, "forbidden"],
    ["cross-site fetch", { site: "cross-site" }, 403, "forbidden"],
    ["a text body", { type: "text/plain" }, 400, "invalid_request"],
  ];
  for (const [label, opts, status, error] of cases) {
    const res = await x.post(VOID_PATH, JSON.stringify({ reason: "Wrong hours" }), opts);
    assert.equal(res.status, status, label); assert.deepEqual(await res.json(), { error }, label);
  }
  for (const reason of ["", "   ", "a".repeat(501), "two\nlines", 7]) {
    const res = await x.post(VOID_PATH, JSON.stringify({ reason }));
    assert.equal(res.status, 400, String(reason).slice(0, 10)); assert.deepEqual(await res.json(), { error: "invalid_reason" });
  }
  assert.equal((await x.post("/organization/invoices/P/INV-1/void", JSON.stringify({ reason: "x" }))).status, 404, "not an invoice number");
  assert.equal((await x.post("/organization/invoices/Q/" + UNPAID.invoiceNumber + "/void", JSON.stringify({ reason: "x" }))).status, 404, "outside what the voider sees");
  const get = await fetch(x.base + VOID_PATH);
  assert.equal(get.status, 405); assert.equal(get.headers.get("allow"), "POST");
  assert.deepEqual(x.credits, [], "nothing refused reached the credit note store");
});

test("INVOICE_VOID_HTTP without a gateway origin or a void store nobody voids", async (t) => {
  const reads: TransferInvoiceReads = { listForOrganization: async () => ({ orgId: "P", name: "Parent", invoices: [UNPAID] }), document: async () => UNPAID, statement: async () => null };
  for (const voids of [undefined, { reads, origin: "", credit: async () => { throw new Error("never"); } }]) {
    const service = createInvoicesHttp({ sessions: { get: async () => ({ personId: "fin" }) as never }, reads, ...(voids ? { voids } : {}) });
    assert.equal((await service.voidList("fin", "P")) !== null, voids !== undefined);
    const server = createServer(async (req, res) => { await handleInvoices(req, res, service); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    t.after(() => new Promise<void>(r => server.close(() => r())));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${VOID_PATH}`, { method: "POST", body: JSON.stringify({ reason: "x" }),
      headers: { "content-type": "application/json", accept: "application/json", origin: "", cookie: `__Host-studenthub_session=${FIN}` } });
    assert.equal(res.status, 403);
  }
});
