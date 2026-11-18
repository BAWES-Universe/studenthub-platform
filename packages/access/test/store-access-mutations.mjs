import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane A4: the store manager rule is load-bearing. Items 1, 3 and 5 die
// here; item 4 (a company grant never reaches a store) lives in the Postgres
// read port and dies in packages/db/test/access-store-managers-mutations.mjs.
const built = (name) => new URL(`../../../dist/packages/access/src/${name}`, import.meta.url);
const suites = ["store-access.test.js"].map((name) =>
  fileURLToPath(new URL(`../../../dist/packages/access/test/${name}`, import.meta.url)));
const mutations = [
  ["read a store without the grant row", "A4_RULE", "store-access.js",
    'return row.revokedAt === null && row.storeStatus === "active" && row.orgLive;', 'return row.storeStatus === "active" && row.orgLive;'],
  ["list a sibling store", "A4_NO_LEAK", "store-access.js",
    ".find((row) => row.storeId === storeId)", ".find(() => true)"],
  ["ignore a removed store", "A4_REVOKE", "store-access.js",
    'return row.revokedAt === null && row.storeStatus === "active" && row.orgLive;', "return row.revokedAt === null && row.orgLive;"],
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
process.stdout.write(`${mutations.length}/${mutations.length} access A4 mutations killed\n`);
