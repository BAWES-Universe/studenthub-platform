import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runMigrations } from "@studenthub/db";
import pg from "pg";
import { TransferLifecycleService } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, PostgresTransferLifecycleTransaction, type PayLifecycleEffects, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";
import { PostgresPayLinesStore } from "../src/payroll/postgres-pay-lines-store.js";
import { validatePayLine } from "../../payroll/src/pay-lines.js";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "invalid:");
if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname)) {
  throw Error("disposable loopback PostgreSQL DATABASE_URL required");
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const a = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, application_name: "f3-test-a" });
const b = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, application_name: "f3-test-b" });
const actor = { principalId: "f3-staff", actingAs: false };
const company = "f3-company", person = "f3-person", storeId = randomUUID();
const policy: PayLifecyclePolicy = {
  authorize: async (_c, who, t) => who.principalId === actor.principalId && t.companyId === company,
  unassignedPersonIds: async (c, id) => (await c.query(`SELECT DISTINCT l.person_id FROM pay_transfer_lines l WHERE l.transfer_id=$1 AND NOT EXISTS (SELECT 1 FROM work_assignments w WHERE w.person_principal_id=l.person_id AND w.org_id=$2 AND w.start_date <= '2026-11-19' AND (w.end_date IS NULL OR w.end_date >= '2026-11-19'))`, [id, company])).rows.map(r => r.person_id),
};
// Synthetic transaction probes only. NOT an implementation of billing issuance.
function effects(fail = false): PayLifecycleEffects {
  return {
    ensureChildrenAndInvoices: async (c, id) => {
      await c.query("INSERT INTO f3_test_effects(transfer_id) VALUES($1) ON CONFLICT DO NOTHING", [id]);
      if (fail) throw Error("synthetic late invoice failure");
    },
    markInvoicesPaid: async (c, id) => { await c.query("UPDATE f3_test_effects SET paid=true WHERE transfer_id=$1", [id]); },
    softDeleteGroup: async (c, id) => { await c.query("UPDATE f3_test_effects SET deleted=true WHERE transfer_id=$1", [id]); },
  };
}
const clock = () => new Date("2026-11-18T21:30:00Z");
function service(p: pg.Pool, e?: PayLifecycleEffects) { return new TransferLifecycleService(new PostgresTransferLifecycleStore(p, policy, e), clock); }
let lines: PostgresPayLinesStore;
before(async () => {
  await runMigrations(pool);
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,$1)", [company]);
  for (const id of [actor.principalId, person]) await pool.query("INSERT INTO principals(id) VALUES($1)", [id]);
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Synthetic shop',$3,$3)", [storeId, company, "a".repeat(64)]);
  await pool.query("INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by) VALUES($1,$2,$3,$4,'{}','2026-11-01','2026-11-30','staff',$5)", [randomUUID(), person, company, storeId, actor.principalId]);
  await pool.query("CREATE TABLE f3_test_effects(transfer_id text PRIMARY KEY REFERENCES pay_transfers(id),paid boolean DEFAULT false,deleted boolean DEFAULT false)");
  lines = new PostgresPayLinesStore(pool, async (_c, who, co) => who === actor.principalId && co === company, validatePayLine);
});
after(async () => { await Promise.all([a.end(), b.end(), pool.end()]); });
function line() { return { id: randomUUID(), personId: person, storeId, currencyCode: "KWD", candidateTotal: "12.500", companyTotal: "15.000", note: "synthetic", calculation: { source: "manual", minutes: 150 } }; }
async function draft() {
  const id = randomUUID(); await lines.create(actor.principalId, { id, companyId: company, periodStart: "2026-11-01", periodEnd: "2026-11-30", currencyCode: "KWD" });
  await lines.appendLines(actor.principalId, id, 0, [line()]); return id;
}
async function snapshot(id: string) {
  return {
    transfer: (await pool.query("SELECT status,version,deleted,payment_received_on::text FROM pay_transfers WHERE id=$1", [id])).rows[0],
    history: (await pool.query("SELECT action,from_status,to_status FROM pay_transfer_lifecycle_history WHERE transfer_id=$1 ORDER BY id", [id])).rows,
    effects: (await pool.query("SELECT * FROM f3_test_effects WHERE transfer_id=$1", [id])).rows,
  };
}

