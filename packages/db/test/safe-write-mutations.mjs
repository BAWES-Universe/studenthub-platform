import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// SHU-84: every guard in the safe-write path must be load-bearing. Each
// mutation rewrites one built module in place, the named test must fail by
// AssertionError against the real PostgreSQL, and the module is restored
// before the next. The unmutated suite passes before and after.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the SHU-84 mutations");
const store = new URL("../dist/safe-write-store.js", import.meta.url);
const gateway = new URL("../../../dist/apps/gateway/src/language-preference.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/safe-write-store.test.js", import.meta.url));
const mutations = [
  [
    store, "skip the grant check inside the commit", "SHU-84/AC-06 AUTHORITY",
    "if (!await this.#mayWrite(client, principalId))\n                throw new Refusal(\"not_own_record\");", "",
  ],
  [
    store, "treat a grantless principal as an owner", "SHU-84/AC-06 AUTHORITY",
    "WHERE p.id = $1 AND EXISTS (SELECT 1 FROM grants g WHERE g.principal_id = p.id)", "WHERE p.id = $1",
  ],
  [
    store, "accept another principal's references", "SHU-84/AC-06 AUTHORITY",
    "if (input.principalRef !== ownPrincipalRef || input.personRef !== ownPersonRef) {", "if (false) {",
  ],
  [
    store, "drop the compare from the update", "SHU-84/AC-10 STATE",
    "WHERE principal_id = $1 AND language = $3 RETURNING 1", "WHERE principal_id = $1 AND $3::text IS NOT NULL RETURNING 1",
  ],
  [
    store, "let a first write overwrite an existing value", "SHU-84/AC-10 STATE",
    "ON CONFLICT (principal_id) DO NOTHING RETURNING 1", "ON CONFLICT (principal_id) DO UPDATE SET language = EXCLUDED.language RETURNING 1",
  ],
  [
    store, "record a fresh token reference per commit", "SHU-84/AC-05 SINGLE USE",
    "const spentRef = tokenRef(input.tokenId);", "const spentRef = tokenRef(input.tokenId + Math.random());",
  ],
  [
    store, "commit the field before its receipt", "SHU-84/AC-07 ATOMIC",
    "throw new Refusal(\"state_changed\");\n            await client.query(`INSERT INTO authorization_mutation_audit",
    "throw new Refusal(\"state_changed\");\n            await client.query(\"COMMIT\"); await client.query(\"BEGIN\");\n            await client.query(`INSERT INTO authorization_mutation_audit",
  ],
  [
    store, "read a receipt without matching its owner", "SHU-84/AC-08 RECEIPT",
    "AND request_ref = $2 AND target_principal_ref = $3`", "AND request_ref = $2 AND $3::text IS NOT NULL`",
  ],
  [
    gateway, "accept a write from any origin", "SHU-84/AC-11 BOUNDARY",
    "if (request.headers.origin !== origin || request.headers[\"sec-fetch-site\"] === \"cross-site\") {", "if (false) {",
  ],
  [
    gateway, "accept unknown body keys", "SHU-84/AC-11 BOUNDARY",
    "if (!exactKeys(body, [\"language\"]))", "if (typeof body !== \"object\")",
  ],
];

function run(pattern) {
  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite,
  ], { encoding: "utf8", env: process.env, timeout: 120_000 });
  return { ...result, output: result.stdout + result.stderr };
}

const baseline = run();
assert.equal(baseline.status, 0, `baseline must pass\n${baseline.output}`);

for (const [file, name, pattern, from, to] of mutations) {
  const original = await readFile(file, "utf8");
  assert.equal(original.split(from).length - 1, 1, `mutation must bind exactly once: ${name}`);
  try {
    await writeFile(file, original.replace(from, to));
    const result = run(pattern);
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: survived\n${result.output}`);
    assert.match(result.output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${result.output}`);
    assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: infrastructure failure\n${result.output}`);
    assert.match(result.output, /code: 'ERR_ASSERTION'/, `${name}: must die by AssertionError\n${result.output}`);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
  } finally {
    await writeFile(file, original);
  }
}

const restored = run();
assert.equal(restored.status, 0, `restored suite must pass\n${restored.output}`);
process.stdout.write(`${mutations.length}/${mutations.length} SHU-84 mutations killed\n`);
