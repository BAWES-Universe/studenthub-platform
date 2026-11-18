import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Invoices lane, legacy invoice import: every guard must be load-bearing. Each
// mutant rewrites one built module or the migration, the named test must fail by
// assertion, and the file is restored before the next. PostgreSQL is required.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for legacy invoice mutations (scratch PostgreSQL)");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const unit = "dist/packages/billing/test/legacy-invoices.test.js";
const postgres = "dist/packages/db/test/postgres-billing-legacy-invoice.test.js";
const domain = "dist/packages/billing/src/legacy-invoices.js";
const store = "packages/db/dist/billing/postgres-legacy-invoice-store.js";
const migration = "packages/db/migrations/0592_legacy_invoice.sql";
const mutations = [
  ["sum through floating point", "LEGACY_INVOICE_AMOUNT", unit, domain,
    "fils += negative ? -amount : amount;", "fils = BigInt(Math.round((Number(fils) / 1000 + Number(value)) * 1000));"],
  ["count deleted invoices in totals", "LEGACY_INVOICE_RECONCILE", unit, domain,
    "if (record.deleted)\n            continue;", ""],
  ["ignore rejected rows", "LEGACY_INVOICE_DIFF", unit, domain,
    "&& mapping.rejected.length === 0 && totalsMatch", "&& totalsMatch"],
  ["silently drop a duplicate", "LEGACY_INVOICE_REJECTS", unit, domain,
    'reject("duplicate_invoice_id");', ""],
  ["flag deleted invoices too", "LEGACY_INVOICE_FLAGS", unit, domain,
    "if (!deleted && row.transferStatus === LEGACY_TRANSFER_STATUS.cancel)", "if (row.transferStatus === LEGACY_TRANSFER_STATUS.cancel)"],
  ["drop the BIGINT bound", "LEGACY_INVOICE_REJECTS", unit, domain,
    "&& BigInt(value) <= BIGINT_MAX", ""],
  ["accept year zero", "LEGACY_INVOICE_REJECTS", unit, domain,
    ' || value.startsWith("0000")', ""],
  ["drop the per-row total range", "LEGACY_INVOICE_REJECTS", unit, domain,
    "> MAX_TOTAL_INTEGER_DIGITS", "> 1000"],
  ["let a re-import move paid back to unpaid", "LEGACY_INVOICE_PG_FROZEN", postgres, migration,
    "     OR (OLD.status = 'paid' AND NEW.status <> 'paid')\n", ""],
  ["allow truncate", "LEGACY_INVOICE_PG_FROZEN", postgres, migration,
    "CREATE TRIGGER legacy_invoice_no_truncate BEFORE TRUNCATE ON legacy_invoice\n  FOR EACH STATEMENT EXECUTE FUNCTION legacy_invoice_guard();", ""],
  ["overwrite a changed total", "LEGACY_INVOICE_PG_RERUN", postgres, store,
    "if (!frozenEqual(current, record)\n", "if (false\n"],
  ["commit each row on its own", "LEGACY_INVOICE_PG_ATOMIC", postgres, store,
    "inserted++;\n",
    'inserted++;\n                    await client.query("COMMIT");\n                    await client.query("BEGIN");\n'],
];

function run(files, pattern) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
    ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), ...files],
  { cwd: root, env: process.env, encoding: "utf8", timeout: 120_000 });
  return { ...result, output: result.stdout + result.stderr };
}
function green(label) {
  const result = run([unit, postgres]);
  assert.equal(result.error, undefined, `${label}: runner error`);
  assert.equal(result.status, 0, `${label} must pass\n${result.output}`);
  assert.match(result.output, /# skipped 0\b/);
  console.log(`${label}: suites green`);
}
green("baseline");
let killed = 0;
for (const [name, title, suite, path, from, to] of mutations) {
  const target = `${root}${path}`;
  const original = readFileSync(target, "utf8");
  assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
  try {
    writeFileSync(target, original.replace(from, to));
    const result = run([suite], title);
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
console.log(`${killed}/${mutations.length} legacy invoice mutations killed`);
