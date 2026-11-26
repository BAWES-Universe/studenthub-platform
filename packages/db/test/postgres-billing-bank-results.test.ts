import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresBankResultStore, PostgresTransferInvoiceEffects, bankResultLifecyclePolicy, operatorFinanceGate, type BankResultCompletePort, type BankResultFileGate } from "@studenthub/db/billing";
import { TRANSFER_INVOICE_VOID_ROLE, transferInvoiceVoidDecision } from "../../billing/src/transfer-invoice-access.js";
import { DEFAULT_OPERATOR_ORG_IDS } from "../../organizations/src/organizations.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createBankResultsHttp, handleBankResults } from "../../../apps/gateway/src/billing/bank-results-http.js";
import { AUB_RESULT_COLUMNS, type BankCell } from "../../billing/src/bank-results.js";
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
const financeGate: BankResultFileGate = async (_client, who) => who === "fin" || who === "fin2";
const results = (port: BankResultCompletePort = complete, rules: PayLifecyclePolicy = policy, gate: BankResultFileGate = financeGate) => new PostgresBankResultStore(pool, rules, effects(), port, gate);
const AUB_FIRST = ["Status", "Status Description", "Debit Narrative", "Credit Narrative"];
const AUB_HEAD = [...AUB_FIRST, ...AUB_RESULT_COLUMNS.filter((c) => !AUB_FIRST.includes(c))];
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
/** Preview, then apply exactly the reviewed outcome (as the finance page does). */
async function approve(store: PostgresBankResultStore, who: { principalId: string; actingAs: boolean }, fileId: string) {
  const review = await store.preview(who, fileId);
  return store.apply(who, fileId, review.kind === "review" ? review.reviewId : "0".repeat(64));
}
async function submit(cells: BankCell[][]): Promise<string> {
  const result = await results().submit(actor, { format: "aub", contentSha256: sha(cells), cells });
  assert.equal(result.kind, "submitted");
  return (result as { fileId: string }).fileId;
}

test("BANK_STORE_PAY an AUB file marks each echoed line paid, records its confirmation, and completes the transfer once nothing is unpaid", async () => {
  const t = await transfer([{ id: "L-1", person: "w1", amount: "120.500" }, { id: "L-2", person: "w2", amount: "80.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-2", "x", "L-2"]));
  const applied = await approve(results(), actor, fileId);
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
  const applied = await approve(results(), actor, fileId);
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
  assert.equal((await approve(results(), actor, fileId)).kind, "applied");
  assert.deepEqual(await approve(results(), actor, fileId), { kind: "refused", code: "already_applied" });
  assert.deepEqual(await approve(results(), actor, randomUUID()), { kind: "refused", code: "not_found" });
  assert.deepEqual(await approve(results(), actor, "-".repeat(36)), { kind: "refused", code: "not_found" });
  await assert.rejects(pool.query("UPDATE bank_result_files SET status='pending'"), /applied once/);
  await assert.rejects(pool.query("DELETE FROM bank_result_rows"), /append-only/);
  await assert.rejects(pool.query("DELETE FROM bank_result_confirmations"), /append-only/);
});

test("BANK_STORE_REPLAY a different file repeating a recorded confirmation is a duplicate; the same reference on another line is held", async () => {
  await transfer([{ id: "L-1", person: "w1", amount: "10.000" }, { id: "L-2", person: "w2", amount: "10.000" }, { id: "L-3", person: "w3", amount: "10.000" }], "lock", "payment_received");
  await approve(results(), actor, await submit(aub(["SUCCESS", "REF-1", "x", "L-1"])));
  const second = await submit(aub(["SUCCESS", "REF-1", "again", "L-1"], ["SUCCESS", "REF-1-B", "x", "L-3"]));
  await approve(results(), actor, second);
  assert.deepEqual(await rows(second), [[3, "duplicate", null, ["L-1"], "REF-1"], [4, "pay", null, ["L-3"], "REF-1-B"]]);
  const third = await submit(aub(["SUCCESS", "REF-1", "elsewhere", "L-2"]));
  await approve(results(), actor, third);
  assert.deepEqual(await rows(third), [[3, "hold", "reference_conflict", ["L-1", "L-2"], "REF-1"]]);
  assert.deepEqual(await paidLines(), ["L-1", "L-3"]);
});

