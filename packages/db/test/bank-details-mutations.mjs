import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// SHU-182: every guard in the bank-details store must be load-bearing against
// the real PostgreSQL. Each mutation rewrites the built store in place, the
// named test must fail by assertion, and the module is restored before the next.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the SHU-182 bank-details mutations");
const store = new URL("../dist/postgres-bank-details-store.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-bank-details.test.js", import.meta.url));
const mutations = [
  ["skip the candidate check inside the commit", "SHU182_BANK_PG_OWNER",
    "if (!await this.#isCandidate(client, principalId, true))", "if (false)"],
  ["skip the bank check at commit", "SHU182_BANK_PG_BANK_AT_COMMIT",
    "if (bank.rows[0]?.status !== \"active\")", "if (false)"],
  ["drop the compare from the commit", "SHU182_BANK_PG_STALE",
    "if (current !== input.expectedBefore)", "if (false)"],
  ["record a fresh token reference per commit", "SHU182_BANK_PG_RACE",
    "const spentRef = tokenRef(input.tokenId);", "const spentRef = tokenRef(input.tokenId + Math.random());"],
  ["read a receipt without matching its owner", "SHU182_BANK_PG_WRITE",
    "AND request_ref = $2 AND target_principal_ref = $3`", "AND request_ref = $2 AND $3::text IS NOT NULL`"],
  ["read the bank's status without waiting for a retire", "SHU182_BANK_PG_RETIRE_RACE",
    "WHERE catalogue_type = 'bank' AND id = $1::uuid FOR SHARE", "WHERE catalogue_type = 'bank' AND id = $1::uuid"],
  ["serve a receipt for another record", "SHU182_BANK_PG_SCHEMA",
    "|| a?.personRef !== bankDetailsRecordRef(principalId)", "|| !a"],
];
const original = await readFile(store, "utf8");
const run = (pattern) => spawnSync(process.execPath, ["--test-reporter=tap", "--test-concurrency=1",
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
process.stdout.write(`${mutations.length}/${mutations.length} SHU-182 bank-details mutations killed\n`);
