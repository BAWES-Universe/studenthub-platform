/**
 * Orca standing tick: one fresh, pinned worktree per run (HANDOVER Part C).
 *
 * A tick never installs, builds or checks out in the shared clone or in another run's tree, and
 * never mutates or reads a shared ref to decide what to run. `main` is resolved to an immutable SHA
 * with `ls-remote`, objects are fetched with no ref and no FETCH_HEAD written, and every read is by
 * that SHA. A run id is reserved atomically; only the holder of its owner nonce can remove its tree.
 * The B3 run lock (claims directory, not a checkout) still serializes ticket work.
 *
 * Builtins only and erasable TypeScript only, so the bootstrap can run this file straight from
 * `git show <sha>:tools/orca-lane/src/tick.ts` with Node's type stripping, before anything is built.
 * The bootstrap passes `--experimental-strip-types`, so this works from Node 22.6, not only from 22.18
 * where stripping became the default.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;
const OWNER = /^[0-9a-f]{32}$/;

export type TickStep = "input" | "reserve" | "resolve" | "fetch" | "worktree" | "verify" | "cleanup";

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
  /** The SHA the bootstrap resolved; when absent, setup resolves `main` itself. */
  readonly sha?: string;
  readonly remote?: string;
  readonly branch?: string;
  /** Test seam: runs after `main` is resolved and before the fetch (for example, to move origin). */
  readonly afterResolve?: (sha: string) => void;
}

export interface SetupResult { readonly status: "ready"; readonly run: string; readonly dir: string; readonly sha: string; readonly owner: string }
export interface CleanupResult { readonly status: "removed"; readonly run: string; readonly dir: string }

/** Strips credentials from any URL in a message, so an error can be shown without leaking a token. */
export function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1***@");
}

