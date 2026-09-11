import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  launchBuilder,
  persistClaudeEnvelope,
} from "../adapters/claude-code.mjs";
import { runReviewEvidence } from "../review-execution.mjs";
import { bounded, MAX_CAPTURE_BYTES } from "../review-execution-child.mjs";
import { CANONICAL_SEED, inspectFixtureSeed, SEED_MARKER } from "../fixture-seed.mjs";
import { createReceipt, foldLaunchOutcome } from "../reconcile.mjs";
import { createEpisodeHarness, SHA_INPUT, SHA_WRITE } from "./fixture/episode-harness.mjs";

const ATTEMPT = "23223223-2232-4232-8232-232232232232";
const SHA = "2".repeat(40);
const TEST_LINK = "file:///srv/shu/review-evidence/review-test.json";

function privateTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function output(stage = "PASS", over = {}) {
  return JSON.stringify({
    type: "result",
    is_error: false,
    session_id: ATTEMPT,
    structured_output: {
      attempt_id: ATTEMPT,
      target_sha: SHA,
      stage,
      links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/232"],
      ...over,
    },
  });
}

function executor(stdout) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    queueMicrotask(() => callback(null, stdout, ""));
  };
  impl.calls = calls;
  return impl;
}

function reviewProof(over = {}) {
  return async () => ({
    executed: true,
    passed: true,
    reason_code: "REVIEW_TESTS_PASSED",
    evidence_link: TEST_LINK,
    ...over,
  });
}

function launchArgs(dir, stdout, over = {}) {
  return {
    issue_id: "SHU-140",
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "PROMPT_SENTINEL_SHU232_ONLY",
    oauth_token: "oauth-SHU232-sentinel",
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      SHU_REVIEW_EVIDENCE_DIR: dir,
      GITHUB_TOKEN: "ENV_SENTINEL_GITHUB_SHU232",
      LINEAR_API_TOKEN: "ENV_SENTINEL_LINEAR_SHU232",
    },
    readHeadImpl: async () => SHA,
    reviewEvidenceImpl: reviewProof(),
    execFileImpl: executor(stdout),
    ...over,
  };
}

function fold(out) {
  const made = createReceipt({
    issue_id: "SHU-140",
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    requested_worker: "claude-verifier",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "coordinator/SHU-140",
    target_sha: SHA,
    attempt_id: ATTEMPT,
  });
  assert.equal(made.ok, true);
  return foldLaunchOutcome(made.receipt, out).receipt;
}

