import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  callbackValid,
  launchBuilder,
  validateCallback,
} from "../adapters/claude-code.mjs";
import { createReceipt, foldLaunchOutcome } from "../reconcile.mjs";
import { routeSuccessorFromReceipts } from "../review-routing.mjs";

const ATTEMPT = "24024024-0240-4240-8240-240240240240";
const WRITER_ATTEMPT = "24024024-0240-4240-8240-240240240241";
const SHA = "a".repeat(40);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu240-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, ATTEMPT);
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(workspace, { mode: 0o750 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  const source = path.join(workspace, "source.mjs");
  const reportPath = path.join(evidence, `${ATTEMPT}.review-test.1.json`);
  fs.writeFileSync(source, "export const value = 1;\n");
  const report = {
    version: "1.0.0", target_sha: SHA, test_files: ["source.mjs"],
    expected_uid: 994, actual_uid: 994, workspace_uid: process.getuid?.() ?? 1000,
    filesystem_probe: "DENIED", sibling_workspace_probe: "DENIED",
    workspace_write_probe: "DENIED", network_probe: "DENIED", forbidden_env_keys: [],
    tests: { executed: true, exit_code: 0, signal: null, stdout: "one test passed", stderr: "" },
  };
  fs.writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
  return { root, workspace, evidence, source, reportPath, report };
}

function callback(stage, links, over = {}) {
  return { attempt_id: ATTEMPT, target_sha: SHA, stage, links, ...over };
}

function output({ structured, result }) {
  const envelope = { type: "result", subtype: "success", is_error: false, session_id: ATTEMPT };
  if (structured !== undefined) envelope.structured_output = structured;
  if (result !== undefined) envelope.result = typeof result === "string" ? result : JSON.stringify(result);
  return JSON.stringify(envelope);
}

function launch(f, stdout) {
  const calls = [];
  const execFileImpl = (_file, args, _options, done) => {
    calls.push(args);
    queueMicrotask(() => done(null, stdout, ""));
  };
  return {
    calls,
    result: launchBuilder({
      issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
      attempt_id: ATTEMPT, target_sha: SHA, task_context: "Review the exact fixture head.",
      oauth_token: "subscription-oauth", cwd: f.workspace,
      env: { PATH: process.env.PATH, SHU_REVIEW_EVIDENCE_DIR: f.evidence },
      readHeadImpl: async () => SHA,
      reviewEvidenceImpl: async () => ({
        executed: true, passed: true, reason_code: "REVIEW_TESTS_PASSED",
        evidence_link: pathToFileURL(f.reportPath).href, report: f.report,
      }),
      persistEnvelopeImpl: () => ({ link: pathToFileURL(path.join(f.evidence, "envelope.stdout")).href }),
      execFileImpl,
    }),
  };
}

test("SHU-240 A1: prompt-supplied local evidence binds and BLOCKED routes to the same writer", async (t) => {
  const f = fixture(t);
  const links = [pathToFileURL(f.reportPath).href, `${pathToFileURL(f.source).href}#L1`];
  const run = launch(f, output({ structured: callback("BLOCKED", links) }));
  const adapter = await run.result;
  assert.equal(adapter.stage, "HOLD", "BLOCKED is a routable verdict, never success");
  assert.ok(adapter.callback, adapter.reason);
  assert.equal(adapter.callback.stage, "BLOCKED", adapter.reason);
  assert.deepEqual(adapter.evidence_links, links);

  const made = createReceipt({
    issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    requested_worker: "claude-verifier", repo: "BAWES-Universe/studenthub-platform",
    branch: "coordinator/SHU-140", target_sha: SHA, attempt_id: ATTEMPT,
  });
  assert.equal(made.ok, true);
  const writer = {
    ...made.receipt,
    attempt_id: WRITER_ATTEMPT,
    requested_worker: "codex-builder",
    stage: "COMPLETED",
    worker_identity: "codex:fixture-writer",
    external_run_id: "codexrun_fixturewriter",
    adapter_status: "completed",
    verdict_stage: "BUILD_READY",
    result_sha: SHA,
  };
  const folded = foldLaunchOutcome(made.receipt, adapter, { current_head: SHA, lineage: [writer] });
  assert.equal(folded.accepted, true);
  assert.equal(folded.receipt.verdict_stage, "BLOCKED", "the valid BLOCK survives receipt folding");
  const routed = routeSuccessorFromReceipts({
    issueReceipts: [writer, folded.receipt], terminal: folded.receipt,
    evidenceStage: folded.receipt.verdict_stage, authoritativeHead: SHA, max_revise: 3,
  });
  assert.equal(routed.ok, true, routed.reason);
  assert.equal(routed.order.role, "revise");
  assert.equal(routed.order.requested_worker, "codex-builder", "revision returns to the active writer lane");
});

test("SHU-240 A2: outside, symlinked, and traversal file evidence is refused by the named link field", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside.txt");
  fs.writeFileSync(outside, "outside");
  const symlink = path.join(f.workspace, "linked.txt");
  fs.symlinkSync(f.source, symlink);
  const context = { attempt_id: ATTEMPT, target_sha: SHA, cwd: f.workspace, evidence_dir: f.evidence };
  for (const link of [
    pathToFileURL(outside).href,
    pathToFileURL(symlink).href,
    `file://${f.workspace}/nested/../source.mjs`,
  ]) {
    const checked = validateCallback(callback("BLOCKED", [link]), context);
    assert.equal(checked.valid, false, `${link} must not bind`);
    assert.equal(checked.field, "links[0]", "diagnosis names the rejected callback field");
  }
});

