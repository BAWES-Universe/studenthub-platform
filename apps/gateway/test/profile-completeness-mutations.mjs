import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/apps/gateway/src/profile-completeness.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/apps/gateway/test/profile-completeness.test.js", import.meta.url));
const original = await readFile(source, "utf8");
const needle = "        return failed;";
assert.equal(original.split(needle).length - 1, 1, "Q14_4_STATUS failure guard binds once");
const target = new URL(`../../../dist/apps/gateway/src/profile-completeness-mutant-${process.pid}.js`, import.meta.url);
function run(module) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^Q14_4_STATUS ", suite], { encoding: "utf8", timeout: 30000, env: { ...process.env, SHU588_COMPLETENESS_MODULE: module } });
  assert.equal(result.error, undefined, "Q14_4_STATUS runner must execute");
  return { ...result, output: result.stdout + result.stderr };
}
try {
  const control = run(source.href);
  assert.equal(control.status, 0, `Q14_4_STATUS passing control\n${control.output}`);
  await writeFile(target, original.replace(needle, "        throw new Error(\"mutant escaped source failure\");"));
  const mutant = run(target.href);
  assert.notEqual(mutant.status, 0, `Q14_4_STATUS mutant survived\n${mutant.output}`);
  assert.match(mutant.output, /not ok \d+ - Q14_4_STATUS/);
  assert.match(mutant.output, /AssertionError/);
  assert.match(mutant.output, /failure must preserve profile status/);
  assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/);
  console.log("KILLED Q14_4_STATUS escaped gatherer failure -> failure must preserve profile status");
} finally {
  await unlink(target).catch(error => { if (error.code !== "ENOENT") throw error; });
  assert.equal(await readFile(source, "utf8"), original, "Q14_4_STATUS original remains unchanged");
}
