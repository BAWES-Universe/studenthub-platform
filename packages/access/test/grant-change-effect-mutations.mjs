import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane G-02: every part of the effect of a grant change is load-bearing and dies here.
const built = (name) => new URL(`../../../dist/packages/access/src/${name}`, import.meta.url);
const suites = ["grant-change-effect.test.js"].map((name) =>
  fileURLToPath(new URL(`../../../dist/packages/access/test/${name}`, import.meta.url)));
const mutations = [
  ["drop every grant of the role, on any organization", "G02_EFFECT", "grant-catalogue-view.js",
    "!(grant.orgId === change.orgId && grant.role === change.role)", "!(grant.role === change.role)"],
  ["ask a company without the organizations above it", "G02_EFFECT", "grant-catalogue-view.js",
    "companyAncestors: input.orgAncestors }", "companyAncestors: [] }"],
  ["keep the role when it is taken away", "G02_EFFECT", "grant-catalogue-view.js",
    "change.after === null ? others :", "change.after === null ? input.held :"],
  ["count what they already had as gained", "G02_EFFECT", "grant-catalogue-view.js",
    "now.has(capability) && !before.has(capability)", "now.has(capability)"],
  ["ask an operator change at the operator itself", "G02_EFFECT", "grant-catalogue-view.js",
    "operatorOrgIds.includes(change.orgId)\n", "false\n"],
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
process.stdout.write(`${mutations.length}/${mutations.length} grant change effect mutations killed\n`);
