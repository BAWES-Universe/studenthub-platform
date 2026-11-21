// Orca lane poll. Run from a clone of studenthub-platform with main built:
//   node dist/tools/orca-lane/src/poll.js --bot studenthub-universe --mode observe
//   node dist/tools/orca-lane/src/poll.js --bot studenthub-universe --mode work
//   node dist/tools/orca-lane/src/poll.js --bot studenthub-universe --mode check --key <claimKey> --token <runToken>
//   node dist/tools/orca-lane/src/poll.js --bot studenthub-universe --mode check --key <claimKey> --token <runToken> --purpose ready
//   node dist/tools/orca-lane/src/poll.js --bot studenthub-universe --mode expect --key <claimKey> --token <runToken> --sha <head about to be pushed> --pull <n> --changes <comment id>
//   node dist/tools/orca-lane/src/poll.js --bot studenthub-universe --mode release --key <claimKey> --token <runToken>
//   node dist/tools/orca-lane/src/poll.js --bot studenthub-universe --mode recover --key <runLock.key> --token <runLock.token>
// observe never claims or locks; it lists observe-mode rows and what work mode would pick.
// work claims at most one ticket, takes the bot-wide run lock and prints it with a run token.
// check must pass immediately before every push, PR change or comment of a run.
// release ends a run; it frees the lock only for the matching key and token.
// recover frees a lock left by a run verified stopped, only for that exact run (key and token).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireRun, type BranchPull, claim, type ClaimRecord, decide, expectHead, type ExpectedHead, readExpected, holdsRun, parseRegister, readClaim, readRun, recoverRun, releaseRun, ticketBranch, type Decision, type IssueComment, type ObserveDecision, type WorkDecision } from "./lane.js";

const REPO = "BAWES-Universe/studenthub-platform";
const REGISTER = "docs/lanes/orca/REGISTER.md";

export type Next = (WorkDecision & { readonly runToken: string | null }) | null;

/** The ticket work mode would take: an owned ticket (resume) always before a new one (start). */
export function choose(decisions: readonly Decision[]): WorkDecision | null {
  const work = decisions.filter((d): d is WorkDecision => d.action === "start" || d.action === "resume");
  return work.find((d) => d.action === "resume") ?? work.find((d) => d.action === "start") ?? null;
}

/**
 * At most one ticket per bot. The bot-wide run lock is taken first, so only one
 * poll at a time can get past it; decisions are then re-read under the lock, and
 * the poll goes ahead only if the same ticket is still the one to take. A start
 * also needs the claim. Losing any step releases the lock and does nothing now.
 * tryRun returns the run token, or null if the lock is busy.
 */
export function pickNext(
  decisions: readonly Decision[],
  tryClaim: (decision: WorkDecision) => "claimed" | "held",
  tryRun: (decision: WorkDecision) => string | null,
  undoRun: (decision: WorkDecision, runToken: string) => void = () => {},
  reread: () => readonly Decision[] = () => decisions,
): Next {
  const chosen = choose(decisions);
  if (!chosen) return null;
  const runToken = tryRun(chosen);
  if (runToken === null) return null;
  const fresh = choose(reread());
  if (!fresh || fresh.claimKey !== chosen.claimKey || (fresh.action === "start" && tryClaim(fresh) !== "claimed")) {
    undoRun(chosen, runToken);
    return null;
  }
  return { ...fresh, runToken };
}

/**
 * The check before a write. `mine` is this run's resume decision (decided with
 * this run's declaration), `holds` whether its token holds the run lock.
 * purpose "write" passes for an ordinary resume; once a declared revision is on
 * the PR it fails. purpose "ready" passes only in that completion-only state,
 * and then returns the exact ready receipt header to post.
 */
