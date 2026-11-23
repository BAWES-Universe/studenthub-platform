/**
 * Orca standing tick: one fresh, pinned worktree per run (HANDOVER Part C).
 *
 * A tick never installs, builds or checks out in the shared clone or in another run's tree. It
 * resolves `main` once with `ls-remote`, fetches without touching any shared ref or FETCH_HEAD,
 * adds a detached worktree at exactly that SHA, and later removes only that worktree. The B3 run
 * lock (claims directory, not a checkout) still serializes ticket work.
 *
 * Builtins only and erasable TypeScript only, so the launcher can run this file straight from a
 * `git show` of main with Node's type stripping, before anything is built.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;

export type TickStep = "input" | "resolve" | "fetch" | "worktree" | "verify" | "cleanup";

export class TickError extends Error {
  readonly step: TickStep;
  constructor(step: TickStep, message: string) {
    super(redact(message));
    this.step = step;
  }
}

export interface SetupOptions {
  readonly clone: string;
  readonly ticks: string;
  readonly run: string;
  readonly remote?: string;
  readonly branch?: string;
  /** Test seam: runs after `main` is resolved and before the fetch (for example, to move origin). */
  readonly afterResolve?: (sha: string) => void;
}

export interface SetupResult { readonly status: "ready"; readonly run: string; readonly dir: string; readonly sha: string }
export interface CleanupResult { readonly status: "removed" | "absent"; readonly run: string; readonly dir: string }

/** Strips credentials from any URL in a message, so an error can be shown without leaking a token. */
export function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1***@");
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function failure(error: unknown): string {
  const e = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  return stderr || (typeof e.message === "string" ? e.message : String(error));
}

/** This run's tree: `<ticks>/<run>`, with a run id that cannot climb out of `<ticks>`. */
export function runDir(ticks: string, run: string): string {
  if (!RUN_ID.test(run)) throw new TickError("input", "run id must be 1 to 64 of A-Z a-z 0-9 . _ - and start with a letter or digit");
  return path.join(path.resolve(ticks), run);
}

function registered(clone: string, dir: string): boolean {
  const list = git(clone, ["worktree", "list", "--porcelain"]);
  return list.split("\n").some((line) => line.startsWith("worktree ") && path.resolve(line.slice(9)) === dir);
}

export function setupRun(options: SetupOptions): SetupResult {
  const { clone, ticks, run, remote = "origin", branch = "main" } = options;
  const dir = runDir(ticks, run);
  if (existsSync(dir)) throw new TickError("input", `run ${run} already has a tree; run ids are never reused`);
  let sha: string;
  try {
    const line = git(clone, ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`]);
    sha = line.split(/\s+/)[0] ?? "";
  } catch (error) { throw new TickError("resolve", failure(error)); }
  if (!SHA.test(sha)) throw new TickError("resolve", `remote ${branch} did not resolve to a full SHA`);
  options.afterResolve?.(sha);
  try {
    // No remote-tracking update and no FETCH_HEAD: concurrent ticks share no ref they could race on.
    git(clone, ["fetch", "--quiet", "--no-tags", "--refmap=", "--no-write-fetch-head", remote, `refs/heads/${branch}`]);
    try { git(clone, ["cat-file", "-e", `${sha}^{commit}`]); }
    catch { git(clone, ["fetch", "--quiet", "--no-tags", "--refmap=", "--no-write-fetch-head", remote, sha]); }
    git(clone, ["cat-file", "-e", `${sha}^{commit}`]);
  } catch (error) { throw new TickError("fetch", failure(error)); }
  try {
    mkdirSync(path.dirname(dir), { recursive: true });
    git(clone, ["worktree", "add", "--quiet", "--detach", dir, sha]);
  } catch (error) {
    removeOwn(clone, dir);
    throw new TickError("worktree", failure(error));
  }
  const head = git(dir, ["rev-parse", "HEAD"]);
  if (head !== sha) {
    removeOwn(clone, dir);
    throw new TickError("verify", `tree is at ${head}, expected ${sha}`);
  }
  return { status: "ready", run, dir, sha };
}

function removeOwn(clone: string, dir: string): void {
  try { if (registered(clone, dir)) git(clone, ["worktree", "remove", "--force", dir]); } catch { /* reported by the caller's error */ }
}

/** Removes exactly this run's tree. Never prunes, never touches another run's tree. */
export function cleanupRun(options: { readonly clone: string; readonly ticks: string; readonly run: string }): CleanupResult {
  const dir = runDir(options.ticks, options.run);
  try {
    if (!registered(options.clone, dir)) {
      if (existsSync(dir)) throw new TickError("cleanup", `${dir} exists but is not a worktree of this clone; left in place`);
      return { status: "absent", run: options.run, dir };
    }
    git(options.clone, ["worktree", "remove", "--force", dir]);
  } catch (error) {
    if (error instanceof TickError) throw error;
    throw new TickError("cleanup", failure(error));
  }
  return { status: "removed", run: options.run, dir };
}

function argValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** CLI: `setup|cleanup --clone <path> --ticks <dir> --run <id>`. Prints one JSON line; exit 2 on failure. */
export function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  const clone = argValue(rest, "--clone"), ticks = argValue(rest, "--ticks"), run = argValue(rest, "--run");
  try {
    if ((command !== "setup" && command !== "cleanup") || !clone || !ticks || !run) {
      throw new TickError("input", "usage: tick setup|cleanup --clone <path> --ticks <dir> --run <id>");
    }
    const result = command === "setup" ? setupRun({ clone, ticks, run }) : cleanupRun({ clone, ticks, run });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const step = error instanceof TickError ? error.step : "input";
    const message = error instanceof Error ? redact(error.message) : redact(String(error));
    process.stdout.write(`${JSON.stringify({ status: "failed", command: command ?? null, run: run ?? null, step, message })}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
