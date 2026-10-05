import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { allocateInvoiceNumber, type InvoiceNumberRequest } from "../src/numbering.js";
import { canonicalInvoiceBody, FixtureInvoiceBodyStore, type InvoiceContent } from "../src/document.js";
import { issueInvoice, resolveInvoice } from "../src/postgres-invoice-store.js";

const url = process.env.DATABASE_URL;
let admin: pg.Pool;
let pool: pg.Pool;
let schema: string;
let bodies: FixtureInvoiceBodyStore;
const fixture = { accountId: "account-a", accountPrefix: "ACME", period: "2026-09",
  groupId: "group-a", orgId: "org-a", kind: "subtotal" as const,
  issuedAt: "2026-09-30T12:00:00.000Z", amount: "12.345", scale: 3,
  capturedOrgName: "Synthetic Acme", capturedStoreNames: ["Synthetic Cafe"] };
const second = { ...fixture, accountId: "account-b", accountPrefix: "BETA", groupId: "group-b", orgId: "org-b" };

before(async () => {
  assert.ok(url, "DATABASE_URL must point to a disposable scratch PostgreSQL database");
  admin = new pg.Pool({ connectionString: url });
});
beforeEach(async () => {
  schema = `invoice_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000` });
  bodies = new FixtureInvoiceBodyStore();
  await runMigrations(pool);
});
afterEach(async () => {
  await pool?.end();
  if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
});
after(async () => { await admin?.end(); });

async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
const issue = (change: Partial<InvoiceNumberRequest & InvoiceContent> = {}) => tx(c => issueInvoice(c, bodies, { ...fixture, ...change }));
const resolve = (number: string, accountId = fixture.accountId) => tx(c => resolveInvoice(c, bodies, accountId, number));

test("SHU-264/AC-01 concurrent-issue-one-number", async () => {
  await tx(c => allocateInvoiceNumber(c, fixture)); // committed counter row before the race
  const one = await pool.connect();
  const two = await pool.connect();
  let pending: Promise<{ number?: string; error?: unknown }> | undefined;
  try {
    await one.query("BEGIN");
    await two.query("BEGIN");
    const first = await allocateInvoiceNumber(one, fixture);
    const pid = (await two.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    pending = allocateInvoiceNumber(two, fixture).then(number => ({ number }), error => ({ error }));
    // Wait for actual PG lock contention, not an arbitrary sleep. With the
    // FOR UPDATE mutant the second read is stale and its UPDATE blocks instead.
    let blocked = false;
    for (let i = 0; i < 400; i++) {
      const { rows } = await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid]);
      if (rows[0]?.wait_event_type === "Lock") { blocked = true; break; }
      await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(blocked, "second allocation must wait for the caller's first transaction");
    await one.query("COMMIT");
    const result = await pending;
    assert.equal(result.error, undefined, "both concurrent allocations must succeed");
    await two.query("COMMIT");
    assert.deepEqual([first, result.number], ["ACME-2026-09-000002", "ACME-2026-09-000003"]);
    assert.equal(await tx(c => allocateInvoiceNumber(c, second)), "BETA-2026-09-000001");
  } finally {
    await one.query("ROLLBACK");
    await pending;
    await two.query("ROLLBACK");
    one.release(); two.release();
  }
});

test("SHU-264/AC-02 renumber-after-void", async () => {
  // Make the independent counter deliberately diverge from document count/id.
  await tx(c => allocateInvoiceNumber(c, fixture));
  await tx(c => allocateInvoiceNumber(c, fixture));
  const original = await issue();
  const credit = await issue({ kind: "credit", creditOf: original.invoiceNumber, amount: "-12.345" });
  const later = await issue({ period: "2026-10" });
  assert.deepEqual([original.invoiceNumber, credit.invoiceNumber, later.invoiceNumber],
    ["ACME-2026-09-000003", "ACME-2026-09-000004", "ACME-2026-10-000005"]);
  assert.equal(credit.creditOf, original.invoiceNumber);
  assert.deepEqual((await resolve(original.invoiceNumber))?.document, original);
  const ids = (await pool.query("SELECT id FROM invoice_document ORDER BY id")).rows.map(r => r.id);
  assert.deepEqual(ids, ["1", "2", "3"]);
  await assert.rejects(tx(c => issueInvoice(c, bodies, { ...second, kind: "credit", creditOf: original.invoiceNumber })), /original not found/);
});

test("SHU-264/AC-03 issued-doc-unchanged", async () => {
  await pool.query("INSERT INTO organizations (id, name) VALUES ('org-a', 'Synthetic Acme'), ('org-b', 'Synthetic Beta')");
  await pool.query("CREATE TABLE invoice_fixture_stores (id text PRIMARY KEY, org_id text, name text)");
  await pool.query("INSERT INTO invoice_fixture_stores VALUES ('store-a', 'org-a', 'Synthetic Cafe')");
  const original = await issue();
  const before = await resolve(original.invoiceNumber);
  await pool.query("UPDATE organizations SET name = 'Renamed Org' WHERE id = 'org-a'");
  await pool.query("UPDATE invoice_fixture_stores SET org_id = 'org-b', name = 'Moved Cafe' WHERE id = 'store-a'");
  await assert.doesNotReject(async () => {
    const after = await resolve(original.invoiceNumber);
    assert.deepEqual(after, before);
    assert.equal(after?.document.capturedOrgName, "Synthetic Acme");
    assert.deepEqual(after?.document.capturedStoreNames, ["Synthetic Cafe"]);
    assert.equal(after?.document.bodyHash, original.bodyHash);
  });
  assert.equal(await resolve(original.invoiceNumber, second.accountId), undefined);
});

