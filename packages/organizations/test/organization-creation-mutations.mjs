import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const source = new URL("../dist/organization-creation.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/organizations/test/organization-creation.test.js", import.meta.url));
const mutations = [
  ["roles", "SHU333_DECISION", '(row.role === "staff" || row.role === "admin")', "true"],
  ["subtree", "SHU333_DECISION", 'row.scope === "subtree" && ', ""],
  ["hierarchy", "SHU333_HIERARCHY", "|| operators.includes(parentOfParent)", "|| true"],
  ["trim", "SHU333_NAME", "const trimmed = value.trim();", "const trimmed = value;"],
];
const run = (pattern, module) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", env: { ...process.env, ...(module ? { SHU333_TEST_MODULE: module } : {}) }, timeout: 30000 });
assert.equal(run().status, 0);
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../dist/organization-creation-mutation-${process.pid}.js`, import.meta.url);
  try { await writeFile(target, original.replace(from, to)); const result = run(pattern, `${target.href}?mutation=${name}`); assert.notEqual(result.status, 0, `${name} survived\n${result.stdout}${result.stderr}`); }
  finally { await unlink(target).catch(() => {}); }
}
assert.equal(run().status, 0);
process.stdout.write("4/4 SHU333 mutations killed\n");
