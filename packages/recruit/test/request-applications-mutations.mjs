// Recruit R7b: each request-application rule is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/packages/recruit/src/request-applications.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/recruit/test/request-applications.test.js", import.meta.url));
const mutations = [
  ["filled-takes", "REC7B_RULES", 'return status === "open" || status === "filling";', 'return status !== "draft";'],
  ["decide-twice", "REC7B_RULES", 'return from === "applied" && (to === "accepted" || to === "rejected");', 'return to === "accepted" || to === "rejected";'],
  ["decision-to-recruiter", "REC7B_RULES", "return { kind, recipient: personId,", "return { kind, recipient: recruiterId ?? personId,"],
  ["open-query", "REC7B_VIEW", '!["q", "type", "applied", "page"].includes(key)', "false"],
  ["apply-twice", "REC7B_VIEW", "canApply: !row.application_id && ", "canApply: "],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { REC7B_APPLICATIONS_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/packages/recruit/src/request-applications-mutation-${process.pid}.js`, import.meta.url);
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
process.stdout.write(`${mutations.length}/${mutations.length} recruit request-application mutations killed\n`);
