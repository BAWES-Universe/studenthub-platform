import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresFinanceSettledReads, PostgresTransferInvoiceEffects, PostgresTransferInvoiceReads, PostgresTransferInvoiceVoids, listTransferInvoices, operatorFinanceGate } from "@studenthub/db/billing";
import { TRANSFER_INVOICE_VOID_ROLE, transferInvoiceReadDecision, transferInvoiceVoidDecision } from "../../billing/src/transfer-invoice-access.js";
import { DEFAULT_OPERATOR_ORG_IDS } from "../../organizations/src/organizations.js";
import { TransferLifecycleService, type TransferAction } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";
import { createFinanceSettledHttp, handleFinanceSettled } from "../../../apps/gateway/src/billing/finance-settled-http.js";
import { createInvoicesHttp, handleInvoices } from "../../../apps/gateway/src/billing/invoices-http.js";

// A-20 Finance settled against PostgreSQL, with the production gate and per-company rule. Synthetic data only.
const url = process.env.DATABASE_URL;
let admin: pg.Pool, pool: pg.Pool, schema: string;
const store: Record<string, string> = {};
const decision = (g: Parameters<typeof transferInvoiceVoidDecision>[0], org: string, up: readonly string[]) => transferInvoiceVoidDecision(g, org, up, DEFAULT_OPERATOR_ORG_IDS);
const reads = () => new PostgresFinanceSettledReads(pool, operatorFinanceGate(DEFAULT_OPERATOR_ORG_IDS, TRANSFER_INVOICE_VOID_ROLE), decision);
const policy: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
const move = async (id: string, action: TransferAction) => assert.equal((await new TransferLifecycleService(
  new PostgresTransferLifecycleStore(pool, policy, new PostgresTransferInvoiceEffects()), () => new Date("2026-11-22T10:00:00Z")).transition({ principalId: "fin", actingAs: false }, id, action)).kind, "changed", action);

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `finance_settled_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  // root is StudentHub; P and its sub-company C sit under it; X is a company outside it.
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('root','StudentHub',NULL),('P','P legal','root'),('C','C legal','P'),('X','X legal',NULL)");
  await pool.query("INSERT INTO organization_profiles(org_id,name_en) VALUES ('P','Sultan Co'),('C','Sultan Kids')");
  for (const id of ["fin", "cfin", "staff", "worker"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  await pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES ('fin','root','finance','subtree'),('cfin','P','finance','subtree'),('staff','root','staff','subtree')");
  for (const org of ["P", "C", "X"]) {
    store[org] = randomUUID();
    await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Synthetic shop',$3,$3)", [store[org], org, "a".repeat(64)]);
  }
});
afterEach(async () => { await pool?.end(); if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); });
after(async () => { await admin?.end(); });

async function transfer(company: string, month: string, lines: readonly [org: string, total: string][], ...actions: TransferAction[]): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,$3::date,($3::date + interval '1 month' - interval '1 day')::date,'KWD')`, [id, company, `${month}-01`]);
  for (const [org, total] of lines) {
    await pool.query(`INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation)
      VALUES($1,$2,'worker',$3,'KWD','1.000',$4,'synthetic','{}')`, [randomUUID(), id, store[org], total]);
  }
  for (const action of actions) await move(id, action);
  return id;
}

/** P and C paid in September, P's October invoice credited, C's November invoice unpaid, and X outside StudentHub. */
async function documents() {
  await transfer("P", "2026-09", [["P", "4.000"], ["C", "2.500"]], "lock", "payment_received");
  const october = await transfer("P", "2026-10", [["P", "3.000"]], "lock");
  await transfer("P", "2026-11", [["C", "1.250"]], "lock");
  await transfer("X", "2026-11", [["X", "9.000"]], "lock");
  const voids = new PostgresTransferInvoiceVoids({ pool, decision });
  const credited = (await listTransferInvoices(pool, october)).find((i) => !i.deleted)!.invoiceNumber;
  assert.equal((await voids.credit({ actorId: "fin", invoiceNumber: credited, reason: "Synthetic wrong period" })).kind, "credited");
  return { credited };
}

test("FINANCE_SETTLED_PG central Finance sees each company's balance and every invoice across companies, filtered by status and paged", async () => {
  const { credited } = await documents();
  const page = await reads().settled("fin");
  assert.ok(page);
  assert.deepEqual(page.balances.map((b) => [b.orgId, b.companyName, b.currencyCode, b.invoiced, b.paid, b.credited, b.outstanding]),
    [["P", "Sultan Co", "KWD", "7.000", "4.000", "3.000", "0.000"], ["C", "Sultan Kids", "KWD", "3.750", "2.500", "0.000", "1.250"]].sort((a, b) => a[1]!.localeCompare(b[1]!)),
    "X outside StudentHub has no balance here; a credit note settles like a payment");
  assert.deepEqual(page.invoices.map((i) => [i.orgId, i.total]).sort(), [["C", "1.250"], ["C", "2.500"], ["P", "3.000"], ["P", "4.000"]]);
  assert.deepEqual([page.page, page.more, page.deletedOrgIds], [1, false, []]);
  const of = async (status: "unpaid" | "paid" | "credited") => (await reads().settled("fin", { status }))!.invoices.map((i) => [i.orgId, i.total, i.creditNumber !== null]).sort();
  assert.deepEqual(await of("unpaid"), [["C", "1.250", false]]);
  assert.deepEqual(await of("paid"), [["C", "2.500", false], ["P", "4.000", false]]);
  assert.deepEqual(await of("credited"), [["P", "3.000", true]]);
  assert.equal((await reads().settled("fin", { status: "credited" }))!.invoices[0]!.invoiceNumber, credited);
  const first = await reads().settled("fin", { page: 1 }, 3), second = await reads().settled("fin", { page: 2 }, 3);
  assert.deepEqual([first?.invoices.length, first?.more, second?.invoices.length, second?.more], [3, true, 1, false]);
  assert.deepEqual(new Set([...first!.invoices, ...second!.invoices].map((i) => i.invoiceNumber)).size, 4, "pages do not overlap");
});

