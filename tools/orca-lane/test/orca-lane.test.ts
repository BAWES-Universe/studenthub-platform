import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireRun, CLAUDE_APP_ID, claim, claimKey, decide, dispatchHeader, holdsRun, parseRegister, readClaim, recoverRun, RegisterError, releaseRun, startReceiptHeader, type IssueComment } from "../src/lane.js";
import { heldClaims, pickNext } from "../src/poll.js";

const BOT = "studenthub-universe";
const NOW = new Date("2026-11-21T12:00:00Z");
const HEAD = "| Issue | Slug | Bot | Gen | Mode | Dispatch | Lease (paths; migrations) | Reviewer | State | Expires (UTC) |\n|---|---|---|---|---|---|---|---|---|---|\n";
const row = (issue: number, gen: number, dispatch: string, state = "active", expires = "2026-11-22 18:00", bot = BOT, mode = "work"): string =>
  `| #${issue} | \`slug-${issue}\` | ${bot} | ${gen} | ${mode} | ${dispatch} | \`docs/x-${issue}.md\` only; no migrations | Claude | ${state} | ${expires} |\n`;
const register = (...rows: string[]): string => `# Orca lane register\n\nPreamble.\n\n${HEAD}${rows.join("")}`;
const dispatch = (id: number, issue: number, gen: number, extra: Partial<IssueComment> = {}): IssueComment =>
  ({ id, body: `${dispatchHeader(BOT, issue, gen)}\n\n@orca-ide ${BOT}`, author: "BAWES", appId: CLAUDE_APP_ID, ...extra });
// claims: [claimKey, saved dispatch, saved lease?] (lease defaults to the test row's lease for that issue)
const leaseOf = (key: string): string => `\`docs/x-${key.split("--")[1]}.md\` only; no migrations`;
const run = (markdown: string, comments: Record<number, IssueComment[]>, claims: ([string, number] | [string, number, string])[] = []) =>
  decide({ rows: parseRegister(markdown), bot: BOT, now: NOW, comments: new Map(Object.entries(comments).map(([k, v]) => [Number(k), v])),
    claims: new Map(claims.map(([key, dispatch, lease]) => [key, { dispatch, lease: lease ?? leaseOf(key), at: "t" }])) });
const acquire = (dir: string) => (d: { claimKey: string }) => { const t = `t-${Math.random()}`; return acquireRun(dir, BOT, d.claimKey, NOW, t) === "acquired" ? t : null; };

test("the live register on main parses", () => {
  const live = readFileSync(path.join(process.cwd(), "docs/lanes/orca/REGISTER.md"), "utf8");
  assert.ok(parseRegister(live).length >= 1);
});

test("only the exact bound comment id authorizes work", () => {
  const md = register(row(581, 2, "`900`"));
  assert.deepEqual(run(md, { 581: [dispatch(900, 581, 2)] }).map((d) => d.action), ["start"]);
  assert.match(JSON.stringify(run(md, { 581: [dispatch(899, 581, 2)] })), /bound dispatch comment not found/);
});

test("a dispatch from before reactivation stays ineligible: old gen 1 comment cannot start gen 2", () => {
  const md = register(row(581, 1, "`800`", "revoked"), row(581, 2, "`900`"));
  const decisions = run(md, { 581: [dispatch(800, 581, 1), dispatch(900, 581, 2)] });
  assert.deepEqual(decisions.map((d) => [d.gen, d.action]), [[1, "skip"], [2, "start"]]);
  // Even if gen 2 named the old comment, its header binds it to gen 1.
  const reused = register(row(581, 1, "`800`", "revoked"), row(581, 2, "`800`"));
  assert.match(JSON.stringify(run(reused, { 581: [dispatch(800, 581, 1)] })), /header does not match/);
});

test("an older generation row never authorizes work even if left active", () => {
  const md = register(row(581, 1, "`800`"), row(581, 2, "-"));
  assert.deepEqual(run(md, { 581: [dispatch(800, 581, 1)] }).map((d) => d.action), ["skip", "skip"]);
});

test("ticket A survives an edit to ticket B's row", () => {
  const before = register(row(581, 1, "`900`"));
  const after = register(row(581, 1, "`900`"), row(590, 1, "`950`", "revoked"));
  const comments = { 581: [dispatch(900, 581, 1)], 590: [dispatch(950, 590, 1)] };
  const a = (md: string) => run(md, comments).find((d) => d.issue === 581)!.action;
  assert.equal(a(before), "start");
  assert.equal(a(after), "start");
});

test("expiry housekeeping on A's row keeps the same binding", () => {
  const comments = { 581: [dispatch(900, 581, 1)] };
  assert.equal(run(register(row(581, 1, "`900`", "active", "2026-11-23 18:00")), comments)[0]!.action, "start");
  assert.match(JSON.stringify(run(register(row(581, 1, "`900`", "active", "2026-11-21 11:00")), comments)), /expired/);
});

