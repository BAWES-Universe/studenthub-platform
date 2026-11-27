import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { CompanyTransferEntry, FinanceTransferDetail } from "@studenthub/db/billing";
import { createFinanceTransfersHttp, filterOf, handleFinanceTransfers, type FinanceTransferReads } from "../src/billing/finance-transfers-http.js";

// A-18 Finance transfers. Synthetic companies, people and amounts only.
const FIN = "f".repeat(43), OTHER = "o".repeat(43);
const OCT: CompanyTransferEntry = { transferId: "t:oct.1", orgId: "P", companyName: "Sultan <Co>", periodStart: "2026-10-01", periodEnd: "2026-10-31",
  currencyCode: "KWD", status: "distributing", lineCount: 2, personCount: 2, companyTotal: "30.000", paymentReceivedOn: "2026-11-22" };
const NOV: CompanyTransferEntry = { ...OCT, transferId: "t-nov", periodStart: "2026-11-01", periodEnd: "2026-11-30", status: "locked", personCount: 1, paymentReceivedOn: null };
const DETAIL: FinanceTransferDetail = { ...OCT, candidateTotal: "25.000", paidTotal: "10.000", paidCount: 1, lines: [
  { lineId: "L-1", personId: "w1", personName: "Amal <Synthetic>", storeName: "Avenues", candidateTotal: "10.000", companyTotal: "12.000", paid: true },
  { lineId: "L-2", personId: "w2", personName: "Badr", storeName: "Avenues", candidateTotal: "15.000", companyTotal: "18.000", paid: false }] };

async function rig(t: TestContext, reads?: Partial<FinanceTransferReads>) {
  const calls: string[] = [];
  const base: FinanceTransferReads = {
    async list(who, filter) { calls.push(`list:${who}:${filter.status ?? "*"}:${filter.page}`); return who === "fin" ? { transfers: filter.page === 1 ? [NOV, OCT] : [], page: filter.page ?? 1, more: filter.page === 1 } : null; },
    async transfer(who, id) { calls.push(`transfer:${who}:${id}`); return who === "fin" && id === "t:oct.1" ? DETAIL : null; },
  };
  const service = createFinanceTransfersHttp({ sessions: { get: async (id: string) => ({ [FIN]: { personId: "fin" }, [OTHER]: { personId: "company-fin" } } as Record<string, { personId: string }>)[id] as never },
    reads: { ...base, ...reads } });
  const server = createServer(async (req, res) => { if (!await handleFinanceTransfers(req, res, service)) { res.writeHead(418); res.end(); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "application/json", method = "GET") =>
    fetch(origin + path, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  return { call, calls };
}

test("FINANCE_TRANSFERS_LIST Finance lists every company's transfers, newest period first, paged and filtered by status, each linking to its detail", async (t) => {
  const x = await rig(t);
  assert.deepEqual(await (await x.call("/finance/transfers", FIN)).json(), { transfers: [NOV, OCT], page: 1, more: true });
  const page = await x.call("/finance/transfers?status=distributing", FIN, "text/html");
  assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  for (const text of ['<a href="/finance/transfers/t%3Aoct.1">1 October 2026 to 31 October 2026</a>', "<td>Sultan &lt;Co&gt;</td><td>2</td><td>KWD 30.000</td>", "<td>Sultan &lt;Co&gt;</td><td>1</td><td>KWD 30.000</td>",
    "Received, paying salaries (payment received 22 November 2026)", '<a href="/finance/transfers?status=distributing" aria-current="page">Received, paying salaries</a>',
    '<a href="/finance/transfers?status=distributing&amp;page=2">Older</a>']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<Co>|Newer/);
  const second = await (await x.call("/finance/transfers?page=2&status=locked", FIN, "text/html")).text();
  assert.ok(second.includes('<a href="/finance/transfers?status=locked">Newer</a>'), second);
  assert.deepEqual(x.calls, ["list:fin:*:1", "list:fin:distributing:1", "list:fin:locked:2"]);
});

test("FINANCE_TRANSFERS_DETAIL a transfer shows each person's salary, the company's amount and whether it is paid, and links its bank payments", async (t) => {
  const x = await rig(t);
  assert.deepEqual(await (await x.call("/finance/transfers/t%3Aoct.1", FIN)).json(), DETAIL);
  const html = await (await x.call("/finance/transfers/t%3Aoct.1", FIN, "text/html")).text();
  for (const text of ['<tr id="line-L-1"><td>Amal &lt;Synthetic&gt;</td><td>Avenues</td><td>KWD 10.000</td><td>KWD 12.000</td><td>Paid</td></tr>',
    '<tr id="line-L-2"><td>Badr</td><td>Avenues</td><td>KWD 15.000</td><td>KWD 18.000</td><td>Not paid yet</td></tr>',
    "Billed to the company: KWD 30.000. Salaries for 2 people: KWD 25.000. Paid so far: KWD 10.000, 1 of 2 lines.",
    '<a href="/finance/bank-results/transfers/t%3Aoct.1">Bank payments for this transfer</a>']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<Synthetic>|Paid to people/);
});

test("FINANCE_TRANSFERS_GATE sign in first; a company's own finance user, a missing transfer and a bad id or filter are the same not found; writes are not allowed", async (t) => {
  const x = await rig(t);
  assert.equal((await x.call("/finance/transfers")).status, 401);
  assert.equal((await x.call("/finance/transfers/t%3Aoct.1")).status, 401);
  const refused = await x.call("/finance/transfers/t%3Aoct.1", OTHER), missing = await x.call("/finance/transfers/t-none", FIN);
  assert.equal(refused.status, 404); assert.equal(missing.status, 404);
  assert.deepEqual(await refused.json(), await missing.json());
  assert.equal((await x.call("/finance/transfers", OTHER)).status, 404);
  const before = x.calls.length;
  for (const bad of ["/finance/transfers?status=paid", "/finance/transfers?page=0", "/finance/transfers?page=1&page=2", "/finance/transfers?sort=x",
    "/finance/transfers/%E0%A4%A", "/finance/transfers/a%20b", "/finance/transfers/t-oct/lines"]) assert.equal((await x.call(bad, FIN)).status, 404, bad);
  assert.equal(x.calls.length, before, "bad input never reaches the reads");
  assert.equal((await x.call("/finance/transfers", FIN, "application/json", "POST")).status, 405);
  assert.equal((await x.call("/finance/transferss", FIN)).status, 418, "not this route's path");
});

test("FINANCE_TRANSFERS_FILTER page and status parse strictly", () => {
  const q = (s: string) => filterOf(new URLSearchParams(s));
  assert.deepEqual(q(""), { page: 1 });
  assert.deepEqual(q("page=3&status=complete"), { page: 3, status: "complete" });
  for (const bad of ["page=01", "page=-1", "page=1.5", "status=", "status=Complete", "page=1&x=1", "status=draft&status=locked"]) assert.equal(q(bad), undefined, bad);
});
