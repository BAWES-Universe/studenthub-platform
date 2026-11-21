import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const SHA = /^[a-f0-9]{40}$/;
const TEST = /\.test\.(?:ts|mjs)$/u;
const OUTCOMES = new Set(["PASS", "FAIL", "NO_RUN", "UNAVAILABLE", "TIMEOUT"]);
const MAX_OUTPUT = 64 * 1024;
const GIT_MAX_OUTPUT = 4 * 1024 * 1024;

function git(cwd, args, timeout = 10_000) {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd, encoding: "utf8", maxBuffer: GIT_MAX_OUTPUT, timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function candidates(output) {
  return [...new Set(output.split("\0").filter((file) =>
    TEST.test(file) && !file.startsWith("/") && !file.includes("\\") &&
    !file.split("/").some((part) => part === "" || part === "." || part === "..") &&
    !/[\u0000-\u001f\u007f\ufffd]/u.test(file),
  ))].sort();
}

function unsupported(file) {
  if (file.startsWith("packages/actor-assertion/test/")) return "requires_vitest";
  if (file.startsWith("packages/db/test/postgres-") ||
      file === "packages/private-documents/test/r2-postgres.test.mjs") return "requires_postgres";
  if (file === "packages/search/test/typesense-integration.test.ts") return "requires_typesense";
  return null;
}

async function fileInside(cwd, relative) {
  const expected = path.resolve(cwd, relative);
  if (!expected.startsWith(cwd + path.sep)) return null;
  try {
    const resolved = await realpath(expected);
    return resolved === expected && (await lstat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function processGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") child.kill(signal);
  }
}

export function runFile(cwd, file, expected, budgetMs) {
  return new Promise((resolve) => {
    const start = performance.now();
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8", TZ: "UTC", CI: "true",
    };
    const child = fork(WORKER, [file, JSON.stringify(expected)], {
      cwd, env, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [],
    });
    const killOnExit = () => processGroup(child, "SIGKILL");
    process.once("exit", killOnExit);
    let result, messages = 0, reason, bytes = 0, force, done = false;
    const stop = (why) => {
      if (reason || done) return;
      reason = why;
      processGroup(child, "SIGTERM");
      force = setTimeout(() => processGroup(child, "SIGKILL"), 200);
    };
    const timer = setTimeout(() => stop("file_timeout"), budgetMs);
    child.on("message", (message) => {
      messages += 1;
      if (messages === 1 && message && OUTCOMES.has(message.outcome)) result = message;
      else stop("invalid_result");
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) stop("output_limit");
    });
    child.on("error", () => stop("spawn_error"));
    child.on("close", (exitCode, signal) => {
      done = true;
      process.removeListener("exit", killOnExit);
      clearTimeout(timer);
      clearTimeout(force);
      processGroup(child, "SIGKILL");
      if (reason) result = { outcome: reason === "file_timeout" ? "TIMEOUT" : "UNAVAILABLE", reason };
      else if (!result || signal || exitCode !== (result.outcome === "PASS" ? 0 : 1)) {
        result = { outcome: "UNAVAILABLE", reason: "incomplete_worker_result" };
      }
      resolve({ ...result, exitCode, signal, elapsedMs: Math.round(performance.now() - start) });
    });
  });
}

function unrun(outcome, reason) {
  return { outcome, reason, exitCode: null, signal: null, elapsedMs: 0 };
}

export async function preflight({ cwd = process.cwd(), base, head, setup = "success", totalMs = 120_000, fileMs = 30_000 }) {
  const start = performance.now();
  cwd = await realpath(cwd);
  const report = { schema: 1, advisory: true, base, head, node: process.version, results: [] };
  try {
    if (!SHA.test(base ?? "") || !SHA.test(head ?? "") || git(cwd, ["rev-parse", "HEAD"]).trim() !== head) {
      report.state = "UNAVAILABLE";
      report.reason = "head_not_verified";
      return report;
    }
    const mergeBase = git(cwd, ["merge-base", base, head]).trim();
    if (!SHA.test(mergeBase)) throw new Error("merge base missing");
    report.mergeBase = mergeBase;
    const files = candidates(git(cwd, ["diff", "--name-only", "--diff-filter=ACMRT", "-z", mergeBase, head]));
    report.state = files.length ? "RECORDED" : "NO_CHANGED_TESTS";
    for (const file of files) {
      let result;
      const target = file.endsWith(".ts") ? `dist/${file.slice(0, -3)}.js` : file;
      if (setup !== "success") result = unrun("UNAVAILABLE", "dependency_or_build_setup");
      else if (performance.now() - start >= totalMs) result = unrun("TIMEOUT", "total_budget_exhausted");
      else if (unsupported(file)) result = unrun("UNAVAILABLE", unsupported(file));
      else {
        try {
          const source = await fileInside(cwd, file);
          const testFile = await fileInside(cwd, target);
          if (!source || !testFile) result = unrun("UNAVAILABLE", "missing_or_unsafe_file");
          else {
            const remaining = Math.max(1, Math.floor(totalMs - (performance.now() - start)));
            const patch = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--unified=0", mergeBase, head, "--", file], Math.min(10_000, remaining));
            const { changedNames } = await import("./changed-names.mjs");
            const expected = await changedNames(await readFile(source, "utf8"), patch, file);
            const budget = Math.min(fileMs, totalMs - (performance.now() - start));
            result = budget > 0 ? await runFile(cwd, testFile, expected, budget) : unrun("TIMEOUT", "total_budget_exhausted");
          }
        } catch {
          result = performance.now() - start >= totalMs
            ? unrun("TIMEOUT", "total_budget_exhausted") : unrun("UNAVAILABLE", "test_preparation_failed");
        }
      }
      report.results.push({ file, runner: target, ...result });
    }
  } catch {
    report.state = "UNAVAILABLE";
    report.reason = "could_not_resolve_git_diff";
  }
  return report;
}

export function evidence(report) {
  return { ...report, sha256: createHash("sha256").update(JSON.stringify(report)).digest("hex") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const report = await preflight({
    base: process.env.PREFLIGHT_BASE_SHA,
    head: process.env.PREFLIGHT_HEAD_SHA,
    setup: process.env.PREFLIGHT_SETUP_STATUS,
  });
  const output = process.env.PREFLIGHT_REPORT_PATH ?? "test-preflight.json";
  await writeFile(output, JSON.stringify(evidence(report), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const totals = Object.fromEntries([...OUTCOMES].map((key) => [key, report.results.filter((r) => r.outcome === key).length]));
  console.log("Changed-test preflight (advisory):", report.state, JSON.stringify(totals));
  if (report.state === "UNAVAILABLE" || report.results.some((result) => result.outcome !== "PASS")) process.exitCode = 1;
}
