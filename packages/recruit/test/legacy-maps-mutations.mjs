// Recruit legacy maps: each documented code is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/packages/recruit/src/legacy-maps.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/recruit/test/legacy-maps.test.js", import.meta.url));
const mutations = [
  ["seen-lost", "REC_LEGACY_INVITE", '[1, seen ? "seen" : "sent"]', '[1, "sent"]'],
  ["evaluated-still-scheduled", "REC_LEGACY_INVITE", '[1, evaluated ? "completed" : "scheduled"]', '[1, "scheduled"]'],
  ["rejected-interview-open", "REC_LEGACY_INVITE", '[2, "cancelled"], [3, "cancelled"]', '[3, "cancelled"]'],
  ["old-draft-unknown", "REC_LEGACY_JOBS", '[0, "draft"], ', ""],
  ["guess-unknown", "REC_LEGACY_JOBS", 'table.has(raw) ? { kind: "mapped", value: table.get(raw) } : { kind: "unmapped", value: raw }', '{ kind: "mapped", value: table.get(raw) }'],
  ["yes-no-swapped", "REC_LEGACY_JOBS", "[[1, true], [2, false]]", "[[1, false], [2, true]]"],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { REC_LEGACY_MAPS_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/packages/recruit/src/legacy-maps-mutation-${process.pid}.js`, import.meta.url);
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
process.stdout.write(`${mutations.length}/${mutations.length} recruit legacy-map mutations killed\n`);
