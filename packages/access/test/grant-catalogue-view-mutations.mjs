import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane G-01: the grant catalogue view asks the enforced rules; every
// question it asks is load-bearing and dies here.
const built = (name) => new URL(`../../../dist/packages/access/src/${name}`, import.meta.url);
const suites = ["grant-catalogue-view.test.js"].map((name) =>
  fileURLToPath(new URL(`../../../dist/packages/access/test/${name}`, import.meta.url)));
const mutations = [
  ["report staff as able to give what only admins give", "G01_GIVERS", "grant-catalogue-view.js",
    'if (may("staff"))', 'if (may("staff") || may("admin"))'],
  ["show finance reports to everyone with any report", "G01_OPENS", "grant-catalogue-view.js",
    '["finance_reports", reports.finance],', '["finance_reports", reports.finance || reports.operations],'],
  ["evaluate operator grants without their company below", "G01_OPENS", "grant-catalogue-view.js",
    "const companyAncestors = grant.orgId === operator ? [operator] : [];", "const companyAncestors = [];"],
  ["let a grant that cannot open the Access pages give roles", "G01_OPENS", "grant-catalogue-view.js",
    "accessPages && grantCatalogue(", "grantCatalogue("],
  ["leave out the company rows", "G01_SHAPE", "grant-catalogue-view.js",
    'for (const place of ["operator", "company"]) {', 'for (const place of ["operator"]) {'],
];
const run = (pattern) => spawnSync(process.execPath, ["--test", "--test-reporter=tap",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), ...suites], { encoding: "utf8", timeout: 120_000 });
const originals = new Map();
for (const [, , file] of mutations) if (!originals.has(file)) originals.set(file, await readFile(built(file), "utf8"));
try {
  assert.equal(run().status, 0, "the unmutated suites pass");
  for (const [name, pattern, file, from, to] of mutations) {
    const original = originals.get(file);
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(built(file), original.replace(from, to));
    const result = run(pattern);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${name}: mutation survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${name}: did not die by assertion\n${output}`);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
    await writeFile(built(file), original);
  }
} finally {
  for (const [file, original] of originals) await writeFile(built(file), original);
}
assert.equal(run().status, 0, "the restored suites pass");
process.stdout.write(`${mutations.length}/${mutations.length} grant catalogue view mutations killed\n`);
