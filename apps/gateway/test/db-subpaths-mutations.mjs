import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const suite = "dist/apps/gateway/test/db-subpaths.test.js";
const mutations = [
  ["gateway root import", "PREP_DEEP_IMPORTS", "dist/apps/gateway/src/wiring/access.js", "@studenthub/db/access", "@studenthub/db"],
  ["missing root area", "PREP_ROOT_SAME", "packages/db/dist/index.js", 'export * from "./profile/index.js";', ""],
  ["missing owned symbol", "PREP_EXPORTS", "packages/db/dist/ops/index.js", 'export { PostgresJobRunsStore } from "../postgres-job-runs-store.js";', ""],
  ["wrong area symbol", "PREP_EXPORTS", "packages/db/dist/catalogue/index.js", 'export { PostgresCatalogueStore } from "../postgres-catalogue-store.js";', 'export { PostgresCatalogueStore } from "../postgres-catalogue-store.js";\nexport { PostgresAuthzStore } from "../postgres-authz-store.js";'],
];

for (const [name, token, file, from, to] of mutations) {
  const original = await readFile(file, "utf8");
  assert.equal(original.split(from).length - 1, 1, `${name} binds exactly once`);
  try {
    await writeFile(file, original.replace(from, to));
    const result = spawnSync(process.execPath, ["--test", "--experimental-test-isolation=none", `--test-name-pattern=^${token} `, suite], { encoding: "utf8", timeout: 30000 });
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name} survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${token} `));
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    process.stdout.write(`KILLED ${name} -> ${token}\n`);
  } finally {
    await writeFile(file, original);
  }
}
process.stdout.write(`${mutations.length}/${mutations.length} database subpath mutations killed\n`);
