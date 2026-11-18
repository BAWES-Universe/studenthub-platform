import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane A7: approval makes the company active, and never makes a paused person an owner.
// The mutation rewrites the built store in place, the named test must fail by
// assertion, and the store is restored.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the access A7 mutations");
const store = new URL("../dist/access/postgres-access-registrations-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-access-registrations.test.js", import.meta.url));
const mutations = [
  ["leave the new company without a status", "A7_APPROVE",
    "INSERT INTO organization_status_overrides (org_id, status) VALUES ($1, 'active')", "SELECT $1::text"],
  ["make a paused person an owner", "A7_REVIEW",
    "SELECT 1 FROM account_pauses WHERE principal_id = $1 AND resumed_at IS NULL", "SELECT 1 FROM account_pauses WHERE principal_id = $1 AND false"],
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
process.stdout.write(`${mutations.length}/${mutations.length} access A7 Postgres mutations killed\n`);