test("F3_PG unavailable billing refuses lock, receipt and delete without mutation", async () => {
  const id = await draft(); const original = await snapshot(id);
  await assert.rejects(service(a).transition(actor, id, "lock"), /billing_unavailable/);
  assert.deepEqual(await snapshot(id), original);
  await service(a, effects()).transition(actor, id, "lock"); const locked = await snapshot(id);
  for (const action of ["payment_received", "delete"] as const) {
    await assert.rejects(service(a).transition(actor, id, action), /billing_unavailable/);
    assert.deepEqual(await snapshot(id), locked);
  }
});

test("F3_PG two independently blocked clients lock exactly once", async () => {
  const id = await draft(), blocker = await pool.connect();
  await blocker.query("BEGIN"); await blocker.query("SELECT id FROM pay_transfers WHERE id=$1 FOR UPDATE", [id]);
  const first = service(a, effects()).transition(actor, id, "lock");
  const second = service(b, effects()).transition(actor, id, "lock");
  try {
    let waiting = 0;
    for (let i = 0; i < 100; i++) {
      waiting = (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name IN ('f3-test-a','f3-test-b') AND wait_event_type='Lock'")).rows[0].n;
      if (waiting === 2) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, 2, "two distinct PostgreSQL clients must contend");
  } finally { await blocker.query("COMMIT"); blocker.release(); }
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(r => r.kind === "changed").length, 1);
  assert.equal(results.filter(r => r.kind === "refused" && r.code === "invalid_transition").length, 1);
  const s = await snapshot(id); assert.equal(s.effects.length, 1); assert.equal(s.history.length, 1);
  assert.equal(s.transfer.version, 2); assert.equal(s.transfer.status, "locked");
});

test("F3_PG effects and state rollback on late invoice failure then retry", async () => {
  const id = await draft(), original = await snapshot(id);
  await assert.rejects(service(a, effects(true)).transition(actor, id, "lock"), /late invoice failure/);
  assert.deepEqual(await snapshot(id), original);
  assert.equal((await service(b, effects()).transition(actor, id, "lock")).kind, "changed");
  assert.equal((await snapshot(id)).effects.length, 1);
});

test("F3_PG audit insert failure rolls back prior effects and state", async () => {
  const id = await draft(), original = await snapshot(id);
  await pool.query(`CREATE FUNCTION f3_test_reject_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER f3_test_audit_failure BEFORE INSERT ON pay_transfer_lifecycle_history FOR EACH ROW EXECUTE FUNCTION f3_test_reject_history()`);
  try { await assert.rejects(service(a, effects()).transition(actor, id, "lock"), /audit failure/); assert.deepEqual(await snapshot(id), original); }
  finally { await pool.query("DROP TRIGGER f3_test_audit_failure ON pay_transfer_lifecycle_history; DROP FUNCTION f3_test_reject_history()"); }
  assert.equal((await service(b, effects()).transition(actor, id, "lock")).kind, "changed");
});

test("F3_PG F1 line write waits for same parent lock then refuses locked state", async () => {
  const id = await draft(); let started!: () => void, finish!: () => void;
  const held = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const e = effects(); const base = e.ensureChildrenAndInvoices;
  e.ensureChildrenAndInvoices = async (c, transfer) => { await base(c, transfer); started(); await release; };
  const locking = service(a, e).transition(actor, id, "lock"); await held;
  const lineStoreB = new PostgresPayLinesStore(b, async () => true, validatePayLine);
  const writing = lineStoreB.appendLines(actor.principalId, id, 1, [line()]);
  const refusal = assert.rejects(writing, /transfer_not_draft/);
  try {
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      waiting = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='f3-test-b' AND wait_event_type='Lock') AS waiting")).rows[0].waiting;
      if (waiting) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true);
  } finally { finish(); }
  await locking; await refusal;
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pay_transfer_lines WHERE transfer_id=$1", [id])).rows[0].n, 1);
});

