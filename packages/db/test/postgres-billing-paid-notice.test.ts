import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { PostgresNotificationsStore, runMigrations } from "@studenthub/db";
import { NotificationsService } from "../../notifications/src/notifications.js";
import { PostgresBankResultStore, PostgresTransferInvoiceEffects, bankResultLifecyclePolicy, operatorFinanceGate, type BankResultCompletePort, type BankResultFileGate } from "@studenthub/db/billing";
import { transferInvoiceVoidDecision } from "../../billing/src/transfer-invoice-access.js";
import { AUB_RESULT_COLUMNS, type BankCell } from "../../billing/src/bank-results.js";
import { TransferLifecycleService, type TransferAction } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";

// F6 paid notices, written by the F5 bank result apply, against PostgreSQL. Synthetic companies, people, amounts and references only.
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
  schema = `paid_notice_${randomUUID().replaceAll("-", "")}`;
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

const notices = async () => (await pool.query(
  "SELECT n.recipient_principal_id AS who,n.kind,n.subject_reference AS subject,n.parameters,n.dedupe_key AS key,c.line_id FROM notifications n LEFT JOIN bank_result_confirmations c ON n.subject_reference='bank_confirmation:'||c.id WHERE n.kind='pay.line_paid' ORDER BY c.line_id,n.recipient_principal_id")).rows;
const noticeCount = async () => (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind='pay.line_paid'")).rows[0].n as number;
const feed = (who: string) => {
  const store = PostgresNotificationsStore.connect({ pool });
  return new NotificationsService(store, store, { listGrantsForPrincipal: async () => [] }).list(who, 1, ["pay.line_paid"]);
};

test("PAID_NOTICE_ONE each line the file pays gets one notice for its own person, keyed by that payment; failed and held rows get none", async () => {
  await transfer([{ id: "L-1", person: "w1", amount: "1120.500" }, { id: "L-2", person: "w2", amount: "80.000" }, { id: "L-3", person: "w3", amount: "5.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"], ["FAIL", "Account closed", "x", "L-2"], ["SUCCESS", "REF-3", "x", "L-404"], ["SUCCESS", "REF-4", "x", "L-3"]));
  assert.equal((await approve(results(), actor, fileId)).kind, "applied");
  const got = await notices();
  assert.deepEqual(got.map((n) => [n.who, n.kind, n.parameters, n.line_id]), [["w1", "pay.line_paid", {}, "L-1"], ["w3", "pay.line_paid", {}, "L-3"]]);
  for (const n of got) assert.equal(n.key, `pay_line_paid:${n.subject.slice("bank_confirmation:".length)}`);
  const page = await feed("w1");
  assert.deepEqual(page.items.map((i) => [i.text, i.href, i.read]),
    [["Transfer paid: KWD 1,120.500 has been transferred to your bank account (Shop P, P legal).", "/pay/L-1", false]]);
  assert.equal(page.unreadCount, 1);
  assert.deepEqual((await feed("w2")).items, [], "a failed payment sends no paid notice");
});

test("PAID_NOTICE_OWN a notice row addressed to someone else is never rendered with another person's line", async () => {
  await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  await approve(results(), actor, await submit(aub(["SUCCESS", "REF-1", "x", "L-1"])));
  const [{ subject }] = await notices();
  await pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES('w2','pay.line_paid',$1,'{}','forged')", [subject]);
  assert.deepEqual((await feed("w2")).items, []);
  assert.equal((await feed("w1")).items.length, 1);
});

test("PAID_NOTICE_ONCE re-applying, replaying a recorded payment in another file, or a stale review sends nothing more", async () => {
  await transfer([{ id: "L-1", person: "w1", amount: "10.000" }, { id: "L-2", person: "w2", amount: "10.000" }], "lock", "payment_received");
  const first = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"]));
  await approve(results(), actor, first);
  assert.equal(await noticeCount(), 1);
  assert.deepEqual(await approve(results(), actor, first), { kind: "refused", code: "already_applied" });
  const replay = await submit(aub(["SUCCESS", "REF-1", "again", "L-1"]));
  await approve(results(), actor, replay);
  assert.deepEqual(await rows(replay), [[3, "duplicate", null, ["L-1"], "REF-1"]]);
  assert.equal(await noticeCount(), 1);
  const stale = await submit(aub(["SUCCESS", "REF-2", "x", "L-2"]));
  assert.equal((await results().apply(actor, stale, "0".repeat(64))).kind, "changed");
  assert.equal(await noticeCount(), 1, "an apply that did not match its review writes nothing");
});

test("PAID_NOTICE_ROLLBACK an apply that fails after marking lines paid leaves no notice behind", async () => {
  await transfer([{ id: "L-1", person: "w1", amount: "10.000" }], "lock", "payment_received");
  const fileId = await submit(aub(["SUCCESS", "REF-1", "x", "L-1"]));
  const failing: BankResultCompletePort = async () => { throw new Error("complete failed"); };
  const review = await results().preview(actor, fileId);
  await assert.rejects(results(failing).apply(actor, fileId, review.kind === "review" ? review.reviewId : ""), /complete failed/);
  assert.deepEqual(await paidLines(), []);
  assert.equal(await noticeCount(), 0);
});

test("PAID_NOTICE_CHECK the database accepts the paid notice only with a confirmation subject and empty parameters, and keeps the earlier kinds", async () => {
  const insert = (kind: string, subject: string, parameters: string) =>
    pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES('w1',$1,$2,$3::jsonb,$4)", [kind, subject, parameters, randomUUID()]);
  await insert("pay.line_paid", "bank_confirmation:1", "{}");
  for (const [subject, parameters] of [["bank_confirmation:0", "{}"], ["bank_confirmation:01", "{}"], ["bank_confirmation:x", "{}"], ["pay_line:1", "{}"], ["bank_confirmation:1", '{"amount":"1"}']])
    await assert.rejects(insert("pay.line_paid", subject, parameters), /notifications_kind_payload_check/, `${subject} ${parameters}`);
  for (const [kind, subject, parameters] of [["work.assigned", `work_assignment:${randomUUID()}`, "{}"], ["staff.message", `staff_message:${randomUUID()}`, "{}"],
    ["recruit.invitation.sent", "recruit_outbox:1", "{}"], ["work.session_approved", "work_session:s1", '{"workDate":"2026-11-02"}'],
    ["organization.status_changed", "organization:P", '{"status":"active"}']])
    await assert.doesNotReject(insert(kind, subject, parameters), `${kind} is still accepted`);
});
