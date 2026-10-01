// SHU-71 try 7: four Codex reviews each blocked on another edge case the
// SHU-140 scanner had carried since its seed commit, and the episode ran out of
// revisions with every revised head green against its oracle. A reviewer is now
// shown the change the card's writers made, blocks on what that change broke or
// on the card's acceptance check, and passes what was already there as
// follow-ups that its receipt keeps.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCodexReviewPrompt, launchBuilder as launchCodex } from "../adapters/codex-cli.mjs";
import { buildClaudePrompt, launchBuilder as launchClaude } from "../adapters/claude-code.mjs";
import { laneForRuntimeRole } from "../launch-vocabulary.mjs";
import { createReceipt, foldLaunchOutcome } from "../reconcile.mjs";
import {
  REVIEW_CHANGE_DIFF_BYTES_MAX,
  REVIEW_CHANGE_HISTORY_MAX,
  STRICT_REVIEW_RULE,
  readReviewChange,
  reviewChangeContext,
  reviewRule,
} from "../review-change.mjs";
import { REVIEW_PASS_NOTE_MAX, reviewPassNote } from "../review-findings.mjs";
import { FIXTURE_ACCEPTANCE, SHU140_REVISION_PATHS } from "../workspace-scope.mjs";

const ATTEMPT = "12345678-9abc-4def-8123-456789abcdef";
const ROOT = mkdtempSync(join(tmpdir(), "shu71-review-change-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const [SCANNER, TESTS, ORACLE] = SHU140_REVISION_PATHS;
const workerSubject = (n) => `StudentHub worker result ${String(n).padStart(8, "0")}-247a-4e4b-8f70-9e4bf7010004`;

const GIT_ENV = { PATH: process.env.PATH, HOME: ROOT, GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z" };
function git(cwd, args) {
  return execFileSync("git", ["-c", `safe.directory=${cwd}`, ...args], { cwd, env: { ...GIT_ENV, GIT_DIR: join(cwd, ".git") }, encoding: "utf8" });
}
const gitIn = (cwd) => async (args) => git(cwd, args);
function commit(cwd, files, subject) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  git(cwd, ["add", "--all"]);
  git(cwd, ["commit", "-q", "--no-verify", "-m", subject]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

// A lane like SHU-140's: a seed commit, then the broker's worker commits.
function lane(name) {
  const cwd = join(ROOT, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-q", "-b", "lane"]);
  const seed = commit(cwd, { [SCANNER]: "const TEST_CALL_RE = /\\b(?:test|it)\\s*\\(/g;\n", [TESTS]: "test('a', () => {});\n",
    [ORACLE]: "export default [];\n", "README.md": "seed\n" }, "fixture(SHU-140): seed the trap");
  const build = commit(cwd, { [SCANNER]: "const TEST_CALL_RE = /(?<![\\w$.])(?:test|it)\\s*\\(/g;\n", "README.md": "outside the scope\n" }, workerSubject(1));
  const revise = commit(cwd, { [ORACLE]: "export default [{ name: 'stub', vacuous: true }];\n" }, workerSubject(2));
  return { cwd, seed, build, revise };
}

test("SHU71_REVIEW_CHANGE_BASE: the change is the broker's commits on the bound head, its base the commit below them", async () => {
  const { cwd, seed, build, revise } = lane("base");
  const change = await readReviewChange({ target_sha: revise, paths: SHU140_REVISION_PATHS, git: gitIn(cwd) });
  assert.equal(change.ok, true);
  assert.deepEqual([change.base_sha, change.commits, change.truncated], [seed, 2, false]);
  assert.match(change.diff, /\+const TEST_CALL_RE = \/\(\?<!/);
  assert.match(change.diff, /\+export default \[\{ name: 'stub'/);
  assert.doesNotMatch(change.diff, /README|outside the scope/, "only the declared scope is quoted");
  const whole = await readReviewChange({ target_sha: revise, git: gitIn(cwd) });
  assert.match(whole.diff, /outside the scope/, "a card with no declared scope is shown its whole change");

  const first = await readReviewChange({ target_sha: build, paths: SHU140_REVISION_PATHS, git: gitIn(cwd) });
  assert.deepEqual([first.base_sha, first.commits], [seed, 1]);
  // An unchanged initial build is reviewed at the seed itself: nothing changed.
  const unchanged = await readReviewChange({ target_sha: seed, paths: SHU140_REVISION_PATHS, git: gitIn(cwd) });
  assert.deepEqual([unchanged.ok, unchanged.base_sha, unchanged.commits, unchanged.diff], [true, seed, 0, ""]);
});

test("SHU71_REVIEW_CHANGE_UNKNOWN: an unreadable or unbounded change leaves the base unknown", async () => {
  const { cwd, revise } = lane("unknown");
  const refused = async () => { throw new Error("git refused"); };
  assert.deepEqual(await readReviewChange({ target_sha: revise, git: refused }), { ok: false });
  assert.deepEqual(await readReviewChange({ target_sha: "not-a-sha", git: gitIn(cwd) }), { ok: false });
  assert.deepEqual(await readReviewChange({ target_sha: "f".repeat(40), git: gitIn(cwd) }), { ok: false }, "a head the checkout lacks");
  // Git answering for another head than the bound one is never trusted.
  assert.deepEqual(await readReviewChange({ target_sha: revise, git: async () => `${"e".repeat(40)}\tseed\n` }), { ok: false });
  // Nothing but worker commits within the history bound: no base to compare with.
  const workers = Array.from({ length: REVIEW_CHANGE_HISTORY_MAX + 1 }, (_, i) => `${i ? "c".repeat(40) : revise}\t${workerSubject(i)}`).join("\n");
  assert.deepEqual(await readReviewChange({ target_sha: revise, git: async () => workers }), { ok: false });
  // A subject that merely starts like the broker's is not a worker commit.
  const lookalike = `${revise}\t${workerSubject(1)} (edited)\n${"c".repeat(40)}\t${workerSubject(2)}\n`;
  const near = await readReviewChange({ target_sha: revise, git: async (args) => (args[0] === "log" ? lookalike : "") });
  assert.deepEqual([near.base_sha, near.commits], [revise, 0]);
});

test("SHU71_REVIEW_CHANGE_BUDGET: a diff over budget is cut to fit, measured on its escaped rendering, and says so", async () => {
  const cwd = join(ROOT, "budget");
  mkdirSync(cwd);
  git(cwd, ["init", "-q", "-b", "lane"]);
  commit(cwd, { [SCANNER]: "seed\n" }, "seed");
  const big = Array.from({ length: 4000 }, (_, i) => `const line${i} = "<${"\\".repeat(4)}${i}>";`).join("\n");
  const head = commit(cwd, { [SCANNER]: `${big}\n` }, workerSubject(1));
  const change = await readReviewChange({ target_sha: head, paths: SHU140_REVISION_PATHS, git: gitIn(cwd) });
  assert.equal(change.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(change.diff.replace(/</g, "\\u003c"))) <= REVIEW_CHANGE_DIFF_BYTES_MAX);
  assert.ok(change.diff.startsWith("diff --git"), "the cut keeps the diff's head");
  assert.match(reviewChangeContext(change), /it was cut to fit, so read the files for the rest/);
});

test("SHU71_REVIEW_RULE: only what the change broke, or the card's acceptance check, blocks", async () => {
  const { cwd, seed, revise } = lane("rule");
  const rule = await reviewRule({ issue_id: "SHU-140", target_sha: revise, git: gitIn(cwd) });
  assert.ok(rule.includes(`2 writer commit(s) on top of the base ${seed}`), rule);
  assert.match(rule, /the change introduced the defect, or made an existing one reachable or worse/);
  assert.ok(rule.includes(`the card's acceptance check fails: ${FIXTURE_ACCEPTANCE} This blocks even where the base already failed it`));
  assert.match(rule, /already present at the base, in the same form, and that the card's acceptance does not cover is not blocking\. Return PASS/);
  assert.match(rule, /under "Follow-ups:"/);
  assert.doesNotMatch(rule, /seeded|trap|defect_path/i, "the rule names the acceptance check, never which file is seeded");
  assert.equal(rule.includes(STRICT_REVIEW_RULE), false);
  // The quoted diff cannot close a tag around it, and stays one JSON string line.
  const quoted = rule.split("\n")[1];
  assert.equal(typeof JSON.parse(quoted.replace(/\\u003c/g, "<")), "string");
  assert.equal(quoted.includes("<"), false);

  const plain = await reviewRule({ issue_id: "SHU-61", target_sha: revise, git: gitIn(cwd) });
  assert.doesNotMatch(plain, /acceptance check fails/, "a card with no fixture contract states no acceptance check");
  assert.match(plain, /outside the scope/);
  const unknown = await reviewRule({ issue_id: "SHU-140", target_sha: revise, git: async () => { throw new Error("no git"); } });
  assert.equal(unknown, `The coordinator could not tell where this card's change starts, so the strict rule holds. ${STRICT_REVIEW_RULE}`);
});

test("SHU71_REVIEW_RULE_PROMPT: both reviewer prompts carry the rule they are given, and the strict rule by default", () => {
  const base = { issue_id: "SHU-140", authorization_ref: "SHU-140", attempt_id: ATTEMPT, target_sha: "a".repeat(40), task_context: "ctx" };
  for (const build of [buildCodexReviewPrompt, (input) => buildClaudePrompt({ ...input, role: "review" })]) {
    assert.ok(build(base).includes(STRICT_REVIEW_RULE));
    const prompt = build({ ...base, review_rule: "RULE-UNDER-TEST" });
    assert.ok(prompt.includes("\nRULE-UNDER-TEST\n"));
    assert.equal(prompt.includes(STRICT_REVIEW_RULE), false);
  }
  assert.match(buildClaudePrompt({ ...base, role: "review" }), /You are read-only\. Do not edit, commit, or push\./);
  const writer = buildClaudePrompt({ ...base, role: "revise", allowed_paths: [SCANNER], review_rule: "RULE-UNDER-TEST" });
  assert.equal(writer.includes("RULE-UNDER-TEST"), false, "a writer is never given the reviewer's rule");
});

function evidenceFor(head, link) {
  return async () => ({
    executed: true, passed: true, reason_code: "REVIEW_TESTS_PASSED", evidence_link: link,
    isolation_wrapper: ["/test/reviewer-model-wrapper"],
    report: { version: "1.0.0", target_sha: head, tests: { executed: true, exit_code: 0 } },
  });
}
function execDouble(stdout) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    queueMicrotask(() => callback(null, stdout, ""));
    return { pid: 4321 };
  };
  impl.calls = calls;
  return impl;
}

test("SHU71_REVIEW_RULE_LAUNCH: each reviewer family reads the change in its own checkout, and git sees only that repository", async () => {
  const { cwd, seed, revise } = lane(ATTEMPT);
  const evidenceDir = join(ROOT, "evidence");
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const report = join(evidenceDir, `${ATTEMPT}.review-test.1.json`);
  writeFileSync(report, "{}", { mode: 0o600 });
  const link = pathToFileURL(report).href;
  const callback = { attempt_id: ATTEMPT, target_sha: revise, stage: "PASS", links: [link, `${SCANNER}@${revise}:1`], summary: "PASS. Follow-ups: none." };
  const gitCalls = [];
  const reviewGitExecImpl = (file, args, options, done) => {
    gitCalls.push({ file, args, options });
    queueMicrotask(() => {
      try { done(null, execFileSync(file, args, { ...options, env: { ...options.env, ...GIT_ENV, GIT_DIR: options.env.GIT_DIR } }), ""); }
      catch (error) { done(error, "", ""); }
    });
    return { pid: 4322 };
  };

  const codexExec = execDouble([
    { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
    { type: "item.completed", item: { id: "i1", type: "agent_message", text: JSON.stringify(callback) } },
    { type: "turn.completed" },
  ].map((line) => JSON.stringify(line)).join("\n"));
  const codex = await launchCodex({ issue_id: "SHU-140", authorization_ref: "SHU-140", attempt_id: ATTEMPT, target_sha: revise,
    task_context: "ctx", role: "review", runtime: "codex-cli", workspace_scope: "full", scope_phase: "review", allowed_paths: [],
    scoped_base_sha: null, cwd, env: { PATH: "/usr/bin", CODEX_HOME: "/srv/codex", SHU_REVIEW_EVIDENCE_DIR: evidenceDir },
    readHeadImpl: async () => revise, reviewEvidenceImpl: evidenceFor(revise, link), execFileImpl: codexExec, reviewGitExecImpl,
    io: { codexStateDir: join(ROOT, "codex-state"), pushBrokerImpl: async () => { throw new Error("a reviewer never pushes"); } } });
  assert.equal(codex.stage, "COMPLETED", codex.reason);
  assert.equal(codexExec.calls.length, 1, "git runs outside the model's process boundary");
  const codexPrompt = codexExec.calls[0].args.at(-1);
  assert.ok(codexPrompt.includes(`on top of the base ${seed}`), codexPrompt);
  assert.match(codexPrompt, /the card's acceptance check fails/);

  // The Claude reviewer's evidence lives in its checkout's own evidence folder.
  mkdirSync(join(cwd, ".review-evidence"), { mode: 0o700 });
  const claudeReport = join(cwd, ".review-evidence", `${ATTEMPT}.review-test.1.json`);
  writeFileSync(claudeReport, "{}", { mode: 0o600 });
  const claudeLink = pathToFileURL(claudeReport).href;
  const claudeExec = execDouble(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: ATTEMPT,
    structured_output: { ...callback, links: [claudeLink, `${SCANNER}@${revise}:1`] } }));
  const claude = await launchClaude({ issue_id: "SHU-140", authorization_ref: "SHU-140", attempt_id: ATTEMPT, target_sha: revise,
    task_context: "ctx", oauth_token: "oauth-test-fixture", cwd, readHeadImpl: async () => revise,
    reviewEvidenceImpl: evidenceFor(revise, claudeLink), execFileImpl: claudeExec, reviewGitExecImpl,
    persistEnvelopeImpl: () => ({ link: pathToFileURL(join(cwd, ".review-evidence", "envelope.stdout")).href }) });
  assert.equal(claude.stage, "COMPLETED", claude.reason);
  assert.equal(claudeExec.calls.length, 1);
  assert.ok(claudeExec.calls[0].args.at(-1).includes(`on top of the base ${seed}`));

  assert.ok(gitCalls.length >= 4);
  for (const call of gitCalls) {
    assert.equal(call.file, "git");
    assert.deepEqual(call.args.slice(0, 2), ["-c", `safe.directory=${cwd}`]);
    assert.ok(["log", "diff"].includes(call.args[2]), `read-only git only: ${call.args[2]}`);
    assert.equal(call.options.cwd, cwd);
    assert.equal(call.options.env.GIT_DIR, join(cwd, ".git"), "git never searches above the checkout");
    assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in call.options.env, false);
  }
});

const S = "5".repeat(40);
const W = "6".repeat(40);
function reviewOf(callback) {
  const id = (n) => `bbbbbbbb-cccc-4ddd-8eee-${String(n).padStart(12, "0")}`;
  const bind = { receipt_version: "1.1.0", issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    repo: "BAWES-Universe/studenthub-platform", branch: "coordinator/SHU-140", episode_id: "shu71-reversed-7", reserved_at: "2026-10-01T05:00:00.000Z" };
  const fold = (r, cb, lineage, head) => foldLaunchOutcome(r, { stage: "COMPLETED", external_run_id: `fixture_${r.attempt_id}`, worker_identity: cb.actor,
    callback: cb.callback }, { current_head: head, expected_head: head, lineage, now: () => new Date("2026-10-01T05:01:00.000Z") }).receipt;
  const made = createReceipt({ ...bind, role: "build", runtime: "claude-code", requested_worker: laneForRuntimeRole("claude-code", "build"), target_sha: S, attempt_id: id(1) });
  const build = fold(made.receipt, { actor: "claude:writer", callback: { attempt_id: id(1), target_sha: S, result_sha: W, stage: "BUILD_READY", links: ["tools/fixture/scan-vacuous.mjs:1"] } }, [], W);
  const review = createReceipt({ ...bind, role: "review", runtime: "codex-cli", requested_worker: laneForRuntimeRole("codex-cli", "review"), target_sha: W, attempt_id: id(2) }).receipt;
  return fold(review, { actor: "codex:reviewer", callback: { attempt_id: id(2), target_sha: W, result_sha: null, links: ["file:///srv/evidence.json"], ...callback } }, [build], W);
}

test("SHU71_REVIEW_PASS_NOTE: a PASS keeps its follow-ups on the review receipt; a BLOCK keeps its findings as before", () => {
  const passed = reviewOf({ stage: "PASS", summary: "No blocking defect.\nFollow-ups: `$test` is read as a test call (pre-existing)." });
  assert.equal(passed.stage, "COMPLETED");
  assert.equal(passed.notes.at(-1), `reviewer summary: ${JSON.stringify("No blocking defect. Follow-ups: `$test` is read as a test call (pre-existing).")}`);
  const blocked = reviewOf({ stage: "BLOCKED", summary: "the oracle row contradicts the contract" });
  assert.equal(blocked.review_findings.summary, "the oracle row contradicts the contract");
  assert.equal(blocked.notes.some((n) => n.startsWith("reviewer summary:")), false);

  assert.equal(reviewPassNote({ stage: "BLOCKED", summary: "x" }), null);
  assert.equal(reviewPassNote({ stage: "PASS", summary: "  " }), null);
  assert.equal(reviewPassNote({ stage: "PASS", summary: "token ghp_" + "a".repeat(36) }), null, "credential-shaped text is dropped, never trimmed");
  assert.equal(reviewPassNote({ stage: "PASS", summary: "x".repeat(REVIEW_PASS_NOTE_MAX + 50) }), `reviewer summary: ${JSON.stringify("x".repeat(REVIEW_PASS_NOTE_MAX))}`);
});
