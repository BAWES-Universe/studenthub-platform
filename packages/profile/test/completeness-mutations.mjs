import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../dist/completeness.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/profile/test/completeness.test.js", import.meta.url));
const mutations = [
  ["treat a No answer or boolean false as missing", "Q14_4_RULES No booleans",
    'if (typeof value === "boolean")\n        return true;', 'if (typeof value === "boolean")\n        return value;'],
  ["require Kuwaiti mother for KW or by name", "Q14_4_RULES Kuwaiti mother",
    'motherRequired = nationalityCode !== "KW";',
    'motherRequired = nationalityCode === "KW" || nationality.value === "Kuwaiti";'],
  ["let imported list satisfy a document requirement", "Q14_4_RULES documents",
    'if (!documents.has("personal-photo"))\n        missing.add("personal_photo");',
    'if (!documents.has("personal-photo") && !importedOnlyMet(profile, "personal_photo", false))\n        missing.add("personal_photo");'],
  ["report complete when a source failed", "Q14_4_DERIVED",
    'return Object.freeze({ kind: "unavailable", reason: "check_failed" });\n    }\n    const profile',
    'return Object.freeze({ kind: "available", pendingFields: Object.freeze([]) });\n    }\n    const profile'],
  ["keep identity_reference", "Q14_4_COMPAT",
    'const ORDER = Object.freeze([\n    "nationality",',
    'const ORDER = Object.freeze([\n    "identity_reference", "nationality",'],
];

for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `mutation must bind exactly once: ${name}`);
  const target = new URL(`../dist/completeness-mutation-${process.pid}.js`, import.meta.url);
  try {
    await writeFile(target, original.replace(from, to));
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=^${pattern} `, suite], {
      encoding: "utf8", env: { ...process.env, SHU576_TEST_MODULE: `${target.href}?mutation=${encodeURIComponent(name)}` }, timeout: 30_000,
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: survived`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named assertion did not fail\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/, `${name}: infrastructure failure\n${output}`);
    assert.match(output, /code: 'ERR_ASSERTION'/, `${name}: must die by AssertionError\n${output}`);
    assert.match(output, /name: 'AssertionError'/, `${name}: must die by AssertionError\n${output}`);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
  } finally {
    await unlink(target).catch(() => undefined);
  }
}

process.stdout.write(`${mutations.length}/${mutations.length} SHU-576 mutations killed\n`);
