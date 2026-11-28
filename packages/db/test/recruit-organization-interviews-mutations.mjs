import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// A company's interviews (O-10), store read: who reads, which company, and that paused people are hidden before
// paging must each be load-bearing. Each mutant rewrites the built file, the named test must fail by assertion,
// and the file is restored before the next.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the organization interviews mutations");
const store = new URL("../dist/recruit/postgres-recruit-interviews-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-recruit-interviews.test.js", import.meta.url));
const mutations = [
  ["page before hiding paused people", "REC6_ORGANIZATION_PAUSED_PAGES", "($4::boolean OR c.person_principal_id IS NULL", "($4::boolean OR true OR c.person_principal_id IS NULL"],
  ["hide paused people from internal callers too", "REC6_ORGANIZATION_PAUSED_PAGES", "[orgId, limit + 1, (page - 1) * limit, internal]", "[orgId, limit + 1, (page - 1) * limit, false]"],
  ["let anyone read a company", "REC6_ORGANIZATION", "if (this.options.staffDecision(grants) || company) {", "if (true) {"],
  ["read every company's interviews", "REC6_ORGANIZATION", "WHERE r.org_id = $1::text", "WHERE $1::text IS NOT NULL"],
  ["hide that an older page exists", "REC6_ORGANIZATION", "const more = rows.length > limit;", "const more = false;"],
];
const original = await readFile(store, "utf8");
const restore = () => writeFile(store, original);
const run = (pattern) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", timeout: 120_000 });
let killed = 0;
try {
  assert.equal(run().status, 0, "the unmutated suite passes");
  for (const [name, pattern, from, to] of mutations) {
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(store, original.replace(from, () => to));
    const result = run(pattern);
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: mutation survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: infrastructure failure\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${name}: did not die by assertion\n${output}`);
    killed++;
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
    await restore();
  }
} finally { await restore(); }
assert.equal(run().status, 0, "the restored suite passes");
process.stdout.write(`${killed}/${mutations.length} organization interviews store mutations killed\n`);
