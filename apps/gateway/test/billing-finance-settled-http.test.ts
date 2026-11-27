import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { FinanceSettledPage } from "@studenthub/db/billing";
import { createFinanceSettledHttp, handleFinanceSettled, settledFilterOf, type FinanceSettledReads } from "../src/billing/finance-settled-http.js";

// A-20 Finance settled. Synthetic companies and amounts only.
const FIN = "f".repeat(43), OTHER = "o".repeat(43);
const invoice = { transferId: "t-1", currencyCode: "KWD", invoiceDate: "2026-11-22", lineCount: 1, paidOn: null, creditNumber: null, creditedOn: null } as const;
const PAGE: FinanceSettledPage = {
  balances: [{ orgId: "c:1", companyName: "Sultan <Kids>", currencyCode: "KWD", invoiced: "3.750", paid: "2.500", credited: "0.000", outstanding: "1.250" }],
  invoices: [
    { ...invoice, invoiceNumber: "SH-2026-11-000003", orgId: "c:1", companyName: "Sultan <Kids>", total: "1.250", status: "unpaid" },
    { ...invoice, invoiceNumber: "SH-2026-11-000002", orgId: "P", companyName: "Sultan Co", total: "3.000", status: "unpaid", creditNumber: "CN-2026-11-000001", creditedOn: "2026-11-23" },
    { ...invoice, invoiceNumber: "SH-2026-11-000001", orgId: "P", companyName: "Sultan Co", total: "4.000", status: "paid", paidOn: "2026-11-24" }],
  page: 1, more: true };

async function rig(t: TestContext, reads?: Partial<FinanceSettledReads>) {
  const calls: string[] = [];
  const base: FinanceSettledReads = {
    async settled(who, filter) { calls.push(`settled:${who}:${filter.status ?? "*"}:${filter.page}`); return who === "fin" ? { ...PAGE, page: filter.page ?? 1, more: filter.page === 1 } : null; },
  };
  const service = createFinanceSettledHttp({ sessions: { get: async (id: string) => ({ [FIN]: { personId: "fin" }, [OTHER]: { personId: "company-fin" } } as Record<string, { personId: string }>)[id] as never },
    reads: { ...base, ...reads } });
  const server = createServer(async (req, res) => { if (!await handleFinanceSettled(req, res, service)) { res.writeHead(418); res.end(); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "application/json", method = "GET") =>
    fetch(origin + path, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  return { call, calls };
}

test("FINANCE_SETTLED_PAGE Finance sees each company's balance and every invoice with its status, filtered and paged", async (t) => {
  const x = await rig(t);
  assert.deepEqual(await (await x.call("/finance/settled", FIN)).json(), PAGE);
  const page = await x.call("/finance/settled?status=credited", FIN, "text/html");
  assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  for (const text of ['<tr><td><a href="/organization/invoices/c%3A1">Sultan &lt;Kids&gt;</a></td><td>KWD</td><td>3.750</td><td>2.500</td><td>0.000</td><td>1.250</td></tr>',
    "<td>KWD 1.250</td><td>Unpaid</td>", "<td>KWD 3.000</td><td>Credited by credit note CN-2026-11-000001 on 23 November 2026</td>",
    "<td>KWD 4.000</td><td>Paid on 24 November 2026</td>", '<a href="/finance/settled?status=credited" aria-current="page">Credited</a>',
    '<a href="/finance/settled?status=credited&amp;page=2">Older</a>', '<a href="/finance/transfers">Transfers</a>']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<Kids>|Newer/);
  const second = await (await x.call("/finance/settled?page=2&status=unpaid", FIN, "text/html")).text();
  assert.ok(second.includes('<a href="/finance/settled?status=unpaid">Newer</a>'), second);
  assert.deepEqual(x.calls, ["settled:fin:*:1", "settled:fin:credited:1", "settled:fin:unpaid:2"]);
});

test("FINANCE_SETTLED_GATE sign in first; a company's own finance user and a bad filter are the same not found; writes are not allowed", async (t) => {
  const x = await rig(t);
  assert.equal((await x.call("/finance/settled")).status, 401);
  const refused = await x.call("/finance/settled", OTHER), bad = await x.call("/finance/settled?status=void", FIN);
  assert.equal(refused.status, 404); assert.equal(bad.status, 404);
  assert.deepEqual(await refused.json(), await bad.json());
  const before = x.calls.length;
  for (const path of ["/finance/settled?status=Paid", "/finance/settled?page=0", "/finance/settled?page=1&page=2", "/finance/settled?sort=x", "/finance/settled/P"]) {
    assert.equal((await x.call(path, FIN)).status, 404, path);
  }
  assert.equal(x.calls.length, before + 0, "bad input never reaches the reads");
  assert.equal((await x.call("/finance/settled", FIN, "application/json", "POST")).status, 405);
  assert.equal((await x.call("/finance/settledx", FIN)).status, 418, "not this route's path");
});

test("FINANCE_SETTLED_FILTER page and status parse strictly", () => {
  const q = (s: string) => settledFilterOf(new URLSearchParams(s));
  assert.deepEqual(q(""), { page: 1 });
  assert.deepEqual(q("page=3&status=paid"), { page: 3, status: "paid" });
  for (const bad of ["page=01", "page=-1", "status=", "status=void", "page=1&x=1", "status=paid&status=unpaid"]) assert.equal(q(bad), undefined, bad);
});
