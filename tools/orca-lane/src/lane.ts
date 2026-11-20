// Orca lane intake: decides, from GitHub state only, whether an Orca bot may
// start or resume a ticket. Pure functions here; poll.ts does the I/O.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /** Header the start receipt must carry; on "resume" with startReceiptPosted false, post it before any work. */
  readonly startReceiptHeader: string;
  readonly startReceiptPosted: boolean;
}

export interface ObserveDecision {
  readonly issue: number;
  readonly gen: number;
  readonly action: "observe";
  readonly dispatch: number;
  readonly slug: string;
  readonly receiptHeader: string;
  /** The exact comment to post, once, if receiptPosted is false. */
  readonly receiptBody: string;
  readonly receiptPosted: boolean;
}

export type Decision =
  | WorkDecision
  | ObserveDecision
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

export const startReceiptHeader = (bot: string, issue: number, gen: number): string =>
  `**Orca ${bot} → Claude** · start · #${issue} gen ${gen}`;

const posted = (comments: readonly IssueComment[], header: string): boolean =>
  comments.some((c) => c.author === DISPATCH_AUTHOR && c.body.split("\n")[0]!.trim() === header);

export const claimKey = (bot: string, issue: number, gen: number): string => `${bot}--${issue}--g${gen}`;

/**
 * Decides per row. Only the exact comment id the row names can authorize work, and
 * only if Claude's app wrote it with the header for this issue and generation.
 * A held claim means the ticket is already ours: resume, never start again, and
 * only for the dispatch the claim saved. A row in observe mode never starts work:
 * it only reports what it sees. `claims` maps each held claim key to its dispatch.
 */
export function decide(input: {
  readonly rows: readonly RegisterRow[];
  readonly bot: string;
  readonly now: Date;
  readonly comments: ReadonlyMap<number, readonly IssueComment[]>;
  readonly claims: ReadonlyMap<string, number>;
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
    const issueComments = input.comments.get(row.issue) ?? [];
    const comment = issueComments.find((candidate) => candidate.id === row.dispatch);
    if (!comment) { skip("bound dispatch comment not found on the issue"); continue; }
    if (comment.author !== DISPATCH_AUTHOR || comment.appId !== CLAUDE_APP_ID) { skip("dispatch not written by Claude's app"); continue; }
    if (comment.body.split("\n")[0]!.trim() !== dispatchHeader(input.bot, row.issue, row.gen)) { skip("dispatch header does not match issue and generation"); continue; }
    if (row.mode === "observe") {
      const receiptHeader = observeReceiptHeader(input.bot, row.issue, row.gen);
      decisions.push({
        issue: row.issue, gen: row.gen, action: "observe", dispatch: comment.id, slug: row.slug, receiptHeader,
        receiptBody: `${receiptHeader}\n\nBound dispatch ${comment.id} on #${row.issue} gen ${row.gen}. Observe only: no claim, no work.`,
        receiptPosted: posted(issueComments, receiptHeader),
      });
      continue;
    }
    const key = claimKey(input.bot, row.issue, row.gen);
    const held = input.claims.get(key);
    if (held !== undefined && held !== comment.id) { skip(`claim is bound to dispatch ${held}, not ${comment.id}`); continue; }
    const header = startReceiptHeader(input.bot, row.issue, row.gen);
    decisions.push({
      issue: row.issue, gen: row.gen, action: held === undefined ? "start" : "resume", dispatch: comment.id, slug: row.slug, claimKey: key,
      startReceiptHeader: header, startReceiptPosted: posted(issueComments, header),
    });
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

/**
 * Exclusive run lock for one ticket generation, fenced by a token. There is no
 * takeover by age: a lock is freed only by its owner's release. If a run dies
 * holding it, Claude recovers by revoking the row and dispatching a new
 * generation, which has a new claim and lock; the old token then fails check.
 */
export function acquireRun(dir: string, key: string, now: Date, token: string): "acquired" | "busy" {
  const lock = path.join(dir, key, "run");
  mkdirSync(path.join(dir, key), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "busy";
    throw error;
  }
  writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ token, since: now.toISOString() })}\n`);
  return "acquired";
}

/** True only if the run lock for this key exists and carries this token. */
export function holdsRun(dir: string, key: string, token: string): boolean {
  try {
    return (JSON.parse(readFileSync(path.join(dir, key, "run", "owner.json"), "utf8")) as { token: string }).token === token;
  } catch {
    return false;
  }
}

/** Frees the run lock only for its owner; any other token changes nothing. */
export function releaseRun(dir: string, key: string, token: string): "released" | "not-owner" {
  if (!holdsRun(dir, key, token)) return "not-owner";
  rmSync(path.join(dir, key, "run"), { recursive: true, force: true });
  return "released";
}

/**
 * Bot-wide gate around choosing a ticket, so two polls of one bot never pick at
 * the same time. Held only for the pick. A gate left by a dead poll process (its
 * pid no longer alive) is cleared; a live one means "busy": do nothing now.
 */
export function withGate<T>(dir: string, bot: string, pid: number, isAlive: (pid: number) => boolean, fn: () => T): T | "busy" {
  mkdirSync(dir, { recursive: true });
  const gate = path.join(dir, `.gate-${bot}`);
  const enter = (): boolean => {
    try {
      mkdirSync(gate);
      writeFileSync(path.join(gate, "pid"), String(pid));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };
  if (!enter()) {
    let owner = Number.NaN;
    try { owner = Number(readFileSync(path.join(gate, "pid"), "utf8")); } catch { /* being written */ }
    if (Number.isNaN(owner) || isAlive(owner)) return "busy";
    try { renameSync(gate, `${gate}.dead-${owner}-${pid}`); } catch { return "busy"; }
    rmSync(`${gate}.dead-${owner}-${pid}`, { recursive: true, force: true });
    if (!enter()) return "busy";
  }
  try {
    return fn();
  } finally {
    rmSync(gate, { recursive: true, force: true });
  }
}
