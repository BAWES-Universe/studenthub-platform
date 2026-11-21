// Orca lane intake: decides, from GitHub state only, whether an Orca bot may
// start or resume a ticket. Pure functions here; poll.ts does the I/O.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /** The lease the claim is taken for; check refuses once the row's lease changes. */
  readonly lease: string;
  /** Header the start receipt must carry; on "resume" with startReceiptPosted false, post it before any work. */
  readonly startReceiptHeader: string;
  readonly startReceiptPosted: boolean;
  /** Set when a parked ticket was sent back: address this changes comment on the same branch and PR, then post a new ready receipt. */
  readonly changesRequested: { readonly head: string; readonly pull: number; readonly comment: number } | null;
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
    const issueMatch = /^#([1-9]\d*)$/.exec(issue ?? "");
    if (!issueMatch) throw new RegisterError(`bad issue cell: ${issue}`);
    if (!/^[1-9]\d*$/.test(gen ?? "")) throw new RegisterError(`bad gen for ${issue}: ${gen}`);
    if (mode !== "observe" && mode !== "work") throw new RegisterError(`bad mode for ${issue}: ${mode}`);
    const dispatchText = unquote(dispatch ?? "");
    if (dispatchText !== "-" && !/^[1-9]\d*$/.test(dispatchText)) throw new RegisterError(`bad dispatch for ${issue}: ${dispatch}`);
    if (state !== "active" && state !== "revoked" && state !== "done") throw new RegisterError(`bad state for ${issue}: ${state}`);
    const expiry = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(expires ?? "");
    if (!expiry) throw new RegisterError(`bad expiry for ${issue}: ${expires}`);
    const expiresAt = new Date(`${expiry[1]}T${expiry[2]}:00Z`);
    // Reject impossible dates (2026-13-01, 2026-02-30) instead of letting them roll over or become NaN.
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString().slice(0, 16) !== `${expiry[1]}T${expiry[2]}`) {
      throw new RegisterError(`bad expiry for ${issue}: ${expires}`);
    }
    if (![Number(issueMatch[1]), Number(gen), dispatchText === "-" ? 1 : Number(dispatchText)].every(Number.isSafeInteger)) {
      throw new RegisterError(`number out of range in row for ${issue}`);
    }
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
      expires: expiresAt,
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

export const readyReceiptHeader = (bot: string, issue: number, gen: number, sha: string): string =>
  `**Orca ${bot} → Claude** · ready · #${issue} gen ${gen} at ${sha}`;

export const changesHeader = (bot: string, issue: number, gen: number, sha: string): string =>
  `**Claude → Orca ${bot}** · changes · #${issue} gen ${gen} at ${sha}`;

const SHA = "[0-9a-f]{40}";
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The open PRs on a ticket's branch, as GitHub reports them now. */
export interface BranchPull { readonly number: number; readonly head: string; readonly base: string; readonly draft: boolean }

export const ticketBranch = (bot: string, slug: string): string => `orca/${bot}/${slug}`;

export type ReviewWait =
  | { readonly state: "parked"; readonly head: string }
  | { readonly state: "held"; readonly reason: string }
  | { readonly state: "sent-back"; readonly head: string; readonly pull: number; readonly changes: number };

/**
 * Review wait. Once the bot posts a ready receipt naming its PR's exact head, the
 * ticket is parked: not eligible for work, but its claim, dispatch, lease and PR
 * stay. Only a later changes comment from Claude's app naming that same head
 * resumes it, and only while the one open, ready PR on the ticket's branch into
 * main still has that head. A ready receipt counts only after the bound dispatch,
 * is the bot's own (never Claude's app), and the latest one wins. A missing PR, a
 * second PR, a draft, another base or a moved head holds the ticket until Claude
 * reviews it explicitly. Returns null when the ticket is not in review.
 */
