import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane A3: a removed contact is never listed again, and removing a
// contact never touches a grant. Each mutation rewrites the built store in
// place, the named test must fail by assertion, and the store is restored.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the access A3 mutations");
const store = new URL("../dist/access/postgres-access-contacts-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-access-contacts.test.js", import.meta.url));
const mutations = [
  ["list a removed contact", "A3_REMOVE",
    "WHERE org_id = $1 AND removed_at IS NULL ORDER BY lower(name), id", "WHERE org_id = $1 ORDER BY lower(name), id"],
  ["remove a grant with the contact", "A3_REMOVE",
    'return changed.rowCount ? { kind: "removed" } : { kind: "refused", reason: "not_found" };',
    `await client.query("DELETE FROM grants WHERE org_id = $1 AND role = 'recruiter'", [input.orgId]);
            return changed.rowCount ? { kind: "removed" } : { kind: "refused", reason: "not_found" };`],
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
process.stdout.write(`${mutations.length}/${mutations.length} access A3 Postgres mutations killed\n`);
