import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireRun, CLAUDE_APP_ID, changesHeader, claim, claimKey, decide, dispatchHeader, expectHead, readExpected, holdsRun, parseRegister, readClaim, recoverRun, RegisterError, readyReceiptHeader, releaseRun, startReceiptHeader, ticketBranch, type BranchPull, type ExpectedHead, type IssueComment } from "../src/lane.js";
import { checkRun, heldClaims, pickNext } from "../src/poll.js";
import type { WorkDecision } from "../src/lane.js";

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
const run = (markdown: string, comments: Record<number, IssueComment[]>, claims: ([string, number] | [string, number, string])[] = [], pulls: Record<string, BranchPull[]> = {}, running?: { key: string; expected: ExpectedHead | null }) =>
  decide({ ...(running ? { running } : {}), rows: parseRegister(markdown), bot: BOT, now: NOW, comments: new Map(Object.entries(comments).map(([k, v]) => [Number(k), v])),
    claims: new Map(claims.map(([key, dispatch, lease]) => [key, { dispatch, lease: lease ?? leaseOf(key), at: "t" }])),
    pulls: new Map(Object.entries(pulls)) });
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

test("a done ticket whose claim is still held never resumes ahead of a new eligible ticket", () => {
  const md = register(row(581, 2, "`900`", "done"), row(600, 1, "`960`"));
  const comments = { 581: [dispatch(900, 581, 2)], 600: [dispatch(960, 600, 1)] };
  const decisions = run(md, comments, [[claimKey(BOT, 581, 2), 900]]);
  assert.deepEqual(decisions.map((d) => [d.issue, d.action]), [[581, "skip"], [600, "start"]]);
  assert.match(JSON.stringify(decisions[0]), /state done/);
  assert.equal(pickNext(decisions, () => "claimed", () => "tok")?.issue, 600);
  // Closed out with nothing else eligible: the held claim stays idle, nothing to pick.
  assert.equal(pickNext(run(register(row(581, 2, "`900`", "done")), comments, [[claimKey(BOT, 581, 2), 900]]), () => "claimed", () => "tok"), null);
});

const HEAD_1 = "1".repeat(40);
const HEAD_2 = "2".repeat(40);
const ready = (id: number, issue: number, gen: number, sha: string, extra: Partial<IssueComment> = {}): IssueComment =>
  ({ id, body: `${readyReceiptHeader(BOT, issue, gen, sha)}\n\nPR #700 ready at ${sha}`, author: "BAWES", appId: null, ...extra });
const changes = (id: number, issue: number, gen: number, sha: string, extra: Partial<IssueComment> = {}): IssueComment =>
  ({ id, body: `${changesHeader(BOT, issue, gen, sha)}\n\nBLOCK: fix the link`, author: "BAWES", appId: CLAUDE_APP_ID, ...extra });
const prA = (head: string, extra: Partial<BranchPull> = {}): Record<string, BranchPull[]> =>
  ({ [ticketBranch(BOT, "slug-581")]: [{ number: 700, head, base: "main", draft: false, ...extra }] });

test("review wait: an interrupted active ticket still resumes first", () => {
  const md = register(row(581, 1, "`900`"), row(590, 1, "`950`"));
  const comments = { 581: [dispatch(900, 581, 1)], 590: [dispatch(950, 590, 1)] };
  const decisions = run(md, comments, [[claimKey(BOT, 581, 1), 900]]);
  const next = pickNext(decisions, () => "claimed", () => "tok");
  assert.equal(next?.issue, 581);
  assert.equal(next?.action, "resume");
  assert.equal(next?.changesRequested, null);
});

test("review wait: a ticket parked at its PR's ready head lets the other ticket start, keeping its claim", () => {
  const md = register(row(581, 1, "`900`"), row(590, 1, "`950`"));
  const comments = { 581: [dispatch(900, 581, 1), ready(910, 581, 1, HEAD_1)], 590: [dispatch(950, 590, 1)] };
  const decisions = run(md, comments, [[claimKey(BOT, 581, 1), 900]], prA(HEAD_1));
  assert.match(JSON.stringify(decisions.find((d) => d.issue === 581)), new RegExp(`waiting for review at ${HEAD_1}`));
  assert.equal(pickNext(decisions, () => "claimed", () => "tok")?.issue, 590);
  assert.ok(decisions.every((d) => !(d.issue === 581 && d.action === "start")));
});

