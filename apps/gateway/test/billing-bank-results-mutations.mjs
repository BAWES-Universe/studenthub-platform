import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Bank result files (F5), finance page: the gate in front of the store must be load-bearing. Each
// mutant rewrites the built handler, the named test must fail by assertion, and it is restored.
const handler = new URL("../../../dist/apps/gateway/src/billing/bank-results-http.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/apps/gateway/test/billing-bank-results-http.test.js", import.meta.url));
const mutations = [
  ["let anyone signed in reach the files", "BANK_HTTP_GATE", "if (!await service.allowed(viewer))", "if (false)"],
  ["accept a write from another origin", "BANK_HTTP_GATE", "if (post && (!service.origin || !sameOrigin(req, service.origin)))", "if (false)"],
  ["preview a file already applied", "BANK_HTTP_FLOW", 'detail.status === "pending" ? await service.preview(viewer, id) : null', "await service.preview(viewer, id)"],
  ["apply without a reviewed outcome", "BANK_HTTP_FLOW", "if (!reviewId)\n                return reply(", "if (false)\n                return reply("],
  ["take a changed outcome as applied", "BANK_HTTP_FLOW", 'if (result.kind === "changed") {', 'if (false) {'],
  ["switch apply on by default", "BANK_HTTP_APPLY_OFF", "applyEnabled: ports.applyEnabled === true,", "applyEnabled: true,"],
  ["apply while switched off", "BANK_HTTP_APPLY_OFF", "if (!service.applyEnabled) {", "if (false) {"],
  ["accept an unknown form field", "BANK_HTTP_INPUT", "else\n            return undefined;\n    }", "\n    }"],
  ["link a transfer by its raw id", "BANK_HTTP_HELD", "`${BANK_RESULTS_PATH}/transfers/${encodeURIComponent(id)}`", "`${BANK_RESULTS_PATH}/transfers/${id}`"],
  ["print a bank reference unescaped", "BANK_HTTP_HELD", "<td>${esc(h.reference ?? \"\")}</td>", "<td>${h.reference ?? \"\"}</td>"],
  ["accept a write on the read pages", "BANK_HTTP_HELD", 'file || read ? "GET"', 'file ? "GET"'],
  ["show a paid line as unpaid", "BANK_HTTP_TRANSFER", "l.paid ? \"Paid (not from a bank result file)\" : \"Unpaid\"", "\"Unpaid\""],
  ["ask the store with the still-encoded id", "BANK_HTTP_TRANSFER", "id = decodeURIComponent(segment);", "id = segment;"],
  ["accept any page value", "BANK_HTTP_HELD", "return /^[1-9][0-9]{0,5}$/.test(value) ? Number(value) : undefined;", "return Number(value) || 1;"],
  ["list an applied file's lines without links", "BANK_HTTP_FLOW", "${decisionsTable(file.decisions, file.lineTransfers)}", "${decisionsTable(file.decisions)}"],
  ["link a line by its raw transfer id", "BANK_HTTP_FLOW", "`<a href=\"${esc(transferHref(transfers[lineId]))}#line-", "`<a href=\"${esc(`/finance/bank-results/transfers/${transfers[lineId]}`)}#line-"],
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
process.stdout.write(`${killed}/${mutations.length} bank result page mutations killed\n`);
