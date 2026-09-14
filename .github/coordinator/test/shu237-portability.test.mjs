import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReviewEvidence, validateReviewWrapper } from "../review-execution.mjs";

const SHA = "7".repeat(40);
const SUDO_ALIAS = "/usr/bin/sudo";
const SUDO_TARGET = "/usr/lib/cargo/bin/sudo";
const SANDBOX_ALIAS = "/usr/local/libexec/shu-reviewer-sandbox";
const SANDBOX_TARGET = "/usr/local/libexec/shu-reviewer-sandbox.real";

function fakeStat(kind, { uid = 0, mode = 0o755, symlink = false } = {}) {
  return {
    uid,
    mode,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => symlink,
  };
}

function safeWrapperFs({ realpaths = {}, stats = {} } = {}) {
  const baseRealpaths = {
    [SUDO_ALIAS]: SUDO_TARGET,
    [SANDBOX_ALIAS]: SANDBOX_TARGET,
  };
  const baseStats = {
    "/": fakeStat("directory"),
    "/usr": fakeStat("directory"),
    "/usr/lib": fakeStat("directory"),
    "/usr/lib/cargo": fakeStat("directory"),
    "/usr/lib/cargo/bin": fakeStat("directory"),
    "/usr/local": fakeStat("directory"),
    "/usr/local/libexec": fakeStat("directory"),
    [SUDO_ALIAS]: fakeStat("file", { symlink: true }),
    [SANDBOX_ALIAS]: fakeStat("file", { symlink: true }),
    [SUDO_TARGET]: fakeStat("file", { mode: 0o4755 }),
    [SANDBOX_TARGET]: fakeStat("file", { mode: 0o755 }),
  };
  const resolved = { ...baseRealpaths, ...realpaths };
  const metadata = { ...baseStats, ...stats };
  const fsImpl = Object.create(fs);
  fsImpl.realpathSync = (candidate) => {
    if (Object.hasOwn(resolved, candidate)) {
      if (resolved[candidate] instanceof Error) throw resolved[candidate];
      return resolved[candidate];
    }
    return fs.realpathSync(candidate);
  };
  fsImpl.lstatSync = (candidate) => Object.hasOwn(metadata, candidate)
    ? metadata[candidate]
    : fs.lstatSync(candidate);
  return fsImpl;
}

function privateTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function successfulReport(expectedUid, files = ["bound.test.mjs"]) {
  return {
    version: "1.0.0",
    target_sha: SHA,
    test_files: files,
    expected_uid: expectedUid,
    actual_uid: expectedUid,
    filesystem_probe: "DENIED",
    sibling_workspace_probe: "DENIED",
    workspace_write_probe: "DENIED",
    network_probe: "DENIED",
    forbidden_env_keys: [],
    tests: { executed: true, exit_code: 0, signal: null, stdout: "pass", stderr: "" },
  };
}

