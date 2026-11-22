import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Invoices lane, transfer invoice reads (I3): every read guard must be load-bearing. Each mutant
// rewrites one built module or the migration, the named test must fail by
// assertion, and the file is restored before the next. PostgreSQL is required.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for transfer invoice read mutations (scratch PostgreSQL)");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const postgres = "dist/packages/db/test/postgres-billing-transfer-invoice-reads.test.js";
const reads = "packages/db/dist/billing/postgres-transfer-invoice-reads.js";
const decision = "dist/packages/billing/src/transfer-invoice-access.js";
const mutations = [
  ["let recruiters read invoices", "TRANSFER_INVOICE_READS_REFUSED", decision,
    'Object.freeze(["staff", "admin", "org-owner", "finance"])', 'Object.freeze(["staff", "admin", "org-owner", "finance", "recruiter"])'],
  ["bill an operator organization", "TRANSFER_INVOICE_READS_REFUSED", decision,
    "if (operators.includes(orgId))\n        return false;", ""],
  ["treat a self grant as subtree", "TRANSFER_INVOICE_READS_SCOPE", decision,
    '(row.scope === "subtree" && ancestors.includes(row.org_id))', "ancestors.includes(row.org_id)"],
  ["read a deleted company", "TRANSFER_INVOICE_READS_REFUSED", reads,
    "if (!await organizationLive(this.#pool, orgId))", "if (false)"],
  ["show voided invoices", "TRANSFER_INVOICE_READS_DOCUMENT", reads,
    "WHERE NOT i.deleted AND", "WHERE"],
  ["show every company's invoices", "TRANSFER_INVOICE_READS_TREE", reads,
    "AND i.org_id IN (SELECT id FROM tree)", "AND $1::text IS NOT NULL"],
  ["serve a document without the read check", "TRANSFER_INVOICE_READS_REFUSED", reads,
    "if (!await this.#allowed(principalId, orgId))\n            return null;\n        return (await", "return (await"],
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
console.log(`${killed}/${mutations.length} transfer invoice read mutations killed`);
