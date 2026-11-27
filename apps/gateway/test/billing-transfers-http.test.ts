import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { CompanyTransferDetail, CompanyTransferEntry } from "@studenthub/db/billing";
import { createInvoicesHttp, handleInvoices, type TransferInvoiceReads } from "../src/billing/invoices-http.js";

// O-13 company transfers. Synthetic companies, people and amounts only.
const FIN = "f".repeat(43), OTHER = "o".repeat(43);
const OCTOBER: CompanyTransferEntry = { transferId: "t-oct", orgId: "P", companyName: "Parent <Co>", periodStart: "2026-10-01", periodEnd: "2026-10-31",
  currencyCode: "KWD", status: "distributing", lineCount: 2, personCount: 2, companyTotal: "12.750", paymentReceivedOn: "2026-11-22" };
const NOVEMBER: CompanyTransferEntry = { ...OCTOBER, transferId: "t-nov", periodStart: "2026-11-01", periodEnd: "2026-11-30", status: "draft", lineCount: 0, personCount: 0,
  companyTotal: "0.000", paymentReceivedOn: null };
const DETAIL: CompanyTransferDetail = { ...OCTOBER, lines: [
  { lineId: "l-1", personName: "Amal <Synthetic>", storeName: "Shop P", worked: { hours: "5", minutes: 15 }, companyTotal: "10.500", paid: true },
  { lineId: "l-2", personName: "w2", storeName: "Shop C1", worked: null, companyTotal: "2.250", paid: false }] };

async function rig(t: TestContext, reads?: Partial<TransferInvoiceReads>) {
  const calls: string[] = [];
  const base: TransferInvoiceReads = {
    listForOrganization: async () => null, document: async () => null, statement: async () => null,
    async companyTransfers(principal, orgId) { calls.push(`transfers:${principal}:${orgId}`); return principal === "fin" && orgId === "P" ? { orgId: "P", name: "Parent <Co>", transfers: [NOVEMBER, OCTOBER] } : null; },
    async companyTransfer(principal, orgId, id) { calls.push(`transfer:${principal}:${orgId}:${id}`); return principal === "fin" && orgId === "P" && id === "t-oct" ? DETAIL : null; },
  };
  const service = createInvoicesHttp({ sessions: { get: async (id: string) => ({ [FIN]: { personId: "fin" }, [OTHER]: { personId: "other" } } as Record<string, { personId: string }>)[id] as never },
    reads: { ...base, ...reads } });
  const server = createServer(async (req, res) => { if (!await handleInvoices(req, res, service)) { res.writeHead(418); res.end(); } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "application/json", method = "GET") =>
    fetch(origin + path, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  return { call, calls };
}

test("COMPANY_TRANSFERS_HTTP a company reader lists its transfers as JSON or a page, each linking to its detail", async (t) => {
  const x = await rig(t);
  const json = await (await x.call("/organization/P/transfers", FIN)).json();
  assert.deepEqual(json, { orgId: "P", name: "Parent <Co>", transfers: [NOVEMBER, OCTOBER] });
  const page = await x.call("/organization/P/transfers", FIN, "text/html");
  assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  for (const text of ['href="/organization/P/transfers/t-oct">1 October 2026 to 31 October 2026</a>', "Parent &lt;Co&gt;", "<td>2</td><td>KWD 12.750</td>",
    "Received, paying salaries (payment received 22 November 2026)", "<td>Draft</td>", 'href="/organization/invoices/P">Invoices']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<Co>/);
});

test("COMPANY_TRANSFERS_HTTP a transfer shows each person's store, worked time and the company's amount, as JSON or a page", async (t) => {
  const x = await rig(t);
  assert.deepEqual(await (await x.call("/organization/P/transfers/t-oct", FIN)).json(), DETAIL);
  const html = await (await x.call("/organization/P/transfers/t-oct", FIN, "text/html")).text();
  for (const text of ["Amal &lt;Synthetic&gt;</td><td>Shop P</td><td>5 h 15 min</td><td>KWD 10.500</td><td>Paid</td>", "<td>w2</td><td>Shop C1</td><td></td><td>KWD 2.250</td><td>Not paid yet</td>",
    "Amount: KWD 12.750 for 2 people.", 'href="/organization/P/transfers">All transfers']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<Synthetic>/);
});

test("COMPANY_TRANSFERS_HTTP sign in first; a refused reader, a missing transfer and a bad id are the same not found; writes are not allowed", async (t) => {
  const x = await rig(t);
  assert.equal((await x.call("/organization/P/transfers")).status, 401);
  assert.equal((await x.call("/organization/P/transfers/t-oct")).status, 401);
  const refused = await x.call("/organization/P/transfers", OTHER), missing = await x.call("/organization/P/transfers/t-none", FIN);
  assert.equal(refused.status, 404); assert.equal(missing.status, 404);
  assert.deepEqual(await refused.json(), await missing.json());
  const before = x.calls.length;
  for (const bad of ["/organization/P/transfers/%E0%A4%A", "/organization/P/transfers/a%20b", "/organization/%E0%A4%A/transfers"]) assert.equal((await x.call(bad, FIN)).status, 404, bad);
  assert.equal(x.calls.length, before, "bad ids never reach the store");
  assert.equal((await x.call("/organization/P/transfers", FIN, "application/json", "POST")).status, 405);
  assert.equal((await x.call("/organization/P/transfers/t-oct/lines", FIN)).status, 418, "not this route's path");
});

test("COMPANY_TRANSFERS_HTTP without the transfer reads the pages are not found", async (t) => {
  const x = await rig(t, { companyTransfers: undefined, companyTransfer: undefined });
  assert.equal((await x.call("/organization/P/transfers", FIN)).status, 404);
  assert.equal((await x.call("/organization/P/transfers/t-oct", FIN)).status, 404);
});

test("COMPANY_TRANSFERS_ROUTE the invoice list of an organization named transfers stays the invoice list", async (t) => {
  const x = await rig(t, { listForOrganization: async (_, orgId) => ({ orgId, name: orgId, invoices: [] }) });
  const res = await x.call("/organization/invoices/transfers", FIN);
  assert.deepEqual(await res.json(), { orgId: "transfers", name: "transfers", invoices: [] });
  assert.equal((await x.call("/organization/invoices/transfers/t-oct", FIN)).status, 404, "the transfer of an organization named invoices");
  assert.deepEqual(x.calls, ["transfer:fin:invoices:t-oct"]);
});
