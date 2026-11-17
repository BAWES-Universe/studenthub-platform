import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane A7: the review queue stays hidden from everyone but operator staff, and the person's own words are escaped.
const built = (name) => new URL(`../../../dist/apps/gateway/src/access/${name}`, import.meta.url);
const suites = ["company-registration.test.js"].map((name) =>
  fileURLToPath(new URL(`../../../dist/apps/gateway/test/${name}`, import.meta.url)));
const mutations = [
  ["show the queue to anyone signed in", "A7_QUEUE", "company-registration.js",
    "!mayReviewRegistrations(await ports.reads.callerGrants(caller), ports.operatorOrgIds)", "false"],
  ["print the company name unescaped in the queue", "A7_SIGN_UP", "company-registration.js",
    "<h3>${e(row.companyName)}</h3>", "<h3>${row.companyName}</h3>"],
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
process.stdout.write(`${mutations.length}/${mutations.length} access A7 gateway mutations killed\n`);
