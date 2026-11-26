import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { BANK_DETAILS_FIELD, BankDetailError, bankDetailsRecordRef, bankDetailsValue, buildBankDetailsWrite, catalogueBankDetailsCheck, validateBankDetails, type BankDetails } from "@studenthub/pay-contracts";
import { PostgresAuthzStore, PostgresBankDetailsStore, PostgresFinanceReferenceResolver, PostgresNotificationsStore, principalAuditRef, runMigrations } from "@studenthub/db";
import { PostgresBankResultStore, PostgresTransferInvoiceEffects, type BankResultCompletePort } from "@studenthub/db/billing";
import { PostgresTransferPaidFeedStore } from "@studenthub/db/comms";
import { AUB_RESULT_COLUMNS, type BankCell } from "../../billing/src/bank-results.js";
import { TransferLifecycleService } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";
import { NotificationsService } from "../../notifications/src/notifications.js";

// Synthetic people, companies, banks, IBANs, amounts and references only. Lines are paid through the pay
// lane's own bank result file path (submit, preview, apply), never by writing its evidence tables.
const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, feed: PostgresTransferPaidFeedStore, finance: string;
const policy: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
const now = () => new Date("2026-11-25T10:00:00Z");
const lifecycle = () => new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, policy, new PostgresTransferInvoiceEffects()), now);
const completes: BankResultCompletePort = async (tx, who, id) => (await lifecycle().transitionInTransaction(tx, who, id, "complete")).kind === "changed";
const bankResults = (complete = completes) => new PostgresBankResultStore(pool, policy, new PostgresTransferInvoiceEffects(), complete, async (_c, who) => who === finance);
const AUB_FIRST = ["Status", "Status Description", "Debit Narrative", "Credit Narrative"];
const AUB_HEAD = [...AUB_FIRST, ...AUB_RESULT_COLUMNS.filter((c) => !AUB_FIRST.includes(c))];

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  feed = new PostgresTransferPaidFeedStore({ pool });
  finance = await principal("finance");
});
after(async () => pool.end());