test("SHU-264/AC-04 document-immutable", async () => {
  const doc = await issue();
  for (const sql of ["UPDATE invoice_document SET document = document", "DELETE FROM invoice_document", "TRUNCATE invoice_document"]) {
    await assert.rejects(pool.query(sql), { code: "23514" });
  }
  assert.deepEqual((await resolve(doc.invoiceNumber))?.document, doc);
  for (const sql of ["UPDATE billing_sequence SET last_sequence = 0", "UPDATE billing_sequence SET account_prefix = 'OTHER'",
    "DELETE FROM billing_sequence", "TRUNCATE billing_sequence CASCADE"]) {
    await assert.rejects(pool.query(sql), { code: "23514" });
  }
});

test("SHU-264/AC-05 tax-shape-open", async () => {
  await assert.doesNotReject(async () => {
    const zero = await issue();
    const taxable = await issue({ taxTotal: "1.250" });
    assert.equal((await resolve(zero.invoiceNumber))?.document.taxTotal, "0.000");
    assert.equal((await resolve(taxable.invoiceNumber))?.document.taxTotal, "1.250");
    const scaled = await issue({ amount: "12.34", scale: 2, taxTotal: "1.25", taxScale: 2 });
    assert.equal((await resolve(scaled.invoiceNumber))?.document.taxTotal, "1.25");
  });
});

test("SHU-264/AC-06 legacy-namespace", async () => {
  await assert.rejects(tx(c => allocateInvoiceNumber(c, { ...fixture, accountPrefix: "LEGACY" })));
  await assert.rejects(pool.query("INSERT INTO billing_sequence VALUES ('legacy', 'LEGACY', 0)"), { code: "23514" });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM billing_sequence")).rows[0].n, 0);
});

test("SHU-264/AC-07 decimal-string-only", async () => {
  for (const amount of [12.345, "12.34", "1e3", "1.2.3", ""]) await assert.rejects(issue({ amount }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM invoice_document")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM billing_sequence")).rows[0].n, 0);
});

test("SHU-264/parity-contract", async () => {
  await assert.doesNotReject(async () => {
    const original = await issue({ kind: "consolidated", orgId: null });
    const other = await tx(c => issueInvoice(c, bodies, second));
    const credit = await issue({ kind: "credit", orgId: null, creditOf: original.invoiceNumber, amount: "-12.345" });
    const subtotal = await issue({ taxTotal: "1.250" });
    assert.equal(original.invoiceNumber, "ACME-2026-09-000001");
    assert.equal(other.invoiceNumber, "BETA-2026-09-000001");
    assert.equal(credit.invoiceNumber, "ACME-2026-09-000002");
    assert.equal(subtotal.invoiceNumber, "ACME-2026-09-000003");
    assert.equal((await resolve(subtotal.invoiceNumber))?.document.taxTotal, "1.250");
    assert.deepEqual((await resolve(original.invoiceNumber))?.body, Uint8Array.from(canonicalInvoiceBody(original)));
    await assert.rejects(pool.query("DELETE FROM invoice_document WHERE invoice_number = $1", [original.invoiceNumber]), { code: "23514" });
    await assert.rejects(issue({ accountPrefix: "LEGACY" }));
    await assert.rejects(issue({ amount: 12345 }));
    assert.equal(await resolve(original.invoiceNumber, second.accountId), undefined);
  });
});

test("transaction ownership, rollback, namespace binding and failed body writes", async () => {
  const client = await pool.connect();
  try { await assert.rejects(allocateInvoiceNumber(client, fixture), { code: "25P01" }); }
  finally { client.release(); }
  await assert.rejects(tx(async c => {
    await issueInvoice(c, bodies, fixture);
    throw new Error("caller aborts");
  }), /caller aborts/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM invoice_document")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM billing_sequence")).rows[0].n, 0);
  await assert.rejects(tx(c => issueInvoice(c, { put: async () => { throw new Error("body unavailable"); }, get: bodies.get.bind(bodies) }, fixture)), /body unavailable/);
  const original = await issue();
  assert.equal(original.invoiceNumber, "ACME-2026-09-000001");
  await assert.rejects(issue({ accountPrefix: "OTHER" }), /already bound/);
  await assert.rejects(tx(c => allocateInvoiceNumber(c, { ...second, accountPrefix: "ACME" })), { code: "23505" });
  const row = (await pool.query("SELECT object_ref FROM invoice_document")).rows[0];
  await assert.rejects(tx(c => resolveInvoice(c, { put: bodies.put.bind(bodies), get: async () => Buffer.from("tampered") }, fixture.accountId, original.invoiceNumber)), /integrity/);
  assert.ok(row.object_ref);
  assert.deepEqual((await resolve(original.invoiceNumber))?.document, original);
});

test("concurrent first issues create one namespace and sequence without precision loss", async () => {
  const docs = await Promise.all([issue(), issue()]);
  assert.deepEqual(docs.map(d => d.invoiceNumber).sort(), ["ACME-2026-09-000001", "ACME-2026-09-000002"]);
  await pool.query("UPDATE billing_sequence SET last_sequence = 9007199254740992 WHERE account_id = 'account-a'");
  assert.equal((await issue()).invoiceNumber, "ACME-2026-09-9007199254740993");
});
