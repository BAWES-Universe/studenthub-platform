import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Finance contracts (A-17), pages: input checks and rendering must be load-bearing. Each mutant rewrites
// the built handler, the named test must fail by assertion, and it is restored.
const handler = new URL("../../../dist/apps/gateway/src/billing/finance-contracts-http.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/apps/gateway/test/billing-finance-contracts-http.test.js", import.meta.url));
const mutations = [
  ["accept an unknown query parameter", "FINANCE_CONTRACTS_GATE", 'keys.some((k) => k !== "page" && k !== "status")', "false"],
  ["accept a write", "FINANCE_CONTRACTS_GATE", 'if (req.method !== "GET") {', "if (false) {"],
  ["accept any contract id", "FINANCE_CONTRACTS_GATE", "/^\\/finance\\/contracts\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/", "/^\\/finance\\/contracts\\/(.+)$/"],
  ["ignore query parameters on one contract", "FINANCE_CONTRACTS_GATE", "if ([...url.searchParams.keys()].length)\n            return notFound(req, res);", ""],
  ["bill an hourly contract by its total", "FINANCE_CONTRACTS_PAGE", "money(t.companyHourlyRate)", "money(t.companyTotal)"],
  ["drop the end of a contract", "FINANCE_CONTRACTS_PAGE", 'typeof e.contract.endDate === "string"', "false"],
  ["show automatic payout on every contract", "FINANCE_CONTRACTS_PAGE", 'if (t.payModel === "monthly_salary")\n        rows.push', "if (true)\n        rows.push"],
  ["print a person's name unescaped", "FINANCE_CONTRACTS_PAGE", "${esc(e.personName)}</a>", "${e.personName}</a>"],
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
process.stdout.write(`${killed}/${mutations.length} finance contract page mutations killed\n`);
