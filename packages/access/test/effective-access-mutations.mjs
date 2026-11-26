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
    "companyAncestors: org.ancestors }", "companyAncestors: [] }"],
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