async function principal(prefix: string) {
  const id = `tp-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  return id;
}
/** A company with a store, and a transfer from it whose payment was received: one line per amount, each for a new person unless given. */
async function transfer(amounts: readonly (string | { amount: string; person: string })[], companyName = "Sultan Co", storeName = "Avenues") {
  const company = `tp-co-${randomUUID()}`, store = randomUUID(), id = randomUUID();
  await authz.upsertOrganization(createOrganization({ id: company, name: companyName }));
  await pool.query("INSERT INTO organization_profiles(org_id,name_en) VALUES($1,$2)", [company, companyName]);
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,$3,$4,$4)", [store, company, storeName, "a".repeat(64)]);
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,'2026-10-01','2026-10-31','KWD')", [id, company]);
  const lines: { id: string; person: string }[] = [];
  for (const a of amounts) {
    const { amount, person } = typeof a === "string" ? { amount: a, person: await principal("person") } : a;
    const line = `line-${randomUUID()}`;
    await pool.query("INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation) VALUES($1,$2,$3,$4,'KWD',$5,$5,'synthetic','{}')",
      [line, id, person, store, amount]);
    lines.push({ id: line, person });
  }
  const actor = { principalId: finance, actingAs: false };
  for (const action of ["lock", "payment_received"] as const) assert.equal((await lifecycle().transition(actor, id, action)).kind, "changed", action);
  return { id, company, lines };
}
/** A bank result file as the bank returns it (AUB): [status, reference or failure text, line id]. */
async function submit(...rows: [string, string, string][]) {
  const cells: BankCell[][] = [[], AUB_HEAD, ...rows.map(([status, reference, line]) => [status, reference, "x", line])];
  const result = await bankResults().submit({ principalId: finance, actingAs: false },
    { format: "aub", contentSha256: createHash("sha256").update(JSON.stringify(cells) + randomUUID()).digest("hex"), cells });
  assert.equal(result.kind, "submitted");
  return (result as { fileId: string }).fileId;
}
/** Finance previews the file, then applies exactly what it reviewed (as the finance page does). */
async function apply(fileId: string, store = bankResults()) {
  const who = { principalId: finance, actingAs: false };
  const review = await store.preview(who, fileId);
  assert.equal(review.kind, "review");
  return store.apply(who, fileId, review.kind === "review" ? review.reviewId : "");
}
const ref = () => `REF-${randomUUID()}`;
async function drain() { let total = 0; for (let n; (n = await feed.dispatch(1000, new Date())) > 0;) total += n; return total; }
const items = async (person: string) => (await pool.query("SELECT kind, subject_reference, parameters, created_at FROM notifications WHERE recipient_principal_id = $1", [person])).rows;
const service = () => { const store = PostgresNotificationsStore.connect({ pool }); return { store, feed: new NotificationsService(store, store, authz) }; };

test("COMMS_TRANSFER_PAID_FEED_PG an applied bank file reaches the paid line's person once, dated when the bank confirmed it; a preview sends nothing", async () => {
  await drain();
  const t = await transfer(["12.500"]), [l] = t.lines;
  const fileId = await submit(["SUCCESS", ref(), l!.id]);
  await bankResults().preview({ principalId: finance, actingAs: false }, fileId);
  assert.equal(await drain(), 0, "a preview is rolled back: no confirmation, no item");
  assert.equal((await apply(fileId)).kind, "applied");
  assert.deepEqual(await items(l!.person), [], "nothing before the job runs");
  assert.equal(await drain(), 1);
  assert.equal(await feed.dispatch(1000, new Date()), 0, "nothing left");
  const { id, recorded_at } = (await pool.query("SELECT id::text id, recorded_at FROM bank_result_confirmations WHERE line_id = $1", [l!.id])).rows[0];
  assert.deepEqual(await items(l!.person), [{ kind: "pay.transfer_paid", subject_reference: `bank_confirmation:${id}`, parameters: {}, created_at: recorded_at }]);
  assert.deepEqual(await items(finance), [], "the finance user who applied the file gets nothing");
});

test("COMMS_TRANSFER_PAID_FEED_RENDER the item shows the confirmed amount and where it was earned, opens pay history, and the bell counts it", async () => {
  await drain();
  const t = await transfer(["7.250", "1234.500"]), [l, big] = t.lines;
  await apply(await submit(["SUCCESS", ref(), l!.id], ["SUCCESS", ref(), big!.id]));
  await drain();
  const { store, feed: notifications } = service();
  await pool.query("UPDATE organizations SET name = 'Sultan Group' WHERE id = $1", [t.company]);
  const page = await notifications.list(l!.person, 1, ["pay.transfer_paid"]);
  assert.deepEqual(page.items.map((i) => [i.text, i.href, i.read]), [["KWD 7.250 for Avenues, Sultan Group has been transferred to your bank account.", "/pay", false]]);
  assert.equal(await notifications.count(l!.person), 1);
  const id = (await pool.query("SELECT id::text id FROM bank_result_confirmations WHERE line_id = $1", [l!.id])).rows[0].id;
  assert.deepEqual(await store.readTransferPayments(await principal("other"), [id]), [], "someone else's payment is never read");
  assert.deepEqual(await store.readTransferPayments(l!.person, ["0", "x", "9223372036854775808", "9999999999999999999"]), [], "references outside bigint are not read");
  // Legacy's number_format(amount, 3): thousands separated by commas.
  assert.deepEqual((await notifications.list(big!.person, 1)).items.map((i) => i.text), ["KWD 1,234.500 for Avenues, Sultan Group has been transferred to your bank account."]);
  await notifications.markAllRead(l!.person);
  assert.equal(await notifications.count(l!.person), 0);
});

test("COMMS_TRANSFER_PAID_FEED_NOT_PAID a failed row, a held row and an apply that rolls back send nothing", async () => {
  await drain();
  const t = await transfer(["10.000", "20.000"]), [failed, held] = t.lines;
  // FAIL is recorded as unpay; a success reference already used by another line is held as a conflict.
  const used = ref(), other = await transfer(["5.000"]);
  await apply(await submit(["SUCCESS", used, other.lines[0]!.id]));
  await apply(await submit(["FAIL", "Account closed", failed!.id], ["SUCCESS", used, held!.id]));
  assert.deepEqual((await pool.query("SELECT kind FROM bank_result_rows r JOIN pay_transfer_lines l ON l.id = ANY(r.line_ids) WHERE l.id = ANY($1) ORDER BY kind", [[failed!.id, held!.id]])).rows.map((r) => r.kind), ["hold", "unpay"]);
  assert.equal(await drain(), 1, "only the line on the other transfer was paid");
  assert.deepEqual(await items(failed!.person), []);
  assert.deepEqual(await items(held!.person), []);
  // Completing the transfer is refused inside the apply: the whole apply rolls back, so nothing is paid or sent.
  const solo = await transfer(["3.000"]), fileId = await submit(["SUCCESS", ref(), solo.lines[0]!.id]);
  await assert.rejects(apply(fileId, bankResults(async () => false)), /bank_result_complete_refused/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM bank_result_confirmations WHERE line_id = $1", [solo.lines[0]!.id])).rows[0].n, 0);
  assert.equal(await drain(), 0);
  assert.deepEqual(await items(solo.lines[0]!.person), []);
});

test("COMMS_TRANSFER_PAID_FEED_EVIDENCE a confirmation without an applied file's pay row for a paid line is never sent, shown or counted; a line set back to unpaid hides its item", async () => {
  await drain();
  // Written past the pay lane's apply: a pending file, a hold row, an unpaid line.
  const t = await transfer(["9.000"]), [l] = t.lines, file = randomUUID();
  await pool.query("INSERT INTO bank_result_files(id,format,content_sha256,uploaded_by,sheet) VALUES($1,'aub',$2,$3,'{}'::jsonb)", [file, createHash("sha256").update(file).digest("hex"), finance]);
  await pool.query("INSERT INTO bank_result_rows(file_id,row_number,kind,reason,line_ids,reference) VALUES($1,1,'hold','unmatched',$2,$3)", [file, [l!.id], ref()]);
  const forged = (await pool.query<{ id: string }>("INSERT INTO bank_result_confirmations(reference,line_id,file_id,row_number,amount,currency_code) VALUES($1,$2,$3,1,'9.000','KWD') RETURNING id::text", [ref(), l!.id, file])).rows[0]!.id;
  assert.equal(await drain(), 0, "marked done, nothing written");
  assert.equal((await pool.query("SELECT count(*)::int n FROM comms_dispatched_bank_confirmations WHERE confirmation_id = $1", [forged])).rows[0].n, 1);
  await pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'pay.transfer_paid',$2,'{}'::jsonb,$2)", [l!.person, `bank_confirmation:${forged}`]);
  const { feed: notifications } = service();
  assert.deepEqual((await notifications.list(l!.person, 1)).items, []);
  assert.equal(await notifications.count(l!.person), 0);
  // Each part of the evidence matters on its own, even for a line that is paid: the file applied, the row a pay row, the row naming this line.
  const forge = async (applied: boolean, kind: "pay" | "hold", rowNamesOther: boolean) => {
    const x = await transfer(["6.000", "6.000"]), [line, otherLine] = x.lines, f = randomUUID();
    await pool.query("UPDATE pay_transfer_lines SET paid = true WHERE id = $1", [line!.id]);
    await pool.query("INSERT INTO bank_result_files(id,format,content_sha256,uploaded_by,sheet) VALUES($1,'aub',$2,$3,'{}'::jsonb)", [f, createHash("sha256").update(f).digest("hex"), finance]);
    await pool.query("INSERT INTO bank_result_rows(file_id,row_number,kind,reason,line_ids,reference) VALUES($1,1,$2,$3,$4,$5)", [f, kind, kind === "hold" ? "unmatched" : null, [rowNamesOther ? otherLine!.id : line!.id], ref()]);
    if (applied) await pool.query("UPDATE bank_result_files SET status='applied',applied_by=$2,applied_at=now() WHERE id=$1", [f, finance]);
    const c = (await pool.query<{ id: string }>("INSERT INTO bank_result_confirmations(reference,line_id,file_id,row_number,amount,currency_code) VALUES($1,$2,$3,1,'6.000','KWD') RETURNING id::text", [ref(), line!.id, f])).rows[0]!.id;
    assert.equal(await drain(), 0, `applied=${applied} kind=${kind} other=${rowNamesOther}: nothing written`);
    await pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'pay.transfer_paid',$2,'{}'::jsonb,$2)", [line!.person, `bank_confirmation:${c}`]);
    assert.deepEqual((await notifications.list(line!.person, 1)).items, [], `applied=${applied} kind=${kind} other=${rowNamesOther}: not shown`);
    assert.equal(await notifications.count(line!.person), 0, `applied=${applied} kind=${kind} other=${rowNamesOther}: not counted`);
  };
  await forge(false, "pay", false);
  await forge(true, "hold", false);
  await forge(true, "pay", true);
  // A real payment, then the line set back to unpaid: the item is no longer shown or counted.
  const p = await transfer(["4.000"]), [paid] = p.lines;
  await apply(await submit(["SUCCESS", ref(), paid!.id]));
  await drain();
  assert.equal(await notifications.count(paid!.person), 1);
  await pool.query("UPDATE pay_transfer_lines SET paid = false WHERE id = $1", [paid!.id]);
  assert.deepEqual((await notifications.list(paid!.person, 1)).items, []);
  assert.equal(await notifications.count(paid!.person), 0);
});

test("COMMS_TRANSFER_PAID_FEED_ONCE racing workers write one item, and a confirmation already marked is never dispatched", async () => {
  await drain();
  const t = await transfer(["12.500", "12.500"]), [l, m] = t.lines;
  await apply(await submit(["SUCCESS", ref(), l!.id]));
  const results = await Promise.all([feed.dispatch(1000, new Date()), feed.dispatch(1000, new Date()), feed.dispatch(1000, new Date())]);
  assert.equal(results.reduce((a, b) => a + b, 0), 1);
  assert.equal((await items(l!.person)).length, 1);
  await apply(await submit(["SUCCESS", ref(), m!.id]));
  const id = (await pool.query("SELECT id FROM bank_result_confirmations WHERE line_id = $1", [m!.id])).rows[0].id;
  await pool.query("INSERT INTO comms_dispatched_bank_confirmations(confirmation_id, dispatched_at) VALUES($1, now())", [id]);
  assert.equal(await drain(), 0);
  assert.deepEqual(await items(m!.person), []);
});

test("COMMS_TRANSFER_PAID_FEED_PAYLOAD the database takes only an empty payload and a confirmation reference; a stored reference past bigint does not break the page", async () => {
  const person = await principal("payload");
  const insert = (reference: string, parameters: string) => pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key) VALUES($1,'pay.transfer_paid',$2,$3::jsonb,$4)", [person, reference, parameters, `k-${randomUUID()}`]);
  await assert.rejects(insert("bank_confirmation:1", '{"amount":"1.000"}'), { code: "23514" });
  await assert.rejects(insert("bank_confirmation:0", "{}"), { code: "23514" });
  await assert.rejects(insert(`work_assignment:${randomUUID()}`, "{}"), { code: "23514" });
  await insert("bank_confirmation:42", "{}");
  await insert("bank_confirmation:9999999999999999999", "{}");
  const { feed: notifications } = service();
  assert.deepEqual((await notifications.list(person, 1)).items, []);
  assert.equal(await notifications.count(person), 0);
});

// GPT's payroll acceptance follow-through on desk #393: synthetic data only, no real account, no production action.
const SECRET = "comms-paid-feed-e2e-secret-at-least-thirty-two-bytes";
const VALID_IBAN = "KW81CBKU0000000000001234560101";
const MALFORMED_IBAN = "KW81CBKU0000000000001234560102"; // one digit off: the checksum fails
async function bank(status: "active" | "deleted") {
  const id = randomUUID(), at = new Date("2026-10-01T00:00:00Z");
  await pool.query(`INSERT INTO catalogue_items (id, catalogue_type, name, normalized_name, status, created_by_ref, updated_by_ref, created_at, updated_at, deleted_at)
    VALUES ($1, 'bank', $2, $2, $3, $4, $4, $5, $5, $6)`, [id, `Synthetic bank ${id.slice(0, 8)}`, status, "a".repeat(64), at, status === "deleted" ? at : null]);
  return id;
}

test("COMMS_TRANSFER_PAID_FEED_E2E an ended placement's unpaid line: refused bank details leave it unresolved and silent; once paid, only that person gets one notice", async () => {
  await drain();
  const banks = new PostgresFinanceReferenceResolver(pool), details = new PostgresBankDetailsStore({ pool });
  const t = await transfer(["15.000", "15.000"]), [mine, theirs] = t.lines;
  const store = (await pool.query("SELECT store_id FROM pay_transfer_lines WHERE id = $1", [mine!.id])).rows[0].store_id;
  for (const line of [mine!, theirs!]) {
    await authz.grantMany(line.person, [{ orgId: t.company, role: "candidate" }]);
    // The placement the line pays for has ended.
    await pool.query(`INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by)
      VALUES($1,$2,$3,$4,'{}'::jsonb,'2026-09-01','2026-10-31','staff',$5)`, [randomUUID(), line.person, t.company, store, finance]);
  }
  const supported = await bank("active"), unsupported = await bank("deleted");
  const name = "Synthetic Beneficiary";
  // The two refusals are told apart: a malformed IBAN, and a well-formed IBAN at a bank payroll does not support.
  await assert.rejects(validateBankDetails({ bankId: supported, iban: MALFORMED_IBAN, beneficiaryName: name }, banks), (e) => e instanceof BankDetailError && e.code === "invalid_iban");
  await assert.rejects(validateBankDetails({ bankId: unsupported, iban: VALID_IBAN, beneficiaryName: name }, banks), (e) => e instanceof BankDetailError && e.code === "invalid_bank");
  await assert.rejects(validateBankDetails({ bankId: randomUUID(), iban: VALID_IBAN, beneficiaryName: name }, banks), (e) => e instanceof BankDetailError && e.code === "invalid_bank");
  // The person's own save refuses both and stores nothing.
  const writer = buildBankDetailsWrite({ store: details.forPrincipal(mine!.person), secret: SECRET, check: catalogueBankDetailsCheck(banks) });
  const principalRef = principalAuditRef(mine!.person);
  const change = (d: BankDetails) => ({ personRef: bankDetailsRecordRef(mine!.person), field: BANK_DETAILS_FIELD, value: bankDetailsValue(d) });
  for (const refused of [{ bankId: supported, iban: MALFORMED_IBAN, beneficiaryName: name }, { bankId: unsupported, iban: VALID_IBAN, beneficiaryName: name }]) {
    assert.deepEqual(await writer.preview({ principalRef, change: change(refused) }), { ok: false, reason: "invalid_value" });
  }
  // Visibly unresolved: no details on file (what the missing bank info counter reads), the line unpaid, the transfer still distributing; no notice.
  assert.deepEqual(await details.principalsWithoutDetails([mine!.person]), [mine!.person]);
  assert.deepEqual((await pool.query("SELECT l.paid, t.status FROM pay_transfer_lines l JOIN pay_transfers t ON t.id = l.transfer_id WHERE l.id = $1", [mine!.id])).rows[0], { paid: false, status: "distributing" });
  assert.equal(await drain(), 0);
  assert.deepEqual(await items(mine!.person), []);
  // A supported synthetic beneficiary is saved, and the bank confirms only this person's line.
  const good = { bankId: supported, iban: VALID_IBAN, beneficiaryName: name };
  const preview = await writer.preview({ principalRef, change: change(good) });
  assert.ok(preview.ok, JSON.stringify(preview));
  assert.ok((await writer.confirm({ principalRef, change: change(good), token: preview.token })).ok);
  assert.deepEqual(await details.principalsWithoutDetails([mine!.person]), []);
  await apply(await submit(["SUCCESS", ref(), mine!.id]));
  assert.equal(await drain(), 1);
  assert.equal(await drain(), 0);
  assert.equal((await items(mine!.person)).length, 1, "exactly one notice for the paid line");
  assert.deepEqual(await items(theirs!.person), [], "the unpaid colleague on the same transfer gets nothing");
  assert.equal((await pool.query("SELECT status FROM pay_transfers WHERE id = $1", [t.id])).rows[0].status, "distributing", "one line is still unpaid");
});