test("FINANCE_SETTLED_PG_GATE a company's finance user, StudentHub staff and a worker get null; bad filters are refused", async () => {
  await documents();
  for (const who of ["cfin", "staff", "worker", "nobody", " "]) assert.equal(await reads().settled(who), null, who);
  assert.equal(await reads().settled("fin", { status: "void" as never }), null);
  assert.equal(await reads().settled("fin", { page: 0 }), null);
});

test("FINANCE_SETTLED_HTTP_PG wired as production: a Finance-only session opens the page and each company link opens; a company's finance user is not found", async (t) => {
  await documents();
  const FIN = "f".repeat(43), CFIN = "c".repeat(43);
  const sessions = { get: async (id: string) => ({ [FIN]: { personId: "fin" }, [CFIN]: { personId: "cfin" } } as Record<string, { personId: string }>)[id] as never };
  const settled = createFinanceSettledHttp({ sessions, reads: reads() });
  // The company invoices page as apps/gateway/src/wiring/billing.ts builds it: read rule, plus the void view for central Finance.
  const invoices = createInvoicesHttp({ sessions,
    reads: new PostgresTransferInvoiceReads({ pool, decision: (g, org, up) => transferInvoiceReadDecision(g, org, up, DEFAULT_OPERATOR_ORG_IDS) }),
    voids: { reads: new PostgresTransferInvoiceReads({ pool, decision }), credit: async () => { throw new Error("read only test"); }, origin: "https://studenthub.test.invalid" } });
  const server = createServer(async (req, res) => { if (!await handleFinanceSettled(req, res, settled) && !await handleInvoices(req, res, invoices)) { res.writeHead(418); res.end(); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, session: string, accept = "text/html") => fetch(base + path, { headers: { cookie: `__Host-studenthub_session=${session}`, accept } });
  const page = await get("/finance/settled", FIN);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<tr><td><a href="\/organization\/invoices\/C">Sultan Kids<\/a><\/td><td>KWD<\/td><td>3\.750<\/td><td>2\.500<\/td><td>0\.000<\/td><td>1\.250<\/td><\/tr>/);
  const links = [...new Set([...html.matchAll(/href="(\/organization\/invoices\/[^"]+)"/g)].map((m) => m[1]!))];
  assert.deepEqual(links.sort(), ["/organization/invoices/C", "/organization/invoices/P"]);
  for (const link of links) assert.equal((await get(link, FIN)).status, 200, `${link} opens for central Finance`);
  assert.equal((await get("/finance/settled", CFIN, "application/json")).status, 404);
  assert.equal((await get("/finance/settled?status=credited", FIN, "application/json")).status, 200);
});

test("FINANCE_SETTLED_PG_DELETED a deleted company keeps its balance and invoices, is reported as deleted, and is named without a dead link", async (t) => {
  await documents();
  await pool.query("INSERT INTO organization_deletions(org_id,receipt_ref) VALUES ('C',$1)", ["d".repeat(64)]);
  const page = await reads().settled("fin");
  assert.ok(page);
  assert.deepEqual(page.balances.map((b) => [b.orgId, b.outstanding]).sort(), [["C", "1.250"], ["P", "0.000"]], "what C still owes stays in view");
  assert.equal(page.invoices.filter((i) => i.orgId === "C").length, 2);
  assert.deepEqual(page.deletedOrgIds, ["C"]);
  const FIN = "f".repeat(43);
  const settled = createFinanceSettledHttp({ sessions: { get: async (id: string) => (id === FIN ? { personId: "fin" } : undefined) as never }, reads: reads() });
  const server = createServer(async (req, res) => { if (!await handleFinanceSettled(req, res, settled)) { res.writeHead(418); res.end(); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/finance/settled`, { headers: { cookie: `__Host-studenthub_session=${FIN}`, accept: "text/html" } })).text();
  assert.match(html, /<tr><td>Sultan Kids \(deleted company\)<\/td><td>KWD<\/td><td>3\.750<\/td><td>2\.500<\/td><td>0\.000<\/td><td>1\.250<\/td><\/tr>/);
  assert.deepEqual([...new Set([...html.matchAll(/href="(\/organization\/invoices\/[^"]+)"/g)].map((m) => m[1]!))], ["/organization/invoices/P"], "only the live company links");
});