export function checkRun(mine: WorkDecision | undefined, holds: boolean, purpose: "write" | "ready"): { ok: boolean; reason: string | null; readyReceiptHeader?: string } {
  if (!mine) return { ok: false, reason: "ticket generation no longer eligible" };
  if (!holds) return { ok: false, reason: "run lock not held by this token" };
  if (purpose === "ready") {
    return mine.completeOnly
      ? { ok: true, reason: null, readyReceiptHeader: mine.completeOnly.readyReceiptHeader }
      : { ok: false, reason: "no declared revision is on the PR: nothing to complete" };
  }
  return mine.completeOnly
    ? { ok: false, reason: "revision is on the PR: the only write left is the ready receipt (--purpose ready)" }
    : { ok: true, reason: null };
}

type Mode = "observe" | "work" | "check" | "expect" | "release" | "recover";

function args(argv: readonly string[]): { bot: string; mode: Mode; claims: string; key?: string; token?: string; sha?: string; pull?: number; changes?: number; purpose: "write" | "ready" } {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const bot = value("--bot");
  const mode = value("--mode");
  if (!bot || (mode !== "observe" && mode !== "work" && mode !== "check" && mode !== "expect" && mode !== "release" && mode !== "recover")) {
    throw new Error("usage: poll --bot <name> --mode observe|work|check|expect|release|recover [--key <claimKey>] [--token <runToken>] [--sha <sha> --pull <n> --changes <id>] [--purpose write|ready] [--claims <dir>]");
  }
  const key = value("--key");
  const token = value("--token");
  if ((mode === "check" || mode === "expect" || mode === "release" || mode === "recover") && (!key || !token)) throw new Error(`${mode} needs --key and --token`);
  const sha = value("--sha");
  const pull = value("--pull");
  const changes = value("--changes");
  if (mode === "expect" && (!sha || !pull || !changes)) throw new Error("expect needs --sha, --pull and --changes");
  const purpose = value("--purpose") ?? "write";
  if (purpose !== "write" && purpose !== "ready") throw new Error("--purpose is write or ready");
  return { bot, mode, purpose, claims: value("--claims") ?? path.join(os.homedir(), ".orca-lane", "claims"), ...(key ? { key } : {}), ...(token ? { token } : {}),
    ...(sha ? { sha } : {}), ...(pull ? { pull: Number(pull) } : {}), ...(changes ? { changes: Number(changes) } : {}) };
}

function comments(issue: number): IssueComment[] {
  const raw = execFileSync("gh", ["api", "--paginate", `repos/${REPO}/issues/${issue}/comments?per_page=100`,
    "--jq", ".[] | {id, body, author: .user.login, appId: .performed_via_github_app.id}"], { encoding: "utf8" });
  return raw.split("\n").filter(Boolean).map((line) => {
    const parsed = JSON.parse(line) as { id: number; body: string; author: string; appId: number | null };
    return { id: parsed.id, body: parsed.body, author: parsed.author, appId: parsed.appId ?? null };
  });
}

/** Open PRs whose head is the ticket branch in this repository. */
function branchPulls(branch: string): BranchPull[] {
  const owner = REPO.split("/")[0]!;
  const raw = execFileSync("gh", ["api", "--paginate", `repos/${REPO}/pulls?state=open&per_page=100&head=${owner}:${branch}`,
    "--jq", ".[] | {number, head: .head.sha, base: .base.ref, draft, headRepo: .head.repo.full_name}"], { encoding: "utf8" });
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as BranchPull & { headRepo: string })
    .filter((pull) => pull.headRepo === REPO).map(({ number, head, base, draft }) => ({ number, head, base, draft }));
}

export function heldClaims(dir: string): Map<string, ClaimRecord> {
  const held = new Map<string, ClaimRecord>();
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    // No claims directory yet means no claims. Any other read error fails closed.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const key of entries.filter((entry) => !entry.startsWith("."))) {
    // Claims are published whole, so an unreadable one means tampering: hold it as unbound so it never resumes.
    held.set(key, readClaim(dir, key) ?? { dispatch: -1, lease: "", at: "" });
  }
  return held;
}

