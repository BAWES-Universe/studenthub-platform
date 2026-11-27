import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Finance transfers (A-18), pages: input checks and rendering must be load-bearing. Each mutant rewrites
// the built handler, the named test must fail by assertion, and it is restored.
const handler = new URL("../../../dist/apps/gateway/src/billing/finance-transfers-http.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/apps/gateway/test/billing-finance-transfers-http.test.js", import.meta.url));
const mutations = [
  ["accept an unknown query parameter", "FINANCE_TRANSFERS_GATE", 'keys.some((k) => k !== "page" && k !== "status")', "false"],
  ["accept a write", "FINANCE_TRANSFERS_GATE", 'if (req.method !== "GET") {', "if (false) {"],
  ["ask the reads with an unchecked id", "FINANCE_TRANSFERS_GATE", "const id = transferIdOf(detail[1]);", "const id = detail[1];"],
  ["link a transfer by its raw id", "FINANCE_TRANSFERS_LIST", "`${FINANCE_TRANSFERS_PATH}/${encodeURIComponent(id)}`", "`${FINANCE_TRANSFERS_PATH}/${id}`"],
  ["call the whole salary total paid", "FINANCE_TRANSFERS_DETAIL", "Paid so far: ${esc(t.currencyCode)} ${esc(t.paidTotal)}", "Paid so far: ${esc(t.currencyCode)} ${esc(t.candidateTotal)}"],
  ["count lines as people in the list", "FINANCE_TRANSFERS_LIST", "<td>${t.personCount}</td>", "<td>${t.lineCount}</td>"],
  ["show an unpaid line as paid", "FINANCE_TRANSFERS_DETAIL", 'l.paid ? "Paid" : "Not paid yet"', '"Paid"'],
  ["print a person's name unescaped", "FINANCE_TRANSFERS_DETAIL", "<td>${esc(l.personName)}</td>", "<td>${l.personName}</td>"],
];
const original = await readFile(handler, "utf8");
const run = (pattern) => spawnSync(process.execPath, ["--test", "--test-reporter=tap",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", timeout: 120_000 });
let killed = 0;
try {
  assert.equal(run().status, 0, "the unmutated suite passes");
  for (const [name, pattern, from, to] of mutations) {
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(handler, original.replace(from, () => to));
    const result = run(pattern);
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: mutation survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: infrastructure failure\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${name}: did not die by assertion\n${output}`);
    killed++;
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
    await writeFile(handler, original);
  }
} finally { await writeFile(handler, original); }
assert.equal(run().status, 0, "the restored suite passes");
process.stdout.write(`${killed}/${mutations.length} finance transfer page mutations killed\n`);
