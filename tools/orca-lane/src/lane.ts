// Orca lane intake: decides, from GitHub state only, whether an Orca bot may
// start or resume a ticket. Pure functions here; poll.ts does the I/O.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CLAUDE_APP_ID = 1236702;
export const DISPATCH_AUTHOR = "BAWES";

export type RowState = "active" | "revoked" | "done";

export interface RegisterRow {
  readonly issue: number;
  readonly slug: string;
  readonly bot: string;
  readonly gen: number;
  readonly mode: "observe" | "work";
  readonly dispatch: number | null;
  readonly lease: string;
  readonly reviewer: string;
  readonly state: RowState;
  readonly expires: Date;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly author: string;
  readonly appId: number | null;
}

export interface WorkDecision {
  readonly issue: number;
  readonly gen: number;
  readonly action: "start" | "resume";
  readonly dispatch: number;
  readonly slug: string;
  readonly claimKey: string;
}

export type Decision =
  | WorkDecision
  | { readonly issue: number; readonly gen: number; readonly action: "observe"; readonly dispatch: number; readonly slug: string; readonly receiptHeader: string }
  | { readonly issue: number; readonly gen: number; readonly action: "skip"; readonly reason: string };

const HEADER = ["Issue", "Slug", "Bot", "Gen", "Mode", "Dispatch", "Lease (paths; migrations)", "Reviewer", "State", "Expires (UTC)"];

const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

const unquote = (value: string): string => value.replace(/^`(.*)`$/, "$1");

export class RegisterError extends Error {}

/** Parses the register table. Any malformed row makes the whole register unusable: no partial reads. */
export function parseRegister(markdown: string): RegisterRow[] {
  const lines = markdown.split("\n");
  const headerAt = lines.findIndex((line) => line.trim().startsWith("| Issue |"));
  if (headerAt < 0) throw new RegisterError("register table not found");
  const header = cells(lines[headerAt]!);
  if (header.join("|") !== HEADER.join("|")) throw new RegisterError(`unexpected register columns: ${header.join(", ")}`);
  const rows: RegisterRow[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(headerAt + 2)) {
    if (!line.trim().startsWith("|")) break;
    const [issue, slug, bot, gen, mode, dispatch, lease, reviewer, state, expires] = cells(line);
    const issueMatch = /^#(\d+)$/.exec(issue ?? "");
    if (!issueMatch) throw new RegisterError(`bad issue cell: ${issue}`);
    if (!/^\d+$/.test(gen ?? "") || Number(gen) < 1) throw new RegisterError(`bad gen for ${issue}: ${gen}`);
    if (mode !== "observe" && mode !== "work") throw new RegisterError(`bad mode for ${issue}: ${mode}`);
    const dispatchText = unquote(dispatch ?? "");
    if (dispatchText !== "-" && !/^\d+$/.test(dispatchText)) throw new RegisterError(`bad dispatch for ${issue}: ${dispatch}`);
    if (state !== "active" && state !== "revoked" && state !== "done") throw new RegisterError(`bad state for ${issue}: ${state}`);
    const expiry = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(expires ?? "");
    if (!expiry) throw new RegisterError(`bad expiry for ${issue}: ${expires}`);
    const key = `${issueMatch[1]}#${gen}`;
    if (seen.has(key)) throw new RegisterError(`duplicate row ${key}`);
    seen.add(key);
    rows.push({
      issue: Number(issueMatch[1]),
      slug: unquote(slug ?? ""),
      bot: bot ?? "",
      gen: Number(gen),
      mode,
      dispatch: dispatchText === "-" ? null : Number(dispatchText),
      lease: lease ?? "",
      reviewer: reviewer ?? "",
      state,
      expires: new Date(`${expiry[1]}T${expiry[2]}:00Z`),
    });
  }
  return rows;
}

export const dispatchHeader = (bot: string, issue: number, gen: number): string =>
  `**Claude → Orca ${bot}** · dispatch · #${issue} gen ${gen}`;

export const observeReceiptHeader = (bot: string, issue: number, gen: number): string =>
  `**Orca ${bot} → Claude** · observe · #${issue} gen ${gen}`;

export const claimKey = (bot: string, issue: number, gen: number): string => `${bot}--${issue}--g${gen}`;

/**
 * Decides per row. Only the exact comment id the row names can authorize work, and
 * only if Claude's app wrote it with the header for this issue and generation.
 * A held claim means the ticket is already ours: resume, never start again.
 * A row in observe mode never starts work: it only reports what it sees.
 */
