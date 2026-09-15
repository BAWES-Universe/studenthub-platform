// Fixed child for the reviewer evidence sandbox. This file is loaded from the
// coordinator checkout, never from the builder-authored target checkout.
// The host-configured wrapper must confine this process before it starts.
import { PROTECTED_CLASSES } from "./service/reviewer-isolation.mjs";
import fs from "node:fs";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// JSON can expand a captured control byte to six bytes (for example, NUL to
// \\u0000). Two worst-case streams plus report metadata therefore remain safely
// below the parent's fixed 1 MiB evidence-artifact ceiling.
export const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_ENV = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|SSH|GITHUB|LINEAR|ANTHROPIC|CLAUDE)/i;

function parseArgs(argv) {
  const split = argv.indexOf("--");
  if (split < 0) throw new Error("missing test-file separator");
  const values = new Map();
  for (let i = 0; i < split; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error("invalid reviewer evidence arguments");
    values.set(argv[i].slice(2), argv[i + 1]);
  }
  return { values, testFiles: argv.slice(split + 1) };
}

export function protectedFileDenied(file) {
  let descriptor;
  try {
    // Reachability is enough for the isolation assertion. Open and close only:
    // even a failed sandbox must never copy credential bytes into this process.
    descriptor = fs.openSync(file, fs.constants.O_RDONLY);
    fs.closeSync(descriptor);
    return false;
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    return ["EACCES", "EPERM"].includes(error?.code);
  }
}

export function inheritedDescriptorDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {
  if (typeof canary !== "string" || !/^SHU261_FD_[0-9a-f]{32}$/.test(canary)) return false;
  let descriptors = [];
  try { descriptors = fsImpl.readdirSync(`/proc/${pid}/fd`); } catch { return false; }
  for (const descriptor of descriptors) {
    if (!/^\d+$/.test(descriptor) || Number(descriptor) <= 2) continue;
    try {
      // Reading a pipe can block forever. The sentinel is a regular file.
      if (!fsImpl.statSync(`/proc/${pid}/fd/${descriptor}`).isFile()) continue;
      if (fsImpl.readFileSync(`/proc/${pid}/fd/${descriptor}`, "utf8").includes(canary)) return false;
    } catch { /* unreadable/non-regular descriptors do not expose the canary */ }
  }
  return true;
}

export function environmentValueDenied(canary, env = process.env) {
  return typeof canary === "string" && /^SHU261_ENV_[0-9a-f]{32}$/.test(canary) && !Object.values(env).some((value) => String(value).includes(canary));
}

export function processInspectionDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {
  if (typeof canary !== "string" || !/^SHU261_PROCESS_[0-9a-f]{32}$/.test(canary)) return false;
  let entries = [];
  try { entries = fsImpl.readdirSync("/proc"); } catch { return false; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === pid) continue;
    for (const name of ["cmdline", "environ"]) {
      try {
        if (fsImpl.readFileSync(`/proc/${entry}/${name}`, "utf8").includes(canary)) return false;
      } catch { /* invisible processes are the intended result */ }
    }
  }
  return true;
}

export function protectedProbes(raw) {
  if (!raw) return { ok: false, classes: {}, symlink: "INVALID", traversal: "INVALID" };
  let probes;
  try { probes = JSON.parse(raw); } catch { return { ok: false, classes: {}, symlink: "INVALID", traversal: "INVALID" }; }
  if (!Array.isArray(probes) || probes.length === 0 || probes.length > 16) {
    return { ok: false, classes: {}, symlink: "INVALID", traversal: "INVALID" };
  }
  const classes = {};
  let symlink = true;
  let traversal = true;
  for (const probe of probes) {
    if (!probe || typeof probe !== "object" || ![...PROTECTED_CLASSES, "deployed_supervisor_environment"].includes(probe.class)
      || typeof probe.path !== "string" || !probe.path.startsWith("/") || Object.hasOwn(classes, probe.class)) {
      return { ok: false, classes: {}, symlink: "INVALID", traversal: "INVALID" };
    }
    const denied = protectedFileDenied(probe.path);
    classes[probe.class] = denied ? "DENIED" : "REACHABLE";
    if (probe.symlink_path) symlink &&= protectedFileDenied(probe.symlink_path);
    if (probe.traversal_path) traversal &&= protectedFileDenied(probe.traversal_path);
  }
  return {
    ok: Object.values(classes).every((value) => value === "DENIED") && symlink && traversal,
    classes,
    symlink: symlink ? "DENIED" : "REACHABLE",
    traversal: traversal ? "DENIED" : "REACHABLE",
  };
}