test("review wait: only Claude's changes request at the PR's current head resumes the same PR, never a second start", () => {
  const md = register(row(581, 1, "`900`"), row(590, 1, "`950`"));
  const base = [dispatch(900, 581, 1), { id: 905, body: `${startReceiptHeader(BOT, 581, 1)}\n\ndispatch 900`, author: "BAWES", appId: null }, ready(910, 581, 1, HEAD_1)];
  const pick = (extra: IssueComment[], pulls = prA(HEAD_1)) => {
    const decisions = run(md, { 581: [...base, ...extra], 590: [dispatch(950, 590, 1)] }, [[claimKey(BOT, 581, 1), 900]], pulls);
    return { decisions, next: pickNext(decisions, () => "claimed", () => "tok") };
  };
  // Trusted, exact head, after the ready receipt, PR still at that head: resume A on its claim.
  const sent = pick([changes(920, 581, 1, HEAD_1)]);
  assert.equal(sent.next?.issue, 581);
  assert.equal(sent.next?.action, "resume");
  assert.equal(sent.next?.startReceiptPosted, true);
  assert.deepEqual(sent.next?.changesRequested, { head: HEAD_1, pull: 700, comment: 920 });
  // None of these resume A: a different head, not Claude's app, or written before the ready receipt, or for another issue.
  for (const bad of [changes(920, 581, 1, HEAD_2), changes(920, 581, 1, HEAD_1, { appId: null }), changes(908, 581, 1, HEAD_1), changes(920, 590, 1, HEAD_1)]) {
    assert.equal(pick([bad]).next?.issue, 590);
  }
  // A new ready receipt at the fixed head parks A again; the old changes request no longer counts.
  assert.equal(pick([changes(920, 581, 1, HEAD_1), ready(930, 581, 1, HEAD_2)], prA(HEAD_2)).next?.issue, 590);
  // A ready receipt written through Claude's app can't park or unpark anything.
  assert.equal(pick([ready(915, 581, 1, HEAD_2, { appId: CLAUDE_APP_ID })]).next?.issue, 590);
  // With the claim lost, a parked ticket is skipped rather than started twice.
  const lost = run(md, { 581: [...base, changes(920, 581, 1, HEAD_1)], 590: [dispatch(950, 590, 1)] }, [], prA(HEAD_1));
  assert.match(JSON.stringify(lost.find((d) => d.issue === 581)), /never start twice/);
});

