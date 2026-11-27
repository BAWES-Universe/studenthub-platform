import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Finance settled (A-20), read part: every rule between a reader and the companies' invoices and balances must be
// load-bearing. Each mutant rewrites a built file, the named test must fail by assertion, and the files are
// restored before the next.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the finance settled mutations");
const settled = new URL("../dist/billing/postgres-finance-settled-reads.js", import.meta.url);
// The central gate and per-company decision are shared with Finance transfers.
const companies = new URL("../dist/billing/postgres-finance-transfer-reads.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-billing-finance-settled.test.js", import.meta.url));
const mutations = [
  ["let anyone past the central finance gate", "FINANCE_SETTLED_PG_GATE", "if (!await gate(client, principalId))\n        return null;", "if (false)\n        return null;", companies],
  ["show every company's invoices", "FINANCE_SETTLED_PG", "chains.filter((c) => decision(grants, c.company, c.ancestors))", "chains.filter(() => true)", companies],
  ["look only at one company", "FINANCE_SETTLED_PG", "SELECT DISTINCT org_id FROM transfer_invoice", "SELECT 'P'"],
  ["ignore the status filter", "FINANCE_SETTLED_PG", "($2::text IS NULL OR", "(true OR"],
  ["count a credited invoice by its payment status", "FINANCE_SETTLED_PG", "(c.credit_number IS NULL AND i.status = $2)", "(i.status = $2)"],
  ["leave credits out of the balance", "FINANCE_SETTLED_PG", "sum(amount)::numeric(40,3)::text AS outstanding", "(sum(amount) FILTER (WHERE kind <> 'credit'))::numeric(40,3)::text AS outstanding"],
  ["report payments as credits", "FINANCE_SETTLED_PG", "FILTER (WHERE kind = 'credit')", "FILTER (WHERE kind = 'payment')"],
  ["hide that an older page exists", "FINANCE_SETTLED_PG", "const more = rows.length > limit;", "const more = false;"],
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
process.stdout.write(`${killed}/${mutations.length} finance settled read mutations killed\n`);
