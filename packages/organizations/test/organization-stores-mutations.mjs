// SHU-165: each acceptance item of the store rules is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../dist/organization-stores.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/organizations/test/organization-stores.test.js", import.meta.url));
const mutations = [
  ["write-roles", "SHU-165/AC-01 write-owner-staff-admin", 'const WRITE_ROLES = ["staff", "admin", "org-owner"];', 'const WRITE_ROLES = ["staff", "admin", "org-owner", "recruiter"];'],
  ["owner-write", "SHU-165/AC-01 write-owner-staff-admin", 'const WRITE_ROLES = ["staff", "admin", "org-owner"];', 'const WRITE_ROLES = ["staff", "admin"];'],
  ["subtree", "SHU-165/AC-01 write-owner-staff-admin", '(row.scope === "subtree" && ancestors.includes(row.org_id))', "ancestors.includes(row.org_id)"],
  ["read-roles", "SHU-165/AC-02 read-members-and-staff", 'const READ_ROLES = ["staff", "admin", "org-owner", "recruiter"];', 'const READ_ROLES = ["staff", "admin", "org-owner", "recruiter", "finance"];'],
  ["unknown-keys", "SHU-165/AC-03 fields-parse", 'if (Object.keys(record).some((key) => !["name", "location", "brandId", "mallId"].includes(key)))', "if (false)"],
  ["trim", "SHU-165/AC-03 fields-parse", "const trimmed = value.trim();", "const trimmed = value;"],
  ["removed", "SHU-165/AC-04 removed-hidden", '.filter((row) => row.status === "active")', ""],
  ["reference-status", "SHU-165/AC-04 removed-hidden", 'row.brand_status === "active" ?', "true ?"],
  ["spread", "SHU-165/AC-05 view-whitelist", ".map((row) => ({", ".map((row) => ({ ...row,"],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { SHU165_TEST_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../dist/organization-stores-mutation-${process.pid}.js`, import.meta.url);
  try {
    await writeFile(target, original.replace(from, to));
    const r = run(pattern, `${target.href}?mutation=${encodeURIComponent(name)}`);
    assert.notEqual(r.status, 0, `${name} survived\n${r.output}`);
    if (r.error?.code !== "EPERM") assert.match(r.output, new RegExp(`not ok \\d+ - ${pattern} `));
  } finally {
    await unlink(target).catch(() => {});
  }
}
assert.equal(run().status, 0);
process.stdout.write(`${mutations.length}/${mutations.length} SHU-165 mutations killed\n`);
