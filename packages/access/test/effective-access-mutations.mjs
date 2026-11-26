import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane G-03: every part of the effective-access view is load-bearing and dies here.
const built = (name) => new URL(`../../../dist/packages/access/src/${name}`, import.meta.url);
const suites = ["effective-access.test.js"].map((name) =>
  fileURLToPath(new URL(`../../../dist/packages/access/test/${name}`, import.meta.url)));
const mutations = [
  ["list organizations they hold no grant on", "G03_EFFECTIVE", "grant-catalogue-view.js",
    "if (!input.held.some((grant) => grant.orgId === org.orgId))", "if (false)"],
  ["credit every grant with every ability", "G03_EFFECTIVE", "grant-catalogue-view.js",
    "alone.filter(([, opens]) => opens.has(capability))", "alone.filter(() => true)"],
  ["ask a company without the organizations above it", "G03_EFFECTIVE", "grant-catalogue-view.js",
    "here: { companyId: org.orgId, companyAncestors: org.ancestors, operator }", "here: { companyId: org.orgId, companyAncestors: [], operator }"],
  ["ask below a company without the company itself", "G03_EFFECTIVE_REACH", "grant-catalogue-view.js",
    "companyAncestors: [...org.ancestors, org.orgId], operator }", "companyAncestors: [...org.ancestors], operator }"],
  ["ask below an operator at the operator itself", "G03_EFFECTIVE_REACH", "grant-catalogue-view.js",
    "hereAmong: OPERATOR_CAPABILITIES, below: directlyBelow }", "hereAmong: OPERATOR_CAPABILITIES, below: { companyId: operator, companyAncestors: [], operator } }"],
  ["ask every operator at the first", "G03_EFFECTIVE_ROOTS", "grant-catalogue-view.js",
    "companyAncestors: [operator], operator }", "companyAncestors: [operator] }"],
  ["list only the first operator", "G03_EFFECTIVE_ROOTS", "grant-catalogue-view.js",
    "if (operator !== first && !input.held.some((grant) => grant.orgId === operator))", "if (operator !== first)"],
  ["claim what holds everywhere for each operator", "G03_EFFECTIVE_ROOTS", "grant-catalogue-view.js",
    "hereAmong: OPERATOR_CAPABILITIES,", "hereAmong: CATALOGUE_CAPABILITIES,"],
  ["claim what holds everywhere for each company", "G03_EFFECTIVE", "grant-catalogue-view.js",
    "hereAmong: SCOPED_COMPANY_CAPABILITIES,", "hereAmong: CATALOGUE_CAPABILITIES,"],
  ["leave out what holds everywhere", "G03_EFFECTIVE", "grant-catalogue-view.js",
    "operator: first }, GLOBAL_CAPABILITIES)", "operator: first }, [])"],
  ["list a company twice", "G03_EFFECTIVE", "grant-catalogue-view.js",
    "places.some((item) => item.orgId === org.orgId)", "false"],
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
process.stdout.write(`${mutations.length}/${mutations.length} effective access mutations killed\n`);
