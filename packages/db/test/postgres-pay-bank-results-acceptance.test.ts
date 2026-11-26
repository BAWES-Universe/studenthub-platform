import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresNotificationsStore, runMigrations } from "@studenthub/db";
import { PostgresBankResultStore, PostgresTransferInvoiceEffects, bankResultLifecyclePolicy, operatorFinanceGate, type BankResultCompletePort } from "@studenthub/db/billing";
import { PostgresTransferInitiatedFeedStore, PostgresTransferPaidFeedStore } from "@studenthub/db/comms";
import { AUB_RESULT_COLUMNS, type BankCell } from "../../billing/src/bank-results.js";
import { TRANSFER_INVOICE_VOID_ROLE, transferInvoiceVoidDecision } from "../../billing/src/transfer-invoice-access.js";
import { NotificationsService } from "../../notifications/src/notifications.js";
import { DEFAULT_OPERATOR_ORG_IDS } from "../../organizations/src/organizations.js";
import { TransferLifecycleService } from "../../payroll/src/transfer-lifecycle.js";
import { PostgresTransferLifecycleStore, type PayLifecyclePolicy } from "../src/payroll/postgres-transfer-lifecycle-store.js";
import { createBankResultsHttp, handleBankResults } from "../../../apps/gateway/src/billing/bank-results-http.js";

// Acceptance, synthetic data only: one transfer with a paid line and a held line, end to end.
// Payment received puts the transfer in both people's feeds; a bank result file pays one line and holds
// the other; only the paid person hears it was paid; and a central Finance-only user traces the held
// line from the ordinary bank result pages, wired as production. Apply is called on the store, as the
// page's apply would; switching Apply on and native AUB/KFH files stay separate.
const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore;
const allow: PayLifecyclePolicy = { authorize: async () => true, unassignedPersonIds: async () => [] };
const lifecycle = () => new TransferLifecycleService(new PostgresTransferLifecycleStore(pool, allow, new PostgresTransferInvoiceEffects()), () => new Date());
const complete: BankResultCompletePort = async (tx, who, id) => (await lifecycle().transitionInTransaction(tx, who, id, "complete")).kind === "changed";
const AUB_FIRST = ["Status", "Status Description", "Debit Narrative", "Credit Narrative"];
const AUB_HEAD = [...AUB_FIRST, ...AUB_RESULT_COLUMNS.filter((c) => !AUB_FIRST.includes(c))];

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
});
after(async () => pool.end());

