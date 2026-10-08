import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// SHU-143: every guard in the candidate-profile store must be load-bearing against
// the real PostgreSQL. Each mutation rewrites the built store in place, the named
// test must fail by assertion, and the module is restored before the next.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the SHU-143 candidate-profile mutations");
const store = new URL("../dist/postgres-candidate-profile-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-candidate-profile.test.js", import.meta.url));
const mutations = [
  ["delete the completeness recompute", "SHU143_PG_COMPLETENESS",
    "await client.query(\"UPDATE candidate_profiles SET pending_fields = $2::text[] WHERE principal_id = $1\", [principalId, pending]);", ""],
  ["drop the principal-equals-owner check", "SHU143_PG_OWNER",
    "input.principalRef === ownPrincipalRef && input.personRef === ownRecordRef\n                ? this.#commit", "true\n                ? this.#commit"],
  ["skip the candidate check inside the commit", "SHU143_PG_OWNER",
    "if (!await this.#isCandidate(client, principalId, true))", "if (false)"],
  ["drop the compare from the commit", "SHU143_PG_STALE",
    "if (current !== input.expectedBefore)", "if (false)"],
  ["record a fresh token reference per commit", "SHU143_PG_RACE",
    "const spentRef = tokenRef(input.tokenId);", "const spentRef = tokenRef(input.tokenId + Math.random());"],
  ["skip the catalogue check at commit", "SHU143_PG_CATALOGUE_AT_COMMIT",
    "if (item.rows[0]?.status !== \"active\")", "if (false)"],
  ["read a receipt without matching its owner", "SHU143_PG_WRITE",
    "AND request_ref = $2 AND target_principal_ref = $3`", "AND request_ref = $2 AND $3::text IS NOT NULL`"],
  ["serve a receipt for another record", "SHU143_PG_SCHEMA",
    "|| a?.personRef !== candidateProfileRecordRef(principalId)", "|| !a"],
  ["report a taken phone as a server error", "SHU143_PG_UNIQUE",
    "if (code === \"23505\" && constraint !== undefined && UNIQUE_INDEXES.has(constraint))", "if (false)"],
  ["let the uniqueness lookup see the caller's own row as taken", "SHU143_PG_UNIQUE",
    " = $1 AND principal_id <> $2`", " = $1 AND $2::text IS NOT NULL`"],
];
const original = await readFile(store, "utf8");
const run = (pattern) => spawnSync(process.execPath, ["--test-reporter=tap", "--test-concurrency=1",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", timeout: 300_000 });
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
process.stdout.write(`${mutations.length}/${mutations.length} SHU-143 candidate-profile mutations killed\n`);
