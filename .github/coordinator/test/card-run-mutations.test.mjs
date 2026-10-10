// SHU-86 — every card-run guard is pinned: removing it makes its named test in
// card-run.test.mjs fail by assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR = path.join(HERE, "..");
const FILE = "service/card-run.mjs";

const CASES = [
  {
    name: "M1 arm a busy host",
    from: '    if (busy.length) refuse("CARD_RUN_HOST_BUSY", busy.join("; "));',
    to: "    // SHU86-M1",
    pattern: "SHU-86 C6:",
  },
  {
    name: "M2 arm without a verified receipt at HEAD",
    from: '  if (receipt?.state !== "VERIFIED" || receipt?.revision !== head) {',
    to: "  if (false) { // SHU86-M2",
    pattern: "SHU-86 C7:",
  },
  {
    name: "M3 arm a dirty checkout or one off main",
    from: "  if (!SHA_RE.test(head) || head !== main || dirty) refuse(",
    to: "  if (!SHA_RE.test(head)) refuse( // SHU86-M3\n",
    pattern: "SHU-86 C7:",
  },
  {
    name: "M4 arm a card whose branch moved off the revision",
    file: "service/card-prepare.mjs",
    from: '  if (head !== null) refuse("CARD_RUN_BRANCH_NOT_AT_TARGET",',
    to: '  if (false) refuse("CARD_RUN_BRANCH_NOT_AT_TARGET", // SHU86-M4\n',
    pattern: "SHU-86 C8:",
  },
  {
    name: "M5 arm a unit with no resident drop-in",
    from: "    if (!io.fs.existsSync(path.join(dir, RESIDENT_DROP_IN))) refuse(",
    to: "    if (false) refuse( // SHU86-M5\n",
    pattern: "SHU-86 C16:",
  },
  {
    name: "M6 tick without reading back the supervisor's environment",
    from: '  if (!environ.includes("ENABLE_DISPATCH=true") || !environ.includes(`DISPATCH_TARGET_SHA=${target}`)) {',
    to: "  if (false) { // SHU86-M6",
    pattern: "SHU-86 C10:",
  },
  {
    name: "M7 keep ticking a card that is not eligible",
    from: "        if (ticks.length === 1 && outcome.eligible === 0) {",
    to: "        if (false) { // SHU86-M7",
    pattern: "SHU-86 C11:",
  },
  {
    name: "M8 tick past the run window",
    from: "      const deadline = Date.parse(plan.record.expires_at);",
    to: "      const deadline = Date.parse(plan.record.expires_at) + 24 * 60 * 60 * 1000; // SHU86-M8",
    pattern: "SHU-86 C12:",
  },
  {
    name: "M9 revert under a running worker",
    from: "  while (workerCount(io) !== 0) {",
    to: "  while (false) { // SHU86-M9",
    pattern: "SHU-86 C13:",
  },
  {
    name: "M10 accept another run's armed activation",
    from: "  if (activationId && armedId !== activationId) {",
    to: "  if (false) { // SHU86-M10",
    pattern: "SHU-86 C4:",
  },
  {
    name: "M11 pick a reviewer from the author's family",
    from: ".find((lane) => familyForLane(lane) !== review.authorFamily);",
    to: ".find(() => true); // SHU86-M11",
    pattern: "SHU-86 C3:",
  },
  {
    name: "M12 run a fixture lane as a card",
    from: "    if (!(config.card_lanes ?? []).some((lane) => lane?.id === id) || !cardLane) {",
    to: "    if (!cardLane) { // SHU86-M12",
    pattern: "SHU-86 C2:",
  },
  {
    name: "M13 leave a failed arm unreverted",
    from: '      result = { ok: false, outcome: "ERROR", reason: error.message, code: error.code ?? "CARD_RUN_ERROR" };',
    to: "      throw error; // SHU86-M13",
    pattern: "SHU-86 C10:",
  },
  {
    name: "M14 take another run's lock",
    from: 'String(process.pid), { flag: "wx", mode: 0o600 }',
    to: "String(process.pid), { mode: 0o600 } /* SHU86-M14 */",
    pattern: "SHU-86 C14:",
  },
  {
    name: "M15 leave the activation record armed after revert",
    from: "    io.fs.renameSync(paths.activation, retired);",
    to: "    // SHU86-M15",
    pattern: "SHU-86 C9:",
  },
  {
    name: "M16 leave the dispatch drop-ins after revert",
    from: "      if (io.fs.existsSync(file)) io.fs.unlinkSync(file);",
    to: "      // SHU86-M16",
    pattern: "SHU-86 C9:",
  },
  {
    name: "M17 read a review PASS as a stop",
    from: '/^review PASS\\b/.test(reason) ? "PASS"',
    to: 'false /* SHU86-M17 */ ? "PASS"',
    pattern: "SHU-86 C4:",
  },
  {
    name: "M18 keep ticking when the tick does not report this run armed",
    from: "  if (!armedId) return {",
    to: "  if (false) return { // SHU86-M18\n",
    pattern: "SHU-86 C4:",
  },
  {
    name: "M19 ignore a leftover build or review worktree",
    from: "if (/^(build-|review-pr)/.test(name))",
    to: "if (false) // SHU86-M19\n",
    pattern: "SHU-86 C5:",
  },
  {
    name: "M20 take a pull request on a card run",
    from: '    if (review) refuse("CARD_RUN_REVIEW_INPUT",',
    to: '    if (false) refuse("CARD_RUN_REVIEW_INPUT", // SHU86-M20\n',
    pattern: "SHU-86 C2:",
  },
  {
    name: "M21 count a stopped run as a success",
    from: "      result = { ok: ANSWERED.has(outcome.outcome),",
    to: '      result = { ok: outcome.outcome !== "REFUSED", // SHU86-M21\n',
    pattern: "SHU-86 C17:",
  },
  {
    name: "M22 abandon the revert when the dispatch-off tick fails",
    from: "  try { offTick = tickOutcome(tick(io)).activation; }\n  catch (error) { offTick = `tick failed: ${error.message}`; }",
    to: "  offTick = tickOutcome(tick(io)).activation; // SHU86-M22",
    pattern: "SHU-86 C18:",
  },
  {
    name: "M23 retire the record although the broker did not stop",
    from: '  run(io, "systemctl", ["stop", "shu71-evidence.service"]);',
    to: '  io.exec("systemctl", ["stop", "shu71-evidence.service"]); // SHU86-M23',
    pattern: "SHU-86 C19:",
  },
  {
    name: "M24 start a tick after the window closed",
    from: "        // arming itself can outlast it.\n        if (io.now().getTime() >= deadline) {",
    to: "        // arming itself can outlast it.\n        if (false) { // SHU86-M24",
    pattern: "SHU-86 C20:",
  },
  {
    name: "M25 run a card a person or agent owns",
    file: "service/card-prepare.mjs",
    from: "  if (issue.assignee || issue.delegate) return {",
    to: "  if (false) return { // SHU86-M25\n",
    pattern: "SHU-86 C22:",
  },
  {
    name: "M26 move a started or finished card back to Todo",
    file: "service/card-prepare.mjs",
    from: "  if (!MOVABLE_STATE_TYPES.includes(issue.state?.type)) {",
    to: "  if (false) { // SHU86-M26",
    pattern: "SHU-86 C22:",
  },
  {
    name: "M27 arm although the Todo move did not read back",
    file: "service/card-prepare.mjs",
    from: '  if (cardAction(after).action !== "none") {',
    to: '  if (false) { // SHU86-M27',
    pattern: "SHU-86 C23:",
  },
  {
    name: "M28 read credentials from a file others can read",
    file: "service/card-prepare.mjs",
    from: "  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {",
    to: "  if (false) { // SHU86-M28",
    pattern: "SHU-86 C24:",
  },
  {
    name: "M29 create the branch before the card is known to be movable",
    file: "service/card-prepare.mjs",
    from: "  await checkCard(io, credentials, plan.id);\n  const branch = plan.branch ? await prepareBranch(io, credentials, repo, plan.branch, revision, apply) : null;",
    to: "  const branch = plan.branch ? await prepareBranch(io, credentials, repo, plan.branch, revision, apply) : null; // SHU86-M29\n  await checkCard(io, credentials, plan.id);",
    pattern: "SHU-86 C22:",
  },
  {
    name: "M30 let plan write to Linear or GitHub",
    from: "credentials, apply: false });",
    to: "credentials, apply: true }); // SHU86-M30",
    pattern: "SHU-86 C15:",
  },
  {
    name: "M31 move or arm on the first snapshot, ignoring the read after the branch step",
    file: "service/card-prepare.mjs",
    from: "  const { issue, decision } = await checkCard(io, credentials, id);\n  if (decision.action === \"none\" || !apply)",
    to: "  const issue = await readCard(io, credentials, id); const seen = cardAction(issue); // SHU86-M31\n  const decision = seen.action === \"refuse\" ? { action: \"none\" } : seen;\n  if (decision.action === \"none\" || !apply)",
    pattern: "SHU-86 C25:",
  },
  {
    name: "M32 trust the Todo move without checking the card's history",
    file: "service/card-prepare.mjs",
    from: "  const own = changes.length === 1 &&",
    to: "  const own = true || changes.length === 1 && // SHU86-M32\n",
    pattern: "SHU-86 C26:",
  },
  {
    name: "M33 leave a concurrently started card in Todo",
    file: "service/card-prepare.mjs",
    from: "    const restored = theirs !== issue.state.id && await putBack(theirs);",
    to: "    const restored = false; // SHU86-M33",
    pattern: "SHU-86 C26:",
  },
  {
    name: "M34 read only the first page of the card's history",
    file: "service/card-prepare.mjs",
    from: "    if (!history.pageInfo?.hasNextPage) return",
    to: "    if (true) return // SHU86-M34\n",
    pattern: "SHU-86 C26:",
  },
  {
    name: "M35 count history from before the run's own read",
    file: "service/card-prepare.mjs",
    from: "&& Date.parse(entry.createdAt) > since) changes.push(entry);",
    to: ") changes.push(entry); // SHU86-M35",
    pattern: "SHU-86 C26:",
  },
  {
    name: "M41 put a raced card back even after it changed again",
    file: "service/card-prepare.mjs",
    from: "    if (current.state?.id !== decision.stateId || later.length !== 0) return false;",
    to: "    // SHU86-M41",
    pattern: "SHU-86 C26:",
  },
  {
    name: "M42 leave a card claimed during the move in Todo",
    file: "service/card-prepare.mjs",
    from: "    const restored = await putBack(issue.state.id);",
    to: "    const restored = false; // SHU86-M42",
    pattern: "SHU-86 C23:",
  },
  {
    name: "M36 take a move that left no trace in the history as done",
    file: "service/card-prepare.mjs",
    from: "  if (changes.length === 0) refuse(",
    to: "  if (false) refuse( // SHU86-M36\n",
    pattern: "SHU-86 C23:",
  },
  {
    name: "M37 finish a run without posting its report",
    from: "  return { ...summary, report: await postRunReport({ io, credentials, result: summary, timeoutMs: limits.reportTimeoutMs }) };",
    to: "  return { ...summary, report: { posted: true, issue: \"SHU-71\" } }; // SHU86-M37",
    pattern: "SHU-86 C27:",
  },
  {
    name: "M38 post the report before the host is reverted",
    from: "    let reverted;\n    try { reverted = revert(io, paths, limits); }",
    to: "    await postRunReport({ io, credentials, result: { card: plan.id, kind: plan.kind, activation_id: plan.record.activation_id, ...result, ticks, revert: {} } }); // SHU86-M38\n    let reverted;\n    try { reverted = revert(io, paths, limits); }",
    pattern: "SHU-86 C27:",
  },
  {
    name: "M39 let a failed report fail the run",
    file: "service/card-prepare.mjs",
    from: "  } catch (error) {\n    return { posted: false, issue: REPORT_ISSUE, code: \"CARD_RUN_REPORT\", reason: plainReason(error.message) };",
    to: "  } catch (error) { // SHU86-M39\n    throw error;",
    pattern: "SHU-86 C28:",
  },
  {
    name: "M40 copy the coordinator's reason into the report unflattened",
    file: "service/card-prepare.mjs",
    from: "  if (result.reason) lines.push(`Reason: ${plainReason(result.reason)}`);",
    to: "  if (result.reason) lines.push(`Reason: ${result.reason}`); // SHU86-M40",
    pattern: "SHU-86 C29:",
  },
  {
    name: "M43 post the report while the run still holds the lock",
    from: "    try { io.fs.unlinkSync(paths.lock); } catch { /* the lock is gone already */ }\n  }\n  // Reported last",
    to: "  }\n  // SHU86-M43\n  // Reported last",
    pattern: "SHU-86 C30:",
  },
  {
    name: "M44 wait on Linear without a deadline",
    file: "service/card-prepare.mjs",
    from: "    const send = (query, variables) => bounded(sendLinear(query, variables, credentials.LINEAR_API_TOKEN, io.fetch), timeoutMs);",
    to: "    const send = (query, variables) => sendLinear(query, variables, credentials.LINEAR_API_TOKEN, io.fetch); // SHU86-M44",
    pattern: "SHU-86 C30:",
  },
  {
    name: "M45 copy the card's state name into the report unflattened",
    file: "service/card-prepare.mjs",
    from: "from ${plainReason(card.from)} to Todo",
    to: "from ${card.from} to Todo",
    pattern: "SHU-86 C29:",
  },
  {
    name: "M46 let the timer run the same revision twice",
    from: '{ flag: "wx", mode: 0o600 });\n  } catch (error) {\n    if (error.code === "EEXIST")',
    to: '{ mode: 0o600 }); // SHU86-M46\n  } catch (error) {\n    if (error.code === "EEXIST")',
    pattern: "SHU-86 C31:",
  },
  {
    name: "M47 run while the host is paused",
    from: '  if (io.fs.existsSync(paths.pause)) return skip("PAUSED",',
    to: '  if (false) return skip("PAUSED", // SHU86-M47\n',
    pattern: "SHU-86 C32:",
  },
  {
    name: "M48 keep the claim when the host was taken after it",
    from: "      io.fs.unlinkSync(claim);\n      return skip(",
    to: "      return skip( // SHU86-M48\n",
    pattern: "SHU-86 C34:",
  },
  {
    name: "M49 stay silent about a refusal before arming",
    from: "    result.report = await postRunReport({ io, credentials, result, timeoutMs: limits.reportTimeoutMs });\n  }\n  try {",
    to: "  }\n  try { // SHU86-M49",
    pattern: "SHU-86 C33:",
  },
  {
    name: "M50 report a refusal before arming as a failed revert",
    file: "service/card-prepare.mjs",
    from: '  lines.push(result.outcome === "NOT_STARTED" ? "Nothing was armed, so there was nothing to revert."',
    to: '  lines.push(false ? "" // SHU86-M50\n',
    pattern: "SHU-86 C33:",
  },
  {
    name: "M51 replace timer units that hold other content",
    from: '    else if (io.fs.readFileSync(file, "utf8") !== text) refuse(',
    to: "    else if (false) refuse( // SHU86-M51\n",
    pattern: "SHU-86 C35:",
  },
  {
    name: "M52 remove the timer while its run is going",
    from: '  if (["active", "activating", "deactivating", "reloading"].includes(state)) {',
    to: "  if (false) { // SHU86-M52",
    pattern: "SHU-86 C35:",
  },
  {
    name: "M53 accept a timer that did not come up",
    from: '  if (enabled !== "enabled" || active !== "active") refuse(',
    to: "  if (false) refuse( // SHU86-M53\n",
    pattern: "SHU-86 C35:",
  },
  {
    name: "M54 let systemd kill a run before its revert",
    from: '    "TimeoutStartSec=8h",',
    to: '    "TimeoutStartSec=90min", // SHU86-M54',
    pattern: "SHU-86 C35:",
  },
  {
    name: "M55 count the timer from the service's last run",
    from: "    `OnCalendar=${AUTO_SCHEDULE}`,",
    to: '    "OnUnitInactiveSec=30min", // SHU86-M55',
    pattern: "SHU-86 C35:",
  },
  {
    name: "M56 remove the unit files while the timer is still on",
    from: '  if (["active", "activating", "reloading"].includes(timerState)) refuse(',
    to: "  if (false) refuse( // SHU86-M56\n",
    pattern: "SHU-86 C35:",
  },
];

for (const mutation of CASES) {
  test(`SHU-86 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu86-mutation-"));
    try {
      fs.cpSync(COORDINATOR, root, { recursive: true });
      const target = path.join(root, mutation.file ?? FILE);
      const source = fs.readFileSync(target, "utf8");
      assert.equal(source.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, source.replace(mutation.from, mutation.to));
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test",
        `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", "card-run.test.mjs"),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 60_000 });
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
