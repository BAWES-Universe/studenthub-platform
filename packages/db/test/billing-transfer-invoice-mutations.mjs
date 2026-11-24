import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Invoices lane, transfer invoices: every guard must be load-bearing. Each mutant
// rewrites one built module or the migration, the named test must fail by
// assertion, and the file is restored before the next. PostgreSQL is required.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for transfer invoice mutations (scratch PostgreSQL)");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const postgres = "dist/packages/db/test/postgres-billing-transfer-invoice.test.js";
const effects = "packages/db/dist/billing/postgres-transfer-invoice-effects.js";
const migration = "packages/db/migrations/0593_transfer_invoice.sql";
// 0594 (credit notes) replaces the guard function, so the guard body is mutated where it now lives.
const guard = "packages/db/migrations/0594_transfer_invoice_credit.sql";
const mutations = [
  ["bill lines of an unrelated company", "TRANSFER_INVOICE_OUTSIDE", effects,
    "if (groups.some(group => !group.in_tree))", "if (false)"],
  ["re-issue on every relock", "TRANSFER_INVOICE_RELOCK", effects,
    "if (existing?.lines_hash === group.lines_hash)", "if (false)"],
  ["skip the invoice of a transfer without lines", "TRANSFER_INVOICE_EMPTY", effects,
    "const wanted = groups.length > 0 ? groups", "const wanted = groups.length >= 0 ? groups"],
  ["keep a dropped company's invoice live", "TRANSFER_INVOICE_RELOCK_DROPPED", effects,
    "if (!wantedOrgs.has(orgId))", "if (false)"],
  ["mark paid with nothing issued", "TRANSFER_INVOICE_UNAVAILABLE", effects,
    "if (live.rowCount === 0)", "if (false)"],
  ["pay other transfers' invoices", "TRANSFER_INVOICE_PAID", effects,
    "WHERE transfer_id = $1 AND NOT deleted AND status = 'unpaid'", "WHERE NOT deleted AND status = 'unpaid' AND $1::text IS NOT NULL"],
  ["leave invoices live on transfer delete", "TRANSFER_INVOICE_DELETE", effects,
    "UPDATE transfer_invoice SET deleted = true, void_reason = 'transfer_deleted' WHERE transfer_id = $1 AND NOT deleted", "SELECT 1 WHERE $1::text IS NULL"],
  ["allow edits to issued columns", "TRANSFER_INVOICE_FROZEN", guard,
    "     OR (to_jsonb(NEW) - 'status' - 'paid_at' - 'deleted' - 'void_reason')\n        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'paid_at' - 'deleted' - 'void_reason')\n", ""],
  ["accept any status move", "TRANSFER_INVOICE_FROZEN", guard,
    "(OLD.status = 'unpaid' AND NEW.status = 'paid' AND NOT NEW.deleted)", "(NEW.status IN ('unpaid', 'paid'))"],
  ["allow truncate", "TRANSFER_INVOICE_FROZEN", migration,
    "CREATE TRIGGER transfer_invoice_no_truncate BEFORE TRUNCATE ON transfer_invoice\n  FOR EACH STATEMENT EXECUTE FUNCTION transfer_invoice_guard();", ""],
  ["allow two live invoices per company", "TRANSFER_INVOICE_FROZEN", migration,
    "CREATE UNIQUE INDEX transfer_invoice_live ON transfer_invoice(transfer_id, org_id) WHERE NOT deleted;", ""],
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
console.log(`${killed}/${mutations.length} transfer invoice mutations killed`);
