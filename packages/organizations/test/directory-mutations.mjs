import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// SHU-163: every directory guard must be load-bearing. Each mutation is applied to the
// built module, the named test group must fail by AssertionError, and the
// unmutated suite must pass before and after.
const source = new URL("../dist/organizations.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/organizations/test/organization-directory.test.js", import.meta.url));
const mutations = [
  [
    "list for an employer role", "SHU-163/AC-01 SCOPE",
    'new Set(["staff", "admin"])', 'new Set(["staff", "admin", "org-owner"])',
  ],
  [
    "ignore the active context bound", "SHU-163/AC-01 SCOPE",
    ".filter((context) => context.role === request.role && within.has(context.orgId)",
    ".filter((context) => context.role === request.role",
  ],
  [
    "borrow coverage from another role", "SHU-163/AC-01 SCOPE",
    ".filter((context) => context.role === request.role && within.has(context.orgId)",
    ".filter((context) => within.has(context.orgId)",
  ],
  [
    "count uncovered sub-organizations", "SHU-163/AC-01 SCOPE",
    "child.parentOrgId === org.id && covered.has(child.id)", "child.parentOrgId === org.id",
  ],
  [
    "skip context resolution", "SHU-163/AC-01 SCOPE",
    "if (resolution.kind !== \"authorized\" || resolution.context.orgId !== request.orgId\n                || resolution.context.role !== request.role)\n                return { kind: \"not_found\" };\n            const [contexts",
    "const [contexts",
  ],
  [
    "list sub-organizations at the top level", "SHU-163/AC-02 HIERARCHY",
    "if (companyParentOf(organizations, org.id, this.#operators) !== null)\n                    continue;",
    "companyParentOf(organizations, org.id, this.#operators);",
  ],
  [
    "treat an unavailable status as inactive", "SHU-163/AC-03 FILTERS",
    "availableValue(entry.status) !== filters.status", "(availableValue(entry.status) ?? \"inactive\") !== filters.status",
  ],
  [
    "skip the Arabic common name in search", "SHU-163/AC-03 FILTERS",
    "availableValue(entry.commonNameEn),\n            availableValue(entry.commonNameAr)]", "availableValue(entry.commonNameEn)]",
  ],
  [
    "search case-sensitively", "SHU-163/AC-03 FILTERS",
    "return value.normalize(\"NFKC\").toLocaleLowerCase(\"en\");", "return value;",
  ],
  [
    "accept unknown filters", "SHU-163/AC-03 FILTERS",
    "if (Object.keys(rest).length > 0)\n        return false;", "",
  ],
  [
    "add contact data to entries", "SHU-163/AC-04 PROJECTION",
    "subOrganizationCount,\n        legalName:", "subOrganizationCount,\n        email: row === undefined ? unavailable(\"email\", \"not_imported\") : plainField(\"email\", row),\n        legalName:",
  ],
  [
    "page size off by one", "SHU-163/AC-05 PAGES",
    "entries.slice(start, start + ORGANIZATION_DIRECTORY_PAGE_SIZE)", "entries.slice(start, start + ORGANIZATION_DIRECTORY_PAGE_SIZE + 1)",
  ],
  [
    "hide a company whose data is unreadable", "SHU-163/AC-06 UNAVAILABLE",
    "const row = snapshotRow(await this.#source.readSnapshot(org.id), org.id, null);",
    "let row;\n                try { row = snapshotRow(await this.#source.readSnapshot(org.id), org.id, null); } catch { continue; }",
  ],
];

function run(pattern, module) {
  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite,
  ], {
    encoding: "utf8",
    env: { ...process.env, ...(module ? { SHU163_TEST_MODULE: module } : {}) },
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
process.stdout.write(`${mutations.length}/${mutations.length} SHU-163 mutations killed\n`);
