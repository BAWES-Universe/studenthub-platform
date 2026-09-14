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
  [
    "relax date shape widths and end anchor", "PROFILE-PARSER",
    String.raw`/^\d{4}-\d{2}-\d{2}$/`, String.raw`/^\d{4}-\d{1,2}-\d{1,2}/`,
    "PROFILE-PARSER candidate_birth_date rejects malformed imported value",
  ],
  [
    "echo malformed enum input in thrown error", "PROFILE-ERROR",
    'if (!mapping.has(value))\n            throw new TypeError("malformed approved profile value");',
    'if (!mapping.has(value))\n            throw new TypeError("malformed approved profile value: " + String(value));',
    "PROFILE-ERROR candidate_gender uses constant error message",
  ],
  [
    "swap gender mapping", "PROFILE-ENUM",
    '[1, "male"], [2, "female"]', '[1, "female"], [2, "male"]',
    "PROFILE-ENUM gender 2 positive fixture mapping",
  ],
  [
    "swap driving licence mapping", "PROFILE-ENUM",
    'new Map([[1, true], [2, false]])', 'new Map([[1, false], [2, true]])',
    "PROFILE-ENUM drivingLicence 1 positive fixture mapping",
  ],
  [
    "swap language mapping", "PROFILE-ENUM",
    '[["en", "en"], ["ar", "ar"]]', '[["en", "ar"], ["ar", "en"]]',
    "PROFILE-ENUM language ar positive fixture mapping",
  ],
  [
    "restore unconfigured 404", "PROFILE-DEFAULT-JSON",
    'if (link.kind === "unconfigured")', 'if (false)',
    "PROFILE-DEFAULT-JSON unconfigured profile must render instead of 404",
  ],
];

for (const [name, pattern, from, to, assertion] of mutations) {
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
    assert.match(output, /code: 'ERR_ASSERTION'/, `${name}: must die by AssertionError\n${output}`);
    assert.match(output, /name: 'AssertionError'/, `${name}: must die by AssertionError\n${output}`);
    if (assertion) assert.ok(output.includes(assertion), `${name}: expected assertion text\n${output}`);
    process.stdout.write(`KILLED ${name} -> ${pattern}${assertion ? ` -> AssertionError [ERR_ASSERTION]: ${assertion}` : ""}\n`);
  } finally {
    await unlink(target).catch(() => undefined);
  }
}

process.stdout.write(`${mutations.length}/${mutations.length} SHU-92 mutations killed\n`);
