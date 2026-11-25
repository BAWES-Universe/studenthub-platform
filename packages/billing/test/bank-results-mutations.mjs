import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Bank result files (F5), pure part: every rule that keeps a payment from being
// marked on a guess must be load-bearing. Each mutant rewrites the built module,
// the named test must fail by assertion, and the file is restored before the next.
// No database needed. Run after `npm run build`.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const suite = "dist/packages/billing/test/bank-results.test.js";
const module = "dist/packages/billing/src/bank-results.js";
const mutations = [
  ["round a fourth decimal away", "BANK_AMOUNT",
    "(?:\\.(\\d{1,3}))?$/u", "(?:\\.(\\d{1,3})\\d*)?$/u"],
  ["take an unknown status as success", "BANK_SHEET_AUB",
    'rejected.push({ rowNumber, problem: "unknown_status" });\n                continue;', ""],
  ["ignore a different amount on an echoed id", "BANK_PLAN_CHECKS",
    "row.amount !== null && row.amount !== line.paidAmount", "false"],
  ["ignore a different currency on an echoed id", "BANK_PLAN_CHECKS",
    "row.currency !== null && row.currency !== line.currency", "false"],
  ["take the first of tied account matches", "BANK_PLAN_FALLBACK",
    "if (open.length > 1) {", "if (false) {"],
  ["let one line be paid by two rows", "BANK_PLAN_HOLDS",
    "if (claimed.has(line.lineId)) {", "if (false) {"],
  ["re-pay a line already paid under another reference", "BANK_PLAN_PROVENANCE",
    'decisions.push(hold(row.rowNumber, "already_paid", [line.lineId]));', 'decisions.push({ kind: "pay", rowNumber: row.rowNumber, lineId: line.lineId, transferId: line.transferId, reference: row.reference });'],
  ["look up recorded confirmations only after the unpaid fallback", "BANK_PLAN_REPLAY",
    "            if (prior.length) {\n                const p = prior[0];", "            if (false) {\n                const p = prior[0];"],
  ["take a recorded reference as a replay whatever its amount", "BANK_PLAN_PROVENANCE",
    "prior.length === 1 && p.account === row.account && p.amount === row.amount", "prior.length === 1 && p.account === row.account"],
  ["take the first of several recorded lines for one reference", "BANK_PLAN_PROVENANCE",
    "const replay = prior.length === 1 && p.account", "const replay = prior.length >= 1 && p.account"],
  ["let one reference settle two rows in a file", "BANK_PLAN_PROVENANCE",
    "if (references.has(row.reference)) {", "if (false) {"],
  ["apply an id row whose reference is recorded on another line", "BANK_PLAN_PROVENANCE",
    "prior.length === 1 && prior[0].lineId === line.lineId && line.paid", "true"],
  ["unpay by account match without an id", "BANK_PLAN_CHECKS",
    'if (row.outcome === "fail") {\n                decisions.push(hold(row.rowNumber, "unmatched"));\n                continue;\n            }', ""],
  ["count held rows as touching their transfer", "BANK_PLAN_CHECKS",
    'd.kind === "pay" || d.kind === "unpay" ? [d.transferId] : []', '"transferId" in d ? [d.transferId] : ["T1"]'],
];

function run(pattern) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite],
  { cwd: root, env: process.env, encoding: "utf8", timeout: 60_000 });
  return { ...result, output: result.stdout + result.stderr };
}
function green(label) {
  const result = run();
  assert.equal(result.error, undefined, `${label}: runner error`);
  assert.equal(result.status, 0, `${label} must pass\n${result.output}`);
  assert.match(result.output, /# skipped 0\b/);
  console.log(`${label}: suite green`);
}
green("baseline");
let killed = 0;
for (const [name, title, from, to] of mutations) {
  const target = `${root}${module}`;
  const original = readFileSync(target, "utf8");
  assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
  try {
    writeFileSync(target, original.replace(from, to));
    const result = run(title);
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: survived\n${result.output}`);
    assert.match(result.output, new RegExp(`not ok \\d+ - ${title} `), `${name}: named test did not fail\n${result.output}`);
    assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: infrastructure failure\n${result.output}`);
    assert.match(result.output, /code: 'ERR_ASSERTION'/, `${name}: must fail by assertion\n${result.output}`);
    killed++;
    console.log(`KILLED ${name} -> ${title}`);
  } finally { writeFileSync(target, original); }
}
green("restored");
console.log(`${killed}/${mutations.length} bank result mutations killed`);