test("SHU-240 A3: existing HTTPS GitHub and Linear evidence still binds", () => {
  assert.equal(callbackValid(callback("PASS", [
    "https://github.com/BAWES-Universe/studenthub-platform/pull/82",
    "https://linear.app/bawes/issue/SHU-240/example",
  ]), { attempt_id: ATTEMPT, target_sha: SHA }), true);
});

test("SHU-240 A6: either valid envelope field binds; invalid fields are named", async (t) => {
  const f = fixture(t);
  const link = pathToFileURL(f.reportPath).href;
  const good = callback("PASS", [link]);
  const invalidStructured = callback("PASS", [link], { attempt_id: "wrong" });
  const invalidResult = callback("PASS", [link], { target_sha: "b".repeat(40) });

  const fromResult = await launch(f, output({ structured: invalidStructured, result: good })).result;
  assert.equal(fromResult.stage, "COMPLETED", fromResult.reason);
  const fromStructured = await launch(f, output({ structured: good, result: invalidResult })).result;
  assert.equal(fromStructured.stage, "COMPLETED", fromStructured.reason);

  const neither = await launch(f, output({ structured: invalidStructured, result: invalidResult })).result;
  assert.equal(neither.reason_code, "CALLBACK_BINDING_INVALID");
  assert.match(neither.reason, /structured_output\.attempt_id/);
  assert.match(neither.reason, /result\.target_sha/);

  const prose = await launch(f, output({ result: "looks good" })).result;
  assert.equal(prose.reason_code, "NO_STRUCTURED_OUTPUT");
  assert.match(prose.reason, /structured_output/);
  assert.match(prose.reason, /result/);
});

test("SHU-240 A7/A8: trusted evidence is inline and private URI is never presented as readable", async (t) => {
  const f = fixture(t);
  const adapter = launch(f, output({ structured: callback("PASS", [pathToFileURL(f.reportPath).href]) }));
  const result = await adapter.result;
  assert.equal(result.stage, "COMPLETED", result.reason);
  const prompt = adapter.calls[0].at(-1);
  assert.match(prompt, /machine provenance only; do not Read/);
  assert.match(prompt, /trusted evidence payload included in this prompt/i);
  assert.ok(prompt.includes(JSON.stringify(f.report)), "the exact trusted report is available without a file-tool read");
  assert.doesNotMatch(prompt, /Inspect the supplied evidence reference/);
  const args = adapter.calls[0];
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "Read,Glob,Grep"]);
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.deepEqual(args.slice(args.indexOf("--disallowedTools"), args.indexOf("--disallowedTools") + 2), ["--disallowedTools", "mcp__*"]);
  assert.equal(args.includes("--bare"), false);
});
