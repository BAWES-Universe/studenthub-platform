import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// A-02 slice 1: only operator staff and admin warn and tag a person who exists; a warning
// emails the person its title and message; a correction needs the version read and only
// touches the person's own warning; removed tags leave the list. Each mutation rewrites the
// built store in place, the named test must fail by assertion, and the store is restored.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the A-02 lifecycle mutations");
const store = new URL("../dist/access/postgres-person-lifecycle-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-person-lifecycle.test.js", import.meta.url));
const mutations = [
  ["let anyone read and write", "A02_DENY", "this.options.staffDecision(grants) && exists ?", "exists ?"],
  ["go ahead for a person who does not exist", "A02_DENY", "this.options.staffDecision(grants) && exists ?", "this.options.staffDecision(grants) ?"],
  ["email a fixed heading instead of the title", "A02_WARN", "heading: input.title", 'heading: "Warning"'],
  ["list warnings oldest first", "A02_WARN", "FROM person_warnings w WHERE principal_id = $1::text ORDER BY created_at DESC", "FROM person_warnings w WHERE principal_id = $1::text ORDER BY created_at"],
  ["ignore the version read", "A02_CORRECT", "row.version !== input.expectedVersion", "false"],
  ["correct another person's warning", "A02_CORRECT", "WHERE id = $1::uuid AND principal_id = $2 FOR UPDATE", "WHERE id = $1::uuid AND $2::text IS NOT NULL FOR UPDATE"],
  ["list removed tags", "A02_TAGS", "AND removed_at IS NULL ORDER BY created_at DESC, id", "ORDER BY created_at DESC, id"],
  ["remove another person's tag", "A02_TAGS", "WHERE id = $1::uuid AND principal_id = $2 AND removed_at IS NULL", "WHERE id = $1::uuid AND $2::text IS NOT NULL AND removed_at IS NULL"],
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
process.stdout.write(`${mutations.length}/${mutations.length} A-02 lifecycle Postgres mutations killed\n`);