test("BANK_STORE_ELIGIBLE a line on a transfer the company has not paid in, or a deleted one, is unmatched and stays unpaid", async () => {
  const locked = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock");
  await transfer([{ id: "L-2", person: "w2", amount: "10.000" }], "lock", "delete");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-2", "x", "L-2"], ["SUCCESS", "REF-3", "x", "L-404"]));
  await approve(results(), actor, fileId);
  assert.deepEqual(await rows(fileId), [[3, "hold", "unmatched", [], "REF-1"], [4, "hold", "unmatched", [], "REF-2"], [5, "hold", "unmatched", [], "REF-3"]]);
  assert.deepEqual(await paidLines(), []);
  assert.equal(await status(locked), "locked");
});

test("BANK_STORE_ATOMIC a refused completion rolls back every paid flag, row and confirmation, and leaves the file pending", async () => {
  const t = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"]));
  await assert.rejects(approve(results(async () => false), actor, fileId), /bank_result_complete_refused/);
  assert.deepEqual(await paidLines(), []);
  assert.equal(await status(t), "distributing");
  assert.deepEqual(await rows(fileId), []);
  assert.equal((await pool.query("SELECT status FROM bank_result_files WHERE id=$1", [fileId])).rows[0].status, "pending");
  assert.equal((await approve(results(), actor, fileId)).kind, "applied");
  assert.equal(await status(t), "complete");
});

test("BANK_STORE_REFERENCE_UNIQUE the database refuses a second line under one bank reference, even past the planner", async () => {
  await transfer([{ id: "L-1", person: "w1", amount: "10.000" }, { id: "L-2", person: "w2", amount: "10.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-2", "x", "L-2"]));
  await approve(results(), actor, fileId);
  await assert.rejects(pool.query("INSERT INTO bank_result_confirmations(reference,line_id,file_id,row_number,amount,currency_code) VALUES('REF-1','L-2',$1,4,'10.000','KWD')", [fileId]),
    /bank_result_confirmations_reference/);
});

test("BANK_STORE_REFUSED act-as sessions and unreadable files are refused before anything is stored", async () => {
  const cells = aub(["SUCCESS", "REF-1", "x", "L-1"]);
  assert.deepEqual(await results().submit({ principalId: "fin", actingAs: true }, { format: "aub", contentSha256: sha(cells), cells }), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await results().submit(actor, { format: "aub", contentSha256: "nope", cells }), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await results().submit(actor, { format: "aub", contentSha256: sha([]), cells: [[], ["Status"]] }),
    { kind: "refused", code: "missing_headers", missing: AUB_RESULT_COLUMNS.filter((c) => c !== "Status") });
  const fileId = await submit(cells);
  assert.deepEqual(await approve(results(), { principalId: "fin", actingAs: true }, fileId), { kind: "refused", code: "forbidden" });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM bank_result_files")).rows[0].n, 1);
});

test("BANK_STORE_AUTHORIZE an actor who may not complete a named transfer settles nothing in the file, and the file stays pending", async () => {
  const mine = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  const other = await transfer([{ id: "L-2", person: "w2", amount: "10.000" }, { id: "L-3", person: "w3", amount: "10.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-2", "x", "L-2"]));
  const asked: string[] = [];
  const onlyMine: PayLifecyclePolicy = { ...policy, authorize: async (_c, who, t, action) => { asked.push(`${who.principalId}:${action}`); return t.id === mine; } };
  assert.deepEqual(await approve(results(complete, onlyMine), actor, fileId), { kind: "refused", code: "forbidden" });
  assert.ok(asked.length > 0 && asked.every((a) => a === "fin:complete"));
  assert.deepEqual(await paidLines(), []);
  assert.deepEqual(await rows(fileId), []);
  assert.equal(await status(other), "distributing");
  assert.equal((await pool.query("SELECT status FROM bank_result_files WHERE id=$1", [fileId])).rows[0].status, "pending");
});

