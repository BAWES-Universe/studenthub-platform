// Recruit R5: each employer-view rule is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/packages/recruit/src/employer-view.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/recruit/test/employer-view.test.js", import.meta.url));
const mutations = [
  ["birthday-late", "REC5_AGE", "(tm < bm || (tm === bm && td < bd) ? 1 : 0)", "(tm < bm || (tm === bm && td <= bd) ? 1 : 0)"],
  ["any-age", "REC5_AGE", "age >= 0 && age <= 120 ? age : null", "age"],
  ["withdrawn-card-sees", "REC5_SIGHT", 'link.stage !== null && link.stage !== "withdrawn"', "link.stage !== null"],
  ["withdrawn-invite-sees", "REC5_SIGHT", 'link.invitation_status !== null && link.invitation_status !== "withdrawn"', "link.invitation_status !== null"],
  ["unsorted-experience", "REC5_VIEW", ".sort((a, b) => b.startYear - a.startYear)", ""],
  ["show-withdrawn", "REC5_VIEW", 'stage: link.stage === "withdrawn" ? null : link.stage', "stage: link.stage"],
  ["custom-major-lost", "REC5_VIEW", "major: r.major ?? str(r.fields.customMajor)", "major: r.major"],
  ["not-looking-looks", "REC5_VIEW", 'person.job_search_status === "active" || person.job_search_status === "open_to_offers"', 'person.job_search_status !== null'],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { REC5_EMPLOYER_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/packages/recruit/src/employer-view-mutation-${process.pid}.js`, import.meta.url);
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
process.stdout.write(`${mutations.length}/${mutations.length} recruit employer view mutations killed\n`);