test("dispatches not written by Claude's app, or for another issue, are rejected", () => {
  const md = register(row(581, 1, "`900`"));
  assert.match(JSON.stringify(run(md, { 581: [dispatch(900, 581, 1, { appId: null })] })), /not written by Claude/);
  assert.match(JSON.stringify(run(md, { 581: [dispatch(900, 581, 1, { author: "someone" })] })), /not written by Claude/);
  assert.match(JSON.stringify(run(md, { 581: [dispatch(900, 582, 1)] })), /header does not match/);
});

test("rows for other bots and unbound rows are ignored or skipped", () => {
  const md = register(row(581, 1, "-"), row(600, 1, "`700`", "active", "2026-11-22 18:00", "other-bot"));
  assert.deepEqual(run(md, {}).map((d) => [d.issue, d.action]), [[581, "skip"]]);
});

test("observe mode reports the eligible dispatch but never claims or starts", () => {
  const md = register(row(581, 2, "`900`", "active", "2026-11-22 18:00", BOT, "observe"));
  const decisions = run(md, { 581: [dispatch(900, 581, 2)] });
  assert.deepEqual(decisions.map((d) => d.action), ["observe"]);
  const observed = decisions[0]!;
  assert.ok(observed.action === "observe" && !observed.receiptPosted && observed.receiptBody.startsWith(observed.receiptHeader) && observed.receiptBody.includes("900"));
  const again = run(md, { 581: [dispatch(900, 581, 2), { id: 901, body: `${observed.action === "observe" ? observed.receiptHeader : ""}\n\nx`, author: "BAWES", appId: null }] })[0]!;
  assert.ok(again.action === "observe" && again.receiptPosted);
  assert.equal(pickNext(decisions, () => { throw new Error("must not claim"); }, () => { throw new Error("must not lock"); }), null);
});

test("a resume stays bound to the lease its claim saved", () => {
  const md = register(row(581, 1, "`900`"));
  assert.match(JSON.stringify(run(md, { 581: [dispatch(900, 581, 1)] }, [[claimKey(BOT, 581, 1), 900, "`docs/other.md` only; no migrations"]])), /lease changed/);
});

test("claims and run locks are published whole: a leftover temp directory blocks nothing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-atomic-"));
  mkdirSync(path.join(dir, ".tmp-leftover"));
  assert.equal(claim(dir, claimKey(BOT, 581, 1), { dispatch: 900, lease: "l", at: "t" }), "claimed");
  assert.equal(readClaim(dir, claimKey(BOT, 581, 1))?.lease, "l");
  assert.equal(acquireRun(dir, BOT, claimKey(BOT, 581, 1), NOW, "A"), "acquired");
  assert.equal(holdsRun(dir, BOT, claimKey(BOT, 581, 1), "A"), true);
});

test("a malformed register is refused as a whole", () => {
  assert.throws(() => parseRegister(register(row(581, 0, "`900`"))), RegisterError);
  assert.throws(() => parseRegister(register(row(581, 1, "abc"))), RegisterError);
  assert.throws(() => parseRegister(register(row(581, 1, "`900`"), row(581, 1, "`901`"))), RegisterError);
  assert.throws(() => parseRegister(register(row(581, 1, "`900`"), row(581, "01" as unknown as number, "`901`"))), RegisterError);
  assert.throws(() => parseRegister(register(row(581, 1, "`900`", "active", "2026-13-22 18:00"))), RegisterError);
  assert.throws(() => parseRegister(register(row(581, "9007199254740993" as unknown as number, "`900`"))), RegisterError);
  assert.throws(() => parseRegister(register(row(581, 1, "`9007199254740993`"))), RegisterError);
  assert.throws(() => parseRegister(register(row(581, 1, "`900`", "active", "2026-02-30 18:00"))), RegisterError);
  assert.throws(() => parseRegister("# no table"), RegisterError);
  assert.throws(() => parseRegister(register(row(581, 1, "`900`", "active", "2026-11-22 18:00", BOT, "maybe"))), RegisterError);
});

test("concurrent wakes: exactly one claim wins, the other must not start", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-claims-"));
  const key = claimKey(BOT, 581, 1);
  const results = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => claim(dir, key, { dispatch: 900, lease: "l", at: "t" }))));
  assert.equal(results.filter((r) => r === "claimed").length, 1);
  assert.equal(readClaim(dir, key)?.dispatch, 900);
});

