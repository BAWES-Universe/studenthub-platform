import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../dist/restore-check.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-restore-check.test.js", import.meta.url));
const mutations = [
  ["skip one table", "SHU104_COUNTS", "const allTables = [...new Set([...sourceTables, ...restoredTables])].sort();", "const allTables = [...new Set([...sourceTables, ...restoredTables])].sort().slice(1);"],
  ["skip sequence check", "SHU104_INTEGRITY", "sequenceChecks.push({ table: sequence.table_name, constraint: sequence.sequence_name, ok: result.rows[0].ok });", "sequenceChecks.push({ table: sequence.table_name, constraint: sequence.sequence_name, ok: true });"],
  ["drop suffix guard", "SHU104_SAFE_TARGET", "if (suffixes.length === 0 || suffixes.some((suffix) => !suffix) || !suffixes.some((suffix) => restored.endsWith(suffix))) {", "if (false) {"],
];
function run(pattern, module) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", env: { ...process.env, ...(module ? { SHU437_TEST_MODULE: module } : {}) }, timeout: 120000 });
  return { ...result, output: result.stdout + result.stderr };
}
const baseline = run();
assert.equal(baseline.status, 0, `unmutated restore-check tests must pass\n${baseline.output}`);
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../dist/restore-check-mutation-${process.pid}.js`, import.meta.url);
  try {
    await writeFile(target, original.replace(from, to));
    const result = run(pattern, `${target.href}?mutation=${encodeURIComponent(name)}`);
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name} survived\n${result.output}`);
    assert.match(result.output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${result.output}`);
    assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: infrastructure failure\n${result.output}`);
    assert.match(result.output, /code: 'ERR_ASSERTION'/, `${name}: must die by AssertionError\n${result.output}`);
  } finally { await unlink(target).catch(() => undefined); }
}
const restored = run();
assert.equal(restored.status, 0, `unmutated restore-check tests must still pass\n${restored.output}`);
process.stdout.write("3/3 SHU-437 mutations killed\n");
