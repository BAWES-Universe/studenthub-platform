import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane A1: the Postgres write is one transaction that decides on what
// it read inside it. Each mutation rewrites the built store in place, the
// named test must fail by assertion, and the module is restored before the next.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the access A1 mutations");
const store = new URL("../dist/access/postgres-access-grants-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-access-grants.test.js", import.meta.url));
const mutations = [
  ["write the grant before the audit outside a transaction", "A1_ATOMIC",
    'await client.query("BEGIN");', 'await client.query("SELECT 1");'],
  ["skip the decision at commit", "A1_GUARDS",
    "const decision = input.decide(snapshot);",
    'const decision = { kind: "apply", before: snapshot.current, after: request.action === "grant" ? request.scope : null };'],
  ["show a granter for a grant made outside the page", "A1_LIST",
    'const known = row.action === "grant" && row.actor_id !== null;', "const known = true;"],
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
process.stdout.write(`${mutations.length}/${mutations.length} access A1 Postgres mutations killed\n`);