function workspaceWriteDenied(cwd) {
  const probe = `${cwd}/.shu-review-write-probe-${process.pid}`;
  try {
    fs.writeFileSync(probe, "must not be writable", { flag: "wx" });
    fs.unlinkSync(probe);
    return false;
  } catch (error) {
    return ["EACCES", "EPERM", "EROFS"].includes(error?.code);
  }
}

function networkDenied(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(port) });
    let settled = false;
    const finish = (denied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(denied);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    socket.setTimeout(750, () => finish(true));
  });
}

export function bounded(text) {
  const value = String(text ?? "");
  return Buffer.byteLength(value) <= MAX_CAPTURE_BYTES
    ? value
    : `${Buffer.from(value).subarray(0, MAX_CAPTURE_BYTES).toString("utf8")}\n[output truncated by coordinator]`;
}

async function main() {
  const { values, testFiles } = parseArgs(process.argv.slice(2));
  const cwd = values.get("cwd");
  const expectedUid = Number(values.get("expected-uid"));
  const protectedPath = values.get("protected-path");
  const siblingProbePath = values.get("sibling-probe-path");
  const probePort = values.get("probe-port");
  const targetSha = values.get("target-sha");
  const isolation = protectedProbes(values.get("protected-paths-json"));
  const fdDenied = inheritedDescriptorDenied(values.get("fd-canary"));
  const environmentDenied = environmentValueDenied(values.get("env-canary"));
  const processDenied = processInspectionDenied(values.get("process-canary"));
  const actualUid = typeof process.getuid === "function" ? process.getuid() : null;
  const forbiddenEnvKeys = Object.keys(process.env).filter((key) => FORBIDDEN_ENV.test(key));
  const filesystemDenied = protectedFileDenied(protectedPath);
  const siblingWorkspaceDenied = protectedFileDenied(siblingProbePath);
  const workspaceWriteBlocked = workspaceWriteDenied(cwd);
  const noNetwork = await networkDenied(probePort);
  const probeOk = Number.isInteger(expectedUid) && expectedUid > 0 && actualUid === expectedUid
    && filesystemDenied && siblingWorkspaceDenied && workspaceWriteBlocked && noNetwork && forbiddenEnvKeys.length === 0
    && isolation.ok && fdDenied && environmentDenied && processDenied;

  const report = {
    version: "1.0.0",
    target_sha: targetSha,
    test_files: testFiles,
    expected_uid: expectedUid,
    actual_uid: actualUid,
    workspace_uid: (() => { try { return fs.statSync(cwd).uid; } catch { return null; } })(),
    filesystem_probe: filesystemDenied ? "DENIED" : "REACHABLE",
    sibling_workspace_probe: siblingWorkspaceDenied ? "DENIED" : "REACHABLE",
    workspace_write_probe: workspaceWriteBlocked ? "DENIED" : "WRITABLE",
    network_probe: noNetwork ? "DENIED" : "REACHABLE",
    forbidden_env_keys: forbiddenEnvKeys,
    protected_class_probes: isolation.classes,
    symlink_probe: isolation.symlink,
    traversal_probe: isolation.traversal,
    inherited_descriptor_probe: fdDenied ? "DENIED" : "REACHABLE",
    environment_value_probe: environmentDenied ? "DENIED" : "REACHABLE",
    process_inspection_probe: processDenied ? "DENIED" : "REACHABLE",
    tests: { executed: false, exit_code: null, signal: null, stdout: "", stderr: "" },
  };

  if (probeOk && testFiles.length > 0) {
    const result = spawnSync(process.execPath, ["--test", ...testFiles], {
      cwd,
      env: process.env,
      encoding: "utf8",
      timeout: 15 * 60 * 1000,
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    report.tests = {
      executed: true,
      exit_code: Number.isInteger(result.status) ? result.status : null,
      signal: result.signal ?? null,
      stdout: bounded(result.stdout),
      stderr: bounded(result.stderr),
    };
  }

  process.stdout.write(JSON.stringify(report));
  if (!probeOk || !report.tests.executed) process.exitCode = 70;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`review evidence child failed: ${error?.message ?? "unknown"}\n`);
    process.exitCode = 70;
  });
}
