import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane G-02: the Postgres store change is one transaction that decides
// on what it read inside it. Each mutation rewrites the built store in place,
// the named test must fail by assertion, and the module is restored before the next.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the access G-02 store mutations");
const store = new URL("../dist/access/postgres-access-grants-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-access-store-grants.test.js", import.meta.url));
const mutations = [
  ["write the access before the event outside a transaction", "G02_STORE_ATOMIC",
    'await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");', 'await client.query("SELECT 1");'],
  ["confirm over a change made meanwhile", "G02_STORE_GUARDS",
    "if (snapshot.held !== input.expectedHeld)", "if (false)"],
  ["ignore a pause made meanwhile", "G02_STORE_GUARDS",
    "paused: Boolean(paused.rowCount)", "paused: false"],
  ["give access at a removed store", "G02_STORE_GUARDS",
    'row.status === "active" &&', ""],
  ["record a revoke as a grant", "G02_STORE_ATOMIC",
    'verdict.after ? "grant" : "revoke"', '"grant"'],
  ["offer removed stores in the search", "G02_STORE_LIST",
    "WHERE s.status = 'active' AND lower(s.name) LIKE", "WHERE lower(s.name) LIKE"],
  ["list access at a removed store", "G02_STORE_LIST",
    "AND a.revoked_at IS NULL AND s.status = 'active'", "AND a.revoked_at IS NULL"],
];
const original = await readFile(store, "utf8");
const run = (pattern) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", timeout: 120_000 });
try {
  assert.equal(run().status, 0, "the unmutated suite passes");
  for (const [name, pattern, from, to] of mutations) {
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(store, original.replace(from, to));
    const result = run(pattern);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${name}: mutation survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${name}: did not die by assertion\n${output}`);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
    await writeFile(store, original);
  }
} finally {
  await writeFile(store, original);
}
assert.equal(run().status, 0, "the restored suite passes");
process.stdout.write(`${mutations.length}/${mutations.length} access G-02 store Postgres mutations killed\n`);