test("BANK_STORE_PREVIEW a preview shows what apply would do and writes nothing; the file page then lists every recorded decision", async () => {
  const t = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["BAD", "x", "x", "L-9"]));
  const preview = await results().preview(actor, fileId);
  assert.equal(preview.kind, "review");
  assert.deepEqual(preview.kind === "review" && [preview.decisions.map((d) => d.kind), preview.completedTransferIds], [["pay", "hold"], [t]]);
  assert.deepEqual(await paidLines(), []);
  assert.equal(await status(t), "distributing");
  const pending = await results().file(actor, fileId);
  assert.deepEqual(pending && [pending.status, pending.rowCount, pending.decisions, pending.uploadedBy, pending.appliedAt], ["pending", 2, [], "fin", null]);
  await approve(results(), actor, fileId);
  const applied = await results().file(actor, fileId);
  assert.deepEqual(applied && [applied.status, applied.appliedBy, applied.decisions], ["applied", "fin", [
    { rowNumber: 3, kind: "pay", reason: null, lineIds: ["L-1"], reference: "REF-1" },
    { rowNumber: 4, kind: "hold", reason: "rejected_row", lineIds: [], reference: null }]]);
  assert.deepEqual((await results().files(actor))!.map((f) => [f.fileId, f.status]), [[fileId, "applied"]]);
  assert.equal(await results().file(actor, randomUUID()), null);
  assert.equal(await results().file(actor, "nope"), null);
  const outsider = { principalId: "w1", actingAs: false };
  assert.deepEqual([await results().files(outsider), await results().file(outsider, fileId)], [null, null], "the read side needs finance file permission too");
  assert.equal((await results().preview(outsider, fileId)).kind, "refused");
});

test("BANK_STORE_REVIEW_BOUND apply commits only the reviewed outcome; if it changed, nothing is written and the fresh review comes back", async () => {
  await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  const t2 = await transfer([{ id: "L-2", person: "w2", amount: "10.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-2", "x", "L-2"]));
  const reviewed = await results().preview(actor, fileId);
  assert.equal(reviewed.kind, "review");
  if (reviewed.kind !== "review") return;
  assert.deepEqual((await results().preview(actor, fileId)) , reviewed, "the same state reviews the same way");
  // Between review and apply, another file settles L-2: applying now would do something else.
  await approve(results(), actor, await submit(aub(["SUCCESS", "REF-9", "y", "L-2"])));
  const stale = await results().apply(actor, fileId, reviewed.reviewId);
  assert.equal(stale.kind, "changed");
  assert.notEqual(stale.kind === "changed" && stale.reviewId, reviewed.reviewId);
  assert.deepEqual(stale.kind === "changed" && stale.decisions.map((d) => [d.kind, d.kind === "hold" ? d.reason : d.lineId]), [["pay", "L-1"], ["hold", "already_paid"]]);
  assert.deepEqual(await paidLines(), ["L-2"], "nothing from the stale apply was written");
  assert.deepEqual(await rows(fileId), []);
  assert.equal((await pool.query("SELECT status FROM bank_result_files WHERE id=$1", [fileId])).rows[0].status, "pending");
  assert.equal((await results().apply(actor, fileId, "f".repeat(64))).kind, "changed", "an unknown review applies nothing");
  const applied = await results().apply(actor, fileId, stale.kind === "changed" ? stale.reviewId : "");
  assert.equal(applied.kind, "applied");
  assert.deepEqual(await paidLines(), ["L-1", "L-2"]);
  assert.equal(await status(t2), "complete");
});

test("BANK_STORE_READER_SCOPED a file's recorded decisions name only the lines the current reader may settle, whoever applied it", async () => {
  const theirs = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  await transfer([{ id: "L-2", person: "w2", amount: "10.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-2", "x", "L-2"]));
  await approve(results(), actor, fileId);
  const scoped: PayLifecyclePolicy = { ...policy, authorize: async (_c, who, t) => who.principalId === "fin" || t.id !== theirs };
  const lines = async (who: string) => (await results(complete, scoped).file({ principalId: who, actingAs: false }, fileId))!.decisions.map((d) => [d.rowNumber, d.kind, d.lineIds]);
  assert.deepEqual(await lines("fin"), [[3, "pay", ["L-1"]], [4, "pay", ["L-2"]]]);
  assert.deepEqual(await lines("fin2"), [[3, "pay", []], [4, "pay", ["L-2"]]], "the applying actor's view is not reused");
});

