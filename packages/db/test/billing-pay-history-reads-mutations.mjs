import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Invoices lane, own pay history reads (F4.9): every read guard must be load-bearing. Each mutant
// rewrites the built module, the named test must fail by
// assertion, and the file is restored before the next. PostgreSQL is required.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for pay history read mutations (scratch PostgreSQL)");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const postgres = "dist/packages/db/test/postgres-billing-pay-history-reads.test.js";
const reads = "packages/db/dist/billing/postgres-pay-history-reads.js";
const mutations = [
  ["show every person's lines", "PAY_HISTORY_READS_OWN", reads, "WHERE l.person_id = $1 AND", "WHERE $1::text IS NOT NULL AND"],
  ["show unpaid lines", "PAY_HISTORY_READS_PAID", reads, "AND l.paid AND", "AND"],
  // "AND NOT t.deleted" has no mutant: the lifecycle deletes only draft, locked and cancelled transfers,
  // which the status filter already leaves out, so the clause is defence in depth.
  ["show lines before the payment is received", "PAY_HISTORY_READS_PAID", reads, "t.status IN ('distributing', 'complete')", "t.status <> 'draft'"],
  ["list oldest first", "PAY_HISTORY_READS_OWN", reads, "ORDER BY t.period_end DESC", "ORDER BY t.period_end ASC"],
  ["return every line on one page", "PAY_HISTORY_READS_PAGES", reads, "LIMIT ${PAY_HISTORY_PAGE_SIZE} OFFSET $2", "OFFSET $2"],
  ["show the company total", "PAY_HISTORY_READS_OWN", reads, "l.candidate_total::text AS total", "l.company_total::text AS total"],
  ["serve the raw calculation", "PAY_HISTORY_READS_DETAIL", reads, "return { ...entry, status: \"paid\", worked: candidateWorked(calculation) };", "return { ...entry, calculation, status: \"paid\", worked: candidateWorked(calculation) };"],
  ["read worked time from any pay model", "PAY_HISTORY_READS_CALCULATION", reads, "|| rate.payModel !== \"hourly\")", ")"],
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
console.log(`${killed}/${mutations.length} pay history read mutations killed`);