test("SHU-237 A1/A2/A5: real sudo-rs-style filesystem links resolve to immutable canonical argv", (t) => {
  const root = privateTemp("shu237-real-links-");
  const sudoAlias = path.join(root, "usr/bin/sudo");
  const sudoTarget = path.join(root, "usr/lib/cargo/bin/sudo");
  const sandboxAlias = path.join(root, "usr/local/libexec/shu-reviewer-sandbox");
  const sandboxTarget = path.join(root, "usr/local/libexec/shu-reviewer-sandbox.real");
  fs.mkdirSync(path.dirname(sudoAlias), { recursive: true });
  fs.mkdirSync(path.dirname(sudoTarget), { recursive: true });
  fs.mkdirSync(path.dirname(sandboxAlias), { recursive: true });
  fs.writeFileSync(sudoTarget, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(sandboxTarget, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
  fs.symlinkSync(path.relative(path.dirname(sudoAlias), sudoTarget), sudoAlias);
  fs.symlinkSync(path.basename(sandboxTarget), sandboxAlias);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fsImpl = Object.create(fs);
  fsImpl.lstatSync = (candidate) => {
    const stat = fs.lstatSync(candidate);
    const permissions = stat.isDirectory() ? 0o755 : stat.mode & 0o7777;
    return alteredStat(stat, { uid: 0, mode: (stat.mode & ~0o7777) | permissions });
  };
  const normalized = validateReviewWrapper([sudoAlias, "-n", sandboxAlias], fsImpl);
  assert.deepEqual(normalized, [fs.realpathSync(sudoTarget), "-n", fs.realpathSync(sandboxTarget)]);
  assert.equal(fs.lstatSync(sudoAlias).isSymbolicLink(), true, "the acceptance fixture must really contain a symlink");
  assert.equal(fs.lstatSync(sandboxAlias).isSymbolicLink(), true, "the sandbox fixture must really contain a symlink");
});

test("SHU-237 A1/A2/A5: sudo-rs and sandbox symlinks execute only their validated canonical targets", async (t) => {
  const root = privateTemp("shu237-canonical-");
  const attemptId = "23723723-7237-4237-8237-237237237001";
  const workspace = path.join(root, attemptId);
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(workspace, { mode: 0o755 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, "bound.test.mjs"), "// bound\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownUid = process.getuid?.() ?? 1000;
  const expectedUid = ownUid + 2000;
  const calls = [];
  const result = await runReviewEvidence({
    attempt_id: attemptId,
    target_sha: SHA,
    cwd: workspace,
    fsImpl: safeWrapperFs(),
    env: {
      SHU_REVIEW_EXEC_UID: String(expectedUid),
      SHU_REVIEW_EXEC_WRAPPER_JSON: JSON.stringify([SUDO_ALIAS, "-n", SANDBOX_ALIAS]),
      SHU_REVIEW_TEST_FILES_JSON: JSON.stringify(["bound.test.mjs"]),
      SHU_REVIEW_EVIDENCE_DIR: evidence,
    },
    execFileImpl: (file, args, _options, callback) => {
      calls.push({ file, args });
      queueMicrotask(() => callback(null, JSON.stringify(successfulReport(expectedUid)), ""));
    },
  });
  assert.equal(result.executed, true, result.detail);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, SUDO_TARGET, "the unresolved /usr/bin alias is never executed");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-n", SANDBOX_TARGET], "sudo receives the validated sandbox target");
});

test("SHU-237 A3/A4: wrapper resolution fails closed for unsafe targets and directory chains", () => {
  const cases = [
    ["non-root target", { stats: { [SUDO_TARGET]: fakeStat("file", { uid: 1234 }) } }, /root-owned/],
    ["writable target", { stats: { [SUDO_TARGET]: fakeStat("file", { mode: 0o775 }) } }, /root-owned/],
    ["non-executable target", { stats: { [SUDO_TARGET]: fakeStat("file", { mode: 0o644 }) } }, /executable/],
    ["non-regular target", { stats: { [SUDO_TARGET]: fakeStat("directory") } }, /regular file/],
    ["unresolved target symlink", { stats: { [SUDO_TARGET]: fakeStat("file", { symlink: true }) } }, /regular file/],
    ["writable canonical parent", { stats: { "/usr/lib/cargo": fakeStat("directory", { mode: 0o777 }) } }, /directory chain/],
    ["non-root canonical parent", { stats: { "/usr/lib": fakeStat("directory", { uid: 1234 }) } }, /directory chain/],
    ["broken link", { realpaths: { [SUDO_ALIAS]: Object.assign(new Error("missing"), { code: "ENOENT" }) } }, /must resolve/],
    ["cyclic link", { realpaths: { [SUDO_ALIAS]: Object.assign(new Error("loop"), { code: "ELOOP" }) } }, /must resolve/],
    ["unsafe sandbox target", { stats: { [SANDBOX_TARGET]: fakeStat("file", { uid: 1234 }) } }, /root-owned/],
  ];
  for (const [name, changes, pattern] of cases) {
    assert.throws(
      () => validateReviewWrapper([SUDO_ALIAS, "-n", SANDBOX_ALIAS], safeWrapperFs(changes)),
      pattern,
      name,
    );
  }
  assert.throws(
    () => validateReviewWrapper([SUDO_ALIAS, "-n", SANDBOX_ALIAS, "--extra"], safeWrapperFs()),
    /fixed noninteractive/,
  );
  const renamedSudo = "/usr/lib/cargo/bin/sudo-rs";
  assert.throws(
    () => validateReviewWrapper([SUDO_ALIAS, "--preserve-env"], safeWrapperFs({
      realpaths: { [SUDO_ALIAS]: renamedSudo },
      stats: { [renamedSudo]: fakeStat("file", { mode: 0o4755 }) },
    })),
    /fixed noninteractive/,
    "the configured sudo alias keeps the fixed form even when its package target has another basename",
  );
});

function alteredStat(stat, overrides) {
  return new Proxy(stat, {
    get(target, property, receiver) {
      return Object.hasOwn(overrides, property) ? overrides[property] : Reflect.get(target, property, receiver);
    },
  });
}

async function ownershipRun({ attempt, childUid, childMode = 0o644, workspaceUid, workspaceMode = 0o755 }) {
  const root = privateTemp(`shu237-owner-${attempt}-`);
  const attemptId = `23723723-7237-4237-8237-${String(attempt).padStart(12, "0")}`;
  const workspace = path.join(root, attemptId);
  const evidence = path.join(root, "evidence");
  const child = path.join(root, "review-execution-child.mjs");
  fs.mkdirSync(workspace, { mode: 0o755 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  fs.writeFileSync(child, "// trusted child\n", { mode: 0o644 });
  fs.writeFileSync(path.join(workspace, "bound.test.mjs"), "// bound\n");
  const ownUid = 991;
  const expectedUid = 992;
  let executions = 0;
  const fsImpl = Object.create(fs);
  fsImpl.lstatSync = (candidate) => {
    const stat = fs.lstatSync(candidate);
    if (path.resolve(candidate) === path.resolve(child)) {
      return alteredStat(stat, { uid: childUid, mode: (stat.mode & ~0o7777) | childMode });
    }
    if (path.resolve(candidate) === path.resolve(workspace)) {
      return alteredStat(stat, { uid: workspaceUid, mode: (stat.mode & ~0o7777) | workspaceMode });
    }
    if (path.resolve(candidate) === path.resolve(evidence)) return alteredStat(stat, { uid: ownUid });
    return stat;
  };
  const result = await runReviewEvidence({
    attempt_id: attemptId,
    target_sha: SHA,
    cwd: workspace,
    childPath: child,
    ownUid,
    fsImpl,
    validateWrapperImpl: (wrapper) => wrapper,
    env: {
      SHU_REVIEW_EXEC_UID: String(expectedUid),
      SHU_REVIEW_EXEC_WRAPPER_JSON: JSON.stringify(["/test/wrapper"]),
      SHU_REVIEW_TEST_FILES_JSON: JSON.stringify(["bound.test.mjs"]),
      SHU_REVIEW_EVIDENCE_DIR: evidence,
    },
    execFileImpl: (_file, _args, _options, callback) => {
      executions += 1;
      queueMicrotask(() => callback(null, JSON.stringify(successfulReport(expectedUid)), ""));
    },
  });
  fs.rmSync(root, { recursive: true, force: true });
  return { result, executions };
}

test("SHU-237 A6: root-owned and coordinator-owned child/workspace pairs are trusted", async () => {
  const rootOwned = await ownershipRun({ attempt: 1, childUid: 0, workspaceUid: 0 });
  assert.equal(rootOwned.result.executed, true, rootOwned.result.detail);
  assert.equal(rootOwned.executions, 1);
  const coordinatorOwned = await ownershipRun({ attempt: 2, childUid: 991, workspaceUid: 991 });
  assert.equal(coordinatorOwned.result.executed, true, coordinatorOwned.result.detail);
  assert.equal(coordinatorOwned.executions, 1);
});

test("SHU-237 A7: reviewer/unrelated ownership and writable control-plane objects fail before execution", async () => {
  const cases = [
    ["reviewer-owned child", { childUid: 992, workspaceUid: 991 }],
    ["unrelated-owned child", { childUid: 777, workspaceUid: 991 }],
    ["group-writable child", { childUid: 0, childMode: 0o664, workspaceUid: 991 }],
    ["reviewer-owned workspace", { childUid: 991, workspaceUid: 992 }],
    ["unrelated-owned workspace", { childUid: 991, workspaceUid: 777 }],
    ["world-writable workspace", { childUid: 991, workspaceUid: 0, workspaceMode: 0o757 }],
  ];
  let attempt = 10;
  for (const [name, shape] of cases) {
    const { result, executions } = await ownershipRun({ attempt, ...shape });
    attempt += 1;
    assert.equal(result.executed, false, name);
    assert.equal(result.reason_code, "REVIEW_EXECUTION_UNAVAILABLE", name);
    assert.match(result.detail, /root\/coordinator-owned/, name);
    assert.equal(executions, 0, `${name} must fail before the wrapper starts`);
  }
});