export function reviewWait(input: {
  readonly comments: readonly IssueComment[];
  readonly bot: string;
  readonly issue: number;
  readonly gen: number;
  readonly dispatch: number;
  readonly pulls: readonly BranchPull[] | undefined;
}): ReviewWait | null {
  const { bot, issue, gen } = input;
  const first = (c: IssueComment): string => c.body.split("\n")[0]!.trim();
  const ready = new RegExp(`^${escape(readyReceiptHeader(bot, issue, gen, ""))}(${SHA})$`);
  const sorted = [...input.comments].sort((a, b) => a.id - b.id);
  const lastReady = sorted.filter((c) => c.id > input.dispatch && c.author === DISPATCH_AUTHOR && c.appId !== CLAUDE_APP_ID && ready.test(first(c))).at(-1);
  if (!lastReady) return null;
  const head = ready.exec(first(lastReady))![1]!;
  const pulls = input.pulls ?? [];
  if (pulls.length !== 1) return { state: "held", reason: `ready at ${head} but ${pulls.length} open PRs on the branch: held for Claude's review` };
  const pull = pulls[0]!;
  if (pull.base !== "main" || pull.draft) return { state: "held", reason: `ready at ${head} but PR #${pull.number} is ${pull.draft ? "a draft" : `into ${pull.base}`}: held for Claude's review` };
  if (pull.head !== head) return { state: "held", reason: `ready at ${head} but PR #${pull.number} head is ${pull.head}: held for Claude's review` };
  const changes = sorted.find((c) => c.id > lastReady.id && c.author === DISPATCH_AUTHOR && c.appId === CLAUDE_APP_ID && first(c) === changesHeader(bot, issue, gen, head));
  return changes ? { state: "sent-back", head, pull: pull.number, changes: changes.id } : { state: "parked", head };
}

const posted = (comments: readonly IssueComment[], header: string): boolean =>
  comments.some((c) => c.author === DISPATCH_AUTHOR && c.body.split("\n")[0]!.trim() === header);

export const claimKey = (bot: string, issue: number, gen: number): string => `${bot}--${issue}--g${gen}`;

/**
 * Decides per row. Only the exact comment id the row names can authorize work, and
 * only if Claude's app wrote it with the header for this issue and generation.
 * A held claim means the ticket is already ours: resume, never start again, and
 * only for the dispatch the claim saved. A row in observe mode never starts work:
 * it only reports what it sees. `claims` maps each held claim key to the dispatch
 * and lease it was taken for; a row whose dispatch or lease has changed since is not resumed.
 */
export function decide(input: {
  readonly rows: readonly RegisterRow[];
  readonly bot: string;
  readonly now: Date;
  readonly comments: ReadonlyMap<number, readonly IssueComment[]>;
  readonly claims: ReadonlyMap<string, ClaimRecord>;
  /** Open PRs per ticket branch (ticketBranch). Only needed once a ticket has a ready receipt; missing means none. */
  readonly pulls?: ReadonlyMap<string, readonly BranchPull[]>;
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
    if (held !== undefined && held.dispatch !== comment.id) { skip(`claim is bound to dispatch ${held.dispatch}, not ${comment.id}`); continue; }
    if (held !== undefined && held.lease !== row.lease) { skip("lease changed since the claim was taken"); continue; }
    const wait = reviewWait({ comments: issueComments, bot: input.bot, issue: row.issue, gen: row.gen, dispatch: comment.id, pulls: input.pulls?.get(ticketBranch(input.bot, row.slug)) });
    if (wait?.state === "held") { skip(wait.reason); continue; }
    if (wait?.state === "parked") { skip(`waiting for review at ${wait.head}`); continue; }
    if (wait && held === undefined) { skip("ready receipt posted but no claim held here: never start twice"); continue; }
    const header = startReceiptHeader(input.bot, row.issue, row.gen);
    decisions.push({
      issue: row.issue, gen: row.gen, action: held === undefined ? "start" : "resume", dispatch: comment.id, slug: row.slug, claimKey: key, lease: row.lease,
      startReceiptHeader: header, startReceiptPosted: posted(issueComments, header),
      changesRequested: wait?.state === "sent-back" ? { head: wait.head, pull: wait.pull, comment: wait.changes } : null,
    });
  }
  return decisions;
}

export interface ClaimRecord { readonly dispatch: number; readonly lease: string; readonly at: string }

/**
 * Publishes a directory holding one file in a single step: the file is written in
 * a private temp directory, which is then renamed into place. A rename onto an
 * existing (non-empty) directory fails, so exactly one publisher wins, and a stop
 * at any point never leaves a half-made directory under the real name.
 */
