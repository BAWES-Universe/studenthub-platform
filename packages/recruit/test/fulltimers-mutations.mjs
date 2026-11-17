// Recruit R9: each full-timer rule is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/packages/recruit/src/fulltimers.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/recruit/test/fulltimers.test.js", import.meta.url));
const mutations = [
  ["company-reads", "REC9_RULES", '&& row.scope === "subtree" && operators.includes(row.org_id));', '&& row.scope === "subtree");'],
  ["case-sensitive-name", "REC9_RULES", 'name.normalize("NFKC").toLowerCase()', 'name.normalize("NFKC")'],
  ["raw-phone", "REC9_RULES", "value.replace(/[\\s\\-().]/g, \"\")", "value"],
  ["half-location", "REC9_PARSE", "(latitude === null) !== (longitude === null) || ", ""],
  ["future-birth", "REC9_PARSE", ' && r.birthDate <= today', ""],
  ["duplicate-tags", "REC9_PARSE", "[...new Set(items.filter((v) => v !== null && v !== undefined))]", "items.filter((v) => v !== null && v !== undefined)"],
  ["open-form", "REC9_PARSE", "if (!closed(value, KEYS))", "if (false)"],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { REC9_FULLTIMERS_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/packages/recruit/src/fulltimers-mutation-${process.pid}.js`, import.meta.url);
  try {
    await writeFile(target, original.replace(from, to));
    const r = run(pattern, `${target.href}?mutation=${encodeURIComponent(name)}`);
    assert.notEqual(r.status, 0, `${name} survived\n${r.output}`);
    assert.match(r.output, new RegExp(`not ok \\d+ - ${pattern} `));
  } finally {
    await unlink(target).catch(() => {});
  }
}
assert.equal(run().status, 0);
process.stdout.write(`${mutations.length}/${mutations.length} recruit full-timer mutations killed\n`);
