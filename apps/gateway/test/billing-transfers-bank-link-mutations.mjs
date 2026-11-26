import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The ordinary transfer record links its bank payments (F5) only when the bank record admits the viewer.
// Each mutant rewrites the built handler, the named test must fail by assertion, and it is restored.
const handler = new URL("../../../dist/apps/gateway/src/billing/invoices-http.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/apps/gateway/test/billing-transfers-http.test.js", import.meta.url));
const mutations = [
  ["link without asking the bank record", "COMPANY_TRANSFERS_BANK_LINK", "+ (bankRecords ? `<p><a", "+ (true ? `<p><a"],
  ["let a failing bank read fail the record", "COMPANY_TRANSFERS_BANK_LINK", ".catch(() => false) === true", " === true"],
  ["ask the bank record about another transfer", "COMPANY_TRANSFERS_BANK_LINK", "service.bankRecords(viewer, result.transferId)", "service.bankRecords(viewer, id + \"x\")"],
  ["link the raw transfer id", "COMPANY_TRANSFERS_BANK_LINK", "transfers/${encodeURIComponent(transferId)}`", "transfers/${transferId}`"],
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
process.stdout.write(`${killed}/${mutations.length} transfer bank-link mutations killed\n`);
