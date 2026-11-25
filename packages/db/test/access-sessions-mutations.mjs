import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane U-03: the sessions store reads and ends only the person's own sessions.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the access U-03 mutations");
const store = new URL("../dist/access/postgres-access-sessions-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-access-sessions.test.js", import.meta.url));
const mutations = [
  ["list everyone's sessions", "U03_LIST", "WHERE person_id = $1 AND expires_at > now()", "WHERE ($1::text IS NOT NULL) AND expires_at > now()"],
  ["list expired sessions", "U03_LIST", "WHERE person_id = $1 AND expires_at > now()", "WHERE person_id = $1"],
  ["count only the listed sessions", "U03_OVER_LIMIT", "count(*) OVER () AS live", "$3::int AS live"],
  ["end only the current browser", "U03_END", 'DELETE FROM login_sessions WHERE person_id = $1"', 'DELETE FROM login_sessions WHERE person_id = $1 AND false"'],
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
process.stdout.write(`${mutations.length}/${mutations.length} access U-03 store mutations killed\n`);
