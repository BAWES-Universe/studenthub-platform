import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane G-02: each store-change guard in packages/access is load-bearing.
// Each mutation rewrites one built module in place, the named test must fail
// by assertion, and the module is restored before the next.
const built = (name) => new URL(`../../../dist/packages/access/src/${name}`, import.meta.url);
const suites = ["store-grant.test.js"].map((name) =>
  fileURLToPath(new URL(`../../../dist/packages/access/test/${name}`, import.meta.url)));
const mutations = [
  ["allow a self change", "G02_STORE_GUARDS", "store-grant.js",
    "if (request.targetPrincipalId === callerId)", "if (false)"],
  ["let anyone covering the company in without the Access pages", "G02_STORE_GUARDS", "store-grant.js",
    "if (!mayOpenAccessAdmin(snapshot.callerGrants, operatorOrgIds))", "if (false)"],
  ["skip the company coverage check", "G02_STORE_GUARDS", "store-grant.js",
    "if (!mayManageStoreAccess(snapshot.callerGrants, snapshot.store.orgId, snapshot.store.orgAncestors))", "if (false)"],
  ["give while paused", "G02_STORE_GUARDS", "store-grant.js",
    'return snapshot.paused ? refuse("paused")', "return false ? refuse(\"paused\")"],
  ["revoke what is not held", "G02_STORE_GUARDS", "store-grant.js",
    'return snapshot.held ? { kind: "apply", before: true, after: false } : refuse("not_held");',
    'return { kind: "apply", before: true, after: false };'],
  ["accept an altered store change", "G02_STORE_CONFIRM", "store-grant.js",
    "if (token.changeDigest !== storeGrantDigest(input.request))", "if (false)"],
  ["accept another caller's token", "G02_STORE_CONFIRM", "store-grant.js",
    "if (token.callerRef !== accessCallerRef(input.callerId))", "if (false)"],
  ["accept an expired token", "G02_STORE_CONFIRM", "store-grant.js",
    "input.now.getTime() >= expires", "false"],
  ["accept an uppercase store id", "G02_STORE_PARSE", "store-grant.js",
    "const STORE_ID = /^[0-9a-f]{8}", "const STORE_ID = /^[0-9a-fA-F]{8}"],
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
process.stdout.write(`${mutations.length}/${mutations.length} access G-02 store mutations killed\n`);
