// Self-repair B2 — every landing-repair guard on the runner side is pinned:
// removing it makes its named "Self-repair B2:" test fail by assertion.
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
    name: "M1 turn the repair on unless it is switched off",
    file: "service/card-repair.mjs",
    from: "  return config?.landing_repair === true;",
    to: "  return config?.landing_repair !== false;",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: O1",
  },
  {
    name: "M2 start a second round over an existing record",
    file: "service/card-run.mjs",
    from: "  if (!io.fs.existsSync(file)) return { next: { id, repair: claim } };",
    to: "  if (true) return { next: { id, repair: claim } };",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R3",
  },
  {
    name: "M3 re-launch a round that never finished",
    file: "service/card-run.mjs",
    from: "  if (round?.state !== \"finished\") {",
    to: "  if (false) {",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R3",
  },
  {
    name: "M4 count a failing run of another head as evidence",
    file: "service/card-repair.mjs",
    from: "&& run?.app?.slug === \"github-actions\" && Number.isSafeInteger(run?.id) && run.id > 0 && run.head_sha === head)",
    to: "&& run?.app?.slug === \"github-actions\" && Number.isSafeInteger(run?.id) && run.id > 0)",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: E5",
  },
  {
    name: "M5 trust a job that reads back at another head",
    file: "service/card-repair.mjs",
    from: "    if (job.body?.id !== run.id || job.body?.head_sha !== head) continue;",
    to: "    // B2-M5",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: E5",
  },
  {
    name: "M6 keep a failure line that carries a secret",
    file: "service/card-repair.mjs",
    from: "  if (kept === null || secretIndicator(kept)) return null;",
    to: "  if (kept === null) return null;",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: E2",
  },
  {
    name: "M7 judge each chunk on its own",
    file: "service/card-repair.mjs",
    from: "      const parts = `${carry}${text}`.split(\"\\n\");",
    to: "      const parts = text.split(\"\\n\");",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: E3",
  },
  {
    name: "M8 carry the evidence uncapped",
    file: "service/card-repair.mjs",
    from: "  if (full.length <= max) return { text: full, truncated: false };",
    to: "  if (true) return { text: full, truncated: false };",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: E4",
  },
  {
    name: "M9 let an assignment through",
    file: "service/card-repair.mjs",
    from: "  if (SECRET_WORD_RE.test(text) || ASSIGNMENT_RE.test(text) || ",
    to: "  if (SECRET_WORD_RE.test(text) || ",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: E2",
  },
  {
    name: "M10 let URL credentials through",
    file: "service/card-repair.mjs",
    from: " || URL_CREDENTIAL_RE.test(text) || ",
    to: " || ",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: E2",
  },
  {
    name: "M11 read a missing Actions permission as an ordinary failure",
    file: "service/card-repair.mjs",
    from: "const permissionStatus = (status) => status === 401 || status === 403 || status === 404;",
    to: "const permissionStatus = (status) => false && status;",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: E6",
  },
  {
    name: "M12 claim the round without re-checking the pause",
    file: "service/card-run.mjs",
    from: "  if (io.fs.existsSync(paths.pause)) repairSkip(\"PAUSED\",",
    to: "  if (false) repairSkip(\"PAUSED\",",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R2",
  },
  {
    name: "M13 write the round record over an existing one",
    file: "service/card-repair.mjs",
    from: "state: \"claimed\" })}\\n`, { flag: \"wx\", mode: 0o600 });",
    to: "state: \"claimed\" })}\\n`, { mode: 0o600 });",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R4",
  },
  {
    name: "M14 arm before the round says so",
    file: "service/card-run.mjs",
    from: "      if (repairRound?.round) advanceRound(io, repairRound.round, \"armed\",",
    to: "      if (false) advanceRound(io, repairRound.round, \"armed\",",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R1",
  },
  {
    name: "M15 mint a new repair id every start",
    file: "service/card-repair.mjs",
    from: "export const repairActivationId = (id, revision) => `${String(id).toLowerCase()}-repair-${revision}`;",
    to: "export const repairActivationId = (id, revision) => `${String(id).toLowerCase()}-repair-${revision.slice(0, 8)}${Date.now()}`;",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R1",
  },
  {
    name: "M16 repair from the installed revision instead of the failed head",
    file: "service/card-run.mjs",
    from: "  const record = { ...base.record, activation_id: repairActivationId(id, revision), initial_target_sha: claim.reviewed_head,",
    to: "  const record = { ...base.record, activation_id: repairActivationId(id, revision), initial_target_sha: revision,",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R1",
  },
  {
    name: "M17 prepare a repair by today's card rule",
    file: "service/card-run.mjs",
    from: "      ...repairPrepare(planned, config) });",
    to: "    });",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R1",
  },
  {
    name: "M18 repair a PASS of another episode",
    file: "service/card-repair.mjs",
    from: "  if (!terminal || terminal.episode_id !== claim.activation_id || terminal.stage",
    to: "  if (!terminal || terminal.stage",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R2",
  },
  {
    name: "M19 let a skip, only or todo form through",
    file: "service/card-repair.mjs",
    from: "    const weakening = lines.added.find(",
    to: "    const weakening = undefined && lines.added.find(",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: G1",
  },
  {
    name: "M20 let a removed test case through",
    file: "service/card-repair.mjs",
    from: "    if (isTestPath(name) && lines.removed.some((line) => CASE_RE.test(line))) return refuse(",
    to: "    if (false) return refuse(",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: G1",
  },
  {
    name: "M33 let a dropped assertion through",
    file: "service/card-repair.mjs",
    from: "    if (isTestPath(name) && assertions(lines.removed) > assertions(lines.added)) return refuse(",
    to: "    if (false) return refuse(",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: G1",
  },
  {
    name: "M21 let a deleted or renamed test file through",
    file: "service/card-repair.mjs",
    from: "    if (names.some(isTestPath) && (file.status === \"removed\"",
    to: "    if (false && (file.status === \"removed\"",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: G1",
  },
  {
    name: "M22 let a test script change through",
    file: "service/card-repair.mjs",
    from: "      if (was !== now) return refuse(",
    to: "      if (false) return refuse(",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: G1",
  },
  {
    name: "M23 let a runner config change through",
    file: "service/card-repair.mjs",
    from: "    if (names.some(isTestConfigPath)) return refuse(",
    to: "    if (false) return refuse(",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: G1",
  },
  {
    name: "M24 pass a change the guard cannot read",
    file: "service/card-repair.mjs",
    from: "    if (!lines) return refuse(`${name} has no readable diff`);",
    to: "    if (!lines) continue;",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: G1",
  },
  {
    name: "M25 re-land a repair without the weakening guard",
    file: "service/card-land.mjs",
    from: "    if (repair) {\n      const guard = await readTestWeakening(",
    to: "    if (false) {\n      const guard = await readTestWeakening(",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: L1",
  },
  {
    name: "M26 find or open a pull request for a repair",
    file: "service/card-land.mjs",
    from: "    const opened = repair ? await repairPull(",
    to: "    const opened = false ? await repairPull(",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R1",
  },
  {
    name: "M27 ignore the repaired pull request's identity during the wait",
    file: "service/card-land.mjs",
    from: "  if (wrong) return { identity: wrong };",
    to: "  if (false) return { identity: wrong };",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: L2",
  },
  {
    name: "M28 count check runs of another head",
    file: "service/card-land.mjs",
    from: "  const allRuns = head && Array.isArray(listed) ? listed.filter((run) => run?.head_sha === head) : listed;",
    to: "  const allRuns = listed;",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: L3",
  },
  {
    name: "M29 merge without the repair's last look",
    file: "service/card-land.mjs",
    from: "        repairHeld = await repairLastCheck(",
    to: "        repairHeld = null && await repairLastCheck(",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: L2",
  },
  {
    name: "M30 never count a merged repair as landed",
    file: "service/card-landed.mjs",
    from: "  if (rounds.some(mergedByRepair)) return { landed: true, by: \"repair\" };",
    to: "  if (false) return { landed: true, by: \"repair\" };",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R1",
  },
  {
    name: "M31 an interrupted repair needs no owner",
    file: "service/card-status.mjs",
    from: "  if (REPAIR_ALERT_OUTCOMES.has(result?.outcome)) return true;",
    to: "  // B2-M31",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R3",
  },
  {
    name: "M32 alert an interrupted repair on every start",
    file: "service/card-run.mjs",
    from: "  if (io.fs.existsSync(alerted)) return skip(\"REPAIR_INTERRUPTED\", next.reason);",
    to: "  if (false) return skip(\"REPAIR_INTERRUPTED\", next.reason);",
    tests: "card-run.test.mjs",
    pattern: "Self-repair B2: R3",
  },
];

for (const mutation of CASES) {
  test(`Self-repair B2: mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-repair-b2-mutation-"));
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