test("BANK_STORE_POLICY the production rule lets StudentHub finance settle a company's transfer and refuses that company's own finance user", async () => {
  for (const id of ["cfin"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  await pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES ('fin','root','finance','subtree'),('cfin','P','finance','subtree')");
  const rule = bankResultLifecyclePolicy((grants, orgId, ancestors) => transferInvoiceVoidDecision(grants, orgId, ancestors, ["root"]));
  const port: BankResultCompletePort = async (tx, who, id) =>
    (await new TransferLifecycleService({ transaction: async () => { throw new Error("unused"); } }, now).transitionInTransaction(tx, who, id, "complete")).kind === "changed";
  const t = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"]));
  // Past a (deliberately open) file gate, the per-transfer rule alone still refuses the company's own finance user.
  assert.deepEqual(await approve(results(port, rule, async () => true), { principalId: "cfin", actingAs: false }, fileId), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await paidLines(), []);
  assert.equal((await approve(results(port, rule), actor, fileId)).kind, "applied");
  assert.deepEqual(await paidLines(), ["L-1"]);
  assert.equal(await status(t), "complete");
  const history = await pool.query("SELECT actor_id FROM pay_transfer_lifecycle_history WHERE transfer_id=$1 AND action='complete'", [t]);
  assert.deepEqual(history.rows, [{ actor_id: "fin" }]);
});

test("BANK_STORE_GATE without finance file permission nothing is stored, no earlier file is named, and a file with no eligible transfer is not applied", async () => {
  await pool.query("INSERT INTO principals(id) VALUES ('cfin')");
  const cfin = { principalId: "cfin", actingAs: false };
  const kfh = [[], [], [], [], [], [], [], [], ["Beneficiary Account", "Amount", "Transfer Currency", "Refrence Number", "Exchange Rates", "Beneficiary Name", "Bank", "Amount Deducted"], ["ACC-1", "10.000", "KWD", "K-1"]];
  assert.deepEqual(await results().submit(cfin, { format: "kfh", contentSha256: sha(kfh), cells: kfh }), { kind: "refused", code: "forbidden" });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM bank_result_files")).rows[0].n, 0);
  const fileId = (await results().submit(actor, { format: "kfh", contentSha256: sha(kfh), cells: kfh })) as { fileId: string };
  assert.deepEqual(await results().submit(cfin, { format: "kfh", contentSha256: sha(kfh), cells: kfh }), { kind: "refused", code: "forbidden" }, "a duplicate is not disclosed");
  assert.deepEqual(await approve(results(), cfin, fileId.fileId), { kind: "refused", code: "forbidden" }, "no transfer to authorize is not a pass");
  assert.deepEqual(await approve(results(), cfin, randomUUID()), { kind: "refused", code: "forbidden" }, "absence is not disclosed either");
  assert.equal((await pool.query("SELECT status FROM bank_result_files WHERE id=$1", [fileId.fileId])).rows[0].status, "pending");
  await pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES ('fin','root','finance','subtree'),('cfin','P','finance','subtree')");
  const gate = operatorFinanceGate(["root"]);
  const client = await pool.connect();
  try { assert.deepEqual([await gate(client, "fin"), await gate(client, "cfin")], [true, false]); } finally { client.release(); }
});

test("BANK_STORE_SCOPED_REPLAY a replayed reference is still caught from history, but a line the actor may not settle is never named", async () => {
  const theirs = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  await transfer([{ id: "L-2", person: "w2", amount: "10.000" }], "lock", "payment_received");
  await approve(results(), actor, await submit(aub(["SUCCESS", "REF-1", "x", "L-1"])));
  const scoped: PayLifecyclePolicy = { ...policy, authorize: async (_c, who, t) => who.principalId === "fin" || t.id !== theirs };
  const fin2 = { principalId: "fin2", actingAs: false };
  await pool.query("INSERT INTO principals(id) VALUES ('fin2')");
  const cells = aub(["SUCCESS", "REF-1", "again", "L-2"], ["SUCCESS", "REF-1-X", "x", "L-1"]);
  const second = (await results(complete, scoped).submit(fin2, { format: "aub", contentSha256: sha(cells), cells })) as { fileId: string };
  const applied = await approve(results(complete, scoped), fin2, second.fileId);
  assert.deepEqual(applied, { kind: "refused", code: "forbidden" }, "a row naming their line refuses the file");
  const only = aub(["SUCCESS", "REF-1", "again", "L-2"]);
  const third = (await results(complete, scoped).submit(fin2, { format: "aub", contentSha256: sha(only), cells: only })) as { fileId: string };
  const result = await approve(results(complete, scoped), fin2, third.fileId);
  assert.deepEqual(result.kind === "applied" && result.decisions, [{ kind: "hold", rowNumber: 3, reason: "reference_conflict", lineIds: ["L-2"] }]);
  assert.deepEqual(await rows(third.fileId), [[3, "hold", "reference_conflict", ["L-2"], "REF-1"]]);
  assert.deepEqual(await paidLines(), ["L-1"]);
});

test("BANK_STORE_CENTRAL_GATE file authority is a subtree finance grant covering every operator organization; self-only, company, other-role and partial cover are refused", async () => {
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES ('ops2','Second operator',NULL),('desk','Operator desk','root')");
  for (const id of ["self", "sub", "both", "cfin", "staff", "deskfin"]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  await pool.query(`INSERT INTO grants(principal_id,org_id,role,scope) VALUES ('self','root','finance','self'),('sub','root','finance','subtree'),
    ('both','root','finance','subtree'),('both','ops2','finance','subtree'),('cfin','P','finance','subtree'),('staff','root','staff','subtree'),('deskfin','desk','finance','subtree')`);
  const client = await pool.connect();
  const verdicts = async (operators: readonly string[]) => {
    const gate = operatorFinanceGate(operators);
    const out: Record<string, boolean> = {};
    for (const who of ["self", "sub", "both", "cfin", "staff", "deskfin"]) out[who] = await gate(client, who);
    return out;
  };
  try {
    assert.deepEqual(await verdicts(["root"]), { self: false, sub: true, both: true, cfin: false, staff: false, deskfin: false }, "one operator: only a subtree finance grant on it");
    assert.deepEqual(await verdicts(["root", "ops2"]), { self: false, sub: false, both: true, cfin: false, staff: false, deskfin: false }, "two separate operators: both must be covered");
    assert.deepEqual(await verdicts(["root", "desk"]), { self: false, sub: true, both: true, cfin: false, staff: false, deskfin: false }, "a nested operator is covered by its ancestor's subtree grant, not the reverse");
    assert.deepEqual(await verdicts([]), { self: false, sub: false, both: false, cfin: false, staff: false, deskfin: false }, "no operator list is no authority");
    assert.deepEqual(await verdicts(["nowhere"]), { self: false, sub: false, both: false, cfin: false, staff: false, deskfin: false }, "an unknown operator is no authority");
  } finally { client.release(); }
  const central = (store = results(complete, policy, operatorFinanceGate(["root", "ops2"]))) => store;
  const cells = aub(["SUCCESS", "REF-1", "x", "L-1"]);
  assert.deepEqual(await central().submit({ principalId: "self", actingAs: false }, { format: "aub", contentSha256: sha(cells), cells }), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await central().submit({ principalId: "sub", actingAs: false }, { format: "aub", contentSha256: sha(cells), cells }), { kind: "refused", code: "forbidden" });
  const stored = await central().submit({ principalId: "both", actingAs: false }, { format: "aub", contentSha256: sha(cells), cells });
  assert.equal(stored.kind, "submitted");
  assert.deepEqual(await approve(central(), { principalId: "sub", actingAs: false }, (stored as { fileId: string }).fileId), { kind: "refused", code: "forbidden" });
});

test("BANK_STORE_RACE two files naming one bank reference on lines of different transfers are serialised: the second sees the first's confirmation", async () => {
  await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  await transfer([{ id: "L-2", person: "w2", amount: "10.000" }], "lock", "payment_received");
  const a = await submit(aub(["SUCCESS", "REF-1", "a", "L-1"])), b = await submit(aub(["SUCCESS", "REF-1", "b", "L-2"]));
  // Each apply waits at the gate for the other to arrive (or 400 ms). Without serialisation both pass
  // together, read no recorded confirmation, and race to the reference index; with it the second waits.
  const seen: number[] = [];
  let arrived = 0;
  const rendezvous: BankResultFileGate = async () => {
    seen.push((await pool.query("SELECT count(*)::int AS n FROM bank_result_files WHERE status='applied'")).rows[0].n);
    arrived++;
    const deadline = Date.now() + 400;
    while (arrived < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    return true;
  };
  // Both files are reviewed first, while neither is applied: each would pay its line.
  const reviews = await Promise.all([a, b].map(async (id) => { const r = await results().preview(actor, id); assert.equal(r.kind, "review"); return r.kind === "review" ? r.reviewId : ""; }));
  const outcomes = await Promise.allSettled([results(complete, policy, rendezvous).apply(actor, a, reviews[0]!), results(complete, policy, rendezvous).apply(actor, b, reviews[1]!)]);
  // Serialised, the second apply sees the first's confirmation, so its outcome is no longer what was reviewed.
  assert.deepEqual(outcomes.map((o) => (o.status === "fulfilled" ? o.value.kind : `rejected:${String(o.reason?.message ?? o.reason).slice(0, 80)}`)).sort(), ["applied", "changed"]);
  assert.deepEqual([...seen].sort(), [0, 1], "the second apply reached the gate only after the first committed");
  assert.equal((await paidLines()).length, 1);
  const changed = outcomes.map((o) => (o.status === "fulfilled" ? o.value : null)).find((o) => o?.kind === "changed");
  assert.deepEqual(changed?.kind === "changed" && changed.decisions.map((d) => (d.kind === "hold" ? d.reason : d.kind)), ["reference_conflict"]);
  const kinds = (await pool.query("SELECT kind,reason FROM bank_result_rows ORDER BY kind")).rows.map((r) => `${r.kind}:${r.reason}`);
  assert.deepEqual(kinds, ["pay:null"], "the changed file wrote nothing");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM bank_result_confirmations WHERE reference='REF-1'")).rows[0].n, 1);
});

test("BANK_STORE_HELD held rows of applied files list newest first with each named line's transfer and paid flag, scoped to the reader", async () => {
  const mine = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }, { id: "L-2", person: "w2", amount: "20.000" }], "lock", "payment_received");
  const theirs = await transfer([{ id: "L-3", person: "w3", amount: "30.000" }], "lock", "payment_received");
  const first = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-9", "x", "L-404"]));
  await approve(results(), actor, first);
  const second = await submit(aub(["SUCCESS", "REF-1", "elsewhere", "L-3"], ["SUCCESS", "REF-2", "x", "L-2"]));
  await approve(results(), actor, second);
  await submit(aub(["SUCCESS", "REF-7", "x", "L-404"]));
  const scoped: PayLifecyclePolicy = { ...policy, authorize: async (_c, who, t) => who.principalId === "fin" || t.id !== theirs };
  const held = async (who: string) => (await results(complete, scoped).held({ principalId: who, actingAs: false }))!.rows
    .map((h) => [h.fileId === second ? "second" : "first", h.rowNumber, h.reason, h.reference, h.lines.map((l) => [l.lineId, l.transferId === mine ? "mine" : "theirs", l.paid])]);
  assert.deepEqual(await held("fin"), [
    ["second", 3, "reference_conflict", "REF-1", [["L-1", "mine", true], ["L-3", "theirs", false]]],
    ["first", 4, "unmatched", "REF-9", []]], "paid rows and a file not applied yet list nothing");
  assert.deepEqual(await held("fin2"), [
    ["second", 3, "reference_conflict", "REF-1", [["L-1", "mine", true]]],
    ["first", 4, "unmatched", "REF-9", []]], "a line the reader may not settle is not named");
  const page = async (n: number) => { const p = (await results().held(actor, n, 1))!; return [p.rows.map((r) => [r.fileId === second ? "second" : "first", r.rowNumber]), p.more]; };
  assert.deepEqual([await page(1), await page(2), await page(3)], [[[["second", 3]], true], [[["first", 4]], false], [[], false]], "every held row is reachable a page at a time");
  assert.equal(await results().held(actor, 0), null);
  assert.equal(await results(complete, scoped, async () => false).held(actor), null);
  assert.equal(await results().held({ principalId: "fin", actingAs: true }), null);
});

test("BANK_STORE_TRANSFER a transfer's lines show the bank payment that paid each and every held or failed row naming it, only to a reader who may settle it", async () => {
  const t = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }, { id: "L-2", person: "w2", amount: "20.000" }, { id: "L-3", person: "w3", amount: "30.000" }], "lock", "payment_received");
  const first = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["FAIL", "Account closed", "x", "L-2"]));
  await approve(results(), actor, first);
  const second = await submit(aub(["SUCCESS", "REF-1", "elsewhere", "L-3"]));
  await approve(results(), actor, second);
  const status = (await results().transfer(actor, t))!;
  assert.deepEqual([status.transferId, status.companyId, status.status], [t, "P", "distributing"]);
  assert.deepEqual(status.lines.map((l) => [l.lineId, l.personId, l.amount, l.currency, l.paid, l.payment && [l.payment.reference, l.payment.fileId === first, l.payment.rowNumber],
    l.rows.map((r) => [r.fileId === first ? "first" : "second", r.rowNumber, r.kind, r.reason, r.reference])]), [
    ["L-1", "w1", "10.000", "KWD", true, ["REF-1", true, 3], [["second", 3, "hold", "reference_conflict", "REF-1"]]],
    ["L-2", "w2", "20.000", "KWD", false, null, [["first", 4, "unpay", null, "Account closed"]]],
    ["L-3", "w3", "30.000", "KWD", false, null, [["second", 3, "hold", "reference_conflict", "REF-1"]]]]);
  const denied: PayLifecyclePolicy = { ...policy, authorize: async (_c, who) => who.principalId === "fin" };
  assert.equal(await results(complete, denied).transfer({ principalId: "fin2", actingAs: false }, t), null, "a transfer the reader may not settle is not shown");
  assert.equal(await results().transfer(actor, "missing"), null);
  assert.equal(await results().transfer(actor, "<bad>"), null);
  assert.equal(await results(complete, policy, async () => false).transfer(actor, t), null);
  assert.equal(await results().transfer({ principalId: "fin", actingAs: true }, t), null);
});

