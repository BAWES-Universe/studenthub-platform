import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { LANE_NAMES, RUNTIMES, ROLES, laneForRuntimeRole, resolveReceiptRoleAuthority } from "../launch-vocabulary.mjs";
import { createReceipt, validateReceipt, receiptCommentBody, parseReceiptCommentBody, adapterNameFor, parseReceiptsFromComments, preparedLaunchOptions } from "../reconcile.mjs";
import { validWorkOrder, reviewVerdictProvenanceValid, routeSuccessorFromReceipts } from "../review-routing.mjs";
import { initialWorkspaceScope, normalizeReceiptWorkspaceScope } from "../workspace-scope.mjs";
import { deriveScopedBaseCommit, prepareAttemptWorkspace } from "../attempt-workspace.mjs";
import { CapacityScheduler } from "../capacity-scheduler.mjs";
import * as claude from "../adapters/claude-code.mjs";

const SHA = "a".repeat(40), RESULT = "b".repeat(40), ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const root = path.resolve(".shu249-tmp");
fs.mkdirSync(root, { recursive: true });
const fixtureLane = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url))).fixture_lane;
const base = { receipt_version: "1.1.0", issue_id: "SHU-249", authorization_ref: "SHU-249", repo: "BAWES-Universe/studenthub-platform", branch: "test/shu249", target_sha: SHA, attempt_id: ID, reserved_at: "2026-09-13T00:00:00.000Z" };
function receipt(role = "build", runtime = "claude-code", extra = {}) {
  const made = createReceipt({ ...base, role, runtime, requested_worker: laneForRuntimeRole(runtime, role), ...extra });
  assert.equal(made.ok, true, made.errors?.join("; "));
  return made.receipt;
}
function temp(t) { const dir = fs.mkdtempSync(path.join(root, "case-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

for (const runtime of RUNTIMES) for (const role of ROLES) test(`SHU-249 A1: ${runtime}/${role} reserves capacity and a valid work order`, (t) => {
  const r = receipt(role, runtime), stateDir = temp(t);
  assert.equal(resolveReceiptRoleAuthority(r).role, role, "SHU-249 A1 trusted revise role must not be re-keyed to the lane default");
  assert.equal(validateReceipt(r).valid, true);
  assert.equal(validWorkOrder({ ...r, version: "1.0.0" }).ok, true);
  assert.equal(adapterNameFor(r.requested_worker), runtime);
  const scheduler = new CapacityScheduler({ stateDir, policy: { global_limit: 2, review_reserve: 1, hosts: { local: 2 }, accounts: { account: 2 }, runtimes: { [runtime]: 2 }, budget_micros: 100, max_deadline_ms: 10000, max_retries: 1, max_revisions: 3, reservation_ttl_ms: 1000 } });
  const task = { task_id: role, role, runtime, host: "local", account: "account", repo: r.repo, branch: r.branch, worktree: path.join(stateDir, "work"), overlap_keys: [], blocked_by: [], estimated_cost_micros: 1, deadline_ms: 1000, retry: 0, revision: 0, priority: 1 };
  assert.equal(scheduler.reserve(task).ok, true);
  if (role !== "review") assert.equal(scheduler.reserve({ ...task, task_id: "second", worktree: path.join(stateDir, "second") }).ok, false, "one writer per branch remains enforced");
});

test("SHU-249 A2: lane-derived role cannot replace required receipt authority", async () => {
  const r = receipt(); delete r.role;
  assert.equal(validateReceipt(r).valid, false, "SHU-249 A2 missing authoritative role must be refused");
  await assert.rejects(preparedLaunchOptions("claude-code", r, {}, {}), /requires an authoritative role/);
  assert.equal(resolveReceiptRoleAuthority({ ...r, receipt_version: "1.0.0", runtime: undefined }).ok, false);
  assert.throws(() => adapterNameFor("unknown"), /refusing to default/);
});

test("SHU-249 A3: Claude author and its revision cannot PASS their own lineage", () => {
  const author = { ...receipt(), worker_identity: "claude:author", result_sha: RESULT, verdict_stage: "BUILD_READY" };
  const revision = { ...receipt("revise"), worker_identity: "claude:author", result_sha: RESULT, verdict_stage: "REVISION_READY" };
  const review = { ...receipt("review"), worker_identity: "claude:author", target_sha: RESULT };
  assert.equal(reviewVerdictProvenanceValid(review, [author, revision]).ok, false, "SHU-249 A3 role-aware author exclusion must reject Claude self-review");
  assert.equal(reviewVerdictProvenanceValid({ ...review, worker_identity: "claude:fresh" }, [author, revision]).ok, false, "fresh session cannot evade author-family exclusion");
  const independent = { ...receipt("review", "codex-cli"), worker_identity: "codex:independent", target_sha: RESULT };
  assert.equal(reviewVerdictProvenanceValid(independent, [author, revision]).ok, true);
  assert.equal(routeSuccessorFromReceipts({ terminal: review, issueReceipts: [author, revision, review], evidenceStage: "PASS" }).ok, false);
});

test("SHU-249 A4: Hermes gets a scoped workspace and cannot claim review scope", (t) => {
  const dir = temp(t), git = (cwd, ...args) => execFileSync("git", ["-c", `safe.directory=${cwd}`, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const seed = path.join(dir, "seed"); fs.mkdirSync(seed); git(seed, "init"); git(seed, "config", "user.name", "Fixture"); git(seed, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(seed, "allowed.txt"), "allowed\n"); fs.writeFileSync(path.join(seed, "hidden.txt"), "hidden\n"); git(seed, "add", "."); git(seed, "commit", "-m", "fixture");
  const sha = git(seed, "rev-parse", "HEAD"), scoped = deriveScopedBaseCommit({ source: seed, target_sha: sha, allowed_paths: ["allowed.txt"] });
  const remote = path.join(dir, "BAWES-Universe", "studenthub-platform.git"); fs.mkdirSync(path.dirname(remote)); git(seed, "clone", "--bare", seed, remote);
  const work = path.join(dir, "work"), state = path.join(dir, "state"); fs.mkdirSync(work); fs.chmodSync(work, 0o3770); fs.mkdirSync(state, { mode: 0o700 });
  const wrapper = path.join(dir, "wrapper"); fs.writeFileSync(wrapper, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
  // Transport test: emulate the ownership reported by a distinct-UID wrapper.
  // Actual UID isolation remains covered by the existing host integration tests.
  const uid = process.getuid() + 1, realStat = fs.statSync;
  const statMock = mock.method(fs, "statSync", (name, ...args) => { const stat = realStat(name, ...args); if (String(name).startsWith(work + path.sep)) stat.uid = uid; return stat; });
  t.after(() => statMock.mock.restore());
  const r = receipt("build", "hermes-pool", { target_sha: sha, workspace_scope: "scoped", scope_phase: "initial", allowed_paths: ["allowed.txt"], scoped_base_sha: scoped });
  const env = { ...process.env, SHU_WORKTREE_ROOT: work, SHU_WORKSPACE_STATE_DIR: state, SHU_PUSH_REMOTE_URL: `file://${remote}`, SHU_WORKER_UID: String(uid), SHU_WORKER_LAUNCH_WRAPPER: wrapper };
  let result, error; try { result = prepareAttemptWorkspace({ receipt: r, env, allowedHost: "file" }); } catch (e) { error = e; }
  assert.equal(error, undefined, `SHU-249 A4 every vocabulary lane must obtain its bound workspace: ${error?.message}`);
  assert.equal(git(result.cwd, "rev-parse", "HEAD"), scoped); assert.equal(fs.existsSync(path.join(result.cwd, "hidden.txt")), false);
  assert.throws(() => prepareAttemptWorkspace({ receipt: { ...r, workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null }, env }), /writer checkout cannot use review scope/);
});

test("SHU-249 A5: trusted lane disagreement HOLDs without fallback", () => {
  const r = { ...receipt(), role: "review" };
  const authority = resolveReceiptRoleAuthority(r);
  assert.equal(authority.ok, false, "SHU-249 A5 role disagreement must HOLD without silent fallback");
  assert.equal(authority.conflict, true); assert.match(authority.reason, /HOLD, no silent fallback/);
  assert.equal(validateReceipt(r).valid, false);
  assert.equal(routeSuccessorFromReceipts({ terminal: r }).hold, "role_authority_invalid");
  assert.equal(validateReceipt({ ...receipt(), runtime: "codex-cli" }).valid, false);
});

test("SHU-249 A6: build defaults are scoped/initial and review defaults full/review", () => {
  for (const runtime of RUNTIMES) for (const role of ROLES) {
    const requestedWorker = laneForRuntimeRole(runtime, role);
    const generic = initialWorkspaceScope({ requestedWorker, role, allowedPaths: ["approved.txt"] });
    assert.deepEqual([generic.workspace_scope, generic.scope_phase], role === "review" ? ["full", "review"] : ["scoped", "initial"], "SHU-249 A6 scope defaults must follow the trusted role");
    const scope = initialWorkspaceScope({ issueId: fixtureLane.id, requestedWorker, role, fixtureLane });
    assert.deepEqual([scope.workspace_scope, scope.scope_phase], role === "review" ? ["full", "review"] : ["scoped", "initial"], "SHU-249 A6 scope defaults must follow the trusted role");
    const r = receipt(role, runtime); for (const field of ["workspace_scope", "scope_phase", "allowed_paths", "scoped_base_sha"]) delete r[field];
    assert.equal(normalizeReceiptWorkspaceScope(r).scope.scope_phase, role === "review" ? "review" : "initial");
  }
});

test("SHU-249 A7: legacy bytes and exact version 1.1.0 schema survive durable replay", () => {
  const legacy = createReceipt({ ...base, receipt_version: "1.0.0", requested_worker: "hermes-box" }).receipt;
  const bytes = receiptCommentBody(legacy); assert.equal(receiptCommentBody(parseReceiptCommentBody(bytes)), bytes);
  const modern = receipt("build", "hermes-pool");
  assert.deepEqual(modern, { ...legacy, receipt_version: "1.1.0", role: "build", runtime: "hermes-pool" });
  assert.deepEqual(parseReceiptsFromComments([{ body: receiptCommentBody(modern) }]), [modern]);
  const schema = JSON.parse(fs.readFileSync(new URL("../receipt-schema.json", import.meta.url)));
  assert.deepEqual(schema.properties.receipt_version, { type: "string", enum: ["1.0.0", "1.1.0"] });
  assert.deepEqual(schema.properties.requested_worker.enum, [...LANE_NAMES]);
  for (const field of ["role", "runtime"]) assert.equal(validateReceipt({ ...legacy, [field]: null }).valid, false);
});

test("SHU-249 A8: Claude writer launches with role-bound scope and broker-owned output", async () => {
  for (const role of ["build", "revise"]) {
    let launched = false, brokered = false, reviewed = false;
    const result = await claude.launchBuilder({ ...base, role, workspace_scope: "scoped", scope_phase: role === "revise" ? "revision" : "initial", allowed_paths: ["allowed.txt"], scoped_base_sha: RESULT,
      oauth_token: "fixture-token", cwd: root, env: { SHU_WORKER_LAUNCH_WRAPPER: "fixture-wrapper", SHU_WORKER_UID: String(process.getuid() + 1) },
      readHeadImpl: async () => RESULT, reviewEvidenceImpl: async () => { reviewed = true; }, persistEnvelopeImpl: () => ({ link: "file:///fixture-envelope" }),
      execFileImpl: (bin, args, options, cb) => { launched = true; assert.equal(bin, "fixture-wrapper"); assert.ok(args.includes("claude")); assert.ok(args.includes("Read,Glob,Grep,Write,Edit")); cb(null, JSON.stringify({ type: "result", session_id: ID, structured_output: { attempt_id: ID, target_sha: SHA, result_sha: null, stage: role === "revise" ? "REVISION_READY" : "BUILD_READY", links: ["allowed.txt"] } }), ""); },
      io: { pushBrokerImpl: async (input) => { brokered = true; assert.equal(input.workspaceReady, true); assert.deepEqual(input.allowed_paths, ["allowed.txt"]); return { ok: true, remote_head: RESULT }; } },
    });
    assert.equal(result.stage, "COMPLETED", result.reason); assert.equal(result.callback.result_sha, RESULT); assert.ok(launched && brokered); assert.equal(reviewed, false);
  }
  const mismatch = await claude.launchBuilder({ ...base, role: "build", workspace_scope: "full", scope_phase: "review" });
  assert.equal(mismatch.stage, "HOLD");
});
