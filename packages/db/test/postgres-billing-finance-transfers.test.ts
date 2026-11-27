import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresFinanceTransferReads, operatorFinanceGate } from "@studenthub/db/billing";
import { TRANSFER_INVOICE_VOID_ROLE, transferInvoiceVoidDecision } from "../../billing/src/transfer-invoice-access.js";
import { DEFAULT_OPERATOR_ORG_IDS } from "../../organizations/src/organizations.js";
import { PostgresTransferInvoiceEffects } from "@studenthub/db/billing";
import { TransferLifecycleService } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";
import { createFinanceTransfersHttp, handleFinanceTransfers } from "../../../apps/gateway/src/billing/finance-transfers-http.js";

// A-18 Finance transfers against PostgreSQL, with the production gate and per-company rule. Synthetic data only.
const url = process.env.DATABASE_URL;
let admin: pg.Pool, pool: pg.Pool, schema: string, store: string;
const decision = (g: Parameters<typeof transferInvoiceVoidDecision>[0], org: string, up: readonly string[]) => transferInvoiceVoidDecision(g, org, up, DEFAULT_OPERATOR_ORG_IDS);
const reads = () => new PostgresFinanceTransferReads(pool, operatorFinanceGate(DEFAULT_OPERATOR_ORG_IDS, TRANSFER_INVOICE_VOID_ROLE), decision);

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `finance_transfers_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  // root is StudentHub; P and its sub-company C sit under it; X is a company outside it.
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('root','StudentHub',NULL),('P','P legal','root'),('C','C legal','P'),('X','X legal',NULL)");
  await pool.query("INSERT INTO organization_profiles(org_id,name_en) VALUES ('P','Sultan Co'),('C','Sultan Kids')");
  for (const id of ["fin", "cfin", "staff", "w1", "w2"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  await pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES ('fin','root','finance','subtree'),('cfin','P','finance','subtree'),('staff','root','staff','subtree')");
  store = randomUUID();
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,'P','Avenues',$2,$2)", [store, "a".repeat(64)]);
});
afterEach(async () => { await pool?.end(); if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`); });
after(async () => { await admin?.end(); });

const allow: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
async function transfer(id: string, company: string, period: string, lines: readonly [string, string, string, string, boolean][], ...actions: ("lock" | "delete")[]) {
  await pool.query(`INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,$3::date,($3::date + interval '1 month' - interval '1 day')::date,'KWD')`, [id, company, period]);
  for (const [line, person, candidate, billed, paid] of lines) {
    await pool.query("INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation,paid) VALUES($1,$2,$3,$4,'KWD',$5,$6,'synthetic','{}',$7)",
      [line, id, person, store, candidate, billed, paid]);
  }
  const lifecycle = new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, allow, new PostgresTransferInvoiceEffects()), () => new Date());
  for (const action of actions) assert.equal((await lifecycle.transition({ principalId: "fin", actingAs: false }, id, action)).kind, "changed", action);
}

test("FINANCE_TRANSFERS_PG central Finance lists every company's transfers it settles, newest period first, with counts and totals; a status filter and pages", async () => {
  await transfer("T-sep", "P", "2026-09-01", [["L-1", "w1", "10.000", "12.000", true]]);
  await transfer("T-oct", "C", "2026-10-01", [["L-2", "w1", "10.000", "12.500", false], ["L-3", "w2", "5.000", "6.000", false]]);
  await transfer("T-x", "X", "2026-11-01", [["L-4", "w2", "1.000", "1.000", false]]);
  await transfer("T-gone", "P", "2026-11-01", [["L-5", "w2", "1.000", "1.000", false]], "lock", "delete");
  const page = await reads().list("fin");
  assert.deepEqual(page && [page.transfers.map((t) => [t.transferId, t.companyName, t.lineCount, t.companyTotal, t.status]), page.page, page.more],
    [[["T-oct", "Sultan Kids", 2, "18.500", "draft"], ["T-sep", "Sultan Co", 1, "12.000", "draft"]], 1, false], "a company outside StudentHub and a deleted transfer are not listed");
  assert.deepEqual((await reads().list("fin", { status: "locked" }))?.transfers, []);
  const small = new PostgresFinanceTransferReads(pool, operatorFinanceGate(DEFAULT_OPERATOR_ORG_IDS, TRANSFER_INVOICE_VOID_ROLE), decision);
  const first = await small.list("fin", { page: 1 }, 1), second = await small.list("fin", { page: 2 }, 1);
  assert.deepEqual([first?.transfers.map((t) => t.transferId), first?.more, second?.transfers.map((t) => t.transferId), second?.more], [["T-oct"], true, ["T-sep"], false]);
});

