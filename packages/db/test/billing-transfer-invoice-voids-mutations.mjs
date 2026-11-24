import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Invoices lane, void and credit notes (F4.7): every guard of the void must be load-bearing. Each
// mutant rewrites one built module or the migration, the named test must fail by assertion, and the
// file is restored before the next. PostgreSQL is required.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for transfer invoice void mutations (scratch PostgreSQL)");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const postgres = "dist/packages/db/test/postgres-billing-transfer-invoice-voids.test.js";
const voids = "packages/db/dist/billing/postgres-transfer-invoice-voids.js";
const reads = "packages/db/dist/billing/postgres-transfer-invoice-reads.js";
const migration = "packages/db/migrations/0594_transfer_invoice_credit.sql";
const mutations = [
  // Voiding with another reason, or not voiding at all, now fails at commit in the database
  // (TRANSFER_INVOICE_VOID_PAIRED proves that trigger), so the store mutants test what is left to it.
  ["date the credit note on another day", "TRANSFER_INVOICE_VOID_PRESERVES_HISTORY", voids,
    "invoice.currency_code, transfer.today, invoice.total", "invoice.currency_code, '2026-01-01', invoice.total"],
  ["credit an invoice a second time", "TRANSFER_INVOICE_VOID_PRESERVES_HISTORY", voids,
    'if (invoice.void_reason === "credited") {', "if (false) {"],
  ["credit a draft's unpaid invoice", "TRANSFER_INVOICE_VOID_REFUSED", voids,
    'if (invoice.status !== "paid" && !["locked", "payment_sent"].includes(transfer.status))', "if (false)"],
  ["accept an over-long reason", "TRANSFER_INVOICE_VOID_REFUSED", voids,
    "[...value].length > CREDIT_REASON_MAX", "[...value].length > 2 * CREDIT_REASON_MAX"],
  ["let a credit note differ from its invoice's total", "TRANSFER_INVOICE_VOID_GUARDED", migration,
    "AND i.total = NEW.total", ""],
  ["let a credit note bill another company", "TRANSFER_INVOICE_VOID_GUARDED", migration,
    "AND i.org_id = NEW.org_id", ""],
  ["mark an invoice credited without its credit note", "TRANSFER_INVOICE_VOID_GUARDED", migration,
    "AND EXISTS (SELECT 1 FROM transfer_invoice_credit c WHERE c.invoice_number = OLD.invoice_number)", ""],
  ["commit a credit note beside a live invoice", "TRANSFER_INVOICE_VOID_PAIRED", migration,
    "CREATE CONSTRAINT TRIGGER transfer_invoice_credit_voids_invoice AFTER INSERT ON transfer_invoice_credit\n  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION transfer_invoice_credit_paired();", ""],
  ["hide a credited invoice once its transfer is unlocked", "TRANSFER_INVOICE_VOID_VISIBLE", reads,
    "OR t.status IN ('locked', 'payment_sent') OR i.void_reason = 'credited')", "OR t.status IN ('locked', 'payment_sent'))"],
  ["leave credit notes off the statement", "TRANSFER_INVOICE_VOID_PAID", reads,
    "FROM docs WHERE credit_number IS NOT NULL", "FROM docs WHERE false"],
  ["count a credit note as a payment", "TRANSFER_INVOICE_VOID_PAID", reads,
    'else if (row.kind === "payment")', 'else if (row.kind !== "invoice")'],
  ["leave credits out of a company's closing balance", "TRANSFER_INVOICE_VOID_PAID", reads,
    "const closing = m.opening + m.invoiced - m.paid - m.credited;", "const closing = m.opening + m.invoiced - m.paid;"],
  ["leave credits out of the currency's closing balance", "TRANSFER_INVOICE_VOID_PAID", reads,
    "closing: fromFils(t.opening + t.invoiced - t.paid - t.credited)", "closing: fromFils(t.opening + t.invoiced - t.paid)"],
];

function run(files, pattern) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
    ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), ...files],
  { cwd: root, env: process.env, encoding: "utf8", timeout: 120_000 });
  return { ...result, output: result.stdout + result.stderr };
}
function green(label) {
  const result = run([postgres]);
  assert.equal(result.error, undefined, `${label}: runner error`);
  assert.equal(result.status, 0, `${label} must pass\n${result.output}`);
  assert.match(result.output, /# skipped 0\b/);
  console.log(`${label}: suite green`);
}
green("baseline");
let killed = 0;
for (const [name, title, path, from, to] of mutations) {
  const target = `${root}${path}`;
  const original = readFileSync(target, "utf8");
  assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
  try {
    writeFileSync(target, original.replace(from, to));
    const result = run([postgres], title);
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: survived\n${result.output}`);
    assert.match(result.output, new RegExp(`not ok \\d+ - ${title} `), `${name}: named test did not fail\n${result.output}`);
    assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND|hookFailed|ECONNREFUSED/, `${name}: infrastructure failure\n${result.output}`);
    assert.match(result.output, /code: 'ERR_ASSERTION'/, `${name}: must fail by assertion\n${result.output}`);
    killed++;
    console.log(`KILLED ${name} -> ${title}`);
  } finally { writeFileSync(target, original); }
}
green("restored");
console.log(`${killed}/${mutations.length} transfer invoice void mutations killed`);
