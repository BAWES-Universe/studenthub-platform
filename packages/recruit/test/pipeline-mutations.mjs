// Recruit R2: each rule of the pipeline domain is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/packages/recruit/src/pipeline.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/recruit/test/pipeline.test.js", import.meta.url));
const mutations = [
  ["extra-move", "REC2_STAGES", '["offered", "withdrawn"],', '["offered", "withdrawn"],\n    ["withdrawn", "suggested"],'],
  ["skip-offer", "REC2_STAGES", '["offered", "placed"],', '["offered", "placed"],\n    ["interviewing", "placed"],'],
  ["any-move", "REC2_STAGES", "return PIPELINE_TRANSITIONS.some(([a, b]) => a === from && b === to);", "return from !== to;"],
  ["fill-any", "REC2_REQUEST_STATUS", 'return status === "open" ? "filling" : null;', 'return status === "open" || status === "filled" ? "filling" : null;'],
  ["headcount", "REC2_REQUEST_STATUS", "event.placedCount >= event.headcount", "event.placedCount > event.headcount"],
  ["filled-from-open", "REC2_REQUEST_STATUS", 'return status === "filling" && event.placedCount', 'return (status === "filling" || status === "open") && event.placedCount'],
  ["accepts-filled", "REC2_REQUEST_STATUS", 'return status === "open" || status === "filling";', 'return status !== "closed";'],
  ["any-staff-moves", "REC2_AUTHORITY", "return isLead || (assignedRecruiterId !== null && assignedRecruiterId === principalId);", "return true;"],
  ["staff-lead", "REC2_AUTHORITY", 'return covers(rows, ["admin"], operators);', 'return covers(rows, ["admin", "staff"], operators);'],
  ["company-recruiter", "REC2_AUTHORITY", 'return covers(rows, ["recruiter", "staff"], operators);', 'return rows.some((row) => (row.role === "recruiter" || row.role === "staff"));'],
  ["legacy-guess", "REC2_LEGACY", "return { kind: \"unmapped\", value };", "return { kind: \"mapped\", stage: \"suggested\" };"],
  ["moves-for-all", "REC2_VIEW", "allowedMoves: canMove ?", "allowedMoves: true ?"],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { REC2_PIPELINE_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/packages/recruit/src/pipeline-mutation-${process.pid}.js`, import.meta.url);
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
process.stdout.write(`${mutations.length}/${mutations.length} recruit pipeline mutations killed\n`);