test("review wait: a stale head, a missing or extra PR, a draft or another base holds the ticket for explicit review", () => {
  const md = register(row(581, 1, "`900`"), row(590, 1, "`950`"));
  const comments = { 581: [dispatch(900, 581, 1), ready(910, 581, 1, HEAD_1), changes(920, 581, 1, HEAD_1)], 590: [dispatch(950, 590, 1)] };
  const branch = ticketBranch(BOT, "slug-581");
  const cases: [Record<string, BranchPull[]>, RegExp][] = [
    [prA(HEAD_2), new RegExp(`PR #700 head is ${HEAD_2}`)],
    [{}, /0 open PRs/],
    [{ [branch]: [] }, /0 open PRs/],
    [{ [branch]: [...prA(HEAD_1)[branch]!, { number: 701, head: HEAD_1, base: "main", draft: false }] }, /2 open PRs/],
    [prA(HEAD_1, { draft: true }), /is a draft/],
    [prA(HEAD_1, { base: "release" }), /into release/],
  ];
  for (const [pulls, reason] of cases) {
    const decisions = run(md, comments, [[claimKey(BOT, 581, 1), 900]], pulls);
    const a = decisions.find((d) => d.issue === 581)!;
    assert.equal(a.action, "skip");
    assert.match(JSON.stringify(a), reason);
    assert.match(JSON.stringify(a), /held for Claude's review/);
    assert.equal(pickNext(decisions, () => "claimed", () => "tok")?.issue, 590);
  }
  // A ready receipt from before the bound dispatch doesn't count at all: the ticket is not in review.
  const early = run(md, { 581: [ready(890, 581, 1, HEAD_1), dispatch(900, 581, 1)], 590: [dispatch(950, 590, 1)] }, [[claimKey(BOT, 581, 1), 900]]);
  assert.equal(early.find((d) => d.issue === 581)!.action, "resume");
});

test("review wait: full revision cycle from parked to changes to a new ready head, release and re-park; unexplained drift still holds", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-cycle-"));
  const md = register(row(581, 1, "`900`"), row(590, 1, "`950`"));
  const keyA = claimKey(BOT, 581, 1);
  const claims: [string, number][] = [[keyA, 900]];
  const a = [dispatch(900, 581, 1), { id: 905, body: `${startReceiptHeader(BOT, 581, 1)}\n\ndispatch 900`, author: "BAWES", appId: null } as IssueComment, ready(910, 581, 1, HEAD_1)];
  const b = [dispatch(950, 590, 1), ready(960, 590, 1, HEAD_2)];
  const prB = { [ticketBranch(BOT, "slug-590")]: [{ number: 701, head: HEAD_2, base: "main", draft: false }] };
  const pulls = (headA: string) => ({ ...prA(headA), ...prB });
  const fresh = (headA: string) => run(md, { 581: a, 590: b }, claims, pulls(headA)).find((d) => d.issue === 581)!;
  // The CLI's own check decision (poll --mode check), on this run's resume decision.
  const checked = (headA: string, token: string, purpose: "write" | "ready" = "write") =>
    checkRun(run(md, { 581: a, 590: b }, claims, pulls(headA), { key: keyA, expected: readExpected(dir, BOT, keyA, token) })
      .find((d): d is WorkDecision => d.action === "resume" && d.claimKey === keyA), holdsRun(dir, BOT, keyA, token), purpose);
  const check = (headA: string, token: string, purpose: "write" | "ready" = "write") => checked(headA, token, purpose).ok;
  const completeOnly = (headA: string, token: string) => checked(headA, token, "ready").readyReceiptHeader ?? null;

  // 1. Parked at HEAD_1.
  assert.match(JSON.stringify(fresh(HEAD_1)), /waiting for review/);
  // 2. Claude sends it back at HEAD_1: a fresh poll resumes A and takes the lock; ordinary writes pass.
  a.push(changes(920, 581, 1, HEAD_1));
  const next = pickNext(run(md, { 581: a, 590: b }, claims, pulls(HEAD_1)), () => "claimed", acquire(dir));
  assert.equal(next?.issue, 581);
  assert.equal(next?.action, "resume");
  assert.deepEqual(next?.changesRequested, { head: HEAD_1, pull: 700, comment: 920 });
  const token = next!.runToken!;
  assert.ok(check(HEAD_1, token));
  assert.deepEqual(checked(HEAD_1, token, "ready"), { ok: false, reason: "no declared revision is on the PR: nothing to complete" });
  // 3. The run declares its one revision push (head, PR, changes request), then pushes it.
  const HEAD_3 = "3".repeat(40);
  const HEAD_5 = "5".repeat(40);
  const declared = { sha: HEAD_3, pull: 700, changes: 920 };
  assert.equal(check(HEAD_3, token, "ready"), false); // pushed without declaring first
  assert.equal(expectHead(dir, BOT, keyA, "other-token", declared), "not-owner");
  assert.equal(expectHead(dir, BOT, keyA, token, { ...declared, sha: "abc" }), "bad-input");
  assert.equal(expectHead(dir, BOT, keyA, token, declared), "recorded");
  assert.equal(expectHead(dir, BOT, keyA, token, { ...declared, sha: HEAD_5 }), "already-declared");
  assert.ok(check(HEAD_1, token)); // declared but not pushed yet: ordinary writes (the push) still pass
  assert.equal(check(HEAD_1, token, "ready"), false); // ...but ready fails before the successor is on the PR
  // On the PR: only the ready receipt at exactly that head may follow; no more pushes or comments.
  assert.equal(check(HEAD_3, token), false);
  assert.ok(check(HEAD_3, token, "ready"));
  assert.deepEqual(checked(HEAD_3, token, "ready"), { ok: true, reason: null, readyReceiptHeader: readyReceiptHeader(BOT, 581, 1, HEAD_3) });
  assert.equal(completeOnly(HEAD_3, token), readyReceiptHeader(BOT, 581, 1, HEAD_3));
  // Movement it didn't declare (a branch sync) holds even the run; anyone else holds on any movement.
  assert.equal(check(HEAD_5, token, "ready"), false);
  assert.equal(check(HEAD_3, "other-token", "ready"), false);
  assert.match(JSON.stringify(fresh(HEAD_3)), /held for Claude's review/);
  assert.match(JSON.stringify(fresh(HEAD_5)), /held for Claude's review/);
  // A declaration bound to another PR or another changes request never completes.
  for (const other of [{ ...declared, pull: 701 }, { ...declared, changes: 919 }]) {
    const d2 = mkdtempSync(path.join(os.tmpdir(), "orca-cycle-other-"));
    const t = `t-${Math.random()}`;
    assert.equal(acquireRun(d2, BOT, keyA, NOW, t), "acquired");
    assert.equal(expectHead(d2, BOT, keyA, t, other), "recorded");
    const mine = run(md, { 581: a, 590: b }, claims, pulls(HEAD_3), { key: keyA, expected: readExpected(d2, BOT, keyA, t) }).find((d) => d.issue === 581)!;
    assert.match(JSON.stringify(mine), /held for Claude's review/);
  }
  // 4. The run posts its new ready receipt at the new head: parked again, so no further writes pass.
  a.push(ready(930, 581, 1, HEAD_3));
  assert.equal(check(HEAD_3, token), false);
  assert.equal(check(HEAD_3, token, "ready"), false);
  assert.equal(completeOnly(HEAD_3, token), null);
  // 5. It releases the lock; fresh polls see it parked at the new head and nothing to pick (B is parked too).
  assert.equal(releaseRun(dir, BOT, keyA, token), "released");
  assert.match(JSON.stringify(fresh(HEAD_3)), new RegExp(`waiting for review at ${HEAD_3}`));
  assert.equal(pickNext(run(md, { 581: a, 590: b }, claims, pulls(HEAD_3)), () => "claimed", acquire(dir)), null);
  // 6. Unexplained drift after that (no new changes request) holds the ticket, even for a lock holder.
  const HEAD_4 = "4".repeat(40);
  assert.match(JSON.stringify(fresh(HEAD_4)), /held for Claude's review/);
  const t2 = `t-${Math.random()}`;
  assert.equal(acquireRun(dir, BOT, keyA, NOW, t2), "acquired");
  assert.equal(check(HEAD_4, t2), false);
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