export function decide(input: {
  readonly rows: readonly RegisterRow[];
  readonly bot: string;
  readonly now: Date;
  readonly comments: ReadonlyMap<number, readonly IssueComment[]>;
  readonly claims: ReadonlySet<string>;
}): Decision[] {
  const decisions: Decision[] = [];
  const latestGen = new Map<number, number>();
  for (const row of input.rows) latestGen.set(row.issue, Math.max(latestGen.get(row.issue) ?? 0, row.gen));
  for (const row of input.rows) {
    if (row.bot !== input.bot) continue;
    const skip = (reason: string): void => { decisions.push({ issue: row.issue, gen: row.gen, action: "skip", reason }); };
    if (row.gen !== latestGen.get(row.issue)) { skip("superseded generation"); continue; }
    if (row.state !== "active") { skip(`state ${row.state}`); continue; }
    if (row.expires.getTime() <= input.now.getTime()) { skip("expired"); continue; }
    if (row.dispatch === null) { skip("no dispatch bound"); continue; }
    const comment = (input.comments.get(row.issue) ?? []).find((candidate) => candidate.id === row.dispatch);
    if (!comment) { skip("bound dispatch comment not found on the issue"); continue; }
    if (comment.author !== DISPATCH_AUTHOR || comment.appId !== CLAUDE_APP_ID) { skip("dispatch not written by Claude's app"); continue; }
    if (comment.body.split("\n")[0]!.trim() !== dispatchHeader(input.bot, row.issue, row.gen)) { skip("dispatch header does not match issue and generation"); continue; }
    if (row.mode === "observe") {
      decisions.push({ issue: row.issue, gen: row.gen, action: "observe", dispatch: comment.id, slug: row.slug, receiptHeader: observeReceiptHeader(input.bot, row.issue, row.gen) });
      continue;
    }
    const key = claimKey(input.bot, row.issue, row.gen);
    decisions.push({ issue: row.issue, gen: row.gen, action: input.claims.has(key) ? "resume" : "start", dispatch: comment.id, slug: row.slug, claimKey: key });
  }
  return decisions;
}

/**
 * Durable, exclusive claim on this machine. mkdir is atomic: of two concurrent
 * pollers exactly one gets "claimed"; the other gets "held" and must not start.
 */
export function claim(dir: string, key: string, record: { readonly dispatch: number; readonly at: string }): "claimed" | "held" {
  mkdirSync(dir, { recursive: true });
  try {
    mkdirSync(path.join(dir, key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "held";
    throw error;
  }
  writeFileSync(path.join(dir, key, "claim.json"), `${JSON.stringify(record)}\n`);
  return "claimed";
}

export function readClaim(dir: string, key: string): { dispatch: number; at: string } | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, key, "claim.json"), "utf8")) as { dispatch: number; at: string };
  } catch {
    return null;
  }
}

/** A run lock older than this is treated as a crashed run and may be taken over (the ticket time box is 4h). */
export const RUN_LOCK_STALE_MS = 4 * 60 * 60 * 1000;

/**
 * Exclusive run lock for one ticket generation: only one process works on a
 * claimed ticket at a time. "busy" means another run holds it; do nothing.
 */
export function acquireRun(dir: string, key: string, now: Date): "acquired" | "busy" {
  const lock = path.join(dir, key, "run");
  mkdirSync(path.join(dir, key), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let since: number;
    try {
      since = Date.parse(readFileSync(path.join(lock, "since"), "utf8"));
    } catch {
      since = Number.NaN;
    }
    if (!Number.isNaN(since) && now.getTime() - since < RUN_LOCK_STALE_MS) return "busy";
    if (Number.isNaN(since) && now.getTime() - statSync(lock).mtimeMs < RUN_LOCK_STALE_MS) return "busy";
    // Stale: take it over by renaming it away atomically, then retry once.
    try {
      renameSync(lock, `${lock}.stale-${now.getTime()}`);
    } catch {
      return "busy";
    }
    try {
      mkdirSync(lock);
    } catch {
      return "busy";
    }
  }
  writeFileSync(path.join(lock, "since"), now.toISOString());
  return "acquired";
}

export function releaseRun(dir: string, key: string): void {
  rmSync(path.join(dir, key, "run"), { recursive: true, force: true });
}
