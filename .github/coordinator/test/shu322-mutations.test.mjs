// SHU-322 — every guard of the card queue self-install is pinned: removing it
// makes its named test in shu322-card-install.test.mjs fail by assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR = path.join(HERE, "..");
const FILE = "service/card-install.mjs";

const CASES = [
  {
    name: "M1 drop the path allowlist",
    from: "    if (!installablePath(change?.path) && !policy) return no(",
    to: "    if (false) /* SHU322-M1 */ return no(",
    pattern: "SHU-322 B2:",
  },
  {
    name: "M2 install a deleted coordinator file",
    from: '    if (!["A", "M"].includes(change.status)) return no(',
    to: "    if (false) /* SHU322-M2 */ return no(",
    pattern: "SHU-322 B2:",
  },
  {
    name: "M3 accept a contracts data file that is not an edit",
    from: 'contracts.status === "M" ? contractChangeRefusal(',
    to: 'true /* SHU322-M3 */ ? contractChangeRefusal(',
    pattern: "SHU-322 B3:",
  },
  {
    name: "M4 let any config key change",
    from: '    if (key === "dispatch_scope" || key === "card_lanes") continue;',
    to: "    continue; // SHU322-M4",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M5 drop the card_lanes prefix check",
    from: "      || !before.every((lane, i) => isDeepStrictEqual(lane, after[i]))) {",
    to: "      /* SHU322-M5 */) {",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M6 drop the queue size bounds",
    from: "  if (ids.length < MIN_INSTALL_QUEUE || ids.length > MAX_CARD_QUEUE || new Set(ids).size !== ids.length) {",
    to: "  if (false) { // SHU322-M6",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M7 accept a queued card that is neither an appended nor an installed lane",
    from: "    if (!added.includes(id) && !known.has(id)) return no(",
    to: "    if (false) /* SHU322-M7 */ return no(",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M8 drop the landed check",
    from: "  for (const id of ids) if (landed.has(id)) return no(",
    to: "  for (const id of ids) if (false) /* SHU322-M8 */ return no(",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M9 drop the added contract check",
    from: "    if (added.includes(id) && (installedContracts.has(id) || !nextContracts.has(id))) return no(",
    to: "    if (false) /* SHU322-M9 */ return no(",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M10 drop the REVIEW_PASS blob binding",
    from: "  if (!review) return no(",
    to: "  if (false) /* SHU322-M10 */ return no(",
    pattern: "SHU-322 B5:",
  },
  {
    name: "M11 trust a review claim root did not write",
    from: " || stat.uid !== 0) continue;",
    to: ") /* SHU322-M11 */ continue;",
    pattern: "SHU-322 B5:",
  },
  {
    name: "M12 drop the ancestry check",
    from: "  if (facts.descends !== true) return no(",
    to: "  if (false) /* SHU322-M12 */ return no(",
    pattern: "SHU-322 B6:",
  },
  {
    name: "M13 install on red checks",
    from: "  if (Array.isArray(checks?.red) && checks.red.length) return no(",
    to: "  if (false) /* SHU322-M13 */ return no(",
    pattern: "SHU-322 B8:",
  },
  {
    name: "M14 install before the checks are green",
    from: "  if (checks?.green !== true) return no(",
    to: "  if (false) /* SHU322-M14 */ return no(",
    pattern: "SHU-322 B8:",
  },
  {
    name: "M15 claim a refusal without the exclusive flag",
    from: 'claimed_at: io.now().toISOString() })}\\n`, { flag: "wx", mode: 0o600 });\n    } catch (error) {\n      if (error.code === "EEXIST") return { silent: true };\n      return { skipped: "INSTALL_UNREADABLE", reason: `the claim cannot be written: ${error.code ?? error.message}` };\n    }\n    return { result:',
    to: 'claimed_at: io.now().toISOString() })}\\n`, { flag: "w", mode: 0o600 }); // SHU322-M15\n    } catch (error) {\n      if (error.code === "EEXIST") return { silent: true };\n      return { skipped: "INSTALL_UNREADABLE", reason: `the claim cannot be written: ${error.code ?? error.message}` };\n    }\n    return { result:',
    pattern: "SHU-322 B9:",
  },
  {
    name: "M16 claim an install without the exclusive flag",
    from: "...(code ? { code, approval } : {}), claimed_at: io.now().toISOString() })}\\n`, { flag: \"wx\", mode: 0o600 });",
    to: "...(code ? { code, approval } : {}), claimed_at: io.now().toISOString() })}\\n`, { flag: \"w\", mode: 0o600 }); // SHU322-M16",
    pattern: "SHU-322 B10:",
  },
  {
    name: "M17 install on a busy host",
    from: "    if (busy.length) { io.fs.unlinkSync(claim); return",
    to: "    if (false) { /* SHU322-M17 */ return",
    pattern: "SHU-322 B10:",
  },
  {
    name: "M18 drop the pause recheck between steps",
    from: '      if (paused()) { outcome = "INSTALL_PAUSED";',
    to: '      if (false) { /* SHU322-M18 */ outcome = "INSTALL_PAUSED";',
    pattern: "SHU-322 B11:",
  },
  {
    name: "M19 leave the host unpaused after a failure",
    from: "      const pause = outcome === \"INSTALL_PAUSED\" || restored?.ok ? null : pauseHost(io, paths, `${main} ${reason}`);",
    to: "      const pause = null; // SHU322-M19",
    pattern: "SHU-322 B12:",
  },
  {
    name: "M20 reinstall R instead of rolling N back",
    from: '            try { provision(io, paths, "rollback", main); rollback = { ok: true }; }',
    to: '            try { provision(io, paths, "install", revision); rollback = { ok: true }; } // SHU322-M20',
    pattern: "SHU-322 B13:",
  },
  {
    name: "M21 accept a plan whose next card is not the first",
    from: "  if (plan.next?.id !== queue[0]) throw",
    to: "  if (false) /* SHU322-M21 */ throw",
    pattern: "SHU-322 B14:",
  },
  {
    name: "M22 skip the plan check",
    from: '      run("plan", () => (queue ? planCheck(io, paths, queue) : codePlanCheck(io, paths, scope)));',
    to: "      // SHU322-M22",
    pattern: "SHU-322 B14:",
  },
  {
    name: "M23 overwrite an existing pause file",
    from: "    io.fs.writeFileSync(paths.pause, `card-install: ${plainReason(reason)}\\n`, { flag: \"wx\", mode: 0o644 });",
    to: "    io.fs.writeFileSync(paths.pause, `card-install: ${plainReason(reason)}\\n`, { mode: 0o644 }); // SHU322-M23",
    pattern: "SHU-322 B15:",
  },
  {
    name: "M24 review after an install in the same start",
    file: "service/card-run.mjs",
    from: "  if (install.result) return install.result;",
    to: "  // SHU322-M24",
    pattern: "SHU-322 B16:",
  },
  {
    // M16: a stopped queue installs too; never installing is now the mutant.
    name: "M25 never install from a stopped queue",
    file: "service/card-run.mjs",
    from: '    if (next.skipped === "QUEUE_DONE" || next.skipped === "QUEUE_STOPPED") done = next;',
    to: '    if (next.skipped === "QUEUE_DONE") done = next; // SHU322-M25',
    pattern: "SHU-322 B16:",
  },
  {
    name: "M26 release the lock when the pause could not be written",
    from: "      if (pause && !pause.held) keepLock = true;",
    to: "      // SHU322-M26",
    pattern: "SHU-322 B18:",
  },
  {
    name: "M27 count anything at the pause path as a pause",
    from: "held = stat.isFile() && !stat.isSymbolicLink();",
    to: "held = true; /* SHU322-M27 */",
    pattern: "SHU-322 B18:",
  },
  {
    name: "M28 refuse an install without a finished status",
    file: "service/card-run.mjs",
    from: '  if (["NEEDS_OWNER", "INSTALL_RESTORED"].includes(install.result?.outcome)) installRefusedStatus({ io, paths, config, result: install.result });',
    to: "  // SHU322-M28",
    pattern: "SHU-322 B19:",
  },
  {
    name: "M29 read an install status as an unknown kind",
    file: "service/card-watchdog.mjs",
    from: 'raw.kind === "review" || raw.kind === "install" ? raw.kind : null,',
    to: 'raw.kind === "review" ? raw.kind : null, // SHU322-M29',
    pattern: "SHU-322 B19:",
  },
  {
    name: "M30 install an owner-only path",
    from: "    if (ownerOnlyPath(change.path)) return no(",
    to: "    if (false) /* M11-M30 */ return no(",
    pattern: "M11 C2:",
  },
  {
    name: "M31 let code change the self-install policy",
    from: "    if (!same) {",
    to: "    if (!same && key !== CODE_SELF_INSTALL_KEY) { // M11-M31",
    pattern: "M11 C2:",
  },
  {
    name: "M32 read the policy from main",
    from: "  const policy = codeInstallPolicy(installed);",
    to: "  const policy = codeInstallPolicy(next); // M11-M32",
    pattern: "M11 C1:",
  },
  {
    name: "M33 install code without its approval",
    from: "    if (read.approved !== true) {",
    to: "    if (false) { // M11-M33",
    pattern: "M11 C1:",
  },
  {
    name: "M34 count the author's own approval",
    from: "    if (who === author) continue;",
    to: "    // M11-M34",
    pattern: "M11 C3:",
  },
  {
    name: "M35 count an approval of another head",
    from: '    if (latest?.state === "APPROVED" && latest.commit_id === head) return',
    to: '    if (latest?.state === "APPROVED") /* M11-M35 */ return',
    pattern: "M11 C3:",
  },
  {
    name: "M36 pause instead of putting R back",
    from: '      if (code && outcome !== "INSTALL_PAUSED" && steps.includes("merge")) {',
    to: "      if (false) { // M11-M36",
    pattern: "M11 C5:",
  },
  {
    name: "M37 run the code plan check as a queue plan check",
    from: '      run("plan", () => (queue ? planCheck(io, paths, queue) : codePlanCheck(io, paths, scope)));',
    to: '      run("plan", () => planCheck(io, paths, queue ?? scope)); // M11-M37',
    pattern: "M11 C4:",
  },
  {
    name: "M38 accept a re-cut queue whose first card is an installed lane",
    from: "  if (!added.includes(ids[0])) return no(",
    to: "  if (false) /* M16-M38 */ return no(",
    pattern: "M16 Q1:",
  },
  {
    name: "M39 drop the kept lane's contract check",
    from: "    if (!added.includes(id) && !nextContracts.has(id)) return no(",
    to: "    if (false) /* M16-M39 */ return no(",
    pattern: "M16 Q1:",
  },
  {
    name: "M40 skip the contracts data check on a queue install",
    from: "  if (contracts) {",
    to: "  if (contracts && code.length) { // M16-M40",
    pattern: "M16 Q5:",
  },
  {
    name: "M41 let an installed card change",
    from: "    if (!isDeepStrictEqual(contract, after.cards[id])) return `it changes ${id}`;",
    to: "    // M16-M41",
    pattern: "M16 Q5:",
  },
  {
    name: "M42 let the review-only cards change",
    from: "  if (!isDeepStrictEqual(before.review_only, after.review_only)) return \"it changes the review-only cards\";",
    to: "  // M16-M42",
    pattern: "M16 Q5:",
  },
  {
    name: "M43 let the writer's finish rule change",
    from: "  if (before.writer_finish_rule !== after.writer_finish_rule) return \"it changes the writer's finish rule\";",
    to: "  // M16-M43",
    pattern: "M16 Q5:",
  },
  {
    name: "M44 accept a new card with any keys",
    from: "    if (!plainObject(contract) || Object.keys(contract).some((key) => !CONTRACT_KEYS.has(key))) return",
    to: "    if (false /* M16-M44 */) return",
    pattern: "M16 Q5:",
  },
  {
    name: "M45 accept a new card under any id",
    from: "    if (!CARD_ID_RE.test(id) || Object.hasOwn(after.review_only, id)) return",
    to: "    if (false /* M16-M45 */) return",
    pattern: "M16 Q5:",
  },
  {
    name: "M46 let code change any config key but the policy",
    from: "    if (!same) {",
    to: "    if (!same && (code.length === 0 || key === CODE_SELF_INSTALL_KEY)) { // M16-M46",
    pattern: "M16 Q6:",
  },
  {
    name: "M47 let code edit installed card lanes",
    from: "        || !lanesBefore.every((lane, i) => isDeepStrictEqual(lane, lanesAfter[i]))) {",
    to: "        || false) { // M16-M47",
    pattern: "M16 Q6:",
  },
  {
    name: "M48 accept a new card under a fixture id",
    from: "    if (isFixtureIssue(id)) return",
    to: "    if (false /* M16-M48 */) return",
    pattern: "M16 Q5:",
  },
  {
    name: "M49 accept unsafe card paths",
    from: "      if (!paths.ok) return `${id} is not a card contract: ${paths.reason}`;",
    to: "      // M16-M49",
    pattern: "M16 Q5:",
  },
  {
    name: "M50 skip the workspace mode check",
    from: "    if (!mode.ok) return `${id} is not a card contract: ${mode.reason}`;",
    to: "    // M16-M50",
    pattern: "M16 Q5:",
  },
  {
    name: "M51 accept an empty acceptance or brief",
    from: "    if (typeof contract.acceptance !== \"string\" || !contract.acceptance || typeof contract.brief !== \"string\" || !contract.brief) return",
    to: "    if (false /* M16-M51 */) return",
    pattern: "M16 Q5:",
  },
  {
    name: "M52 let a queue install a test file a runtime module imports",
    from: "|| RUNTIME_TEST_MODULES.includes(file)) return false;\n  const parts",
    to: ") return false; // M16-M52\n  const parts",
    pattern: "M16 Q7:",
  },
  {
    name: "M53 accept data that is not the contracts document",
    from: "  if (!before || !after) return \"it is not the contracts data at both revisions\";",
    to: "  if (!before || !after) return null; // M16-M53",
    pattern: "M16 Q5:",
  },
  {
    name: "M54 let a card be removed",
    from: "    if (!Object.hasOwn(after.cards, id)) return `it removes ${id}`;",
    to: "    // M16-M54",
    pattern: "M16 Q5:",
  },
  {
    name: "M55 accept any path list on a new card",
    from: "    if (!pathList(contract.initial_build_paths) || !pathList(contract.revision_paths)) return",
    to: "    if (false /* M16-M55 */) return",
    pattern: "M16 Q5:",
  },
  {
    name: "M56 install without the host-wide install lock",
    from: "  try { io.fs.writeFileSync(installLock, String(process.pid), { flag: \"wx\", mode: 0o600 }); }",
    to: "  try { /* M15-W5-M56 */ }",
    pattern: "M15 W5: a self-install holds",
  },
  {
    name: "M57 keep the install lock once the install ended",
    from: "      try { io.fs.unlinkSync(installLock); } catch { /* the lock is gone already */ }",
    to: "      // M15-W5-M57",
    pattern: "M15 W5: a self-install holds",
  },
  {
    name: "M58 tell an install lock whose holder died from a live one",
    file: "service/card-install.mjs",
    from: "  if (/^[1-9]\\d*$/.test(holder) && !io.fs.existsSync(`/proc/${holder}`)) {",
    to: "  if (false) { // M15-W5-M58",
    pattern: "M15 W5: an install lock whose holder died is never taken over",
  },
];

for (const mutation of CASES) {
  test(`SHU-322 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu322-mutation-"));
    try {
      fs.cpSync(COORDINATOR, root, { recursive: true });
      const target = path.join(root, mutation.file ?? FILE);
      const source = fs.readFileSync(target, "utf8");
      assert.equal(source.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, source.replace(mutation.from, () => mutation.to));
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test",
        `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", "shu322-card-install.test.mjs"),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 60_000 });
      const output = run.stdout + run.stderr;
      assert.equal(run.signal, null, `${mutation.name}: a timeout or crash is not a mutation kill`);
      assert.equal(run.status, 1, `${mutation.name}: mutation survived\n${output}`);
      assert.match(output, /AssertionError/, `${mutation.name}: must fail by assertion`);
      assert.match(output, new RegExp(`not ok \\d+ - ${mutation.pattern}`), `${mutation.name}: must fail its named test`);
      assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|TypeError/, `${mutation.name}: infrastructure crashes do not count`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("SHU-322 mutation the unmutated suite passes", () => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "--test-name-pattern=SHU-322 B", path.join(HERE, "shu322-card-install.test.mjs")],
    { cwd: COORDINATOR, env: childEnv, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# pass 20$/m);
});
