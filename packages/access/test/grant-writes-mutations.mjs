import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane A1: each acceptance guard in packages/access is load-bearing.
// Each mutation rewrites one built module in place, the named test must fail
// by assertion, and the module is restored before the next.
const built = (name) => new URL(`../../../dist/packages/access/src/${name}`, import.meta.url);
const suites = ["grant-catalogue.test.js", "grant-writes.test.js"].map((name) =>
  fileURLToPath(new URL(`../../../dist/packages/access/test/${name}`, import.meta.url)));
const mutations = [
  ["let a recruiter grant", "A1_CATALOGUE", "grant-catalogue.js",
    'const staff = covering.some((grant) => grant.role === "staff");',
    'const staff = covering.some((grant) => grant.role === "staff" || grant.role === "recruiter");'],
  ["accept an altered token", "A1_PREVIEW_CONFIRM", "grant-change.js",
    'if (token.changeDigest !== grantChangeDigest(input.request))', "if (false)"],
  ["allow self-escalation", "A1_GUARDS", "grant-change.js",
    "if (request.targetPrincipalId === callerId)", "if (false)"],
  ["drop the last-admin check", "A1_GUARDS", "grant-change.js",
    "snapshot.adminCount <= 1", "snapshot.adminCount < 1"],
  ["record a grant already held", "A1_GUARDS", "grant-change.js",
    'if (snapshot.current === request.scope || snapshot.current === "subtree")', "if (false)"],
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
process.stdout.write(`${mutations.length}/${mutations.length} access A1 mutations killed\n`);