test("F3_PG authorized admin unlock preserves the company and records each exact source version", async () => {
  const id = await draft(), s = service(a, effects());
  for (const from of ["locked", "payment_sent"] as const) {
    assert.equal((await s.transition(actor, id, "lock")).kind, "changed");
    if (from === "payment_sent") assert.equal((await s.transition(actor, id, "payment_sent")).kind, "changed");
    const previous = (await snapshot(id)).transfer;
    assert.equal(previous.status, from);
    assert.equal((await s.transition(actor, id, "admin_unlock")).kind, "changed");
    const transfer = (await pool.query("SELECT company_id,status,version FROM pay_transfers WHERE id=$1", [id])).rows[0];
    assert.deepEqual(transfer, { company_id: company, status: "draft", version: previous.version + 1 });
    const witness = (await pool.query("SELECT from_status,to_status,unlock_source_version FROM pay_transfer_lifecycle_history WHERE transfer_id=$1 AND action='admin_unlock' ORDER BY id DESC LIMIT 1", [id])).rows[0];
    assert.deepEqual(witness, { from_status: from, to_status: "draft", unlock_source_version: previous.version });
  }
  assert.equal((await snapshot(id)).effects.length, 1, "relock preserves the synthetic effect identity");
});

test("F3_PG received date, complete guard, history immutable and relock reuse", async () => {
  const id = await draft(), s = service(a, effects());
  await s.transition(actor, id, "lock");
  await s.transition(actor, id, "admin_unlock"); await s.transition(actor, id, "lock");
  assert.equal((await snapshot(id)).effects.length, 1);
  await s.transition(actor, id, "payment_received");
  assert.equal((await snapshot(id)).transfer.payment_received_on, "2026-11-19");
  assert.deepEqual(await s.transition(actor, id, "complete"), { kind: "refused", code: "unpaid_lines" });
  await pool.query("UPDATE pay_transfer_lines SET paid=true WHERE transfer_id=$1", [id]);
  assert.equal((await s.transition(actor, id, "complete")).kind, "changed");
  await assert.rejects(pool.query("UPDATE pay_transfer_lifecycle_history SET action='cancel' WHERE transfer_id=$1", [id]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM pay_transfer_lifecycle_history WHERE transfer_id=$1", [id]), /append-only/);
});


test("F3_PG denied policy and absent current membership have no effects", async () => {
  const id = await draft(), original = await snapshot(id);
  const denied = new TransferLifecycleService(new PostgresTransferLifecycleStore(a, { ...policy, authorize: async () => false }, effects()), clock);
  assert.deepEqual(await denied.transition(actor, id, "lock"), { kind: "refused", code: "forbidden" });
  assert.deepEqual(await snapshot(id), original);
  await pool.query("UPDATE work_assignments SET end_date='2026-11-18' WHERE person_principal_id=$1", [person]);
  try {
    assert.deepEqual(await service(a, effects()).transition(actor, id, "lock"), { kind: "refused", code: "unassigned_people", personIds: [person] });
    assert.deepEqual(await snapshot(id), original);
  } finally { await pool.query("UPDATE work_assignments SET end_date='2026-11-30' WHERE person_principal_id=$1", [person]); }
});

test("F3_PG F5 same-client paid mutation and reopening commit or roll back together", async () => {
  const id = await draft(), s = service(a, effects());
  await s.transition(actor, id, "lock"); await s.transition(actor, id, "payment_received");
  await pool.query("UPDATE pay_transfer_lines SET paid=true WHERE transfer_id=$1", [id]);
  await s.transition(actor, id, "complete");
  const original = await snapshot(id);
  for (const fail of [true, false]) {
    const c = await a.connect();
    try {
      await c.query("BEGIN");
      const tx = new PostgresTransferLifecycleTransaction(c, policy, effects());
      await tx.lockTransfer(id);
      await c.query("UPDATE pay_transfer_lines SET paid=false WHERE transfer_id=$1", [id]);
      assert.equal((await s.transitionInTransaction(tx, actor, id, "reopen_after_unpaid")).kind, "changed");
      if (fail) throw Error("synthetic later F5 failure");
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK"); if (!fail) throw e;
      assert.match(String(e), /later F5 failure/);
    } finally { c.release(); }
    if (fail) assert.deepEqual(await snapshot(id), original);
    assert.equal((await pool.query("SELECT paid FROM pay_transfer_lines WHERE transfer_id=$1", [id])).rows[0].paid, fail);
  }
  assert.equal((await snapshot(id)).transfer.status, "distributing");
});