test("BANK_STORE_RECORDS_PRODUCTION the held and transfer reads work with the production finance gate and settle policy, which lock grants FOR SHARE", async () => {
  await pool.query("INSERT INTO principals(id) VALUES ('cfin')");
  await pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES ('fin','root','finance','subtree'),('cfin','P','finance','subtree')");
  const rule = bankResultLifecyclePolicy((grants, orgId, ancestors) => transferInvoiceVoidDecision(grants, orgId, ancestors, ["root"]));
  const t = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }, { id: "L-2", person: "w2", amount: "20.000" }], "lock", "payment_received");
  await approve(results(), actor, await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-9", "x", "L-404"])));
  const store = results(complete, rule, operatorFinanceGate(["root"]));
  const held = (await store.held(actor).catch((e) => assert.fail(`held read failed: ${e}`)))!;
  assert.deepEqual(held.rows.map((r) => [r.rowNumber, r.reason]), [[4, "unmatched"]]);
  const status = (await store.transfer(actor, t).catch((e) => assert.fail(`transfer read failed: ${e}`)))!;
  assert.deepEqual(status.lines.map((l) => [l.lineId, l.paid, l.payment?.reference ?? null]), [["L-1", true, "REF-1"], ["L-2", false, null]]);
  const cfin = { principalId: "cfin", actingAs: false };
  assert.equal(await store.held(cfin), null, "a company's own finance user is refused at the gate");
  assert.equal(await results(complete, rule, async () => true).transfer(cfin, t), null, "and, past an open gate, by the settle policy");
});