test("restart after an ambiguous receipt resumes the claimed ticket instead of starting again", () => {
  const md = register(row(581, 1, "`900`"));
  const decisions = run(md, { 581: [dispatch(900, 581, 1)] }, [[claimKey(BOT, 581, 1), 900]]);
  assert.deepEqual(decisions.map((d) => d.action), ["resume"]);
  // The start receipt never landed: resume says so, and the bot posts it before any work.
  assert.ok(decisions[0]!.action === "resume" && decisions[0]!.startReceiptPosted === false);
  let claimed = 0;
  assert.equal(pickNext(decisions, () => { claimed += 1; return "claimed"; }, () => "tok")?.action, "resume");
  assert.equal(claimed, 0);
  const receipt: IssueComment = { id: 905, body: `${startReceiptHeader(BOT, 581, 1)}\n\ndispatch 900`, author: "BAWES", appId: null };
  const after = run(md, { 581: [dispatch(900, 581, 1), receipt] }, [[claimKey(BOT, 581, 1), 900]]);
  assert.ok(after[0]!.action === "resume" && after[0]!.startReceiptPosted === true);
});

test("a resume stays bound to the dispatch its claim saved", () => {
  const md = register(row(581, 1, "`901`"));
  assert.match(JSON.stringify(run(md, { 581: [dispatch(901, 581, 1)] }, [[claimKey(BOT, 581, 1), 900]])), /claim is bound to dispatch 900/);
});

test("one ticket at a time: an owned ticket blocks new starts; a lost claim race does nothing", () => {
  const md = register(row(581, 1, "`900`"), row(590, 1, "`950`"));
  const comments = { 581: [dispatch(900, 581, 1)], 590: [dispatch(950, 590, 1)] };
  const owned = run(md, comments, [[claimKey(BOT, 590, 1), 950]]);
  assert.equal(pickNext(owned, () => "claimed", () => "tok")?.issue, 590);
  assert.equal(pickNext(run(md, comments), () => "held", () => "tok"), null);
});

test("a second wake while a run holds the lock does nothing; only the holder's release frees it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-run-"));
  const key = claimKey(BOT, 581, 1);
  assert.equal(acquireRun(dir, BOT, key, NOW, "A"), "acquired");
  assert.equal(acquireRun(dir, BOT, key, NOW, "B"), "busy");
  const decisions = run(register(row(581, 1, "`900`")), { 581: [dispatch(900, 581, 1)] }, [[key, 900]]);
  assert.equal(pickNext(decisions, () => "claimed", acquire(dir)), null);
  assert.equal(releaseRun(dir, BOT, key, "B"), "not-owner");
  assert.equal(pickNext(decisions, () => "claimed", acquire(dir)), null);
  assert.equal(releaseRun(dir, BOT, key, "A"), "released");
  assert.equal(pickNext(decisions, () => "claimed", acquire(dir))?.action, "resume");
});

test("a revoked run that is still alive blocks every new run until it is verified stopped", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-fence-"));
  const g1 = claimKey(BOT, 581, 1);
  const g2 = claimKey(BOT, 581, 2);
  assert.equal(claim(dir, g1, { dispatch: 900, lease: "l", at: "t" }), "claimed");
  assert.equal(acquireRun(dir, BOT, g1, NOW, "A"), "acquired");
  // Claude revokes gen 1 and dispatches gen 2 (and another ticket), while A still runs.
  const md = register(row(581, 1, "`900`", "revoked"), row(581, 2, "`910`"), row(590, 1, "`950`"));
  const comments = { 581: [dispatch(900, 581, 1), dispatch(910, 581, 2)], 590: [dispatch(950, 590, 1)] };
  const decisions = run(md, comments, [[g1, 900]]);
  // A's generation is no longer eligible, so A's pre-write check fails...
  assert.equal(decisions.some((d) => (d.action === "start" || d.action === "resume") && d.claimKey === g1), false);
  // ...but while A has not stopped, B is refused for gen 2 and for any other ticket. A late poll still waits: no takeover by age.
  assert.equal(acquireRun(dir, BOT, g2, new Date(NOW.getTime() + 24 * 3600_000), "B"), "busy");
  assert.equal(acquireRun(dir, BOT, claimKey(BOT, 590, 1), NOW, "B"), "busy");
  // Nobody else can clear A's lock: not a wrong token, not a recover naming another key.
  assert.equal(releaseRun(dir, BOT, g1, "B"), "not-owner");
  assert.equal(recoverRun(dir, BOT, g2, "A"), "not-owner");
  // A stops and releases (its verified stop). Now B starts gen 2.
  assert.equal(releaseRun(dir, BOT, g1, "A"), "released");
  const b = pickNext(decisions, (d) => claim(dir, d.claimKey, { dispatch: d.dispatch, lease: d.lease, at: "t" }), (d) => acquireRun(dir, BOT, d.claimKey, NOW, "B") === "acquired" ? "B" : null);
  assert.equal(b?.claimKey, g2);
  // A, if it wakes again, cannot write (its key and token no longer hold the lock) and cannot clear B.
  assert.equal(holdsRun(dir, BOT, g1, "A"), false);
  assert.equal(releaseRun(dir, BOT, g1, "A"), "not-owner");
  assert.equal(holdsRun(dir, BOT, g2, "B"), true);
  // A third wake C is refused while B runs.
  assert.equal(pickNext(decisions, () => "claimed", acquire(dir)), null);
});