test("SHU-232 B1: valid callback retains byte-identical 0600 envelope and the receipt links it", async (t) => {
  const dir = privateTemp("shu232-b1-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = output();
  const out = await launchBuilder(launchArgs(dir, raw));
  assert.equal(out.stage, "COMPLETED");
  const envelopeLink = out.audit_evidence_links.find((link) => link.includes("claude-envelope"));
  assert.ok(envelopeLink, "the adapter returns the retained envelope reference");
  const envelopePath = new URL(envelopeLink);
  assert.equal(fs.readFileSync(envelopePath, "utf8"), raw, "retention is byte-identical to CLI stdout");
  assert.equal(fs.statSync(envelopePath).mode & 0o777, 0o600, "the raw envelope is coordinator-private");
  const receipt = fold(out);
  assert.ok(receipt.evidence_links.includes(envelopeLink), "the durable receipt links the retained envelope");
  assert.equal(receipt.stage, "COMPLETED", "valid callback behavior is otherwise unchanged");
});

test("SHU-232 B2: prose-only result retains its envelope and names NO_STRUCTURED_OUTPUT", async (t) => {
  const dir = privateTemp("shu232-b2-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = JSON.stringify({ type: "result", is_error: false, session_id: ATTEMPT, result: "Looks good, but this is prose." });
  const out = await launchBuilder(launchArgs(dir, raw));
  assert.equal(out.stage, "HOLD");
  assert.equal(out.reason_code, "NO_STRUCTURED_OUTPUT");
  const envelopeLink = out.audit_evidence_links.find((link) => link.includes("claude-envelope"));
  assert.ok(envelopeLink, "prose-only output still retains the raw envelope");
  assert.equal(fs.readFileSync(new URL(envelopeLink), "utf8"), raw);
  assert.ok(fold(out).notes.some((note) => note.includes("NO_STRUCTURED_OUTPUT")), "the distinct code survives into the receipt");
});

test("SHU-232 B3: structured but unbound callback names CALLBACK_BINDING_INVALID, never B2's code", async (t) => {
  const dir = privateTemp("shu232-b3-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = output("PASS", { target_sha: "3".repeat(40) });
  const out = await launchBuilder(launchArgs(dir, raw));
  assert.equal(out.stage, "HOLD");
  assert.equal(out.reason_code, "CALLBACK_BINDING_INVALID");
  assert.notEqual(out.reason_code, "NO_STRUCTURED_OUTPUT");
  const envelopeLink = out.audit_evidence_links.find((link) => link.includes("claude-envelope"));
  assert.ok(envelopeLink, "binding-invalid output still retains the raw envelope");
  assert.equal(fs.readFileSync(new URL(envelopeLink), "utf8"), raw);
  assert.ok(fold(out).notes.some((note) => note.includes("CALLBACK_BINDING_INVALID")));
});

test("SHU-232 B4: envelope write failure is logged, nonfatal, and never claimed as retained", async () => {
  const logs = [];
  const out = await launchBuilder(launchArgs("/tmp", output(), {
    persistEnvelopeImpl: () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
    io: { stdout: (line) => logs.push(line) },
  }));
  assert.equal(out.stage, "COMPLETED", "evidence I/O does not erase a valid reviewer result");
  assert.ok(logs.some((line) => line.includes("ENVELOPE_RETENTION_FAILED")), "the failure is visible");
  assert.ok(out.audit_notes.some((line) => line.includes("ENVELOPE_RETENTION_FAILED")));
  assert.equal(out.audit_evidence_links.some((link) => link.includes("claude-envelope")), false, "no false retained link exists");
});

test("SHU-232 B5: envelope is stdout-only, secret-free, token-scanned, and size-bounded", async (t) => {
  const dir = privateTemp("shu232-b5-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = output();
  const args = launchArgs(dir, raw);
  const out = await launchBuilder(args);
  const envelopeLink = out.audit_evidence_links.find((link) => link.includes("claude-envelope"));
  assert.ok(envelopeLink, "safe stdout is retained");
  const envelope = fs.readFileSync(new URL(envelopeLink), "utf8");
  for (const sentinel of [args.env.GITHUB_TOKEN, args.env.LINEAR_API_TOKEN, args.task_context, args.oauth_token]) {
    assert.equal(envelope.includes(sentinel), false, `persisted stdout must not contain ${sentinel}`);
  }
  const childEnv = args.execFileImpl.calls[0].options.env;
  assert.equal(Object.hasOwn(childEnv, "GITHUB_TOKEN"), false, "Claude receives no GitHub credential");
  assert.equal(Object.hasOwn(childEnv, "LINEAR_API_TOKEN"), false, "Claude receives no Linear credential");
  for (const [source, sentinel] of Object.entries({
    github_env: args.env.GITHUB_TOKEN,
    linear_env: args.env.LINEAR_API_TOKEN,
    prompt: args.task_context,
    oauth_env: args.oauth_token,
  })) {
    const leakingRaw = JSON.stringify({ ...JSON.parse(raw), retained_envelope_leak: sentinel });
    assert.ok(leakingRaw.includes(sentinel), `${source} sentinel must actually reach mocked raw stdout`);
    const refused = await launchBuilder(launchArgs(dir, leakingRaw));
    assert.equal(
      refused.audit_evidence_links.some((link) => link.includes("claude-envelope")),
      false,
      `${source} sentinel in raw stdout must prevent envelope retention`,
    );
    assert.ok(
      refused.audit_notes.some((note) => note.includes("ENVELOPE_RETENTION_FAILED")),
      `${source} rejection must remain visible`,
    );
    for (const file of fs.readdirSync(dir).filter((name) => name.includes("claude-envelope"))) {
      assert.equal(
        fs.readFileSync(path.join(dir, file), "utf8").includes(sentinel),
        false,
        `${source} sentinel must appear in no retained envelope`,
      );
    }
  }
  assert.throws(() => persistClaudeEnvelope({
    stdout: JSON.stringify({ token: "github_pat_abcdefghijklmnopqrstuvwxyz1234567890" }),
    attempt_id: ATTEMPT,
    evidence_dir: dir,
  }), /credential-shaped/);
  assert.throws(() => persistClaudeEnvelope({
    stdout: "x".repeat(1024 * 1024 + 1),
    attempt_id: ATTEMPT,
    evidence_dir: dir,
  }), /size limit/);
});

test("SHU-232 B6: a real node --test execution at the bound workspace produces durable evidence", async (t) => {
  const root = privateTemp("shu232-b6-");
  const workspace = path.join(root, "workspace");
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(workspace, { mode: 0o755 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  const marker = path.join(root, "real-node-test-ran");
  const testFile = path.join(workspace, "bound.test.mjs");
  fs.writeFileSync(testFile, `import { test } from "node:test"; import fs from "node:fs"; test("bound", () => fs.writeFileSync(${JSON.stringify(marker)}, "ran"));\n`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expectedUid = (process.getuid?.() ?? 1000) + 1000;
  const execFileImpl = (_file, args, options, callback) => {
    const split = args.indexOf("--");
    const files = args.slice(split + 1);
    const actual = spawnSync(process.execPath, ["--test", ...files], {
      cwd: options.cwd, env: options.env, encoding: "utf8",
    });
    const report = {
      version: "1.0.0", target_sha: SHA, test_files: ["bound.test.mjs"], expected_uid: expectedUid, actual_uid: expectedUid,
      filesystem_probe: "DENIED", workspace_write_probe: "DENIED", network_probe: "DENIED", forbidden_env_keys: [],
      tests: { executed: true, exit_code: actual.status, signal: actual.signal, stdout: actual.stdout, stderr: actual.stderr },
    };
    queueMicrotask(() => callback(null, JSON.stringify(report), ""));
  };
  const result = await runReviewEvidence({
    attempt_id: ATTEMPT,
    target_sha: SHA,
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      SHU_REVIEW_EXEC_UID: String(expectedUid),
      SHU_REVIEW_EXEC_WRAPPER_JSON: JSON.stringify(["/test/confinement-wrapper"]),
      SHU_REVIEW_TEST_FILES_JSON: JSON.stringify(["bound.test.mjs"]),
      SHU_REVIEW_EVIDENCE_DIR: evidence,
    },
    execFileImpl,
    validateWrapperImpl: (wrapper) => wrapper,
  });
  assert.equal(fs.readFileSync(marker, "utf8"), "ran", "assert on execution, not merely constructed argv");
  assert.equal(result.executed, true);
  assert.equal(result.passed, true);
  assert.ok(result.evidence_link);
  const artifact = JSON.parse(fs.readFileSync(new URL(result.evidence_link), "utf8"));
  assert.match(artifact.tests.stdout, /pass 1/);
});

test("SHU-232 B6: worst-case escaped stdout and stderr stay inside the 1 MiB evidence budget", () => {
  const worstCase = "\0".repeat(MAX_CAPTURE_BYTES + 1);
  const report = {
    version: "1.0.0", target_sha: SHA, test_files: ["bound.test.mjs"],
    expected_uid: 65534, actual_uid: 65534, filesystem_probe: "DENIED",
    workspace_write_probe: "DENIED", network_probe: "DENIED", forbidden_env_keys: [],
    tests: { executed: true, exit_code: 0, signal: null, stdout: bounded(worstCase), stderr: bounded(worstCase) },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 1024 * 1024, "serialized evidence retains explicit headroom");
});

test("SHU-232 B7: no confined execution evidence fails closed and can never PASS", async () => {
  const cli = executor(output());
  const out = await launchBuilder(launchArgs("/tmp", output(), {
    execFileImpl: cli,
    reviewEvidenceImpl: reviewProof({ executed: false, evidence_link: null, reason_code: "REVIEW_EXECUTION_UNAVAILABLE" }),
  }));
  assert.equal(out.stage, "HOLD");
  assert.equal(out.reason_code, "REVIEW_EXECUTION_UNAVAILABLE");
  assert.notEqual(out.stage, "COMPLETED");
  assert.equal(cli.calls.length, 0, "Claude is not launched when exact-head execution cannot be proved");
});

test("SHU-232 B7: an actual unconfined child exposes a boundary and is refused before tests", async (t) => {
  const root = privateTemp("shu232-b7-live-");
  const workspace = path.join(root, "workspace");
  const evidence = path.join(root, "evidence");
  const wrapperMarker = path.join(root, "unconfined-wrapper-ran");
  const unconfinedWrapper = path.join(root, "unconfined-wrapper");
  fs.mkdirSync(workspace, { mode: 0o755 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  fs.writeFileSync(unconfinedWrapper, `#!/bin/sh\nprintf ran > ${JSON.stringify(wrapperMarker)}\nexec "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, "must-not-run.test.mjs"), "throw new Error('unconfined test ran');\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownUid = process.getuid?.() ?? 1000;
  const result = await runReviewEvidence({
    attempt_id: "72727272-7272-4272-8272-727272727272",
    target_sha: SHA,
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      SHU_REVIEW_EXEC_UID: String(ownUid + 1),
      SHU_REVIEW_EXEC_WRAPPER_JSON: JSON.stringify([unconfinedWrapper]),
      SHU_REVIEW_TEST_FILES_JSON: JSON.stringify(["must-not-run.test.mjs"]),
      SHU_REVIEW_EVIDENCE_DIR: evidence,
    },
    validateWrapperImpl: (wrapper) => wrapper,
  });
  assert.equal(fs.existsSync(wrapperMarker), true, "a test-owned real wrapper reached the active child probe");
  assert.equal(fs.readFileSync(wrapperMarker, "utf8"), "ran");
  assert.equal(result.executed, false);
  assert.equal(result.reason_code, "REVIEW_EXECUTION_UNAVAILABLE");
  assert.ok(result.evidence_link, "the failed active probe remains inspectable");
  const artifact = JSON.parse(fs.readFileSync(new URL(result.evidence_link), "utf8"));
  assert.equal(artifact.tests.executed, false, "target tests never start outside confinement");
  assert.ok(
    artifact.actual_uid !== artifact.expected_uid || artifact.filesystem_probe === "REACHABLE" || artifact.network_probe === "REACHABLE",
    "the refusal records a concrete failed boundary rather than trusting a flag",
  );
});

test("SHU-232 B8: the canonical re-seed is a checker-visible CI-green trap", (t) => {
  const root = privateTemp("shu232-b8-");
  const fixture = path.join(root, "tools/fixture");
  const tests = path.join(fixture, "test");
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(fixture, "scan-vacuous.mjs"), "export const scanVacuousTests = (s) => s.includes('\\\"}\\\"') ? [{name:'string-brace'}] : [];\n");
  const seeded = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { scanVacuousTests } from "../scan-vacuous.mjs";\n${CANONICAL_SEED}\n`;
  const testFile = path.join(tests, "scan-vacuous.test.mjs");
  fs.writeFileSync(testFile, seeded);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(inspectFixtureSeed(seeded).ok, true, "the seed checker reports the vacuous assertion trap");
  assert.equal(inspectFixtureSeed(seeded.replace(`// ${SEED_MARKER}\n`, "")).ok, false, "a lane with no seed is refused");
  assert.equal(
    inspectFixtureSeed(seeded.replace("assert.deepEqual(expected, []);", "assert.deepEqual(report, expected);")).ok,
    false,
    "a genuine helper assertion is not mislabeled as the seeded defect",
  );
  const commentedHelper = `import { test } from "node:test";\n// const report = scanVacuousTests("fixture");\ntest("unrelated", () => assert.deepEqual([], []));\n`;
  assert.equal(inspectFixtureSeed(commentedHelper).ok, false, "a helper assignment in a comment is not executable seed evidence");
  assert.equal(inspectFixtureSeed(`/*\n${CANONICAL_SEED}\n*/`).ok, false, "the exact seed wrapped in a block comment is refused");
  const run = spawnSync(process.execPath, ["--test", "tools/fixture/test/scan-vacuous.test.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, `the builder's own test remains green:\n${run.stdout}\n${run.stderr}`);
});

test("SHU-232 B9: production-shaped harness reaches build -> BLOCKED -> revision -> re-review -> PASS with no seeded successors", async () => {
  const h = createEpisodeHarness({ githubToken: "ghtok", activationId: "shu232fullarc" });
  try {
    assert.equal(h.receipts().length, 0, "no successor or terminal receipt is pre-seeded");
    await h.runTick();
    const build = h.latestFor("codex-builder");
    await h.runTick();
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    h.branchHead.value = SHA_WRITE;
    h.completeRun(build.external_run_id);
    await h.runTick();
    await h.runTick();
    const review = h.latestFor("claude-verifier");
    await h.runTick();
    h.postCallback({ attemptId: review.attempt_id, stage: "BLOCKED", targetSha: SHA_WRITE, resultSha: SHA_WRITE });
    h.completeRun(review.external_run_id);
    await h.runTick();
    await h.runTick();
    const revise = h.latestFor("codex-builder");
    await h.runTick();
    h.postCallback({ attemptId: revise.attempt_id, stage: "REVISION_READY", targetSha: SHA_WRITE, resultSha: SHA_WRITE });
    h.completeRun(revise.external_run_id);
    await h.runTick();
    await h.runTick();
    const rereview = h.latestFor("claude-verifier");
    await h.runTick();
    h.postCallback({ attemptId: rereview.attempt_id, stage: "PASS", targetSha: SHA_WRITE, resultSha: SHA_WRITE });
    h.completeRun(rereview.external_run_id);
    await h.runTick();
    assert.deepEqual(h.triggers, { "codex-cli": 2, "claude-code": 2, "hermes-pool": 0 }, "all four launches are coordinator-driven");
    assert.deepEqual(h.receipts().map((r) => r.verdict_stage).filter(Boolean), ["BUILD_READY", "BLOCKED", "REVISION_READY", "PASS"]);
  } finally { h.cleanup(); }
});

test("SHU-232 B10: B-ii binds a control-plane-owned workspace to a distinct effective execution uid", async (t) => {
  const root = privateTemp("shu232-b10-");
  const workspace = path.join(root, "workspace");
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(workspace, { mode: 0o755 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, "uid.test.mjs"), "import { test } from 'node:test'; test('ok', () => {});\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownUid = process.getuid?.() ?? 1000;
  const expectedUid = ownUid + 2000;
  const execFileImpl = (_file, _args, _options, callback) => queueMicrotask(() => callback(null, JSON.stringify({
    version: "1.0.0", target_sha: SHA, test_files: ["uid.test.mjs"], expected_uid: expectedUid, actual_uid: expectedUid,
    filesystem_probe: "DENIED", workspace_write_probe: "DENIED", network_probe: "DENIED", forbidden_env_keys: [],
    tests: { executed: true, exit_code: 0, signal: null, stdout: "TAP version 13\n# pass 1", stderr: "" },
  }), ""));
  const result = await runReviewEvidence({
    attempt_id: ATTEMPT, target_sha: SHA, cwd: workspace, execFileImpl, validateWrapperImpl: (wrapper) => wrapper,
    env: {
      SHU_REVIEW_EXEC_UID: String(expectedUid),
      SHU_REVIEW_EXEC_WRAPPER_JSON: JSON.stringify(["/test/confinement-wrapper"]),
      SHU_REVIEW_TEST_FILES_JSON: JSON.stringify(["uid.test.mjs"]),
      SHU_REVIEW_EVIDENCE_DIR: evidence,
    },
  });
  assert.equal(result.executed, true, "the configured non-coordinator uid is accepted only with all probes bound");
  const artifact = JSON.parse(fs.readFileSync(new URL(result.evidence_link), "utf8"));
  assert.equal(artifact.confinement_mode, "B-ii");
  assert.equal(artifact.workspace_uid, ownUid, "the read-only review workspace remains coordinator-owned under B-ii");
  assert.equal(artifact.actual_uid, expectedUid, "builder-authored code executes as the configured non-coordinator uid");
  assert.notEqual(artifact.actual_uid, artifact.workspace_uid);

  const realStat = fs.lstatSync;
  const wrongOwnerFs = Object.create(fs);
  wrongOwnerFs.lstatSync = (candidate) => {
    const stat = realStat(candidate);
    return path.resolve(candidate) === path.resolve(workspace)
      ? new Proxy(stat, { get: (target, property, receiver) => property === "uid" ? expectedUid : Reflect.get(target, property, receiver) })
      : stat;
  };
  const refused = await runReviewEvidence({
    attempt_id: "32323232-3232-4232-8232-323232323232", target_sha: SHA, cwd: workspace, execFileImpl, validateWrapperImpl: (wrapper) => wrapper,
    fsImpl: wrongOwnerFs,
    env: {
      SHU_REVIEW_EXEC_UID: String(expectedUid),
      SHU_REVIEW_EXEC_WRAPPER_JSON: JSON.stringify(["/test/confinement-wrapper"]),
      SHU_REVIEW_TEST_FILES_JSON: JSON.stringify(["uid.test.mjs"]),
      SHU_REVIEW_EVIDENCE_DIR: evidence,
    },
  });
  assert.equal(refused.executed, false, "a reviewer-identity-owned workspace violates the selected B-ii boundary");
});
