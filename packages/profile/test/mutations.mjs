import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../dist/profile.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/profile/test/profile.test.js", import.meta.url));
const mutations = [
  [
    "widen the sensitive-field whitelist",
    "PROFILE-WHITELIST",
    "const PROFILE_FIELD_SPECS = Object.freeze({\n    displayName:",
    "const PROFILE_FIELD_SPECS = Object.freeze({\n    civilIdNumber: fieldSpec(\"candidate_civil_id\", \"Civil ID number\", \"Forbidden sensitive field.\", text(255)),\n    displayName:",
  ],
  [
    "remove owner enforcement",
    "PROFILE-OWNER",
    "if (request.requesterPrincipalId !== request.targetPersonId)",
    "if (false)",
  ],
  [
    "coalesce unavailable to empty",
    "PROFILE-UNAVAILABLE",
    "state: \"unavailable\",\n        reason,",
    "state: \"available\",\n        value: \"\",\n        reason,",
  ],
  [
    "bypass imported-value parsing",
    "PROFILE-PARSER",
    "const value = spec.parse(raw, today);",
    "const value = raw;",
  ],
];

for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `mutation must bind exactly once: ${name}`);
  const target = new URL(`../dist/mutation-${process.pid}.js`, import.meta.url);
  try {
    await writeFile(target, original.replace(from, to));
    const result = spawnSync(process.execPath, [
      "--test", "--test-reporter=tap", `--test-name-pattern=^${pattern} `, suite,
    ], {
      encoding: "utf8",
      env: { ...process.env, SHU92_TEST_MODULE: `${target.href}?mutation=${encodeURIComponent(name)}` },
      timeout: 30_000,
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: survived`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named assertion did not fail\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/, `${name}: infrastructure failure\n${output}`);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
  } finally {
    await unlink(target).catch(() => undefined);
  }
}

process.stdout.write(`${mutations.length}/${mutations.length} SHU-92 mutations killed\n`);
