import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Run serially on a built checkout with DATABASE_URL pointing to scratch PG.
// Every DB test creates/drops only its unique schema. No public/shared tables
// are cleared. Missing PostgreSQL is a failure, never a green mutation skip.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for invoice mutations (scratch PostgreSQL)");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const built = "dist/packages/billing/";
const unit = `${built}test/document.test.js`;
const numbering = `${built}test/numbering.test.js`;
const postgres = `${built}test/invoice-postgres.test.js`;
const numberSource = `${built}src/numbering.js`;
const documentSource = `${built}src/document.js`;
const decimalSource = `${built}src/decimal-string.js`;
const storeSource = `${built}src/postgres-invoice-store.js`;
const migration = "packages/db/migrations/0185b_invoice_document.sql";
const taxReject = ["const captured = {", 'if (input.taxTotal !== undefined && input.taxTotal !== "0.000") throw new TypeError("tax disabled");\n    const captured = {'];
const mutations = [
  ["remove FOR UPDATE", "SHU-264/AC-01 concurrent-issue-one-number", postgres, numberSource,
    "account_id = $1 FOR UPDATE", "account_id = $1"],
  ["derive number from document row identity", "SHU-264/AC-02 renumber-after-void", postgres, numberSource,
    'return `${input.accountPrefix}-${input.period}-${sequence.toString().padStart(6, "0")}`;',
    'const rowId = (await client.query("SELECT nextval(pg_get_serial_sequence(\'invoice_document\', \'id\'))::text AS id")).rows[0].id;\n    return `${input.accountPrefix}-${input.period}-${rowId.padStart(6, "0")}`;'],
  ["resolve names live", "SHU-264/AC-03 issued-doc-unchanged", postgres, storeSource,
    "SELECT document, body_hash, object_ref FROM invoice_document",
    "SELECT jsonb_set(document, '{capturedOrgName}', to_jsonb((SELECT name FROM organizations WHERE id = invoice_document.org_id))) AS document, body_hash, object_ref FROM invoice_document"],
  ["export an update path", "SHU-264/AC-04 document-immutable", unit, storeSource,
    "export async function issueInvoice", "export async function updateInvoice() {}\nexport async function issueInvoice"],
  ["remove update/delete trigger", "SHU-264/AC-04 document-immutable", postgres, migration,
    "CREATE TRIGGER invoice_document_no_change BEFORE UPDATE OR DELETE ON invoice_document\n  FOR EACH ROW EXECUTE FUNCTION invoice_document_immutable();", ""],
  ["remove truncate trigger", "SHU-264/AC-04 document-immutable", postgres, migration,
    "CREATE TRIGGER invoice_document_no_truncate BEFORE TRUNCATE ON invoice_document\n  FOR EACH STATEMENT EXECUTE FUNCTION invoice_document_immutable();", ""],
  ["reject non-zero tax", "SHU-264/AC-05 tax-shape-open", postgres, documentSource, ...taxReject],
  ["remove reserved prefix guard", "SHU-264/AC-06 legacy-namespace", numbering, numberSource,
    "|| /^LEGACY(?:-|$)/.test(input.accountPrefix)", ""],
  ["remove database reserved prefix guard", "SHU-264/AC-06 legacy-namespace", postgres, migration,
    " AND account_prefix !~ '^LEGACY(-|$)'", ""],
  ["accept JS number", "SHU-264/AC-07 decimal-string-only", unit, documentSource,
    "amount: parseDecimalString(input.amount, input.scale)", 'amount: typeof input.amount === "number" ? String(input.amount) : parseDecimalString(input.amount, input.scale)'],
  ["accept wrong scale", "SHU-264/AC-07 decimal-string-only", unit, decimalSource,
    "[0-9]{${scale}}", "[0-9]{1,18}"],
  ["accept malformed decimal", "SHU-264/AC-07 decimal-string-only", unit, decimalSource,
    " || !pattern.test(value)", ""],
  ["parity rejects tax regression", "SHU-264/parity-contract", postgres, documentSource, ...taxReject],
];

function run(files, pattern) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    ...(pattern ? [`--test-name-pattern=^${pattern}$`] : []), ...files],
  { cwd: root, env: process.env, encoding: "utf8", timeout: 60_000 });
  return { ...result, output: result.stdout + result.stderr };
}
function green(label) {
  const result = run([unit, numbering, postgres]);
  assert.equal(result.error, undefined, `${label}: runner error`);
  assert.equal(result.status, 0, `${label} must pass\n${result.output}`);
  assert.match(result.output, /# tests 17\b/);
  assert.match(result.output, /# skipped 0\b/);
  console.log(`${label}: 17 passed, 0 failed, 0 skipped`);
}
green("baseline");
for (const [name, title, suite, path, from, to] of mutations) {
  const target = `${root}${path}`;
  const original = readFileSync(target, "utf8");
  assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
  try {
    writeFileSync(target, original.replace(from, to));
    const result = run([suite], title);
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: survived\n${result.output}`);
    assert.ok(result.output.includes(`not ok 1 - ${title}`) || new RegExp(`not ok \\d+ - ${title}`).test(result.output), `${name}: named test did not fail\n${result.output}`);
    assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|hookFailed|ECONNREFUSED/, `${name}: infrastructure failure\n${result.output}`);
    assert.match(result.output, /code: 'ERR_ASSERTION'/, `${name}: must fail by assertion\n${result.output}`);
    console.log(`KILLED ${name} -> ${title}`);
  } finally { writeFileSync(target, original); }
}
green("restored");
console.log(`${mutations.length}/${mutations.length} SHU-264 mutations killed`);
