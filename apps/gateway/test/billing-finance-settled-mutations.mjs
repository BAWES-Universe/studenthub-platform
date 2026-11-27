import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Finance settled (A-20), page: input checks and rendering must be load-bearing. Each mutant rewrites
// the built handler, the named test must fail by assertion, and it is restored.
const handler = new URL("../../../dist/apps/gateway/src/billing/finance-settled-http.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/apps/gateway/test/billing-finance-settled-http.test.js", import.meta.url));
const mutations = [
  ["accept an unknown query parameter", "FINANCE_SETTLED_GATE", 'keys.some((k) => k !== "page" && k !== "status")', "false"],
  ["accept a write", "FINANCE_SETTLED_GATE", 'if (req.method !== "GET") {', "if (false) {"],
  ["answer under the settled path", "FINANCE_SETTLED_GATE", "if (!page)\n            return notFound(req, res);", ""],
  ["link a company by its raw id", "FINANCE_SETTLED_PAGE", "`${INVOICES_PATH}/${encodeURIComponent(orgId)}`", "`${INVOICES_PATH}/${orgId}`"],
  ["show a credited invoice by its payment status", "FINANCE_SETTLED_PAGE", "${i.creditNumber\n", "${false\n"],
  ["show what is owed as invoiced", "FINANCE_SETTLED_PAGE", "<td>${esc(b.outstanding)}</td>", "<td>${esc(b.invoiced)}</td>"],
  ["print a company name unescaped", "FINANCE_SETTLED_PAGE", "${esc(name)}</a>", "${name}</a>"],
  ["link a deleted company", "FINANCE_SETTLED_PAGE", "deleted.has(orgId) ?", "false ?"],
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
process.stdout.write(`${killed}/${mutations.length} finance settled page mutations killed\n`);
