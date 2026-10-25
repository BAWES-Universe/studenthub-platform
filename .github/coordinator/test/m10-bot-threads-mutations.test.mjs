// SHU-71 M10 (self-repair B3) — every guard on judging and resolving review
// bot threads is pinned: removing it makes its named "SHU-71 M10:" landing
// test in card-run.test.mjs fail by assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR = path.join(HERE, "..");

const CASES = [
  {
    name: "M1 count a person's comment under a bot's name as the bot's",
    file: "service/card-threads.mjs",
    from: "comment?.author?.__typename !== \"Bot\" || !policy.authors.has(",
    to: "!policy.authors.has(",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T4",
  },
  {
    name: "M2 resolve threads the review lane judged must_fix",
    file: "service/card-land.mjs",
    from: "      if (judged.must_fix.length) {",
    to: "      if (false) {",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T2",
  },
  {
    name: "M3 judge a head more than once in a landing",
    file: "service/card-land.mjs",
    from: "      if (judged.judged) return { note: judged.held };",
    to: "      if (false) return { note: judged.held };",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T2",
  },
  {
    name: "M4 accept an answer that leaves a thread out",
    file: "service/card-threads.mjs",
    from: "  if (verdicts.length !== threadIds.length) return",
    to: "  if (false) return",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T3",
  },
  {
    name: "M5 resolve after the head moved",
    file: "service/card-land.mjs",
    from: "      if (!headMatches(now, { repo, branch, head })) stop(",
    to: "      if (false) stop(",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T5",
  },
  {
    name: "M6 resolve a thread that changed while it was judged",
    file: "service/card-land.mjs",
    from: "read.replies.length || JSON.stringify(read.others.map(commentKey)) !== JSON.stringify(readThread(was, null, reviewMarker)?.others.map(commentKey))) {",
    to: "read.replies.length) {",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T6",
  },
  {
    name: "M7 judge threads when the committed switch is off",
    file: "service/card-threads.mjs",
    from: "  if (policy === undefined || policy?.enabled === false) return null;",
    to: "  if (policy === undefined) return null;",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T7",
  },
  {
    name: "M8 launch a second judgement at the same head",
    file: "service/card-threads.mjs",
    from: "{ flag: \"wx\", mode: 0o600 });",
    to: "{ mode: 0o600 });",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T9",
  },
  {
    name: "M9 put the reviewer's login in argv instead of its environment",
    file: "service/card-threads.mjs",
    from: "{ timeoutMs, cwd: workspace, env: buildClaudeEnvironment({ PATH: \"/usr/bin:/bin\", LANG: \"C.UTF-8\" }, token, { reviewer: true }) });",
    to: "{ timeoutMs, cwd: workspace, env: { PATH: \"/usr/bin:/bin\" } });",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T1",
  },
  {
    name: "M10 let the writer's own family judge",
    file: "service/card-threads.mjs",
    from: "  if (!family || family === familyForLane(record?.writer_lane)) return",
    to: "  if (!family) return",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T11",
  },
  {
    name: "M11 stop holding a resolved thread until the merge",
    file: "service/card-land.mjs",
    from: "  for (const [id, expected] of reviewed) checkSettled(",
    to: "  for (const [id, expected] of []) checkSettled(",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T10",
  },
  {
    name: "M12 pass @mentions and markers through to the reply",
    file: "service/card-threads.mjs",
    from: ".replace(/@(?=[A-Za-z0-9])/g, \"@\\u200b\")",
    to: "",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T8",
  },
  {
    name: "M13 claim the head's judgement before the launch preconditions hold",
    file: "service/card-threads.mjs",
    from: "    let env;\n",
    to: "    io.fs.writeFileSync(threadReviewClaim(paths.stateDir, plan.id, head), \"{}\\n\", { flag: \"wx\", mode: 0o600 });\n    let env;\n",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T12",
  },
  {
    name: "M14 stop checking threads the review lane resolved in an earlier landing",
    file: "service/card-land.mjs",
    from: "    if (judged) {",
    to: "    if (false) {",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T13",
  },
  {
    name: "M15 put the threads to the review lane while an approval is still required",
    file: "service/card-land.mjs",
    from: "reviewed && decision !== \"REVIEW_REQUIRED\" && decision !== \"CHANGES_REQUESTED\"",
    to: "reviewed",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T14",
  },
  {
    name: "M16 start the review lane with too little of the landing's wait left",
    file: "service/card-land.mjs",
    from: "      if (!(leftMs >= review.timeoutMs)) return",
    to: "      if (false) return",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T15",
  },
  {
    name: "M17 count the prompt in UTF-16 units instead of bytes",
    file: "service/card-threads.mjs",
    from: "Buffer.byteLength(prompt, \"utf8\")",
    to: "prompt.length",
    tests: "card-run.test.mjs",
    pattern: "SHU-71 M10: T16",
  },
];

for (const mutation of CASES) {
  test(`SHU-71 M10: mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "m10-bot-threads-mutation-"));
    try {
      fs.cpSync(COORDINATOR, root, { recursive: true });
      const target = path.join(root, mutation.file);
      const source = fs.readFileSync(target, "utf8");
      assert.equal(source.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, source.replace(mutation.from, mutation.to));
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test",
        `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", mutation.tests),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 120_000 });
      const output = run.stdout + run.stderr;
      assert.equal(run.signal, null, `${mutation.name}: a timeout or crash is not a mutation kill`);
      assert.equal(run.status, 1, `${mutation.name}: mutation survived\n${output}`);
      assert.match(output, /AssertionError/, `${mutation.name}: must fail by assertion`);
      assert.match(output, new RegExp(`not ok \\d+ - ${mutation.pattern}`), `${mutation.name}: must fail its named test`);
      assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name}: infrastructure crashes do not count`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