async function principal(prefix: string) {
  const id = `pba-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  return id;
}

test("PAY_BANK_ACCEPTANCE one transfer, a paid line and a held line: both people see it initiated, only the paid one sees it paid, and central Finance traces the held line", async (t) => {
  // StudentHub as production has it: the central operator, a company under it, and a Finance-only user.
  for (const id of DEFAULT_OPERATOR_ORG_IDS) await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES($1,'StudentHub',NULL) ON CONFLICT (id) DO NOTHING", [id]);
  const company = `pba-co-${randomUUID()}`, store = randomUUID();
  await pool.query("INSERT INTO organizations(id,name,parent_org_id) VALUES($1,'Sultan Co',$2)", [company, DEFAULT_OPERATOR_ORG_IDS[0]]);
  await pool.query("INSERT INTO organization_profiles(org_id,name_en) VALUES($1,'Sultan Co')", [company]);
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Avenues',$3,$3)", [store, company, "a".repeat(64)]);
  const finance = await principal("finance");
  for (const org of DEFAULT_OPERATOR_ORG_IDS) await pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES($1,$2,$3,'subtree')", [finance, org, TRANSFER_INVOICE_VOID_ROLE]);
  assert.deepEqual((await pool.query("SELECT DISTINCT role FROM grants WHERE principal_id = $1", [finance])).rows, [{ role: "finance" }], "Finance only, no second role");

  // The transfer: Amal will be paid, Badr held. Lock, then payment received.
  const amal = await principal("amal"), badr = await principal("badr"), transfer = randomUUID();
  const paidLine = `line-${randomUUID()}`, heldLine = `line-${randomUUID()}`;
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,'2026-10-01','2026-10-31','KWD')", [transfer, company]);
  for (const [line, person, amount] of [[paidLine, amal, "12.500"], [heldLine, badr, "20.000"]] as const) {
    await pool.query("INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation) VALUES($1,$2,$3,$4,'KWD',$5,$5,'synthetic','{}')",
      [line, transfer, person, store, amount]);
  }
  const actor = { principalId: finance, actingAs: false };
  for (const action of ["lock", "payment_received"] as const) assert.equal((await lifecycle().transition(actor, transfer, action)).kind, "changed", action);

  // Both people hear the transfer was initiated.
  const initiated = new PostgresTransferInitiatedFeedStore({ pool }), paidFeed = new PostgresTransferPaidFeedStore({ pool });
  const drain = async (feed: { dispatch(limit: number, at: Date): Promise<number> }) => { while (await feed.dispatch(1000, new Date()) > 0); };
  await drain(initiated); await drain(paidFeed);
  const notes = PostgresNotificationsStore.connect({ pool }), feed = new NotificationsService(notes, notes, authz);
  const texts = async (person: string) => (await feed.list(person, 1)).items.map((i) => i.text).sort();
  assert.deepEqual(await texts(amal), ["New transfer initiated: KWD 12.500 for Avenues, Sultan Co."]);
  assert.deepEqual(await texts(badr), ["New transfer initiated: KWD 20.000 for Avenues, Sultan Co."]);

  // The bank file: Amal's line succeeds; Badr's row repeats a reference already used for another line, so it is held.
  const bank = new PostgresBankResultStore(pool, bankResultLifecyclePolicy((g, org, up) => transferInvoiceVoidDecision(g, org, up, DEFAULT_OPERATOR_ORG_IDS)),
    new PostgresTransferInvoiceEffects(), complete, operatorFinanceGate(DEFAULT_OPERATOR_ORG_IDS, TRANSFER_INVOICE_VOID_ROLE));
  const submitAndApply = async (...rows: [string, string][]) => {
    const cells: BankCell[][] = [[], AUB_HEAD, ...rows.map(([reference, line]) => ["SUCCESS", reference, "x", line])];
    const up = await bank.submit(actor, { format: "aub", contentSha256: createHash("sha256").update(JSON.stringify(cells) + randomUUID()).digest("hex"), cells });
    assert.equal(up.kind, "submitted");
    const fileId = (up as { fileId: string }).fileId, review = await bank.preview(actor, fileId);
    assert.equal(review.kind, "review");
    assert.equal((await bank.apply(actor, fileId, review.kind === "review" ? review.reviewId : "")).kind, "applied");
    return fileId;
  };
  const used = `REF-${randomUUID()}`, otherLine = `line-${randomUUID()}`, other = randomUUID();
  await pool.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,'2026-10-01','2026-10-31','KWD')", [other, company]);
  await pool.query("INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation) VALUES($1,$2,$3,$4,'KWD','5.000','5.000','synthetic','{}')",
    [otherLine, other, await principal("other"), store]);
  for (const action of ["lock", "payment_received"] as const) await lifecycle().transition(actor, other, action);
  await submitAndApply([used, otherLine]);
  const fileId = await submitAndApply([`REF-${randomUUID()}`, paidLine], [used, heldLine]);
  assert.deepEqual((await pool.query("SELECT id, paid FROM pay_transfer_lines WHERE transfer_id = $1 ORDER BY id = $2 DESC", [transfer, paidLine])).rows, [{ id: paidLine, paid: true }, { id: heldLine, paid: false }]);

  // Only Amal hears the payment.
  await drain(paidFeed);
  assert.deepEqual(await texts(amal), ["KWD 12.500 for Avenues, Sultan Co has been transferred to your bank account.", "New transfer initiated: KWD 12.500 for Avenues, Sultan Co."]);
  assert.deepEqual(await texts(badr), ["New transfer initiated: KWD 20.000 for Avenues, Sultan Co."], "the held line's person is not told it was paid");

  // Central Finance traces the held line from the ordinary pages, wired as apps/gateway/src/wiring/billing.ts does.
  const gate = operatorFinanceGate(DEFAULT_OPERATOR_ORG_IDS, TRANSFER_INVOICE_VOID_ROLE);
  const session = "s".repeat(43);
  const service = createBankResultsHttp({ sessions: { get: async (id: string) => (id === session ? { personId: finance } : undefined) as never }, store: bank, origin: "https://studenthub.test.invalid",
    allowed: async (viewer) => { const c = await pool.connect(); try { return await gate(c, viewer); } finally { c.release(); } } });
  const server = createServer(async (req, res) => { if (!await handleBankResults(req, res, service)) { res.writeHead(418); res.end(); } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = async (path: string) => {
    const res = await fetch(base + path, { headers: { cookie: `__Host-studenthub_session=${session}`, accept: "text/html" } });
    assert.equal(res.status, 200, path);
    return res.text();
  };
  const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heldLink = new RegExp(`<a href="(/finance/bank-results/transfers/[^"#]+)#line-${escaped(heldLine)}">${escaped(heldLine)}</a> \\(unpaid\\)`);
  const list = await page("/finance/bank-results");
  assert.match(list, /<a href="\/finance\/bank-results\/held">Held bank rows<\/a>/);
  const held = heldLink.exec(await page("/finance/bank-results/held"));
  assert.ok(held, "the held row names Badr's line, unpaid, linked to its transfer");
  assert.equal(decodeURIComponent(held[1]!.split("/").pop()!), transfer);
  const record = await page(held[1]!);
  assert.match(record, new RegExp(`<tr id="line-${escaped(heldLine)}">[\\s\\S]*?<td>Unpaid</td><td><a href="/finance/bank-results/${fileId}">[^<]*</a> row 4: held\\.`), "the held line reads unpaid, with the file and row that held it");
  assert.match(record, new RegExp(`<tr id="line-${escaped(paidLine)}">[\\s\\S]*?<td>Paid: bank reference REF-`), "and the paid line beside it, with its bank payment");
  assert.match(await page(`/finance/bank-results/${fileId}`), new RegExp(`<a href="[^"]+#line-${escaped(heldLine)}">${escaped(heldLine)}</a>`), "the file itself links the held line too");
});
