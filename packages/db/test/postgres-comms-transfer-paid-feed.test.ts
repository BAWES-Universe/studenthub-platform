import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresNotificationsStore, runMigrations } from "@studenthub/db";
import { PostgresTransferPaidFeedStore } from "@studenthub/db/comms";
import { NotificationsService } from "../../notifications/src/notifications.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, feed: PostgresTransferPaidFeedStore, uploader: string;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  feed = new PostgresTransferPaidFeedStore({ pool });
  uploader = await principal("finance");
});
after(async () => pool.end());

async function principal(prefix: string) {
  const id = `tp-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  return id;
}
/** A transfer line for a new person at a new company and store, in KWD unless said otherwise. */
async function line(companyName = "Sultan Co", storeName = "Avenues", total = "12.500", currency = "KWD") {
  const company = `tp-co-${randomUUID()}`, store = randomUUID(), transfer = randomUUID(), id = `line-${randomUUID()}`, person = await principal("person");
  await authz.upsertOrganization(createOrganization({ id: company, name: companyName }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,$3,$4,$4)", [store, company, storeName, "a".repeat(64)]);
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,'2026-10-01','2026-10-31',$3)", [transfer, company, currency]);
  await pool.query("INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation) VALUES($1,$2,$3,$4,$5,$6,'20.000','synthetic','{}')",
    [id, transfer, person, store, currency, total]);
  return { id, person, company };
}
/** What the pay lane records when a bank result file confirms a line: the file, its row, and the confirmation. */
async function confirm(lineId: string, amount: string, currency = "KWD") {
  const file = randomUUID();
  await pool.query("INSERT INTO bank_result_files(id,format,content_sha256,uploaded_by,sheet) VALUES($1,'aub',$2,$3,'{}'::jsonb)", [file, randomUUID().replace(/-/g, "").padEnd(64, "0"), uploader]);
  await pool.query("INSERT INTO bank_result_rows(file_id,row_number,kind,line_ids,reference) VALUES($1,1,'pay',$2,$3)", [file, [lineId], `ref-${randomUUID()}`]);
  return (await pool.query<{ id: string }>("INSERT INTO bank_result_confirmations(reference,line_id,file_id,row_number,amount,currency_code) VALUES($1,$2,$3,1,$4,$5) RETURNING id::text",
    [`ref-${randomUUID()}`, lineId, file, amount, currency])).rows[0]!.id;
}
async function drain() { let total = 0; for (let n; (n = await feed.dispatch(1000, new Date())) > 0;) total += n; return total; }
const items = async (person: string) => (await pool.query("SELECT kind, subject_reference, parameters, created_at FROM notifications WHERE recipient_principal_id = $1", [person])).rows;

test("COMMS_TRANSFER_PAID_FEED_PG a confirmed payment reaches the line's person once, dated when the bank confirmed it", async () => {
  await drain();
  const l = await line();
  const id = await confirm(l.id, "12.500");
  assert.deepEqual(await items(l.person), [], "nothing before the job runs");
  assert.equal(await drain(), 1);
  assert.equal(await feed.dispatch(1000, new Date()), 0, "nothing left");
  const recorded = (await pool.query("SELECT recorded_at FROM bank_result_confirmations WHERE id = $1", [id])).rows[0].recorded_at;
  assert.deepEqual(await items(l.person), [{ kind: "pay.transfer_paid", subject_reference: `bank_confirmation:${id}`, parameters: {}, created_at: recorded }]);
  assert.deepEqual(await items(uploader), [], "the finance user who applied the file gets nothing");
});

test("COMMS_TRANSFER_PAID_FEED_RENDER the item shows the confirmed amount and where it was earned, opens pay history, and the bell counts it", async () => {
  await drain();
  const l = await line("Sultan Co", "Avenues", "7.250");
  await confirm(l.id, "7.25");
  await drain();
  const store = PostgresNotificationsStore.connect({ pool }), service = new NotificationsService(store, store, authz);
  await pool.query("UPDATE organizations SET name = 'Sultan Group' WHERE id = $1", [l.company]);
  const page = await service.list(l.person, 1, ["pay.transfer_paid"]);
  assert.deepEqual(page.items.map((i) => [i.text, i.href, i.read]), [["KWD 7.250 for Avenues, Sultan Group has been transferred to your bank account.", "/pay", false]]);
  assert.equal(await service.count(l.person), 1);
  const id = (await pool.query("SELECT bc.id::text id FROM bank_result_confirmations bc WHERE bc.line_id = $1", [l.id])).rows[0].id;
  assert.deepEqual(await store.readTransferPayments(await principal("other"), [id]), [], "someone else's payment is never read");
  assert.deepEqual(await store.readTransferPayments(l.person, ["0", "x"]), []);
  // Legacy's number_format(amount, 3): thousands separated by commas.
  const big = await line("Sultan Co", "Avenues", "1234.500");
  await confirm(big.id, "1234.5");
  await drain();
  assert.deepEqual((await service.list(big.person, 1)).items.map((i) => i.text), ["KWD 1,234.500 for Avenues, Sultan Co has been transferred to your bank account."]);
  await service.markAllRead(l.person);
  assert.equal(await service.count(l.person), 0);
});

test("COMMS_TRANSFER_PAID_FEED_ONCE racing workers write one item, and a confirmation already marked is never dispatched", async () => {
  await drain();
  const l = await line();
  await confirm(l.id, "12.500");
  const results = await Promise.all([feed.dispatch(1000, new Date()), feed.dispatch(1000, new Date()), feed.dispatch(1000, new Date())]);
  assert.equal(results.reduce((a, b) => a + b, 0), 1);
  assert.equal((await items(l.person)).length, 1);
  const m = await line(), id = await confirm(m.id, "12.500");
  await pool.query("INSERT INTO comms_dispatched_bank_confirmations(confirmation_id, dispatched_at) VALUES($1, now())", [id]);
  assert.equal(await drain(), 0);
  assert.deepEqual(await items(m.person), []);
});

test("COMMS_TRANSFER_PAID_FEED_PAYLOAD the database takes only an empty payload and a confirmation reference for the kind", async () => {
  const person = await principal("payload");
  const insert = (reference: string, parameters: string) => pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'pay.transfer_paid',$2,$3::jsonb,$4)", [person, reference, parameters, `k-${randomUUID()}`]);
  await assert.rejects(insert("bank_confirmation:1", '{"amount":"1.000"}'), { code: "23514" });
  await assert.rejects(insert("bank_confirmation:0", "{}"), { code: "23514" });
  await assert.rejects(insert(`work_assignment:${randomUUID()}`, "{}"), { code: "23514" });
  await insert("bank_confirmation:42", "{}");
});
