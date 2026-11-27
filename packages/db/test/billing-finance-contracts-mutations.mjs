import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Finance contracts (A-17), read part: every rule between a reader and the companies' contracts, and the company
// projection of each contract, must be load-bearing. Each mutant rewrites a built file, the named test must fail by
// assertion, and the files are restored before the next.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the finance contract mutations");
const settled = new URL("../dist/billing/postgres-finance-contract-reads.js", import.meta.url);
// The central gate and per-company decision are shared with Finance transfers.
const companies = new URL("../dist/billing/postgres-finance-transfer-reads.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-billing-finance-contracts.test.js", import.meta.url));
const mutations = [
  ["let anyone past the central finance gate", "FINANCE_CONTRACTS_PG_GATE", "if (!await gate(client, principalId))\n        return null;", "if (false)\n        return null;", companies],
  ["show every company's contracts", "FINANCE_CONTRACTS_PG", "chains.filter((c) => decision(grants, c.company, c.ancestors))", "chains.filter(() => true)", companies],
  ["give a refused reader an empty list", "FINANCE_CONTRACTS_PG_GATE", "if (!companies)\n                return null;\n            const rows", "if (false)\n                return null;\n            const rows"],
  ["open one contract of any company", "FINANCE_CONTRACTS_PG_DETAIL", "`${SELECT} AND c.id = $2::uuid`", "`${SELECT.replace(\"c.company_org_id = ANY($1::text[])\", \"($1::text[] IS NOT NULL)\")} AND c.id = $2::uuid`"],
  ["show deleted contracts", "FINANCE_CONTRACTS_PG_DETAIL", "ANY($1::text[]) AND c.status <> 'deleted'", "ANY($1::text[])"],
  ["give Finance the full projection", "FINANCE_CONTRACTS_PG", "projectPayContract(contract, \"company\")", "projectPayContract(contract, \"full\")"],
  ["give Finance the candidate projection", "FINANCE_CONTRACTS_PG_DETAIL", "projectPayContract(contract, \"company\")", "projectPayContract(contract, \"candidate\")"],
  ["name a store of another company", "FINANCE_CONTRACTS_PG", "s.id::text = c.store_id AND s.org_id = c.company_org_id", "s.id::text = c.store_id"],
  ["ignore the status filter", "FINANCE_CONTRACTS_PG", "($2::text IS NULL OR c.status = $2)", "($2::text IS NULL OR true)"],
  ["list the oldest first", "FINANCE_CONTRACTS_PG", "ORDER BY c.start_date DESC, c.id", "ORDER BY c.start_date, c.id"],
  ["hide that an older page exists", "FINANCE_CONTRACTS_PG", "const more = rows.length > limit;", "const more = false;"],
];
const originals = new Map([[settled.href, await readFile(settled, "utf8")], [companies.href, await readFile(companies, "utf8")]]);
const restore = async () => { for (const [href, text] of originals) await writeFile(new URL(href), text); };
const run = (pattern) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", timeout: 120_000 });
let killed = 0;
try {
  assert.equal(run().status, 0, "the unmutated suite passes");
  for (const [name, pattern, from, to, file = settled] of mutations) {
    const original = originals.get(file.href);
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(file, original.replace(from, () => to));
    const result = run(pattern);
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: mutation survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: infrastructure failure\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${name}: did not die by assertion\n${output}`);
    killed++;
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
    await restore();
  }
} finally { await restore(); }
assert.equal(run().status, 0, "the restored suite passes");
process.stdout.write(`${killed}/${mutations.length} finance contract read mutations killed\n`);
