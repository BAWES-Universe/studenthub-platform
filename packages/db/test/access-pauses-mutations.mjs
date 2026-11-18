import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane A6: a pause takes sessions and store grants away with the
// grants, and a resume never gives back a grant at a deleted company. Each
// mutation rewrites the built store in place, the named test must fail by
// assertion, and the store is restored.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the access A6 mutations");
const store = new URL("../dist/access/postgres-access-pauses-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-access-pauses.test.js", import.meta.url));
const mutations = [
  ["keep the sessions of a paused person", "A6_PAUSE",
    'await client.query("DELETE FROM login_sessions WHERE person_id = $1", [target]);', ""],
  ["keep the store grants of a paused person", "A6_PAUSE",
    "WHERE principal_id = $1 AND revoked_at IS NULL RETURNING org_id, store_id", "WHERE false AND principal_id = $1 RETURNING org_id, store_id"],
  ["give back a grant at a deleted company", "A6_RESUME",
    "for (const grant of suspended.filter((item) => liveOrgs.has(item.orgId))) {", "for (const grant of suspended) {"],
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
process.stdout.write(`${mutations.length}/${mutations.length} access A6 Postgres mutations killed\n`);
