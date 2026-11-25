import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresBankResultStore, PostgresTransferInvoiceEffects, type BankResultCompletePort } from "@studenthub/db/billing";
import type { BankCell } from "../../billing/src/bank-results.js";
import { TransferLifecycleService, type TransferAction } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";

// F5 bank result files against PostgreSQL. Synthetic companies, people, amounts and references only.
const url = process.env.DATABASE_URL;
let admin: pg.Pool;
let pool: pg.Pool;
let schema: string;
let storeId: string;
const actor = { principalId: "fin", actingAs: false };
const policy: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
const now = () => new Date("2026-11-25T10:00:00Z");
const effects = () => new PostgresTransferInvoiceEffects();
const lifecycle = () => new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, effects()), now);
const complete: BankResultCompletePort = async (tx, who, id) =>
  (await new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, effects()), now).transitionInTransaction(tx, who, id, "complete")).kind === "changed";
const results = (port: BankResultCompletePort = complete, rules: PayLifecyclePolicy = policy) => new PostgresBankResultStore(pool, rules, effects(), port);
const AUB_HEAD = ["Status", "Status Description", "Debit Narrative", "Credit Narrative"];
const aub = (...rows: BankCell[][]): BankCell[][] => [[], AUB_HEAD, ...rows];
const sha = (cells: unknown) => createHash("sha256").update(JSON.stringify(cells)).digest("hex");

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `bank_results_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  await runMigrations(pool);
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('root','StudentHub',NULL),('P','P legal','root')");
  await pool.query("INSERT INTO organization_profiles(org_id,name_en) VALUES ('P','Parent Trading Co')");
  for (const id of ["fin", "w1", "w2", "w3"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  storeId = randomUUID();
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,'P','Shop P',$2,$2)", [storeId, "a".repeat(64)]);
});
afterEach(async () => {
  await pool?.end();
  if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => { await admin?.end(); });

/** A transfer with lines L-<n>, moved through the real lifecycle. */
async function transfer(lines: readonly { id: string; person: string; amount: string; paid?: boolean }[], ...actions: TransferAction[]): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,'P','2026-10-01','2026-10-31','KWD')", [id]);
  for (const line of lines) {
    await pool.query(`INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation,paid)
      VALUES($1,$2,$3,$4,'KWD',$5,$5,'synthetic','{}',$6)`, [line.id, id, line.person, storeId, line.amount, line.paid ?? false]);
  }
  for (const action of actions) assert.equal((await lifecycle().transition(actor, id, action)).kind, "changed", action);
  return id;
}
const paidLines = async () => (await pool.query("SELECT id FROM pay_transfer_lines WHERE paid ORDER BY id")).rows.map((r) => r.id);
const status = async (id: string) => (await pool.query("SELECT status FROM pay_transfers WHERE id=$1", [id])).rows[0].status;
const rows = async (fileId: string) => (await pool.query("SELECT row_number,kind,reason,line_ids,reference FROM bank_result_rows WHERE file_id=$1 ORDER BY row_number", [fileId]))
  .rows.map((r) => [r.row_number, r.kind, r.reason, r.line_ids, r.reference]);
async function submit(cells: BankCell[][]): Promise<string> {
  const result = await results().submit(actor, { format: "aub", contentSha256: sha(cells), cells });
  assert.equal(result.kind, "submitted");
  return (result as { fileId: string }).fileId;
}

test("BANK_STORE_PAY an AUB file marks each echoed line paid, records its confirmation, and completes the transfer once nothing is unpaid", async () => {
  const t = await transfer([{ id: "L-1", person: "w1", amount: "120.500" }, { id: "L-2", person: "w2", amount: "80.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-2", "x", "L-2"]));
  const applied = await results().apply(actor, fileId);
  assert.equal(applied.kind, "applied");
  assert.deepEqual(applied.kind === "applied" && applied.completedTransferIds, [t]);
  assert.deepEqual(await paidLines(), ["L-1", "L-2"]);
  assert.equal(await status(t), "complete");
  assert.deepEqual(await rows(fileId), [[3, "pay", null, ["L-1"], "REF-1"], [4, "pay", null, ["L-2"], "REF-2"]]);
  assert.deepEqual((await pool.query("SELECT reference,line_id,amount::text,currency_code FROM bank_result_confirmations ORDER BY id")).rows.map(Object.values),
    [["REF-1", "L-1", "120.500", "KWD"], ["REF-2", "L-2", "80.000", "KWD"]]);
  const history = await pool.query("SELECT action,actor_id FROM pay_transfer_lifecycle_history WHERE transfer_id=$1 ORDER BY id", [t]);
  assert.deepEqual(history.rows.map((r) => r.action), ["lock", "payment_received", "complete"]);
  assert.equal(history.rows.at(-1).actor_id, "fin");
  assert.deepEqual((await pool.query("SELECT status,applied_by FROM bank_result_files WHERE id=$1", [fileId])).rows[0], { status: "applied", applied_by: "fin" });
});

test("BANK_STORE_PARTIAL a transfer with a line still unpaid stays distributing; a FAIL is recorded and pays nothing", async () => {
  const t = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }, { id: "L-2", person: "w2", amount: "20.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["FAIL", "Account closed", "x", "L-2"]));
  const applied = await results().apply(actor, fileId);
  assert.deepEqual(applied.kind === "applied" && applied.completedTransferIds, []);
  assert.deepEqual(await paidLines(), ["L-1"]);
  assert.equal(await status(t), "distributing");
  assert.deepEqual(await rows(fileId), [[3, "pay", null, ["L-1"], "REF-1"], [4, "unpay", null, ["L-2"], "Account closed"]]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM bank_result_confirmations")).rows[0].n, 1);
});

test("BANK_STORE_ONCE the same file content is refused as a duplicate, and an applied file cannot be applied again", async () => {
  await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  const cells = aub(["SUCCESS", "REF-1", "x", "L-1"]);
  const fileId = await submit(cells);
  assert.deepEqual(await results().submit(actor, { format: "aub", contentSha256: sha(cells), cells }), { kind: "duplicate_file", fileId });
  assert.equal((await results().apply(actor, fileId)).kind, "applied");
  assert.deepEqual(await results().apply(actor, fileId), { kind: "refused", code: "already_applied" });
  assert.deepEqual(await results().apply(actor, randomUUID()), { kind: "refused", code: "not_found" });
  assert.deepEqual(await results().apply(actor, "-".repeat(36)), { kind: "refused", code: "not_found" });
  await assert.rejects(pool.query("UPDATE bank_result_files SET status='pending'"), /applied once/);
  await assert.rejects(pool.query("DELETE FROM bank_result_rows"), /append-only/);
  await assert.rejects(pool.query("DELETE FROM bank_result_confirmations"), /append-only/);
});

test("BANK_STORE_REPLAY a different file repeating a recorded confirmation is a duplicate; the same reference on another line is held", async () => {
  await transfer([{ id: "L-1", person: "w1", amount: "10.000" }, { id: "L-2", person: "w2", amount: "10.000" }, { id: "L-3", person: "w3", amount: "10.000" }], "lock", "payment_received");
  await results().apply(actor, await submit(aub(["SUCCESS", "REF-1", "x", "L-1"])));
  const second = await submit(aub(["SUCCESS", "REF-1", "again", "L-1"], ["SUCCESS", "REF-1-B", "x", "L-3"]));
  await results().apply(actor, second);
  assert.deepEqual(await rows(second), [[3, "duplicate", null, ["L-1"], "REF-1"], [4, "pay", null, ["L-3"], "REF-1-B"]]);
  const third = await submit(aub(["SUCCESS", "REF-1", "elsewhere", "L-2"]));
  await results().apply(actor, third);
  assert.deepEqual(await rows(third), [[3, "hold", "reference_conflict", ["L-1", "L-2"], "REF-1"]]);
  assert.deepEqual(await paidLines(), ["L-1", "L-3"]);
});

test("BANK_STORE_ELIGIBLE a line on a transfer the company has not paid in, or a deleted one, is unmatched and stays unpaid", async () => {
  const locked = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock");
  await transfer([{ id: "L-2", person: "w2", amount: "10.000" }], "lock", "delete");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-2", "x", "L-2"], ["SUCCESS", "REF-3", "x", "L-404"]));
  await results().apply(actor, fileId);
  assert.deepEqual(await rows(fileId), [[3, "hold", "unmatched", [], "REF-1"], [4, "hold", "unmatched", [], "REF-2"], [5, "hold", "unmatched", [], "REF-3"]]);
  assert.deepEqual(await paidLines(), []);
  assert.equal(await status(locked), "locked");
});

test("BANK_STORE_ATOMIC a refused completion rolls back every paid flag, row and confirmation, and leaves the file pending", async () => {
  const t = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"]));
  await assert.rejects(results(async () => false).apply(actor, fileId), /bank_result_complete_refused/);
  assert.deepEqual(await paidLines(), []);
  assert.equal(await status(t), "distributing");
  assert.deepEqual(await rows(fileId), []);
  assert.equal((await pool.query("SELECT status FROM bank_result_files WHERE id=$1", [fileId])).rows[0].status, "pending");
  assert.equal((await results().apply(actor, fileId)).kind, "applied");
  assert.equal(await status(t), "complete");
});

test("BANK_STORE_REFERENCE_UNIQUE the database refuses a second line under one bank reference, even past the planner", async () => {
  await transfer([{ id: "L-1", person: "w1", amount: "10.000" }, { id: "L-2", person: "w2", amount: "10.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-2", "x", "L-2"]));
  await results().apply(actor, fileId);
  await assert.rejects(pool.query("INSERT INTO bank_result_confirmations(reference,line_id,file_id,row_number,amount,currency_code) VALUES('REF-1','L-2',$1,4,'10.000','KWD')", [fileId]),
    /bank_result_confirmations_reference/);
});

test("BANK_STORE_REFUSED act-as sessions and unreadable files are refused before anything is stored", async () => {
  const cells = aub(["SUCCESS", "REF-1", "x", "L-1"]);
  assert.deepEqual(await results().submit({ principalId: "fin", actingAs: true }, { format: "aub", contentSha256: sha(cells), cells }), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await results().submit(actor, { format: "aub", contentSha256: "nope", cells }), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await results().submit(actor, { format: "aub", contentSha256: sha([]), cells: [[], ["Status"]] }),
    { kind: "refused", code: "missing_headers", missing: ["Status Description", "Credit Narrative"] });
  const fileId = await submit(cells);
  assert.deepEqual(await results().apply({ principalId: "fin", actingAs: true }, fileId), { kind: "refused", code: "forbidden" });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM bank_result_files")).rows[0].n, 1);
});

test("BANK_STORE_AUTHORIZE an actor who may not complete a named transfer settles nothing in the file, and the file stays pending", async () => {
  const mine = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  const other = await transfer([{ id: "L-2", person: "w2", amount: "10.000" }, { id: "L-3", person: "w3", amount: "10.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-2", "x", "L-2"]));
  const asked: string[] = [];
  const onlyMine: PayLifecyclePolicy = { ...policy, authorize: async (_c, who, t, action) => { asked.push(`${who.principalId}:${action}`); return t.id === mine; } };
  assert.deepEqual(await results(complete, onlyMine).apply(actor, fileId), { kind: "refused", code: "forbidden" });
  assert.ok(asked.length > 0 && asked.every((a) => a === "fin:complete"));
  assert.deepEqual(await paidLines(), []);
  assert.deepEqual(await rows(fileId), []);
  assert.equal(await status(other), "distributing");
  assert.equal((await pool.query("SELECT status FROM bank_result_files WHERE id=$1", [fileId])).rows[0].status, "pending");
});