function main(): void {
  const { bot, mode, claims, key, token, sha, pull, changes, purpose } = args(process.argv.slice(2));
  if (mode === "expect") {
    const result = expectHead(claims, bot, key!, token!, { sha: sha!, pull: pull!, changes: changes! });
    process.stdout.write(`${JSON.stringify({ mode, bot, key, sha, pull, changes, result })}\n`);
    if (result !== "recorded") process.exitCode = 3;
    return;
  }
  if (mode === "release") {
    process.stdout.write(`${JSON.stringify({ mode, bot, key, result: releaseRun(claims, bot, key!, token!) })}\n`);
    return;
  }
  if (mode === "recover") {
    process.stdout.write(`${JSON.stringify({ mode, bot, key, result: recoverRun(claims, bot, key!, token!) })}\n`);
    return;
  }
  execFileSync("git", ["fetch", "--quiet", "origin", "main"]);
  const rows = parseRegister(execFileSync("git", ["show", `origin/main:${REGISTER}`], { encoding: "utf8" }));
  const mine = rows.filter((row) => row.bot === bot && row.state === "active");
  const byIssue = new Map<number, IssueComment[]>();
  for (const issue of new Set(mine.map((row) => row.issue))) byIssue.set(issue, comments(issue));
  const pulls = new Map<string, BranchPull[]>();
  for (const branch of new Set(mine.map((row) => ticketBranch(bot, row.slug)))) pulls.set(branch, branchPulls(branch));
  const now = new Date();
  const at = now.toISOString();
  const decisionsFor = (running?: { key: string; expected: ExpectedHead | null }): Decision[] => decide({ rows, bot, now, comments: byIssue, claims: heldClaims(claims), pulls, ...(running ? { running } : {}) });

  if (mode === "check") {
    // A running ticket always holds its claim, so only a matching resume (same dispatch, same lease) passes.
    // Only the lock holder may see its own revision's head move after a hand-back, and only to the head it declared.
    const holds = holdsRun(claims, bot, key!, token!);
    const mineNow = decisionsFor(holds ? { key: key!, expected: readExpected(claims, bot, key!, token!) } : undefined).find((d): d is WorkDecision => d.action === "resume" && d.claimKey === key);
    const { ok, reason, readyReceiptHeader } = checkRun(mineNow, holds, purpose);
    process.stdout.write(`${JSON.stringify({ mode, bot, at, key, purpose, ok, reason, ...(readyReceiptHeader ? { readyReceiptHeader } : {}) })}\n`);
    if (!ok) process.exitCode = 3;
    return;
  }

  if (mode === "observe") {
    const decisions = decisionsFor();
    const observe = decisions.filter((d): d is ObserveDecision => d.action === "observe");
    const wouldPick = decisions.find((d): d is WorkDecision => d.action === "resume") ?? decisions.find((d): d is WorkDecision => d.action === "start") ?? null;
    process.stdout.write(`${JSON.stringify({ mode, bot, at, observe, wouldPick, decisions }, null, 2)}\n`);
    return;
  }

  const decisions = decisionsFor();
  const next = pickNext(
    decisions,
    (d) => claim(claims, d.claimKey, { dispatch: d.dispatch, lease: d.lease, at }),
    (d) => { const runToken = randomUUID(); return acquireRun(claims, bot, d.claimKey, now, runToken) === "acquired" ? runToken : null; },
    (d, runToken) => { releaseRun(claims, bot, d.claimKey, runToken); },
    () => decisionsFor(),
  );
  const result = { decisions, next };
  // When next is null because a run holds the lock, say which run (for manual recovery after a verified stop).
  const held = readRun(claims, bot);
  const runLock = held && result.next === null ? held : null;
  process.stdout.write(`${JSON.stringify({ mode, bot, at, ...result, runLock }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
