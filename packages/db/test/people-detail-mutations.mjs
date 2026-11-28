import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// People A-01: the one-person read is the list's own statement narrowed to one bound id.
// Each mutation rewrites the built store in place, the named test must fail by assertion,
// and the module is restored before the next.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the people A-01 store mutations");
const store = new URL("../../../dist/packages/db/src/postgres-people-directory-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-people-directory.test.js", import.meta.url));
const mutations = [
  ["read the first person instead of the one asked for", "DIRDB_PERSON", "($14::text IS NULL OR p.id=$14::text)", "($14::text IS NULL OR true)"],
  ["query with a malformed id", "DIRDB_PERSON", "principalId.length > 256)", "false)"],
];
const original = await readFile(store, "utf8");
const run = (pattern) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", timeout: 180_000 });
try {
  assert.equal(run("DIRDB_PERSON").status, 0, "the unmutated test passes");
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
process.stdout.write(`${mutations.length}/${mutations.length} people A-01 store mutations killed\n`);