function publish(dir: string, target: string, file: string, content: string): boolean {
  mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.tmp-${randomUUID()}`);
  mkdirSync(temp);
  writeFileSync(path.join(temp, file), content);
  try {
    renameSync(temp, target);
    return true;
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    if (["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/**
 * Durable, exclusive claim on this machine, recording the dispatch and lease it
 * was taken for. Of two concurrent pollers exactly one gets "claimed"; the other
 * gets "held" and must not start.
 */
export function claim(dir: string, key: string, record: ClaimRecord): "claimed" | "held" {
  return publish(dir, path.join(dir, key), "claim.json", `${JSON.stringify(record)}\n`) ? "claimed" : "held";
}

export function readClaim(dir: string, key: string): ClaimRecord | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, key, "claim.json"), "utf8")) as ClaimRecord;
  } catch {
    return null;
  }
}

export interface RunLock { readonly key: string; readonly token: string; readonly since: string }

/*
 * The bot-wide run lock is a sequence of numbered slots in `.run-<bot>/`. Each
 * acquisition publishes the next slot (1, 2, 3, ...) whole, and only if the
 * latest slot is released; of two acquirers only one can publish a given number.
 * Releasing writes a `released` marker into the holder's own slot and deletes
 * nothing. So a late or duplicated release or recovery, with any key or token,
 * can only ever touch the slot that token owns; it can never clear a successor.
 */
const slotsDir = (dir: string, bot: string): string => path.join(dir, `.run-${bot}`);

interface Slot { readonly n: number; readonly owner: RunLock; readonly released: boolean }

function slots(dir: string, bot: string): Slot[] {
  const base = slotsDir(dir, bot);
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => /^[1-9]\d*$/.test(name)).map(Number).sort((a, b) => a - b).map((n) => ({
    n,
    owner: JSON.parse(readFileSync(path.join(base, String(n), "owner.json"), "utf8")) as RunLock,
    released: existsSync(path.join(base, String(n), "released")),
  }));
}

/**
 * Bot-wide run lock, held for the whole execution of one ticket run and fenced by
 * a token. While it is held no other ticket, and no other generation of the same
 * ticket, can start or resume, even after the holder's row is revoked or expired.
 * It is never taken over by age. Only the holder's key and token free it: by
 * release at the end of a run, or by recover after the holder is verified stopped.
 */
export function acquireRun(dir: string, bot: string, key: string, now: Date, token: string): "acquired" | "busy" {
  const latest = slots(dir, bot).at(-1);
  if (latest && !latest.released) return "busy";
  const base = slotsDir(dir, bot);
  mkdirSync(base, { recursive: true });
  const owner = `${JSON.stringify({ key, token, since: now.toISOString() })}\n`;
  return publish(base, path.join(base, String((latest?.n ?? 0) + 1)), "owner.json", owner) ? "acquired" : "busy";
}

/** The current holder of the run lock, or null if it is free. */
export function readRun(dir: string, bot: string): RunLock | null {
  const latest = slots(dir, bot).at(-1);
  return latest && !latest.released ? latest.owner : null;
}

/** True only if the bot's run lock is held now for this ticket generation with this token. */
export function holdsRun(dir: string, bot: string, key: string, token: string): boolean {
  const owner = readRun(dir, bot);
  return owner !== null && owner.key === key && owner.token === token;
}

/** Frees the run lock only for its current holder; any other key or token, or a repeat, changes nothing. */
export function releaseRun(dir: string, bot: string, key: string, token: string): "released" | "not-owner" {
  const latest = slots(dir, bot).at(-1);
  if (!latest || latest.released || latest.owner.key !== key || latest.owner.token !== token) return "not-owner";
  try {
    writeFileSync(path.join(slotsDir(dir, bot), String(latest.n), "released"), "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "not-owner";
    throw error;
  }
  return "released";
}

/**
 * Frees a run lock left by a run that is verified stopped. Manual only: the bot
 * pauses its schedule and confirms no run is active first. It is bound to the
 * exact run (key and token, as the poll's runLock shows them), so it can only
 * free that run's slot, never a later one.
 */
export function recoverRun(dir: string, bot: string, key: string, token: string): "recovered" | "not-owner" {
  return releaseRun(dir, bot, key, token) === "released" ? "recovered" : "not-owner";
}
