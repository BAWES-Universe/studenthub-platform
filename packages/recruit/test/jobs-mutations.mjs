// Recruit R7: each job board rule is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/packages/recruit/src/jobs.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/recruit/test/jobs.test.js", import.meta.url));
const mutations = [
  ["recruiter-manages", "REC7_RULES", '(row.role === "staff" || row.role === "admin")', '(row.role === "staff" || row.role === "admin" || row.role === "recruiter")'],
  ["closed-applies", "REC7_RULES", 'return status === "active";', 'return status !== "draft";'],
  ["unreject", "REC7_RULES", '|| (from === "shortlisted" && to === "rejected")', '|| (from !== "interested")'],
  ["noisy-apply", "REC7_RULES", 'if (to === "interested")\n        return null;', ""],
  ["swapped-ages", "REC7_PARSE", "numbers.minAge > numbers.maxAge", "false"],
  ["swapped-dates", "REC7_PARSE", "availableFrom > availableTo", "false"],
  ["duplicate-skills", "REC7_PARSE", "[...new Set(skills.filter((s) => s !== null))]", "skills.filter((s) => s !== null)"],
  ["open-job-form", "REC7_PARSE", "if (!closed(value, JOB_KEYS))", "if (false)"],
  ["apply-twice", "REC7_VIEW", "jobAcceptsApplications(row.status) && !row.application_status", "jobAcceptsApplications(row.status)"],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { REC7_JOBS_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/packages/recruit/src/jobs-mutation-${process.pid}.js`, import.meta.url);
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
process.stdout.write(`${mutations.length}/${mutations.length} recruit job board mutations killed\n`);
