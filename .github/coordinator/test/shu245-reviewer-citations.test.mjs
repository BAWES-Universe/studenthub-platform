import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchBuilder, validateCallback } from "../adapters/claude-code.mjs";

const ATTEMPT = "75a8514f-2257-4cb0-82ff-8cb02ffc0002";
const SHA = "35f497efb98776d5591f0c8a48bb37d57d185f4d";
const SOURCE_PATHS = [
  "tools/fixture/scan-vacuous.mjs",
  "tools/fixture/test/scan-vacuous.test.mjs",
  "tools/fixture-conformance/scan-vacuous.expectations.mjs",
  "tools/fixture-conformance/README.md",
];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu245-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const evidence = path.join(root, "reviewer-evidence");
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  for (const sourcePath of SOURCE_PATHS) {
    const absolute = path.join(workspace, sourcePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `fixture for ${sourcePath}\n`);
  }
  const reportPath = path.join(evidence, `${ATTEMPT}.review-test.1.json`);
  const report = {
    version: "1.0.0", target_sha: SHA, test_files: [SOURCE_PATHS[1]],
    expected_uid: 994, actual_uid: 994, filesystem_probe: "DENIED",
    sibling_workspace_probe: "DENIED", workspace_write_probe: "DENIED",
    network_probe: "DENIED", forbidden_env_keys: [],
    tests: { executed: true, exit_code: 0, signal: null, stdout: "8 tests passed", stderr: "" },
  };
  fs.writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
  return { workspace, evidence, reportPath, report };
}

function runFiveCallback(f, over = {}) {
  return {
    attempt_id: ATTEMPT,
    target_sha: SHA,
    stage: "PASS",
    links: [
      pathToFileURL(f.reportPath).href,
      ...SOURCE_PATHS.map((sourcePath) => `${sourcePath}@${SHA}`),
    ],
    summary: "The exact revised head passes the confined reviewer tests.",
    ...over,
  };
}

function context(f) {
  return { attempt_id: ATTEMPT, target_sha: SHA, cwd: f.workspace, evidence_dir: f.evidence };
}

function envelope(callback) {
  return JSON.stringify({
    type: "result", subtype: "success", is_error: false, session_id: ATTEMPT,
    structured_output: callback,
    result: JSON.stringify(callback),
  });
}

test("SHU-245 A1: Run #5 file evidence plus exact path@sha citations produces the bound PASS", async (t) => {
  const f = fixture(t);
  const callback = runFiveCallback(f);
  assert.match(callback.links[1], /^tools\/fixture\/scan-vacuous\.mjs@35f497ef/, "the regression must contain Run #5's non-URL citation before launch");
  assert.throws(() => new URL(callback.links[1]), "the regression citation must remain non-URL evidence");

  let launches = 0;
  const result = await launchBuilder({
    issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    attempt_id: ATTEMPT, target_sha: SHA, task_context: "Review the revised fixture head.",
    oauth_token: "subscription-oauth", cwd: f.workspace,
    env: { PATH: process.env.PATH, SHU_REVIEW_EVIDENCE_DIR: f.evidence },
    readHeadImpl: async () => SHA,
    reviewEvidenceImpl: async () => ({
      executed: true, passed: true, reason_code: "REVIEW_TESTS_PASSED",
      evidence_link: pathToFileURL(f.reportPath).href, report: f.report,
    }),
    persistEnvelopeImpl: () => ({ link: pathToFileURL(path.join(f.evidence, "envelope.stdout")).href }),
    execFileImpl: (_file, _args, _options, done) => {
      launches += 1;
      queueMicrotask(() => done(null, envelope(callback), ""));
    },
  });

  assert.equal(launches, 1, "the retained Run #5 envelope shape must traverse the real adapter launch path");
  assert.equal(result.reason_code, undefined, result.reason);
  assert.equal(result.stage, "COMPLETED", result.reason);
  assert.equal(result.callback.stage, "PASS");
  assert.equal(result.callback.attempt_id, ATTEMPT);
  assert.equal(result.callback.target_sha, SHA);
  assert.deepEqual(result.evidence_links, callback.links, "source citations survive byte-for-byte into the accepted result");
});

test("SHU-245 A2: exact attempt and exact head binding cannot be widened", (t) => {
  const f = fixture(t);
  const wrongAttempt = validateCallback(runFiveCallback(f, {
    attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  }), context(f));
  assert.equal(wrongAttempt.valid, false, "foreign attempt must fail closed");
  assert.equal(wrongAttempt.field, "attempt_id");

  const wrongHead = validateCallback(runFiveCallback(f, { target_sha: "b".repeat(40) }), context(f));
  assert.equal(wrongHead.valid, false, "foreign callback head must fail closed");
  assert.equal(wrongHead.field, "target_sha");
});

test("SHU-245 A3: canonical machine file evidence remains mandatory and non-vacuous", (t) => {
  const f = fixture(t);
  const sourceOnly = runFiveCallback(f, { links: SOURCE_PATHS.map((sourcePath) => `${sourcePath}@${SHA}`) });
  assert.equal(sourceOnly.links.some((link) => link.startsWith("file:")), false, "control must actually omit file evidence");
  const missingFile = validateCallback(sourceOnly, context(f));
  assert.equal(missingFile.valid, false, "source citations cannot substitute for machine execution evidence");
  assert.equal(missingFile.field, "links");
  assert.match(missingFile.detail, /machine evidence/);

  const empty = validateCallback(runFiveCallback(f, { links: [] }), context(f));
  assert.equal(empty.valid, false, "empty evidence must fail closed");
  assert.equal(empty.field, "links");
});

test("SHU-245 A4: malformed, unsafe, missing, and foreign-head source citations fail closed", (t) => {
  const f = fixture(t);
  const fileEvidence = pathToFileURL(f.reportPath).href;
  const gitConfig = path.join(f.workspace, ".git", "config");
  fs.mkdirSync(path.dirname(gitConfig), { recursive: true });
  fs.writeFileSync(gitConfig, "hostile fixture\n");
  const linked = path.join(f.workspace, "linked-source.mjs");
  fs.symlinkSync(path.join(f.workspace, SOURCE_PATHS[0]), linked);
  const cases = [
    ["plain prose", "malformed citation"],
    [`${SOURCE_PATHS[0]}@${"b".repeat(40)}`, "foreign cited head"],
    [`../outside.mjs@${SHA}`, "parent traversal"],
    [`/etc/passwd@${SHA}`, "absolute path"],
    [`.git/config@${SHA}`, "git control path"],
    [`missing.mjs@${SHA}`, "missing source"],
    [`linked-source.mjs@${SHA}`, "symlinked source"],
    [`tools/%2e%2e/secret@${SHA}`, "encoded traversal"],
    [`${SOURCE_PATHS[0]}@not-a-sha`, "malformed head"],
  ];
  for (const [citation, label] of cases) {
    const links = [fileEvidence, citation];
    assert.equal(links[0].startsWith("file:"), true, `${label}: control includes mandatory file evidence`);
    const checked = validateCallback(runFiveCallback(f, { links }), context(f));
    assert.equal(checked.valid, false, `${label} must fail closed`);
    assert.equal(checked.field, "links[1]", `${label} must identify the hostile citation`);
  }
});
