import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresNotificationsStore, runMigrations } from "@studenthub/db";
import { PostgresTransferInitiatedFeedStore } from "@studenthub/db/comms";
import { NotificationsService } from "../../notifications/src/notifications.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, feed: PostgresTransferInitiatedFeedStore, staff: string;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  feed = new PostgresTransferInitiatedFeedStore({ pool });
  staff = await principal("staff");
});
after(async () => pool.end());

async function principal(prefix: string) {
  const id = `ti-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  return id;
}
/** A draft transfer at a new company, in KWD unless said otherwise. */
async function transfer(companyName = "Sultan Co", currency = "KWD") {
  const company = `ti-co-${randomUUID()}`, id = randomUUID();
  await authz.upsertOrganization(createOrganization({ id: company, name: companyName }));
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,'2026-10-01','2026-10-31',$3)", [id, company, currency]);
  return { id, company, currency };
}
/** A line on a draft transfer for a new person (or the given one) at a new store of the transfer's company. */
async function line(t: { id: string; company: string; currency: string }, storeName = "Avenues", total = "12.500", person?: string, id = `line-${randomUUID()}`) {
  const store = randomUUID(), who = person ?? await principal("person");
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,$3,$4,$4)", [store, t.company, storeName, "a".repeat(64)]);
  await pool.query("INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation) VALUES($1,$2,$3,$4,$5,$6,'20.000','synthetic','{}')",
    [id, t.id, who, store, t.currency, total]);
  return { id, person: who };
}
/** One lifecycle step as the pay lane's adapter records it: the history row and the status change, in one transaction. */
async function step(transferId: string, action: string, from: string, to: string, at = new Date()) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("INSERT INTO pay_transfer_lifecycle_history(transfer_id,actor_id,action,from_status,to_status,deleted,occurred_at,source_version) SELECT id,$2,$3,$4,$5,false,$6,version FROM pay_transfers WHERE id=$1",
      [transferId, staff, action, from, to, at]);
    await c.query("UPDATE pay_transfers SET status=$2,version=version+1,payment_received_on=CASE WHEN $3 THEN ($4::timestamptz AT TIME ZONE 'Asia/Kuwait')::date ELSE payment_received_on END WHERE id=$1",
      [transferId, to, action === "payment_received", at]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
/** Lock the transfer and mark its payment received, as staff do in legacy admin. */
async function receive(transferId: string, at = new Date()) {
  await step(transferId, "lock", "draft", "locked");
  await step(transferId, "payment_received", "locked", "distributing", at);
}
async function drain() { let total = 0; for (let n; (n = await feed.dispatch(1000, new Date())) > 0;) total += n; return total; }
const items = async (person: string) => (await pool.query("SELECT kind, subject_reference, parameters, created_at FROM notifications WHERE recipient_principal_id = $1 ORDER BY subject_reference", [person])).rows;

test("COMMS_TRANSFER_INITIATED_FEED_PG payment received reaches every line's person once, dated when it was received; locking alone sends nothing", async () => {
  await drain();
  const t = await transfer(), a = await line(t), b = await line(t, "Marina");
  const twice = await principal("twice"), c1 = await line(t, "Kout", "1.000", twice), c2 = await line(t, "Gate", "2.000", twice);
  await step(t.id, "lock", "draft", "locked");
  assert.equal(await drain(), 0, "a locked transfer is not yet initiated");
  const at = new Date("2026-11-20T09:30:00Z");
  await step(t.id, "payment_received", "locked", "distributing", at);
  assert.equal(await drain(), 4);
  assert.equal(await feed.dispatch(1000, new Date()), 0, "nothing left");
  assert.deepEqual(await items(a.person), [{ kind: "pay.transfer_initiated", subject_reference: `pay_line:${a.id}`, parameters: {}, created_at: at }]);
  assert.equal((await items(b.person)).length, 1);
  assert.deepEqual((await items(twice)).map((r) => r.subject_reference), [`pay_line:${c1.id}`, `pay_line:${c2.id}`].sort(), "one item for each line, as legacy did for each transfer candidate");
  assert.deepEqual(await items(staff), [], "the staff member who marked it gets nothing");
  // Completing the transfer, and reopening it after an unpaid line, is not a new payment received.
  await pool.query("UPDATE pay_transfer_lines SET paid = true WHERE transfer_id = $1", [t.id]);
  await step(t.id, "complete", "distributing", "complete");
  await step(t.id, "reopen_after_unpaid", "complete", "distributing");
  assert.equal(await drain(), 0);
});

test("COMMS_TRANSFER_INITIATED_FEED_RENDER the item shows the line's amount and where it was earned, opens pay history, and the bell counts it", async () => {
  await drain();
  const t = await transfer("Sultan Co"), l = await line(t, "Avenues", "7.250"), big = await line(t, "Avenues", "1234.500");
  await receive(t.id);
  await drain();
  const store = PostgresNotificationsStore.connect({ pool }), service = new NotificationsService(store, store, authz);
  await pool.query("UPDATE organizations SET name = 'Sultan Group' WHERE id = $1", [t.company]);
  const page = await service.list(l.person, 1, ["pay.transfer_initiated"]);
  assert.deepEqual(page.items.map((i) => [i.text, i.href, i.read]), [["New transfer initiated: KWD 7.250 for Avenues, Sultan Group.", "/pay", false]]);
  assert.equal(await service.count(l.person), 1);
  // Legacy's number_format(total, 3): thousands separated by commas.
  assert.deepEqual((await service.list(big.person, 1)).items.map((i) => i.text), ["New transfer initiated: KWD 1,234.500 for Avenues, Sultan Group."]);
  assert.deepEqual(await store.readTransferLines(await principal("other"), [l.id]), [], "someone else's line is never read");
  assert.deepEqual(await store.readTransferLines(l.person, ["", "a b", "x".repeat(129)]), []);
  await service.markAllRead(l.person);
  assert.equal(await service.count(l.person), 0);
});

test("COMMS_TRANSFER_INITIATED_FEED_HIDDEN a line on a transfer whose payment was not received is not shown or counted, even with a stored item", async () => {
  const t = await transfer(), l = await line(t);
  await pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'pay.transfer_initiated',$2,'{}'::jsonb,$2)", [l.person, `pay_line:${l.id}`]);
  const store = PostgresNotificationsStore.connect({ pool }), service = new NotificationsService(store, store, authz);
  assert.deepEqual((await service.list(l.person, 1)).items, []);
  assert.equal(await service.count(l.person), 0);
});

test("COMMS_TRANSFER_INITIATED_FEED_ONCE racing workers write each item once, and a step already marked is never dispatched", async () => {
  await drain();
  const t = await transfer(), l = await line(t), m = await line(t);
  await receive(t.id);
  const results = await Promise.all([feed.dispatch(1000, new Date()), feed.dispatch(1000, new Date()), feed.dispatch(1000, new Date())]);
  assert.equal(results.reduce((a, b) => a + b, 0), 2);
  assert.equal((await items(l.person)).length, 1);
  assert.equal((await items(m.person)).length, 1);
  const u = await transfer(), n = await line(u);
  await receive(u.id);
  const id = (await pool.query("SELECT id FROM pay_transfer_lifecycle_history WHERE transfer_id = $1 AND action = 'payment_received'", [u.id])).rows[0].id;
  await pool.query("INSERT INTO comms_dispatched_transfer_receipts(history_id, dispatched_at) VALUES($1, now())", [id]);
  assert.equal(await drain(), 0);
  assert.deepEqual(await items(n.person), []);
});

test("COMMS_TRANSFER_INITIATED_FEED_LINE_ID a line id the pay history cannot open gets no item, and the other lines still do", async () => {
  await drain();
  const t = await transfer(), odd = await line(t, "Avenues", "1.000", undefined, `odd line ${randomUUID()}`), ok = await line(t);
  await receive(t.id);
  assert.equal(await drain(), 1);
  assert.deepEqual(await items(odd.person), []);
  assert.equal((await items(ok.person)).length, 1);
});

test("COMMS_TRANSFER_INITIATED_FEED_PAYLOAD the database takes only an empty payload and a line reference for the kind", async () => {
  const person = await principal("payload");
  const insert = (reference: string, parameters: string) => pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'pay.transfer_initiated',$2,$3::jsonb,$4)", [person, reference, parameters, `k-${randomUUID()}`]);
  await assert.rejects(insert("pay_line:x", '{"amount":"1.000"}'), { code: "23514" });
  await assert.rejects(insert("pay_line:", "{}"), { code: "23514" });
  await assert.rejects(insert("pay_line:a b", "{}"), { code: "23514" });
  await assert.rejects(insert("bank_confirmation:1", "{}"), { code: "23514" });
  await insert("pay_line:line-1", "{}");
});
