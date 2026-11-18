// Recruit R6: each interview rule is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/packages/recruit/src/interviews.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/recruit/test/interviews.test.js", import.meta.url));
const mutations = [
  ["withdrawn-interviews", "REC6_RULES", 'export const INTERVIEW_STAGES = ["contacted", "interviewing", "offered"];', 'export const INTERVIEW_STAGES = ["contacted", "interviewing", "offered", "withdrawn"];'],
  ["revive-cancelled", "REC6_RULES", 'return from === "scheduled" && (to === "completed" || to === "cancelled");', 'return to === "completed" || to === "cancelled";'],
  ["evaluate-cancelled", "REC6_RULES", 'return status === "scheduled" || status === "completed";', "return true;"],
  ["operator-company", "REC6_RULES", "rows.filter((row) => !operators.includes(row.org_id))", "rows"],
  ["company-internal", "REC6_RULES", '&& row.scope === "subtree" && operators.includes(row.org_id));', '&& row.scope === "subtree");'],
  ["utc-wall-clock", "REC6_PARSE", "Date.UTC(y, mo - 1, d, h - 3, mi)", "Date.UTC(y, mo - 1, d, h, mi)"],
  ["no-past-bound", "REC6_PARSE", "at.getTime() < now.getTime() - 86_400_000 || ", ""],
  ["open-schedule", "REC6_PARSE", 'if (!closed(value, ["cardId", "scheduledAt", "durationMinutes", "mode", "location"]))', "if (false)"],
  ["rated-no-show", "REC6_EVALUATION", 'if (outcome === "no_show" && rating !== null)', "if (false)"],
  ["leak-internal", "REC6_VIEW", "return seesInternal ? { ...base, internalNote: row.internal_note } : base;", "return { ...base, internalNote: row.internal_note };"],
  ["shared-dedupe", "REC6_VIEW", "dedupeKey: `${kind}:${interviewId}`", "dedupeKey: interviewId"],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { REC6_INTERVIEWS_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/packages/recruit/src/interviews-mutation-${process.pid}.js`, import.meta.url);
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
process.stdout.write(`${mutations.length}/${mutations.length} recruit interview mutations killed\n`);