test("FINANCE_TRANSFERS_PG_DETAIL a transfer's lines with both amounts and the paid flag; refused readers and unknown transfers are the same null", async () => {
  await transfer("T-oct", "P", "2026-10-01", [["L-2", "w2", "15.000", "18.000", false], ["L-1", "w1", "10.000", "12.000", true]]);
  await transfer("T-x", "X", "2026-10-01", [["L-9", "w2", "1.000", "1.000", false]]);
  const t = await reads().transfer("fin", "T-oct");
  assert.deepEqual(t && [t.companyTotal, t.candidateTotal, t.lines.map((l) => [l.lineId, l.personId, l.storeName, l.candidateTotal, l.companyTotal, l.paid])],
    ["30.000", "25.000", [["L-1", "w1", "Avenues", "10.000", "12.000", true], ["L-2", "w2", "Avenues", "15.000", "18.000", false]]]);
  for (const [who, id] of [["cfin", "T-oct"], ["staff", "T-oct"], ["w1", "T-oct"], ["fin", "T-x"], ["fin", "T-none"], ["fin", "bad id"]] as const) {
    assert.equal(await reads().transfer(who, id), null, `${who} ${id}`);
  }
  for (const who of ["cfin", "staff", "w1"]) assert.equal(await reads().list(who), null, who);
});

test("FINANCE_TRANSFERS_HTTP_PG wired as production: a Finance-only session lists and opens a transfer; a company's finance user and an unknown transfer read the same", async (t) => {
  await transfer("T-oct", "P", "2026-10-01", [["L-1", "w1", "10.000", "12.000", true]]);
  const FIN = "f".repeat(43), CFIN = "c".repeat(43);
  const service = createFinanceTransfersHttp({ sessions: { get: async (id: string) => ({ [FIN]: { personId: "fin" }, [CFIN]: { personId: "cfin" } } as Record<string, { personId: string }>)[id] as never }, reads: reads() });
  const server = createServer(async (req, res) => { if (!await handleFinanceTransfers(req, res, service)) { res.writeHead(418); res.end(); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, session: string, accept = "text/html") => fetch(base + path, { headers: { cookie: `__Host-studenthub_session=${session}`, accept } });
  const list = await get("/finance/transfers", FIN);
  assert.equal(list.status, 200);
  const link = /<a href="(\/finance\/transfers\/[^"]+)">1 October 2026 to 31 October 2026<\/a>/.exec(await list.text());
  assert.ok(link, "the list links the transfer");
  const detail = await get(link[1]!, FIN);
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /<tr id="line-L-1"><td>w1<\/td><td>Avenues<\/td><td>KWD 10\.000<\/td><td>KWD 12\.000<\/td><td>Paid<\/td><\/tr>/);
  const refused = await get("/finance/transfers/T-oct", CFIN, "application/json"), unknown = await get("/finance/transfers/T-none", FIN, "application/json");
  assert.equal(refused.status, 404); assert.equal(unknown.status, 404);
  assert.deepEqual(await refused.json(), await unknown.json());
  assert.equal((await get("/finance/transfers", CFIN)).status, 404);
});
