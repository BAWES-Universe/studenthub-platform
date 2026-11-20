import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireRun, CLAUDE_APP_ID, claim, claimKey, decide, dispatchHeader, parseRegister, readClaim, RegisterError, releaseRun, RUN_LOCK_STALE_MS, type IssueComment } from "../src/lane.js";
import { pickNext } from "../src/poll.js";

const BOT = "studenthub-universe";
const NOW = new Date("2026-11-21T12:00:00Z");
const HEAD = "| Issue | Slug | Bot | Gen | Mode | Dispatch | Lease (paths; migrations) | Reviewer | State | Expires (UTC) |\n|---|---|---|---|---|---|---|---|---|---|\n";
const row = (issue: number, gen: number, dispatch: string, state = "active", expires = "2026-11-22 18:00", bot = BOT, mode = "work"): string =>
  `| #${issue} | \`slug-${issue}\` | ${bot} | ${gen} | ${mode} | ${dispatch} | \`docs/x-${issue}.md\` only; no migrations | Claude | ${state} | ${expires} |\n`;
const register = (...rows: string[]): string => `# Orca lane register\n\nPreamble.\n\n${HEAD}${rows.join("")}`;
const dispatch = (id: number, issue: number, gen: number, extra: Partial<IssueComment> = {}): IssueComment =>
  ({ id, body: `${dispatchHeader(BOT, issue, gen)}\n\n@orca-ide ${BOT}`, author: "BAWES", appId: CLAUDE_APP_ID, ...extra });
const run = (markdown: string, comments: Record<number, IssueComment[]>, claims: string[] = []) =>
  decide({ rows: parseRegister(markdown), bot: BOT, now: NOW, comments: new Map(Object.entries(comments).map(([k, v]) => [Number(k), v])), claims: new Set(claims) });

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
  assert.equal(pickNext(decisions, () => { throw new Error("must not claim"); }, () => { throw new Error("must not lock"); }), null);
});

test("a malformed register is refused as a whole", () => {
  assert.throws(() => parseRegister(register(row(581, 0, "`900`"))), RegisterError);
  assert.throws(() => parseRegister(register(row(581, 1, "abc"))), RegisterError);
  assert.throws(() => parseRegister(register(row(581, 1, "`900`"), row(581, 1, "`901`"))), RegisterError);
  assert.throws(() => parseRegister("# no table"), RegisterError);
  assert.throws(() => parseRegister(register(row(581, 1, "`900`", "active", "2026-11-22 18:00", BOT, "maybe"))), RegisterError);
});

test("concurrent wakes: exactly one claim wins, the other must not start", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-claims-"));
  const key = claimKey(BOT, 581, 1);
  const results = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => claim(dir, key, { dispatch: 900, at: "t" }))));
  assert.equal(results.filter((r) => r === "claimed").length, 1);
  assert.equal(readClaim(dir, key)?.dispatch, 900);
});

test("restart after an ambiguous receipt resumes the claimed ticket instead of starting again", () => {
  const md = register(row(581, 1, "`900`"));
  const decisions = run(md, { 581: [dispatch(900, 581, 1)] }, [claimKey(BOT, 581, 1)]);
  assert.deepEqual(decisions.map((d) => d.action), ["resume"]);
  let claimed = 0;
  assert.equal(pickNext(decisions, () => { claimed += 1; return "claimed"; }, () => "acquired")?.action, "resume");
  assert.equal(claimed, 0);
});

test("one ticket at a time: an owned ticket blocks new starts; a lost claim race does nothing", () => {
  const md = register(row(581, 1, "`900`"), row(590, 1, "`950`"));
  const comments = { 581: [dispatch(900, 581, 1)], 590: [dispatch(950, 590, 1)] };
  const owned = run(md, comments, [claimKey(BOT, 590, 1)]);
  assert.deepEqual(pickNext(owned, () => "claimed", () => "acquired"), owned.find((d) => d.issue === 590));
  assert.equal(pickNext(run(md, comments), () => "held", () => "acquired"), null);
});

test("a second wake while a run holds the lock does nothing; release lets the next poll resume", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-run-"));
  const key = claimKey(BOT, 581, 1);
  const now = new Date("2026-11-21T12:00:00Z");
  assert.equal(acquireRun(dir, key, now), "acquired");
  assert.equal(acquireRun(dir, key, new Date(now.getTime() + 60_000)), "busy");
  const decisions = run(register(row(581, 1, "`900`")), { 581: [dispatch(900, 581, 1)] }, [key]);
  assert.equal(pickNext(decisions, () => "claimed", (d) => acquireRun(dir, d.claimKey, now)), null);
  releaseRun(dir, key);
  assert.equal(pickNext(decisions, () => "claimed", (d) => acquireRun(dir, d.claimKey, now))?.action, "resume");
});

test("a crashed run's lock is taken over only after the stale window", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-stale-"));
  const key = claimKey(BOT, 581, 1);
  const start = new Date("2026-11-21T12:00:00Z");
  assert.equal(acquireRun(dir, key, start), "acquired");
  assert.equal(acquireRun(dir, key, new Date(start.getTime() + RUN_LOCK_STALE_MS - 1)), "busy");
  assert.equal(acquireRun(dir, key, new Date(start.getTime() + RUN_LOCK_STALE_MS + 1)), "acquired");
});