test("recovery is bound to the exact run, and a late or repeated release or recovery never clears a successor", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-recover-"));
  const g1 = claimKey(BOT, 581, 1);
  assert.equal(acquireRun(dir, BOT, g1, NOW, "A"), "acquired");
  // A crashed. Recovery needs A's exact key and token, as runLock shows them.
  assert.equal(recoverRun(dir, BOT, claimKey(BOT, 581, 2), "A"), "not-owner");
  assert.equal(recoverRun(dir, BOT, g1, "other"), "not-owner");
  assert.equal(holdsRun(dir, BOT, g1, "A"), true);
  assert.equal(recoverRun(dir, BOT, g1, "A"), "recovered");
  // The same generation runs again as C (same key, new token).
  assert.equal(acquireRun(dir, BOT, g1, NOW, "C"), "acquired");
  // A delayed duplicate of the recovery, or a late release by A itself, arrives now: C keeps the lock.
  assert.equal(recoverRun(dir, BOT, g1, "A"), "not-owner");
  assert.equal(releaseRun(dir, BOT, g1, "A"), "not-owner");
  assert.equal(holdsRun(dir, BOT, g1, "C"), true);
  assert.equal(acquireRun(dir, BOT, g1, NOW, "D"), "busy");
  // C releases once; a repeat does nothing.
  assert.equal(releaseRun(dir, BOT, g1, "C"), "released");
  assert.equal(releaseRun(dir, BOT, g1, "C"), "not-owner");
});

test("two acquirers racing for the next lock slot: exactly one wins", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-slot-race-"));
  const results = ["A", "B", "C", "D"].map((t) => acquireRun(dir, BOT, claimKey(BOT, 581, 1), NOW, t));
  assert.equal(results.filter((r) => r === "acquired").length, 1);
});


test("one poll at a time gets past the run lock; a poll whose pick went stale under the lock backs out", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-serial-"));
  const md1 = register(row(581, 1, "`900`"), row(590, 1, "`950`"));
  const comments = { 581: [dispatch(900, 581, 1)], 590: [dispatch(950, 590, 1)] };
  const claimIt = (d: { claimKey: string; dispatch: number; lease: string }) => claim(dir, d.claimKey, { dispatch: d.dispatch, lease: d.lease, at: "t" });
  const lockIt = (token: string) => (d: { claimKey: string }) => (acquireRun(dir, BOT, d.claimKey, NOW, token) === "acquired" ? token : null);
  const undo = (d: { claimKey: string }, token: string) => { releaseRun(dir, BOT, d.claimKey, token); };
  // P1 read decisions before P2 claimed 581 and later released. Under the lock P1 re-reads: 581 is now owned (resume), so P1 takes it as a resume, never a second start.
  const p1Before = run(md1, comments);
  const p2 = pickNext(run(md1, comments), claimIt, lockIt("P2"), undo);
  assert.equal(p2?.claimKey, claimKey(BOT, 581, 1));
  assert.equal(pickNext(p1Before, claimIt, lockIt("P1"), undo, () => run(md1, comments, [[claimKey(BOT, 581, 1), 900]])), null);
  assert.equal(releaseRun(dir, BOT, claimKey(BOT, 581, 1), "P2"), "released");
  // P1's stale pick says start 590 (say 581's row moved after it); under the lock the fresh pick is resume 581: P1 backs out and frees the lock.
  const stale = run(register(row(590, 1, "`950`")), { 590: [dispatch(950, 590, 1)] });
  assert.equal(pickNext(stale, claimIt, lockIt("P1"), undo, () => run(md1, comments, [[claimKey(BOT, 581, 1), 900]])), null);
  assert.equal(readClaim(dir, claimKey(BOT, 590, 1)), null);
  assert.equal(acquireRun(dir, BOT, claimKey(BOT, 581, 1), NOW, "P3"), "acquired");
});

test("claims that can't be read fail closed; a missing claims directory means no claims", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-claims-read-"));
  assert.equal(heldClaims(path.join(dir, "absent")).size, 0);
  writeFileSync(path.join(dir, "not-a-dir"), "x");
  assert.throws(() => heldClaims(path.join(dir, "not-a-dir")));
});
