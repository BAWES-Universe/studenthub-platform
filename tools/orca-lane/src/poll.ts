// Orca lane poll. Run from a clone of studenthub-platform:
//   node dist/tools/orca-lane/src/poll.js --bot studenthub-universe --mode observe
//   node dist/tools/orca-lane/src/poll.js --bot studenthub-universe --mode work
// observe never claims and never writes; it only prints what it would do.
// work claims at most one ticket, takes its run lock and prints it. The caller
// works only when "next" is not null, posts the start receipt on "start", and
// runs "--mode release --key <next.claimKey>" when the run ends.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireRun, claim, decide, parseRegister, releaseRun, type Decision, type IssueComment, type WorkDecision } from "./lane.js";

const REPO = "BAWES-Universe/studenthub-platform";
const REGISTER = "docs/lanes/orca/REGISTER.md";

export type Next = WorkDecision | null;

/**
 * At most one ticket per bot: an owned ticket is resumed before anything new starts.
 * A run needs the claim (start) and the run lock; losing either race means do nothing now.
 */
export function pickNext(
  decisions: readonly Decision[],
  tryClaim: (decision: WorkDecision) => "claimed" | "held",
  tryRun: (decision: WorkDecision) => "acquired" | "busy",
): Next {
  const work = decisions.filter((d): d is WorkDecision => d.action === "start" || d.action === "resume");
  const owned = work.filter((d) => d.action === "resume");
  if (owned.length > 0) return tryRun(owned[0]!) === "acquired" ? owned[0]! : null;
  const first = work.find((d) => d.action === "start");
  if (!first || tryClaim(first) !== "claimed") return null;
  return tryRun(first) === "acquired" ? first : null;
}

function args(argv: readonly string[]): { bot: string; mode: "observe" | "work" | "release"; claims: string; key?: string } {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const bot = value("--bot");
  const mode = value("--mode");
  if (!bot || (mode !== "observe" && mode !== "work" && mode !== "release")) {
    throw new Error("usage: poll --bot <name> --mode observe|work|release [--key <claimKey>] [--claims <dir>]");
  }
  const key = value("--key");
  if (mode === "release" && !key) throw new Error("release needs --key");
  return { bot, mode, claims: value("--claims") ?? path.join(os.homedir(), ".orca-lane", "claims"), ...(key ? { key } : {}) };
}

function comments(issue: number): IssueComment[] {
  const raw = execFileSync("gh", ["api", "--paginate", `repos/${REPO}/issues/${issue}/comments?per_page=100`,
    "--jq", ".[] | {id, body, author: .user.login, appId: .performed_via_github_app.id}"], { encoding: "utf8" });
  return raw.split("\n").filter(Boolean).map((line) => {
    const parsed = JSON.parse(line) as { id: number; body: string; author: string; appId: number | null };
    return { id: parsed.id, body: parsed.body, author: parsed.author, appId: parsed.appId ?? null };
  });
}

function main(): void {
  const { bot, mode, claims, key } = args(process.argv.slice(2));
  if (mode === "release") {
    releaseRun(claims, key!);
    process.stdout.write(`${JSON.stringify({ mode, bot, released: key })}\n`);
    return;
  }
  execFileSync("git", ["fetch", "--quiet", "origin", "main"]);
  const rows = parseRegister(execFileSync("git", ["show", `origin/main:${REGISTER}`], { encoding: "utf8" }));
  const mine = rows.filter((row) => row.bot === bot && row.state === "active");
  const byIssue = new Map<number, IssueComment[]>();
  for (const issue of new Set(mine.map((row) => row.issue))) byIssue.set(issue, comments(issue));
  let held: string[] = [];
  try { held = readdirSync(claims); } catch { held = []; }
  const now = new Date();
  const decisions = decide({ rows, bot, now, comments: byIssue, claims: new Set(held) });
  const at = now.toISOString();
  const next = mode === "work"
    ? pickNext(decisions, (d) => claim(claims, d.claimKey, { dispatch: d.dispatch, at }), (d) => acquireRun(claims, d.claimKey, now))
    // observe: report what work mode would pick, touching nothing
    : pickNext(decisions, () => "claimed", () => "acquired");
  process.stdout.write(`${JSON.stringify({ mode, bot, at, decisions, next }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