function git(cwd: string, args: readonly string[]): string {
  // core.longpaths lets Git for Windows check out and delete node_modules paths past 260 characters; elsewhere it is a no-op.
  return execFileSync("git", ["-C", cwd, "-c", "core.longpaths=true", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Removes a run's own tree. Callers reach this only when the run's reservation carries the `tree` marker,
 * which setup writes after its own `worktree add` succeeded; a run never removes, by Git or otherwise, a
 * path it did not create. Git for Windows can unregister a worktree and still fail to delete some of its
 * files ("Directory not empty": long node_modules paths, or a scanner's brief open handle), so cleanup
 * finishes the deletion with Node, which retries busy files, then unregisters the tree if Git still lists
 * it (`worktree remove` accepts a tree that is already gone). Never prunes.
 */
function removeTree(clone: string, dir: string): void {
  let gitError: unknown = null;
  if (registered(clone, dir)) {
    try { git(clone, ["worktree", "remove", "--force", dir]); } catch (error) { gitError = error; }
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (registered(clone, dir)) {
    try { git(clone, ["worktree", "remove", "--force", dir]); }
    catch (error) { throw new Error(`${dir} is still registered: ${failure(error)}${gitError ? `; first attempt: ${failure(gitError)}` : ""}`); }
  }
}

function failure(error: unknown): string {
  const e = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  return stderr || (typeof e.message === "string" ? e.message : String(error));
}

/** Resolves a remote branch to its current commit SHA without touching any local ref. */
export function resolveRemote(cwd: string, remote = "origin", branch = "main"): string {
  let sha: string;
  try { sha = git(cwd, ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`]).split(/\s+/)[0] ?? ""; }
  catch (error) { throw new TickError("resolve", failure(error)); }
  if (!SHA.test(sha)) throw new TickError("resolve", `remote ${branch} did not resolve to a full SHA`);
  return sha;
}

/** Makes `sha` present locally, writing no ref and no FETCH_HEAD, so concurrent fetches share nothing. */
export function fetchCommit(cwd: string, sha: string, remote = "origin", branch = "main"): void {
  if (!SHA.test(sha)) throw new TickError("input", "sha must be a full 40-character commit id");
  const quiet = ["fetch", "--quiet", "--no-tags", "--refmap=", "--no-write-fetch-head", remote];
  try {
    try { git(cwd, ["cat-file", "-e", `${sha}^{commit}`]); return; } catch { /* not here yet */ }
    git(cwd, [...quiet, `refs/heads/${branch}`]);
    try { git(cwd, ["cat-file", "-e", `${sha}^{commit}`]); return; } catch { /* main moved past a rewrite; ask for the commit itself */ }
    git(cwd, [...quiet, sha]);
    git(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
  } catch (error) { throw new TickError("fetch", failure(error)); }
}

/** Fresh read of a file on the remote's current `main`, by immutable SHA, with no shared ref touched. */
export function readAtRemoteMain(cwd: string, file: string, remote = "origin", branch = "main"): { readonly sha: string; readonly content: string } {
  const sha = resolveRemote(cwd, remote, branch);
  fetchCommit(cwd, sha, remote, branch);
  return { sha, content: execFileSync("git", ["-C", cwd, "show", `${sha}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
}

/** This run's tree: `<ticks>/<run>`, with a run id that cannot climb out of `<ticks>`. */
export function runDir(ticks: string, run: string): string {
  if (!RUN_ID.test(run)) throw new TickError("input", "run id must be 1 to 64 of A-Z a-z 0-9 . _ - and start with a letter or digit");
  return path.join(path.resolve(ticks), run);
}

/** Reservation marker: setup's own `worktree add` succeeded, so the files at the run's path are its own. */
const TREE = "tree";

const reservation = (ticks: string, run: string): string => path.join(path.resolve(ticks), ".runs", run);

/** A path with symlinks resolved; for a path that no longer exists, its parent is resolved instead. */
function canonical(p: string): string {
  const resolved = path.resolve(p);
  try { return realpathSync(resolved); } catch { /* gone; resolve what is left */ }
  try { return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved)); } catch { return resolved; }
}

function registered(clone: string, dir: string): boolean {
  const list = git(clone, ["worktree", "list", "--porcelain"]);
  const want = canonical(dir);
  return list.split("\n").some((line) => line.startsWith("worktree ") && canonical(line.slice(9)) === want);
}

export function setupRun(options: SetupOptions): SetupResult {
  const { clone, ticks, run, remote = "origin", branch = "main" } = options;
  const dir = runDir(ticks, run);
  if (options.sha !== undefined && !SHA.test(options.sha)) throw new TickError("input", "sha must be a full 40-character commit id");
  // Exclusive reservation: of two setups with one run id, exactly one creates this directory.
  const reserved = reservation(ticks, run);
  mkdirSync(path.dirname(reserved), { recursive: true });
  try { mkdirSync(reserved); }
  catch (error) { throw new TickError("reserve", `run ${run} is already reserved; run ids are never reused (${(error as NodeJS.ErrnoException).code ?? "error"})`); }
  const owner = randomBytes(16).toString("hex");
  writeFileSync(path.join(reserved, "owner"), owner, { flag: "wx" });
  // From here the run id is ours for good: a reservation is never deleted, so no later run can hold this id
  // and removing its tree on failure can only remove our own. The reservation stays as a spent marker.
  const abandon = (step: TickStep, message: string, ownTree = true): never => {
    // Only a tree this run recorded as its own is ever removed; before the marker, nothing at `dir` is touched.
    try { if (ownTree && existsSync(path.join(reserved, TREE))) removeTree(clone, dir); } catch { /* reported below */ }
    try { mkdirSync(path.join(reserved, "abandoned")); } catch { /* already marked */ }
    throw new TickError(step, message);
  };
  if (existsSync(dir)) abandon("reserve", `${dir} exists without a reservation; left in place`, false);
  let sha: string;
  try {
    sha = options.sha ?? resolveRemote(clone, remote, branch);
    options.afterResolve?.(sha);
    fetchCommit(clone, sha, remote, branch);
  } catch (error) {
    return abandon(error instanceof TickError ? error.step : "fetch", error instanceof Error ? error.message : String(error));
  }
  try { git(clone, ["worktree", "add", "--quiet", "--detach", dir, sha]); }
  catch (error) { return abandon("worktree", failure(error)); }
  // Durable proof that this run created the tree at `dir`: only with it may cleanup or abandonment remove anything there.
  try { mkdirSync(path.join(reserved, TREE)); }
  catch (error) { return abandon("worktree", `could not record the tree: ${failure(error)}`); }
  let head: string;
  try { head = git(dir, ["rev-parse", "HEAD"]); }
  catch (error) { return abandon("verify", failure(error)); }
  if (head !== sha) abandon("verify", `tree is at ${head}, expected ${sha}`);
  return { status: "ready", run, dir, sha, owner };
}

export interface CleanupOptions {
  readonly clone: string;
  readonly ticks: string;
  readonly run: string;
  readonly owner: string;
  /** Test seam: runs while cleanup holds the run id, before the tree is removed; a throw counts as a failed removal. */
  readonly afterClaim?: () => void;
  /** Test seam: runs after the tree is gone and before the `removed` marker; a throw counts as a failed cleanup. */
  readonly afterRemoval?: () => void;
}

/**
 * Removes exactly this run's tree, and only for the holder of its owner nonce. Never prunes.
 * A run id has exactly one reservation for all time (setup never deletes one and cleanup never does), so
 * its owner value is immutable and there is no earlier or later generation to confuse it with. Inside the
 * reservation, cleanup takes an exclusive claim (one `mkdir` wins); only the holder ever deletes that
 * claim. Success leaves a `removed` marker, so a repeated cleanup is refused. If removal fails, the holder
 * drops its claim and the same owner can retry.
 */
export function cleanupRun(options: CleanupOptions): CleanupResult {
  const dir = runDir(options.ticks, options.run);
  const reserved = reservation(options.ticks, options.run);
  const claim = path.join(reserved, "cleaning");
  const refuse = (why: string): never => { throw new TickError("cleanup", `${why}; nothing removed`); };
  let recorded = "";
  try { recorded = readFileSync(path.join(reserved, "owner"), "utf8"); } catch { /* no reservation */ }
  if (!OWNER.test(options.owner) || recorded !== options.owner) refuse(`not the owner of run ${options.run}`);
  try { mkdirSync(claim); } catch { refuse(`run ${options.run} is already being cleaned up`); }
  if (existsSync(path.join(reserved, "removed"))) {
    rmSync(claim, { recursive: true, force: true });
    refuse(`run ${options.run} was already removed`);
  }
  if (!existsSync(path.join(reserved, TREE))) {
    rmSync(claim, { recursive: true, force: true });
    refuse(`run ${options.run} never recorded a tree of its own, so ${dir} is left in place`);
  }
  try {
    options.afterClaim?.();
    removeTree(options.clone, dir);
    if (existsSync(dir)) throw new Error(`${dir} is still present after removal`);
    options.afterRemoval?.();
    mkdirSync(path.join(reserved, "removed"));
  } catch (error) {
    rmSync(claim, { recursive: true, force: true });
    throw new TickError("cleanup", `${failure(error)}; the reservation is kept, retry this cleanup with the same owner value`);
  }
  rmSync(claim, { recursive: true, force: true });
  return { status: "removed", run: options.run, dir };
}

function argValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * CLI: `setup --clone <path> --ticks <dir> --run <id> [--sha <sha>]` or
 * `cleanup --clone <path> --ticks <dir> --run <id> --owner <nonce>`. One JSON line; exit 2 on failure.
 */
export function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  const clone = argValue(rest, "--clone"), ticks = argValue(rest, "--ticks"), run = argValue(rest, "--run");
  const sha = argValue(rest, "--sha"), owner = argValue(rest, "--owner");
  try {
    if (!clone || !ticks || !run || !(command === "setup" || (command === "cleanup" && owner))) {
      throw new TickError("input", "usage: tick setup --clone <path> --ticks <dir> --run <id> [--sha <sha>] | cleanup ... --owner <nonce>");
    }
    const result = command === "setup"
      ? setupRun({ clone, ticks, run, ...(sha ? { sha } : {}) })
      : cleanupRun({ clone, ticks, run, owner: owner! });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const step = error instanceof TickError ? error.step : "input";
    const message = error instanceof Error ? redact(error.message) : redact(String(error));
    process.stdout.write(`${JSON.stringify({ status: "failed", command: command ?? null, run: run ?? null, step, message })}\n`);
    return 2;
  }
}

/**
 * The bootstrap a tick runs in the shared clone before anything is built, exactly as HANDOVER Part C
 * gives it. Every step reads by the resolved SHA; none writes a ref or FETCH_HEAD. The launcher lives in
 * a directory `mktemp -d` creates atomically for this one invocation, so two wakes that pick the same run
 * id never share, overwrite or remove each other's launcher. `<launch>` is the directory step 3 prints.
 */
export const BOOTSTRAP = [
  "git ls-remote origin refs/heads/main",
  "git fetch --quiet --no-tags --refmap= --no-write-fetch-head origin refs/heads/main",
  'mkdir -p "<ticks-dir>/.launch" && mktemp -d "<ticks-dir>/.launch/<run-id>.XXXXXX"',
  'git show <sha>:tools/orca-lane/src/tick.ts > "<launch>/tick.ts"',
  'node --experimental-strip-types "<launch>/tick.ts" setup --clone "<clone>" --ticks "<ticks-dir>" --run <run-id> --sha <sha>',
] as const;

/**
 * How a tick ends. Cleanup runs only after a `ready` setup, with that setup's owner value, through this
 * invocation's own launcher; removing the launcher directory always runs last, ready or not.
 */
export const TEARDOWN = [
  'node --experimental-strip-types "<launch>/tick.ts" cleanup --clone "<clone>" --ticks "<ticks-dir>" --run <run-id> --owner <owner>',
  'rm -rf "<launch>"',
] as const;

// Compare canonical paths, so a launcher reached through a symlinked directory still runs as the CLI.
if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
