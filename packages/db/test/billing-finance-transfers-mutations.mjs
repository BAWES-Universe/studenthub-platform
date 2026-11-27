import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Finance transfers (A-18), read part: every rule between a reader and a company's transfers must be
// load-bearing. Each mutant rewrites the built reads, the named test must fail by assertion, and the
// file is restored before the next.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the finance transfer mutations");
const store = new URL("../dist/billing/postgres-finance-transfer-reads.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-billing-finance-transfers.test.js", import.meta.url));
const mutations = [
  ["let anyone past the central finance gate", "FINANCE_TRANSFERS_PG_DETAIL", "if (!await this.#gate(client, principalId))\n            return null;", "if (false)\n            return null;"],
  ["show every company's transfers", "FINANCE_TRANSFERS_PG", "chains.filter((c) => this.#decision(grants, c.company, c.ancestors))", "chains.filter(() => true)"],
  ["ignore the status filter", "FINANCE_TRANSFERS_PG", "($2::text IS NULL OR t.status = $2)", "($2::text IS NULL OR true)"],
  ["hide that an older page exists", "FINANCE_TRANSFERS_PG", "const more = rows.length > limit;", "const more = false;"],
  ["list the oldest period first", "FINANCE_TRANSFERS_PG", "ORDER BY t.period_end DESC, t.period_start DESC", "ORDER BY t.period_end ASC, t.period_start ASC"],
];
const original = await readFile(store, "utf8");
const run = (pattern) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", timeout: 120_000 });
let killed = 0;
try {
  assert.equal(run().status, 0, "the unmutated suite passes");
  for (const [name, pattern, from, to] of mutations) {
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(store, original.replace(from, () => to));
    const result = run(pattern);
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: mutation survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: infrastructure failure\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${name}: did not die by assertion\n${output}`);
    killed++;
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
    await writeFile(store, original);
  }
} finally { await writeFile(store, original); }
assert.equal(run().status, 0, "the restored suite passes");
process.stdout.write(`${killed}/${mutations.length} finance transfer read mutations killed\n`);