test("BANK_HTTP_RECORDS_PRODUCTION both record pages, wired as production with the real gate and settle rule on PostgreSQL: allowed, refused, and an unknown transfer indistinguishable from a refused one", async (t) => {
  await pool.query("INSERT INTO principals(id) VALUES ('cfin')");
  await pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES ('fin','root','finance','subtree'),('cfin','P','finance','subtree')");
  const paidOnly = await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  const held = await transfer([{ id: "L-2", person: "w2", amount: "20.000" }], "lock", "payment_received");
  await approve(results(), actor, await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["SUCCESS", "REF-2", "x", "L-404"])));
  const S_FIN = "f".repeat(43), S_CFIN = "c".repeat(43);
  // As apps/gateway/src/wiring/billing.ts builds them.
  const voidDecision = (rows: Parameters<typeof transferInvoiceVoidDecision>[0], orgId: string, ancestors: readonly string[]) =>
    transferInvoiceVoidDecision(rows, orgId, ancestors, DEFAULT_OPERATOR_ORG_IDS);
  const fileGate = operatorFinanceGate(DEFAULT_OPERATOR_ORG_IDS, TRANSFER_INVOICE_VOID_ROLE);
  const store = new PostgresBankResultStore(pool, bankResultLifecyclePolicy(voidDecision), effects(), complete, fileGate);
  const allowed = async (viewer: string) => { const c = await pool.connect(); try { return await fileGate(c, viewer); } finally { c.release(); } };
  const sessions = { get: async (id: string) => ({ [S_FIN]: { personId: "fin" }, [S_CFIN]: { personId: "cfin" } } as Record<string, { personId: string }>)[id] as never };
  const service = createBankResultsHttp({ sessions, store, allowed, origin: "https://studenthub.test.invalid" });
  const server = createServer(async (req, res) => { if (!await handleBankResults(req, res, service)) { res.writeHead(418); res.end(); } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, session: string) => fetch(base + path, { headers: { cookie: `__Host-studenthub_session=${session}`, accept: "application/json" } });

  const heldPage = await get("/finance/bank-results/held", S_FIN);
  assert.equal(heldPage.status, 200, await heldPage.clone().text());
  const heldBody = await heldPage.json() as { held: { rowNumber: number; reason: string }[]; page: number; more: boolean };
  assert.deepEqual([heldBody.held.map((r) => [r.rowNumber, r.reason]), heldBody.page, heldBody.more], [[[4, "unmatched"]], 1, false]);
  const paid = await get(`/finance/bank-results/transfers/${paidOnly}`, S_FIN);
  assert.equal(paid.status, 200, await paid.clone().text());
  assert.deepEqual((await paid.json() as { lines: { lineId: string; paid: boolean; payment: { reference: string } | null }[] }).lines.map((l) => [l.lineId, l.paid, l.payment?.reference ?? null]), [["L-1", true, "REF-1"]]);
  assert.equal((await get(`/finance/bank-results/transfers/${held}`, S_FIN)).status, 200);

  const refusedHeld = await get("/finance/bank-results/held", S_CFIN);
  const refused = await get(`/finance/bank-results/transfers/${paidOnly}`, S_CFIN), unknown = await get(`/finance/bank-results/transfers/${randomUUID()}`, S_FIN);
  assert.equal(refusedHeld.status, 404, "a company's own finance user does not see the held page");
  assert.equal(refused.status, 404); assert.equal(unknown.status, 404);
  assert.deepEqual(await refused.json(), await unknown.json(), "a refused transfer and an unknown one read the same");
  assert.equal(await store.transfer({ principalId: "fin", actingAs: false }, randomUUID()), null, "the store itself answers an unknown transfer as not found");
});
