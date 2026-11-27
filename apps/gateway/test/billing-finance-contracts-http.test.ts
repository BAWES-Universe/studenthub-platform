import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { FinanceContractEntry, FinanceContractPage } from "@studenthub/db/billing";
import { contractFilterOf, createFinanceContractsHttp, handleFinanceContracts, type FinanceContractReads } from "../src/billing/finance-contracts-http.js";

// A-17 Finance contracts. Synthetic people, companies and amounts only.
const FIN = "f".repeat(43), OTHER = "o".repeat(43);
const ID = { hourly: "11111111-1111-4111-8111-111111111111", fixed: "22222222-2222-4222-8222-222222222222", monthly: "33333333-3333-4333-8333-333333333333" };
const base = { candidateId: "amal", companyId: "P", storeId: "s-1", currencyId: "cur-1", autoGenerate: false } as const;
const ENTRIES: FinanceContractEntry[] = [
  { personName: "Amal <Synthetic>", companyName: "Sultan Co", storeName: "Avenues", currencyCode: "KWD",
    contract: { ...base, id: ID.fixed, startDate: "2026-11-01", status: "active", terms: { payModel: "fixed_price", companyTotal: "120.000", completionPercentage: 40 } } },
  { personName: "Badr", companyName: "Sultan Kids", storeName: "legacy-store-7", currencyCode: "KWD",
    contract: { ...base, id: ID.monthly, startDate: "2026-10-01", endDate: "2026-10-31", status: "inactive", autoGenerate: true, terms: { payModel: "monthly_salary", companyTotal: "350.000", salaryDay: 25 } } },
  { personName: "Amal <Synthetic>", companyName: "Sultan Co", storeName: "Avenues", currencyCode: "KWD",
    contract: { ...base, id: ID.hourly, startDate: "2026-09-01", status: "active", terms: { payModel: "hourly", companyHourlyRate: "2.000" } } },
];
const PAGE: FinanceContractPage = { contracts: ENTRIES, page: 1, more: true };

