// Reviewer exact-head test evidence. Builder-authored code is executed only
// through a host-configured confinement wrapper. The wrapper is not trusted by
// declaration: a single child invocation proves the effective uid, inability to
// read a coordinator-private sentinel, inability to connect to a live loopback
// listener, absence of secret-bearing environment keys, and then runs node --test.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "review-execution-child.mjs");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const SENSITIVE_KEY = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|SSH|GITHUB|LINEAR|ANTHROPIC|CLAUDE)/i;
const TOKEN_SHAPE = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})/;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

function runExecFile(execFileImpl, file, args, options) {
  return new Promise((resolve) => {
    execFileImpl(file, args, options, (error, stdout = "", stderr = "") => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function privateDirectory(dir, { fsImpl = fs, ownUid = process.getuid?.() } = {}) {
  if (!path.isAbsolute(dir ?? "")) throw new Error("review evidence directory must be absolute");
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fsImpl.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== ownUid) {
    throw new Error("review evidence directory must be coordinator-owned and private (0700)");
  }
  const resolved = fsImpl.realpathSync(dir);
  if (resolved !== path.resolve(dir)) throw new Error("review evidence directory must not resolve through a symlink");
  return resolved;
}

export function reviewTestFiles(env = {}) {
  let files;
  try { files = JSON.parse(env.SHU_REVIEW_TEST_FILES_JSON ?? ""); }
  catch { throw new Error("SHU_REVIEW_TEST_FILES_JSON must be a JSON array"); }
  if (!Array.isArray(files) || files.length === 0 || files.length > 32) {
    throw new Error("SHU_REVIEW_TEST_FILES_JSON must name 1..32 test files");
  }
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0 || path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || !/\.test\.(?:m?js|cjs)$/.test(file)) {
      throw new Error("review test files must be safe relative *.test.js/*.test.mjs paths");
    }
  }
  return files;
}

export function reviewWrapper(env = {}) {
  let wrapper;
  try { wrapper = JSON.parse(env.SHU_REVIEW_EXEC_WRAPPER_JSON ?? ""); }
  catch { throw new Error("SHU_REVIEW_EXEC_WRAPPER_JSON must be a JSON argv array"); }
  if (!Array.isArray(wrapper) || wrapper.length === 0 || wrapper.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error("SHU_REVIEW_EXEC_WRAPPER_JSON must be a non-empty JSON argv array");
  }
  if (!path.isAbsolute(wrapper[0])) throw new Error("review execution wrapper must use an absolute executable path");
  return wrapper;
}

export function buildReviewExecutionEnvironment(_parentEnv = {}) {
  const clean = {
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  return clean;
}

function trustedHostFile(file, fsImpl = fs) {
  const stat = fsImpl.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error("review execution wrapper must be a root-owned, non-writable regular file");
  }
}

export function validateReviewWrapper(wrapper, fsImpl = fs) {
  trustedHostFile(wrapper[0], fsImpl);
  if (path.basename(wrapper[0]) === "sudo") {
    if (wrapper[1] !== "-n" || !path.isAbsolute(wrapper[2] ?? "")) {
      throw new Error("sudo review wrapper must be the fixed noninteractive command form");
    }
    trustedHostFile(wrapper[2], fsImpl);
  }
}

function listenProbe() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function artifactPath(dir, attemptId, kind, fsImpl = fs) {
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    const candidate = path.join(dir, `${attemptId}.${kind}.${sequence}.json`);
    try {
      const fd = fsImpl.openSync(candidate, "wx", 0o600);
      return { candidate, fd };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("review evidence artifact sequence exhausted");
}

function persistEvidence(dir, attemptId, report, fsImpl = fs, sensitiveValues = []) {
  const bytes = Buffer.from(JSON.stringify(report));
  if (bytes.length > MAX_EVIDENCE_BYTES) throw new Error("review test evidence exceeds the size limit");
  const text = bytes.toString("utf8");
  if (TOKEN_SHAPE.test(text) || sensitiveValues.some((secret) => text.includes(secret))) {
    throw new Error("review test evidence contains credential-shaped or environment-secret material");
  }
  const { candidate, fd } = artifactPath(dir, attemptId, "review-test", fsImpl);
  try { fsImpl.writeFileSync(fd, bytes); }
  finally { fsImpl.closeSync(fd); }
  fsImpl.chmodSync(candidate, 0o600);
  return { path: candidate, link: pathToFileURL(candidate).href };
}

export async function runReviewEvidence({
  attempt_id,
  target_sha,
  cwd,
  env = process.env,
  execFileImpl = nodeExecFile,
  fsImpl = fs,
  childPath = CHILD,
  validateWrapperImpl = validateReviewWrapper,
  ownUid = process.getuid?.(),
  timeout_ms = 16 * 60 * 1000,
} = {}) {
  let server;
  let protectedPath;
  try {
    if (!UUID.test(attempt_id ?? "") || !SHA.test(target_sha ?? "") || !path.isAbsolute(cwd ?? "")) {
      throw new Error("invalid review evidence binding");
    }
    const expectedUid = /^\d+$/.test(env.SHU_REVIEW_EXEC_UID ?? "") ? Number(env.SHU_REVIEW_EXEC_UID) : null;
    if (!Number.isInteger(expectedUid) || expectedUid <= 0 || expectedUid === ownUid) {
      throw new Error("review execution requires a distinct non-root SHU_REVIEW_EXEC_UID");
    }
    const wrapper = reviewWrapper(env);
    validateWrapperImpl(wrapper, fsImpl);
    const childStat = fsImpl.lstatSync(childPath);
    if (!childStat.isFile() || childStat.isSymbolicLink() || childStat.uid !== ownUid || (childStat.mode & 0o022) !== 0) {
      throw new Error("review evidence child must be a coordinator-owned, non-writable regular file");
    }
    const files = reviewTestFiles(env);
    const evidenceDir = privateDirectory(env.SHU_REVIEW_EVIDENCE_DIR, { fsImpl, ownUid });
    const resolvedCwd = fsImpl.realpathSync(cwd);
    const workspaceUid = fsImpl.statSync(resolvedCwd).uid;
    if (workspaceUid !== ownUid) {
      throw new Error("B-ii requires the read-only reviewer workspace to remain coordinator-owned");
    }
    if (evidenceDir === resolvedCwd || evidenceDir.startsWith(`${resolvedCwd}${path.sep}`)) {
      throw new Error("review evidence authority must be outside the builder-authored checkout");
    }
    protectedPath = path.join(evidenceDir, `${attempt_id}.confinement-sentinel`);
    fsImpl.writeFileSync(protectedPath, "coordinator-private", { flag: "wx", mode: 0o600 });
    server = await listenProbe();
    const port = server.address().port;
    const safeEnv = buildReviewExecutionEnvironment(env);
    const result = await runExecFile(execFileImpl, wrapper[0], [
      ...wrapper.slice(1),
      process.execPath,
      childPath,
      "--cwd", resolvedCwd,
      "--expected-uid", String(expectedUid),
      "--protected-path", protectedPath,
      "--probe-port", String(port),
      "--target-sha", target_sha,
      "--",
      ...files,
    ], {
      cwd: resolvedCwd,
      env: safeEnv,
      encoding: "utf8",
      timeout: timeout_ms,
      maxBuffer: MAX_EVIDENCE_BYTES,
      windowsHide: true,
    });
    let report = null;
    try { report = JSON.parse(result.stdout); } catch { /* classified below */ }
    if (report && typeof report === "object") {
      report.confinement_mode = "B-ii";
      report.workspace_uid = workspaceUid;
    }
    const probeOk = !result.error
      && report?.target_sha === target_sha
      && JSON.stringify(report?.test_files) === JSON.stringify(files)
      && report?.actual_uid === expectedUid
      && report?.expected_uid === expectedUid
      && report?.filesystem_probe === "DENIED"
      && report?.workspace_write_probe === "DENIED"
      && report?.network_probe === "DENIED"
      && Array.isArray(report?.forbidden_env_keys)
      && report.forbidden_env_keys.length === 0;
    const executed = probeOk && report?.tests?.executed === true;
    const artifact = report ? persistEvidence(evidenceDir, attempt_id, report, fsImpl, sensitiveEnvironmentValues(env)) : null;
    if (!executed) {
      return {
        ok: false,
        executed: false,
        passed: false,
        reason_code: "REVIEW_EXECUTION_UNAVAILABLE",
        evidence_link: artifact?.link ?? null,
        report,
      };
    }
    return {
      ok: true,
      executed: true,
      passed: report.tests.exit_code === 0,
      reason_code: report.tests.exit_code === 0 ? "REVIEW_TESTS_PASSED" : "REVIEW_TESTS_FAILED",
      evidence_link: artifact.link,
      report,
    };
  } catch (error) {
    return { ok: false, executed: false, passed: false, reason_code: "REVIEW_EXECUTION_UNAVAILABLE", evidence_link: null, detail: error?.message ?? "unknown" };
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (protectedPath) {
      try { fsImpl.unlinkSync(protectedPath); } catch { /* evidence write failures never mask the outcome */ }
    }
  }
}

export function sensitiveEnvironmentValues(env = {}) {
  return Object.entries(env)
    .filter(([key, value]) => SENSITIVE_KEY.test(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value);
}
