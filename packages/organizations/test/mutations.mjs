import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// SHU-159: every guard must be load-bearing. Each mutation is applied to the
// built module, the named test group must fail by AssertionError, and the
// unmutated suite must pass before and after.
const source = new URL("../dist/organizations.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/organizations/test/organizations.test.js", import.meta.url));
const mutations = [
  [
    "read status from the stored legacy column", "SHU-159/AC-01 STATUS",
    "const override = statusOverride(row);",
    "if (row.company_status === 10)\n        return available(\"status\", \"active\");\n    const override = statusOverride(row);",
  ],
  [
    "ignore the staff override (legacy employer copy)", "SHU-159/AC-01 STATUS",
    "if (override.state === \"available\")\n        return available(\"status\", override.value);",
    "if (false)\n        return available(\"status\", override.value);",
  ],
  [
    "treat missing counters as zero", "SHU-159/AC-01 STATUS",
    "return missing ? unavailable(\"status\", \"not_imported\") : available(\"status\", \"inactive\");",
    "return available(\"status\", \"inactive\");",
  ],
  [
    "allow a sub-organization to have sub-organizations", "SHU-159/AC-02 HIERARCHY",
    "if (chain.length > 2)", "if (false)",
  ],
  [
    "list children of a sub-organization", "SHU-159/AC-02 HIERARCHY",
    "if (parentOrgId !== null && children.length > 0)", "if (false)",
  ],
  [
    "accept a snapshot that disagrees with the registry", "SHU-159/AC-02 HIERARCHY",
    "if (record.org_id !== orgId || (record.parent_org_id ?? null) !== parentOrgId)",
    "if (record.org_id !== orgId)",
  ],
  [
    "return the staff projection to an org-owner", "SHU-159/AC-03 PROJECTION",
    "\"org-owner\": \"employer\",", "\"org-owner\": \"staff\",",
  ],
  [
    "give candidates the employer projection", "SHU-159/AC-03 PROJECTION",
    "\"org-owner\": \"employer\",", "candidate: \"employer\",\n    \"org-owner\": \"employer\",",
  ],
  [
    "skip grant resolution", "SHU-159/AC-04 SCOPE",
    "if (resolution.kind !== \"authorized\" || resolution.context.orgId !== orgId\n            || resolution.context.role !== request.role)",
    "if (false)",
  ],
  [
    "treat the operator root as an organization", "SHU-159/AC-04 SCOPE",
    "if (this.#operators.has(orgId))\n            return undefined;", "",
  ],
  [
    "drop the parent rate fallback", "SHU-159/AC-05 RATES",
    "return parent[sourceField] === null ? unavailable(name, \"not_recorded\") : available(name, decimal(parent[sourceField]));",
    "return unavailable(name, \"not_recorded\");",
  ],
];

function run(pattern, module) {
  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite,
  ], {
    encoding: "utf8",
    env: { ...process.env, ...(module ? { SHU159_TEST_MODULE: module } : {}) },
    timeout: 30_000,
  });
  return { ...result, output: result.stdout + result.stderr };
}

const baseline = run();
assert.equal(baseline.status, 0, `baseline must pass\n${baseline.output}`);

for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `mutation must bind exactly once: ${name}`);
  const target = new URL(`../dist/mutation-${process.pid}.js`, import.meta.url);
  try {
    await writeFile(target, original.replace(from, to));
    const result = run(pattern, `${target.href}?mutation=${encodeURIComponent(name)}`);
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: survived\n${result.output}`);
    assert.match(result.output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${result.output}`);
    assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/, `${name}: infrastructure failure\n${result.output}`);
    assert.match(result.output, /code: 'ERR_ASSERTION'/, `${name}: must die by AssertionError\n${result.output}`);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
  } finally {
    await unlink(target).catch(() => undefined);
  }
}

const restored = run();
assert.equal(restored.status, 0, `restored suite must pass\n${restored.output}`);
process.stdout.write(`${mutations.length}/${mutations.length} SHU-159 mutations killed\n`);
