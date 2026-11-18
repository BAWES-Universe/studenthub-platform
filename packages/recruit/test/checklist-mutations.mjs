// Recruit R2b: each checklist and note rule is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/packages/recruit/src/checklist.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/recruit/test/checklist.test.js", import.meta.url));
const mutations = [
  ["staff-keep-checklist", "REC2B_DECISIONS", 'return subtree(rows, ["admin"], operators);', 'return subtree(rows, ["admin", "staff"], operators);'],
  ["company-notes", "REC2B_DECISIONS", 'row.scope === "subtree" && operators.includes(row.org_id)', 'row.scope === "subtree"'],
  ["self-scope", "REC2B_DECISIONS", 'row.scope === "subtree" && operators', 'row.scope !== "x" && operators'],
  ["long-name", "REC2B_ITEM", "[...t].length <= max", "[...t].length <= max + 1"],
  ["any-required", "REC2B_ITEM", 'r.required === true || r.required === "on" ? true : undefined', 'r.required ? true : undefined'],
  ["sort-cap", "REC2B_ITEM", "raw <= CHECKLIST_SORT_MAX", "raw <= CHECKLIST_SORT_MAX + 1"],
  ["extra-keys", "REC2B_NOTE", '!["type", "text", "checklistItemId", "cardId"].includes(k)', '!["type", "text", "checklistItemId", "cardId", "requestId"].includes(k)'],
  ["any-ref", "REC2B_NOTE", 'typeof v === "string" && UUID.test(v) ? v.toLowerCase()', 'typeof v === "string" ? v.toLowerCase()'],
  ["nul-ok", "REC2B_NOTE", "const CONTROL = /[\\u0000-\\u0008", "const CONTROL = /[\\u0001-\\u0008"],
  ["optional-counts", "REC2B_PROGRESS", "steps.filter((s) => s.required && !s.done)", "steps.filter((s) => !s.done)"],
  ["unsorted", "REC2B_PROGRESS", "a.sort_order - b.sort_order ||", "0 ||"],
  ["legacy-proto", "REC2B_LEGACY", "Object.hasOwn(map, value)", "value in map"],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { REC2B_CHECKLIST_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/packages/recruit/src/checklist-mutation-${process.pid}.js`, import.meta.url);
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
process.stdout.write(`${mutations.length}/${mutations.length} recruit checklist mutations killed\n`);