async function rig(t: TestContext, reads?: Partial<FinanceContractReads>) {
  const calls: string[] = [];
  const stub: FinanceContractReads = {
    async list(who, filter) { calls.push(`list:${who}:${filter.status ?? "*"}:${filter.page}`); return who === "fin" ? { ...PAGE, page: filter.page ?? 1, more: filter.page === 1 } : null; },
    async contract(who, id) { calls.push(`contract:${who}:${id}`); return who === "fin" ? ENTRIES.find((e) => e.contract.id === id) ?? null : null; },
  };
  const service = createFinanceContractsHttp({ sessions: { get: async (id: string) => ({ [FIN]: { personId: "fin" }, [OTHER]: { personId: "company-fin" } } as Record<string, { personId: string }>)[id] as never },
    reads: { ...stub, ...reads } });
  const server = createServer(async (req, res) => { if (!await handleFinanceContracts(req, res, service)) { res.writeHead(418); res.end(); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "application/json", method = "GET") =>
    fetch(origin + path, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  return { call, calls };
}

test("FINANCE_CONTRACTS_PAGE Finance sees every company's contracts with what the company is billed, filtered and paged", async (t) => {
  const x = await rig(t);
  assert.deepEqual(await (await x.call("/finance/contracts", FIN)).json(), PAGE);
  const page = await x.call("/finance/contracts?status=active", FIN, "text/html");
  assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  for (const text of [`<tr><td><a href="/finance/contracts/${ID.fixed}">Amal &lt;Synthetic&gt;</a></td><td>Sultan Co</td><td>Avenues</td><td>Fixed price</td><td>KWD 120.000 in total, 40% complete</td><td>From 1 November 2026</td><td>Active</td></tr>`,
    "<td>Monthly salary</td><td>KWD 350.000 a month, on day 25</td><td>1 October 2026 to 31 October 2026</td><td>Inactive</td>",
    "<td>Hourly</td><td>KWD 2.000 an hour</td>", '<a href="/finance/contracts?status=active" aria-current="page">Active</a>',
    '<a href="/finance/contracts?status=active&amp;page=2">Older</a>', '<a href="/finance/settled">Settled</a>']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<Synthetic>|Newer/);
  const second = await (await x.call("/finance/contracts?page=2&status=inactive", FIN, "text/html")).text();
  assert.ok(second.includes('<a href="/finance/contracts?status=inactive">Newer</a>'), second);
  const detail = await (await x.call(`/finance/contracts/${ID.monthly}`, FIN, "text/html")).text();
  for (const text of ['<th scope="row">Person</th><td>Badr</td>', '<th scope="row">Store</th><td>legacy-store-7</td>',
    '<th scope="row">Billed to the company</th><td>KWD 350.000 a month, on day 25</td>', '<th scope="row">Monthly payout generated automatically</th><td>Yes</td>',
    '<a href="/finance/contracts">All contracts</a>']) assert.ok(detail.includes(text), text);
  assert.doesNotMatch(await (await x.call(`/finance/contracts/${ID.hourly}`, FIN, "text/html")).text(), /generated automatically/);
  assert.deepEqual(await (await x.call(`/finance/contracts/${ID.hourly}`, FIN)).json(), ENTRIES[2]);
  assert.deepEqual(x.calls, ["list:fin:*:1", "list:fin:active:1", "list:fin:inactive:2", `contract:fin:${ID.monthly}`, `contract:fin:${ID.hourly}`, `contract:fin:${ID.hourly}`]);
});

test("FINANCE_CONTRACTS_GATE sign in first; a company's own finance user, a missing contract and a bad filter are the same not found; writes are not allowed", async (t) => {
  const x = await rig(t);
  assert.equal((await x.call("/finance/contracts")).status, 401);
  assert.equal((await x.call(`/finance/contracts/${ID.hourly}`)).status, 401);
  const refused = await x.call("/finance/contracts", OTHER), bad = await x.call("/finance/contracts?status=deleted", FIN);
  const refusedOne = await x.call(`/finance/contracts/${ID.hourly}`, OTHER), missing = await x.call("/finance/contracts/44444444-4444-4444-8444-444444444444", FIN);
  for (const r of [refused, bad, refusedOne, missing]) assert.equal(r.status, 404);
  const bodies = await Promise.all([refused, bad, refusedOne, missing].map((r) => r.json()));
  for (const body of bodies) assert.deepEqual(body, { error: "not_found" });
  const before = x.calls.length;
  for (const path of ["/finance/contracts?status=Active", "/finance/contracts?page=0", "/finance/contracts?page=1&page=2", "/finance/contracts?sort=x",
    "/finance/contracts/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "/finance/contracts/not-a-uuid", `/finance/contracts/${ID.hourly}/edit`, `/finance/contracts/${ID.hourly}?x=1`]) {
    assert.equal((await x.call(path, FIN)).status, 404, path);
  }
  assert.equal(x.calls.length, before, "bad input never reaches the reads");
  assert.equal((await x.call("/finance/contracts", FIN, "application/json", "POST")).status, 405);
  assert.equal((await x.call(`/finance/contracts/${ID.hourly}`, FIN, "application/json", "PUT")).status, 405);
  assert.equal((await x.call("/finance/contractsx", FIN)).status, 418, "not this route's path");
});

test("FINANCE_CONTRACTS_FILTER page and status parse strictly", () => {
  const q = (s: string) => contractFilterOf(new URLSearchParams(s));
  assert.deepEqual(q(""), { page: 1 });
  assert.deepEqual(q("page=3&status=inactive"), { page: 3, status: "inactive" });
  for (const bad of ["page=01", "page=-1", "status=", "status=deleted", "page=1&x=1", "status=active&status=inactive"]) assert.equal(q(bad), undefined, bad);
});
