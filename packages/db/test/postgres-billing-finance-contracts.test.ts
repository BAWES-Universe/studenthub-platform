import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresFinanceContractReads, operatorFinanceGate } from "@studenthub/db/billing";
import { projectPayContract } from "@studenthub/pay-contracts";
import { TRANSFER_INVOICE_VOID_ROLE, transferInvoiceVoidDecision } from "../../billing/src/transfer-invoice-access.js";
import { DEFAULT_OPERATOR_ORG_IDS } from "../../organizations/src/organizations.js";
import { createFinanceContractsHttp, handleFinanceContracts } from "../../../apps/gateway/src/billing/finance-contracts-http.js";

// A-17 Finance contracts against PostgreSQL, with the production gate and per-company rule. Synthetic data only.
const url = process.env.DATABASE_URL;
let admin: pg.Pool, pool: pg.Pool, schema: string;
const store: Record<string, string> = {};
const decision = (g: Parameters<typeof transferInvoiceVoidDecision>[0], org: string, up: readonly string[]) => transferInvoiceVoidDecision(g, org, up, DEFAULT_OPERATOR_ORG_IDS);
const reads = () => new PostgresFinanceContractReads(pool, operatorFinanceGate(DEFAULT_OPERATOR_ORG_IDS, TRANSFER_INVOICE_VOID_ROLE), decision);
const id = { hourly: randomUUID(), monthly: randomUUID(), fixed: randomUUID(), deleted: randomUUID(), outside: randomUUID() };
/** Every key the company projection may carry: anything else (candidate rate or total, transfer cost, timestamps) must never leave. */
const COMPANY_KEYS = ["autoGenerate", "candidateId", "companyId", "currencyId", "endDate", "id", "startDate", "status", "storeId", "terms"];
const CANDIDATE_ONLY = ["candidateHourlyRate", "candidateTotal", "transferCost", "createdAt", "updatedAt", "1.250", "0.777", "300.000", "90.000"];

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `finance_contracts_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  // root is StudentHub; P and its sub-company C sit under it; X is a company outside it.
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('root','StudentHub',NULL),('P','P legal','root'),('C','C legal','P'),('X','X legal',NULL)");
  await pool.query("INSERT INTO organization_profiles(org_id,name_en) VALUES ('P','Sultan Co'),('C','Sultan Kids')");
  for (const p of ["fin", "cfin", "staff", "worker"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [p]);
  await pool.query("INSERT INTO principals(id,display_name) VALUES ('amal','Amal Synthetic'),('badr','Badr Synthetic')");
  await pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES ('fin','root','finance','subtree'),('cfin','P','finance','subtree'),('staff','root','staff','subtree')");
  for (const org of ["P", "X"]) {
    store[org] = randomUUID();
    await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Synthetic shop',$3,$3)", [store[org], org, "a".repeat(64)]);
  }
  const currency = randomUUID();
  await pool.query("INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at) VALUES($1,'currency','Kuwaiti dinar','kuwaiti dinar','KWD','active',$2,$2,now(),now())", [currency, "a".repeat(64)]);
  const contract = (cid: string, person: string, org: string, storeId: string, model: string, start: string, end: string | null, status: string, terms: (string | number | null)[], auto = false) => pool.query(
    `INSERT INTO pay_contracts(id,candidate_principal_id,company_org_id,store_id,pay_model,start_date,end_date,currency_id,transfer_cost,auto_generate,status,
       candidate_hourly_rate,company_hourly_rate,candidate_total,company_total,completion_percentage,salary_day,created_at,updated_at,deleted_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,0.777,$9,$10,$11,$12,$13,$14,$15,$16,now(),now(),CASE WHEN $10 = 'deleted' THEN now() END)`,
    [cid, person, org, storeId, model, start, end, currency, auto, status, ...terms]);
  await contract(id.hourly, "amal", "P", store.P!, "hourly", "2026-09-01", null, "active", ["1.250", "2.000", null, null, null, null]);
  // C's store id is an imported key with no store row: the page shows the key.
  await contract(id.monthly, "badr", "C", "legacy-store-7", "monthly_salary", "2026-10-01", "2026-10-31", "inactive", [null, null, "300.000", "350.000", null, 25], true);
  await contract(id.fixed, "worker", "P", store.P!, "fixed_price", "2026-11-01", null, "active", [null, null, "90.000", "120.000", 40, null]);
  await contract(id.deleted, "amal", "P", store.P!, "hourly", "2026-12-01", null, "deleted", ["1.250", "2.000", null, null, null, null]);
  await contract(id.outside, "amal", "X", store.X!, "hourly", "2026-12-15", null, "active", ["1.250", "2.000", null, null, null, null]);
});
afterEach(async () => { await pool?.end(); if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); });
after(async () => { await admin?.end(); });

test("FINANCE_CONTRACTS_PG central Finance lists every settled company's contracts, latest start first, company side only, filtered and paged", async () => {
  const page = await reads().list("fin");
  assert.ok(page);
  assert.deepEqual(page.contracts.map((e) => [e.contract.id, e.personName, e.companyName, e.storeName, e.currencyCode]),
    [[id.fixed, "worker", "Sultan Co", "Synthetic shop", "KWD"], [id.monthly, "Badr Synthetic", "Sultan Kids", "legacy-store-7", "KWD"], [id.hourly, "Amal Synthetic", "Sultan Co", "Synthetic shop", "KWD"]],
    "the deleted contract and X outside StudentHub are not listed");
  assert.deepEqual(page.contracts.map((e) => e.contract.terms), [
    { payModel: "fixed_price", companyTotal: "120.000", completionPercentage: 40 },
    { payModel: "monthly_salary", companyTotal: "350.000", salaryDay: 25 },
    { payModel: "hourly", companyHourlyRate: "2.000" }]);
  for (const e of page.contracts) assert.ok(Object.keys(e.contract).every((k) => COMPANY_KEYS.includes(k)), `${String(e.contract.id)} carries only company fields`);
  const text = JSON.stringify(page);
  for (const word of CANDIDATE_ONLY) assert.equal(text.includes(word), false, `${word} never leaves`);
  assert.deepEqual([page.page, page.more], [1, false]);
  assert.deepEqual((await reads().list("fin", { status: "inactive" }))!.contracts.map((e) => e.contract.id), [id.monthly]);
  assert.deepEqual((await reads().list("fin", { status: "active" }))!.contracts.map((e) => e.contract.id), [id.fixed, id.hourly]);
  const first = await reads().list("fin", { page: 1 }, 2), second = await reads().list("fin", { page: 2 }, 2);
  assert.deepEqual([first?.contracts.map((e) => e.contract.id), first?.more, second?.contracts.map((e) => e.contract.id), second?.more],
    [[id.fixed, id.monthly], true, [id.hourly], false]);
});

test("FINANCE_CONTRACTS_PG_DETAIL one contract is the same company projection; deleted, outside, malformed and missing read as null", async () => {
  const one = await reads().contract("fin", id.monthly);
  assert.ok(one);
  assert.deepEqual(Object.keys(one.contract).sort(), COMPANY_KEYS);
  assert.deepEqual({ ...one.contract }, { ...projectPayContract({ id: id.monthly, candidateId: "badr", companyId: "C", storeId: "legacy-store-7", startDate: "2026-10-01",
    endDate: "2026-10-31", currencyId: one.contract.currencyId as string, transferCost: "0.777", autoGenerate: true, status: "inactive",
    terms: { payModel: "monthly_salary", candidateTotal: "300.000", companyTotal: "350.000", salaryDay: 25 }, createdAt: "x", updatedAt: "x" }, "company") });
  for (const other of [id.deleted, id.outside, randomUUID(), "not-a-uuid", id.hourly.toUpperCase()]) assert.equal(await reads().contract("fin", other), null, other);
});

test("FINANCE_CONTRACTS_PG_GATE a company's finance user, StudentHub staff and a worker get null on list and detail; bad filters are refused", async () => {
  for (const who of ["cfin", "staff", "worker", "amal", "nobody", " "]) {
    assert.equal(await reads().list(who), null, who);
    assert.equal(await reads().contract(who, id.hourly), null, who);
  }
  assert.equal(await reads().list("fin", { status: "deleted" as never }), null);
  assert.equal(await reads().list("fin", { page: 0 }), null);
});

test("FINANCE_CONTRACTS_HTTP_PG wired as production: Finance opens the list and each contract; a company's finance user is not found", async (t) => {
  const FIN = "f".repeat(43), CFIN = "c".repeat(43);
  const sessions = { get: async (s: string) => ({ [FIN]: { personId: "fin" }, [CFIN]: { personId: "cfin" } } as Record<string, { personId: string }>)[s] as never };
  const http = createFinanceContractsHttp({ sessions, reads: reads() });
  const server = createServer(async (req, res) => { if (!await handleFinanceContracts(req, res, http)) { res.writeHead(418); res.end(); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, session: string, accept = "text/html") => fetch(base + path, { headers: { cookie: `__Host-studenthub_session=${session}`, accept } });
  const page = await get("/finance/contracts", FIN);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<td>Sultan Kids<\/td><td>legacy-store-7<\/td><td>Monthly salary<\/td><td>KWD 350\.000 a month, on day 25<\/td><td>1 October 2026 to 31 October 2026<\/td><td>Inactive<\/td>/);
  for (const word of CANDIDATE_ONLY) assert.equal(html.includes(word), false, `${word} is not on the page`);
  const links = [...new Set([...html.matchAll(/href="(\/finance\/contracts\/[^"]+)"/g)].map((m) => m[1]!))];
  assert.deepEqual(links.sort(), [id.fixed, id.hourly, id.monthly].map((c) => `/finance/contracts/${c}`).sort());
  for (const link of links) assert.equal((await get(link, FIN)).status, 200, `${link} opens for central Finance`);
  assert.match(await (await get(`/finance/contracts/${id.hourly}`, FIN)).text(), /<th scope="row">Billed to the company<\/th><td>KWD 2\.000 an hour<\/td>/);
  assert.equal((await get(`/finance/contracts/${id.outside}`, FIN)).status, 404);
  assert.equal((await get("/finance/contracts", CFIN, "application/json")).status, 404);
  assert.equal((await get(`/finance/contracts/${id.hourly}`, CFIN, "application/json")).status, 404);
  assert.equal((await get("/finance/contracts?status=active", FIN, "application/json")).status, 200);
});
