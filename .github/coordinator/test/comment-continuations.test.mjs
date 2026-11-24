// Comment continuations and honest Linear refusals.
//
// SHU-304 reached Linear's 2,000-comment cap on 23 Nov, and every receipt
// write to it was refused with "quota exceeded" and no reset. The coordinator
// read that as a spent budget and HOLDed every tick for an hour. These tests
// pin the two halves of the fix: a refusal is a HOLD only when it is the
// budget, and a full thread continues on the issues config names.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  main,
  fetchLinearBoard,
  fetchLinearIssues,
  resolveCommentThread,
  fetchThreadComments,
  commentWriteId,
  commentReadIds,
  linearHoldLine,
  linearRateLimitHold,
  isLinearRateLimited,
  linearExhaustedBucket,
  sendLinear,
  LINEAR_RATE_LIMIT_FALLBACK_SECONDS,
  parseReceiptsFromComments,
  parseReceiptCommentBody,
  receiptCommentBody,
  LINEAR_COMMENT_CAP,
} from "../reconcile.mjs";
import { resolveCommentContinuations, continuationIssueIds, mergeCommentThreads } from "../comment-continuations.mjs";
import { TICK_HOLD_RE, tickOutcome } from "../service/card-run.mjs";

const COORDINATOR_DIR = fileURLToPath(new URL("..", import.meta.url));
const COMMITTED = JSON.parse(fs.readFileSync(join(COORDINATOR_DIR, "config.json"), "utf8"));

const comment = (body, createdAt) => ({ body, createdAt, user: { id: "actor", displayName: "Coordinator" } });
const node = (identifier, id, over = {}) => ({
  id, identifier, title: `card ${identifier}`, state: { name: "Todo" }, priorityLabel: "High",
  labels: { nodes: [{ name: "fixture-safe" }, { name: "repo:platform" }] }, assignee: null, delegate: null, parent: null,
  relations: { nodes: [] }, ...over,
});
const respond = (data) => ({ status: 200, ok: true, headers: new Headers(), json: async () => ({ data }) });

// A Linear double that keeps a thread per issue (keyed by UUID), answers the
// board read with each open issue's thread, and records every request.
// pageInfo: UUID -> the pageInfo to answer for that issue's thread (undefined
// drops the field), to prove what a page without its metadata does.
function linearStore(nodes, { threads = {}, offBoard = [], pageInfo = {} } = {}) {
  const byId = new Map([...nodes, ...offBoard].map((entry) => [entry.id, entry]));
  const page = (id) => {
    const info = Object.hasOwn(pageInfo, id) ? pageInfo[id] : { hasNextPage: false, endCursor: null };
    return info === undefined ? { nodes: [...threadOf(id)] } : { nodes: [...threadOf(id)], pageInfo: info };
  };
  const byIdentifier = new Map([...nodes, ...offBoard].map((entry) => [entry.identifier, entry]));
  const store = { threads: new Map(Object.entries(threads)), requests: [], writes: [] };
  const threadOf = (id) => store.threads.get(id) ?? [];
  store.fetch = async (url, opts) => {
    if (!String(url).includes("api.linear.app")) return { status: 404, ok: false, headers: new Headers(), json: async () => ({}) };
    const { query, variables } = JSON.parse(opts.body);
    const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    store.requests.push(`${name} ${variables?.issueId ?? variables?.team ?? ""}`.trim());
    if (name === "CoordinatorIssues") {
      return respond({ issues: { nodes: nodes.map((entry) => ({ ...entry,
        comments: page(entry.id) })),
      pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    if (name === "CoordinatorCommentContinuation" || name === "CoordinatorIssueIdentity") {
      const found = byIdentifier.get(variables.issueId) ?? byId.get(variables.issueId) ?? null;
      return respond({ issue: found ? { id: found.id, identifier: found.identifier,
        comments: page(found.id) } : null });
    }
    if (name === "CoordinatorIssueComments") {
      return respond({ issue: { comments: page(variables.issueId) } });
    }
    if (query.includes("commentCreate")) {
      store.writes.push(variables.issueId);
      store.threads.set(variables.issueId, [...threadOf(variables.issueId), comment(variables.body, new Date().toISOString())]);
      return respond({ commentCreate: { success: true, comment: { id: `c${store.writes.length}` } } });
    }
    return respond({});
  };
  return store;
}

const CARD = node("SHU-140", "11111111-aaaa-4bbb-8ccc-000000000140");
const CONT = node("SHU-712", "11111111-aaaa-4bbb-8ccc-000000000712", { state: { name: "Backlog" } });
const CONT2 = node("SHU-713", "11111111-aaaa-4bbb-8ccc-000000000713", { state: { name: "Backlog" } });
const OTHER = node("SHU-141", "11111111-aaaa-4bbb-8ccc-000000000141");

// ---------------------------------------------------------------------------
// Config: comment_continuations
// ---------------------------------------------------------------------------

test("COMMENT_CONTINUATIONS config: the committed config continues SHU-304 on SHU-711, and a malformed map is refused", () => {
  assert.deepEqual([...resolveCommentContinuations(COMMITTED)], [["SHU-304", ["SHU-711"]]]);
  assert.deepEqual([...continuationIssueIds(resolveCommentContinuations(COMMITTED))], ["SHU-711"]);
  // Absent and empty change nothing.
  assert.equal(resolveCommentContinuations({}).size, 0);
  assert.deepEqual([...continuationIssueIds(resolveCommentContinuations({ comment_continuations: { "SHU-304": [] } }))], []);
  const refused = (value, pattern) => assert.throws(() => resolveCommentContinuations({ comment_continuations: value }), pattern, JSON.stringify(value));
  refused(null, /must map an issue identifier/);
  refused(["SHU-304"], /must map an issue identifier/);
  refused({ "shu-304": ["SHU-711"] }, /must be an issue identifier/);
  refused({ "SHU-FIXTURE-001": ["SHU-711"] }, /must be an issue identifier/);
  refused({ "SHU-304": "SHU-711" }, /must be a list/);
  refused({ "SHU-304": ["SHU-711 "] }, /only issue identifiers/);
  refused({ "SHU-304": [711] }, /only issue identifiers/);
  refused({ "SHU-304": ["SHU-304"] }, /may not list itself/);
  refused({ "SHU-304": ["SHU-711", "SHU-711"] }, /lists SHU-711 twice/);
  refused({ "SHU-304": ["SHU-711"], "SHU-305": ["SHU-711"] }, /SHU-711 continues both SHU-304 and SHU-305/);
  refused({ "SHU-304": ["SHU-711"], "SHU-711": ["SHU-712"] }, /may not have continuations of its own/);
  refused({ "SHU-304": ["SHU-711"], "SHU-711": [] }, /may not be listed as an original/);
});

test("COMMENT_CONTINUATIONS merge: the original's comments come first, a receipt carried twice is kept once, and conflicting copies fail closed", () => {
  const a = [comment("a2", "2026-11-23T11:01:10Z"), comment("a1", "2026-10-22T00:00:00Z")];
  const b = [comment("b1", "2026-11-24T09:00:00Z"), comment("b2", "2026-11-24T10:00:00Z")];
  assert.deepEqual(mergeCommentThreads([a, b]).comments.map((entry) => entry.body), ["a2", "a1", "b1", "b2"]);
  assert.deepEqual(mergeCommentThreads([a, undefined]).comments.map((entry) => entry.body), ["a2", "a1"]);
  const receipt = (over = {}) => receiptCommentBody({ receipt_version: "1.1.0", attempt_id: "b760441e-0000-4000-8000-000000000001", issue_id: "SHU-304",
    stage: "HOLD", last_activity: "2026-11-23T11:00:00.000Z", notes: [], ...over });
  const old = [comment(receipt({ stage: "LAUNCH_UNKNOWN", last_activity: "2026-11-23T10:00:00.000Z" }), "2026-11-23T10:00:00Z"), comment(receipt(), "2026-11-23T11:00:00Z")];
  const repeated = mergeCommentThreads([old, [comment(receipt(), "2026-11-24T00:00:00Z")]], { parse: parseReceiptCommentBody });
  assert.equal(repeated.comments.length, 2, "the identical receipt on the continuation is the same record");
  const conflicting = mergeCommentThreads([old, [comment(receipt({ notes: ["something else"] }), "2026-11-24T00:00:00Z")]], { parse: parseReceiptCommentBody });
  assert.match(conflicting.error, /conflicting receipts for attempt b760441e-0000-4000-8000-000000000001 \(HOLD\)/);
  // Within one thread nothing changes: that is the tick's own conflict check.
  assert.equal(mergeCommentThreads([[...old, ...old]], { parse: parseReceiptCommentBody }).comments.length, 4);
});

// ---------------------------------------------------------------------------
// The board read
// ---------------------------------------------------------------------------

test("COMMENT_CONTINUATIONS board: a card's thread reads across its continuations in order, writes go to the last, and continuations are never cards", async () => {
  const store = linearStore([CARD, CONT, CONT2, OTHER], { threads: {
    [CARD.id]: [comment("card-1", "2026-10-22T00:00:00Z"), comment("card-2", "2026-11-23T11:01:10Z")],
    [CONT.id]: [comment("cont-1", "2026-11-24T00:00:00Z")],
    [CONT2.id]: [comment("cont2-1", "2026-11-24T01:00:00Z")],
    [OTHER.id]: [comment("other-1", "2026-11-24T00:00:00Z")],
  } });
  const board = await fetchLinearBoard({ token: "tok", repo: "BAWES-Universe/studenthub-platform", fetchImpl: store.fetch,
    commentContinuations: { "SHU-140": ["SHU-712", "SHU-713"] } });
  assert.deepEqual(board.issues.map((issue) => issue.id), ["SHU-140", "SHU-141"], "continuation issues are not on the board");
  const card = board.issues[0];
  assert.equal(commentWriteId(card), CONT2.id, "writes go to the LAST continuation");
  assert.equal(card.commentIssueIdentifier, "SHU-713");
  assert.deepEqual(commentReadIds(card), [CARD.id, CONT.id, CONT2.id]);
  assert.equal(card.linearId, CARD.id, "the card's own UUID is unchanged");
  const read = board.commentsByIssue.get("SHU-140");
  assert.deepEqual(read.comments.map((entry) => entry.body), ["card-1", "card-2", "cont-1", "cont2-1"]);
  assert.equal(board.commentsByIssue.get(CARD.id), read);
  assert.equal(board.commentsByIssue.has("SHU-712"), false);
  assert.deepEqual(board.commentsByIssue.get("SHU-141").comments.map((entry) => entry.body), ["other-1"], "other cards are untouched");
  assert.deepEqual(store.requests, ["CoordinatorIssues SHU"], "continuations on the board cost no extra request");
  // The issue-only read leaves them out too.
  const issues = await fetchLinearIssues({ token: "tok", repo: "BAWES-Universe/studenthub-platform", fetchImpl: store.fetch,
    commentContinuations: { "SHU-140": ["SHU-712", "SHU-713"] } });
  assert.deepEqual(issues.map((issue) => issue.id), ["SHU-140", "SHU-141"]);
});

test("COMMENT_CONTINUATIONS board: a continuation off the open board is read on its own; one Linear cannot find fails the card closed with no write target", async () => {
  const store = linearStore([CARD], { offBoard: [CONT], threads: { [CARD.id]: [comment("card-1", "2026-10-22T00:00:00Z")], [CONT.id]: [comment("cont-1", "2026-11-24T00:00:00Z")] } });
  const board = await fetchLinearBoard({ token: "tok", repo: "BAWES-Universe/studenthub-platform", fetchImpl: store.fetch,
    commentContinuations: { "SHU-140": ["SHU-712"] } });
  assert.deepEqual(board.commentsByIssue.get("SHU-140").comments.map((entry) => entry.body), ["card-1", "cont-1"]);
  assert.equal(commentWriteId(board.issues[0]), CONT.id);
  assert.deepEqual(store.requests, ["CoordinatorIssues SHU", "CoordinatorCommentContinuation SHU-712"]);

  const missing = linearStore([CARD], { threads: { [CARD.id]: [comment("card-1", "2026-10-22T00:00:00Z")] } });
  const unread = await fetchLinearBoard({ token: "tok", repo: "BAWES-Universe/studenthub-platform", fetchImpl: missing.fetch,
    commentContinuations: { "SHU-140": ["SHU-712"] } });
  assert.match(unread.commentsByIssue.get("SHU-140").error, /comment continuation SHU-712 of SHU-140 cannot be read from Linear/);
  assert.equal(commentWriteId(unread.issues[0]), null, "no write target: nothing goes to the full thread");
  assert.equal(commentReadIds(unread.issues[0]), null);
});

test("COMMENT_CONTINUATIONS board: an empty or missing list is a no-op, request for request and field for field", async () => {
  const threads = { [CARD.id]: [comment("card-1", "2026-10-22T00:00:00Z")], [CONT.id]: [comment("cont-1", "2026-11-24T00:00:00Z")] };
  const plain = linearStore([CARD, CONT], { threads });
  const empty = linearStore([CARD, CONT], { threads });
  const before = await fetchLinearBoard({ token: "tok", repo: "BAWES-Universe/studenthub-platform", fetchImpl: plain.fetch });
  const after = await fetchLinearBoard({ token: "tok", repo: "BAWES-Universe/studenthub-platform", fetchImpl: empty.fetch,
    commentContinuations: { "SHU-140": [] } });
  assert.deepEqual(after.issues, before.issues);
  assert.deepEqual([...after.commentsByIssue], [...before.commentsByIssue]);
  assert.deepEqual(after.issues.map((issue) => issue.id), ["SHU-140", "SHU-712"], "with no list, SHU-712 is an ordinary card");
  assert.equal(Object.hasOwn(after.issues[0], "commentIssueId"), false);
  assert.equal(commentWriteId(after.issues[0]), CARD.id);
  assert.deepEqual(empty.requests, plain.requests);
});

// ---------------------------------------------------------------------------
// One card's thread outside the board read (review verdicts, landings, repairs)
// ---------------------------------------------------------------------------

test("COMMENT_CONTINUATIONS thread: resolveCommentThread costs nothing without continuations and names the last one as the write target", async () => {
  const store = linearStore([CARD, CONT], { threads: { [CARD.id]: [comment("card-1", "2026-10-22T00:00:00Z")], [CONT.id]: [comment("cont-1", "2026-11-24T00:00:00Z")] } });
  const none = await resolveCommentThread({ identifier: "SHU-140", linearId: CARD.id, config: {}, token: "tok", fetchImpl: store.fetch });
  assert.deepEqual(none, { identifier: "SHU-140", readIds: [CARD.id], writeId: CARD.id, continuations: [] });
  assert.deepEqual(store.requests, []);
  const config = { comment_continuations: { "SHU-140": ["SHU-712"] } };
  const thread = await resolveCommentThread({ identifier: "SHU-140", linearId: CARD.id, config, token: "tok", fetchImpl: store.fetch });
  assert.deepEqual(thread, { identifier: "SHU-140", readIds: [CARD.id, CONT.id], writeId: CONT.id, continuations: ["SHU-712"] });
  const comments = await fetchThreadComments({ issueIds: thread.readIds, token: "tok", fetchImpl: store.fetch });
  assert.deepEqual(comments.map((entry) => entry.body), ["card-1", "cont-1"]);
  await assert.rejects(resolveCommentThread({ identifier: "SHU-140", linearId: CARD.id, config: { comment_continuations: { "SHU-140": ["SHU-799"] } },
    token: "tok", fetchImpl: store.fetch }), /comment continuation SHU-799 of SHU-140 cannot be read from Linear/);
  await assert.rejects(fetchThreadComments({ issueIds: null, token: "tok", fetchImpl: store.fetch }), /unresolved/);
});

// ---------------------------------------------------------------------------
// A whole tick
// ---------------------------------------------------------------------------

const SHA = "b".repeat(40);
const TRIGGER = "agtch_continuation_1";
const ENV = {
  ENABLE_DISPATCH: "true",
  LINEAR_API_TOKEN: "tok",
  GITHUB_TOKEN: "",
  WORKSPACE_AGENT_ACCESS_TOKEN: "wa-tok",
  WORKSPACE_AGENT_TRIGGER_ID: TRIGGER,
  DISPATCH_TARGET_SHA: SHA,
};
const waCompat = (() => {
  let mod = null;
  const load = () => (mod ??= import("../adapters/workspace-agents.mjs"));
  return {
    launchBuilder: async (o) => (await load()).launchBuilder({ ...o, token: ENV.WORKSPACE_AGENT_ACCESS_TOKEN, api_trigger_id: TRIGGER }),
    monitorRun: async (o) => (await load()).monitorRun({ ...o, token: ENV.WORKSPACE_AGENT_ACCESS_TOKEN, api_trigger_id: TRIGGER }),
  };
})();
function workspaceAgents({ runStatus = "queued" } = {}) {
  let triggers = 0;
  const impl = async (url) => {
    if (url.includes("/runs/")) {
      return { status: 200, ok: true, json: async () => ({ object: "workspace_agent.trigger_run", id: "apirun_cont_1", status: runStatus, agent_id: null,
        error: runStatus === "failed" ? { message: "the run failed" } : null }) };
    }
    triggers += 1;
    return { status: 202, ok: true, json: async () => ({ conversation_url: "https://chatgpt.com/c/cont_1", agent_trigger_run_id: "apirun_cont_1" }) };
  };
  impl.calls = () => triggers;
  return impl;
}
function tickConfig(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-continuations-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({
    pilot_repo: "BAWES-Universe/studenthub-platform", team: "SHU", max_dispatch: 1, enable_dispatch: true,
    adapter_pause_map: {}, wake_actor_allowlist: ["BAWES"],
    fixture_lane: { id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905" },
    comment_continuations: { "SHU-140": ["SHU-712"] },
    ...overrides,
  }));
  return file;
}
async function tick(store, wa, configPath) {
  const out = [];
  const code = await main([], ENV, {
    skipActivationPreflight: true, openPRsOverride: [], configPath, stdout: (line) => out.push(line), fetchDurable: true,
    adapterModules: { "codex-cli": waCompat },
    fetchImpl: async (url, opts) => (String(url).includes("api.linear.app") ? store.fetch(url, opts) : wa(url, opts)),
  });
  return { code, out };
}

test("COMMENT_CONTINUATIONS tick: every receipt is written on the continuation, read back across the card's whole thread, and the continuation is never dispatched", async () => {
  const store = linearStore([CARD, CONT], { threads: { [CARD.id]: Array.from({ length: 3 }, (_, i) => comment(`old ${i}`, "2026-10-22T00:00:00Z")) } });
  const wa = workspaceAgents();
  const first = await tick(store, wa, tickConfig());
  assert.equal(first.code, 0, first.out.join("\n"));
  assert.equal(wa.calls(), 1, "the card launched once");
  assert.ok(store.writes.length >= 2, "a reservation and a launch receipt were written");
  assert.deepEqual([...new Set(store.writes)], [CONT.id], "no comment was aimed at the full thread");
  assert.equal(store.threads.get(CARD.id).length, 3, "the card's own thread did not grow");
  const report = first.out.join("\n");
  assert.doesNotMatch(report, /SHU-712/, "the continuation is neither READY nor EXCLUDED: it is not a card");
  const durable = parseReceiptsFromComments(store.threads.get(CONT.id));
  assert.deepEqual([...new Set(durable.map((receipt) => receipt.issue_id))], ["SHU-140"], "the receipts name the card, not the continuation");

  // Next tick: the active receipt is read from the continuation and holds the slot.
  const wa2 = workspaceAgents();
  const second = await tick(store, wa2, tickConfig());
  assert.equal(second.code, 0, second.out.join("\n"));
  assert.equal(wa2.calls(), 0, "the receipt on the continuation consumes the slot");

  // The run ends: the lifecycle write that records it goes to the continuation too.
  const written = store.writes.length;
  const third = await tick(store, workspaceAgents({ runStatus: "failed" }), tickConfig());
  assert.ok(store.writes.length > written, `the terminal receipt was written\n${third.out.join("\n")}`);
  assert.deepEqual([...new Set(store.writes)], [CONT.id]);
  assert.ok(parseReceiptsFromComments(store.threads.get(CONT.id)).some((receipt) => receipt.stage === "FAILED"), third.out.join("\n"));
});

test("COMMENT_CONTINUATIONS tick: a pause marker on the card's own (full) thread still pauses its adapter", async () => {
  const store = linearStore([CARD, CONT], { threads: { [CARD.id]: [comment("coordinator-pause: codex-cli", "2026-11-23T11:00:00Z")] } });
  const wa = workspaceAgents();
  const run = await tick(store, wa, tickConfig());
  assert.equal(wa.calls(), 0, run.out.join("\n"));
  assert.match(run.out.join("\n"), /adapter_pause_map=\{"codex-cli":true\}/);
  assert.deepEqual(store.writes, []);
});

test("COMMENT_CONTINUATIONS tick: a continuation Linear cannot find prevents dispatch and writes nothing anywhere", async () => {
  const store = linearStore([CARD], {});
  const wa = workspaceAgents();
  const run = await tick(store, wa, tickConfig());
  assert.equal(wa.calls(), 0);
  assert.match(run.out.join("\n"), /durable read failed for SHU-140: comment continuation SHU-712 of SHU-140 cannot be read from Linear — DISPATCH PREVENTED/);
  assert.deepEqual(store.writes, []);
});

// A page with valid nodes but no pageInfo, or a non-boolean hasNextPage, may
// be partial: on a continued card it is an unreadable thread.
const BAD_PAGE_INFO = [["missing", undefined], ["non-boolean", { hasNextPage: "false", endCursor: null }], ["null", { hasNextPage: null, endCursor: null }]];

test("COMMENT_CONTINUATIONS completeness: a continued thread page without pageInfo or a boolean hasNextPage fails closed on the board, in the tick and in the strict read; an uncontinued card is unchanged", async () => {
  const threads = { [CARD.id]: [comment("old 0", "2026-10-22T00:00:00Z")], [CONT.id]: [comment("old 1", "2026-10-22T00:01:00Z")] };
  for (const [label, info] of BAD_PAGE_INFO) {
    for (const bad of [CARD.id, CONT.id]) {
      const where = `${label} pageInfo on ${bad === CARD.id ? "the original" : "the continuation"}`;
      const board = await fetchLinearBoard({ token: "tok", repo: "BAWES-Universe/studenthub-platform", fetchImpl: linearStore([CARD, CONT], { threads, pageInfo: { [bad]: info } }).fetch, commentContinuations: { "SHU-140": ["SHU-712"] } });
      assert.match(board.commentsByIssue.get("SHU-140")?.error ?? "", /pagination metadata/, `${where}: the board read is an error for the card`);

      const store = linearStore([CARD, CONT], { threads, pageInfo: { [bad]: info } });
      const wa = workspaceAgents();
      const run = await tick(store, wa, tickConfig());
      assert.equal(wa.calls(), 0, `${where}: nothing is dispatched\n${run.out.join("\n")}`);
      assert.deepEqual(store.writes, [], `${where}: no receipt is written`);
      assert.match(run.out.join("\n"), /durable read failed for SHU-140: .*pagination metadata.* — DISPATCH PREVENTED/);

      const strict = linearStore([CARD, CONT], { threads, pageInfo: { [bad]: info } });
      await assert.rejects(fetchThreadComments({ issueIds: [CARD.id, CONT.id], token: "tok", fetchImpl: strict.fetch }),
        (error) => error.code === "LINEAR_COMMENT_CONTINUATION_UNREADABLE", `${where}: the strict thread read refuses`);
    }
  }
  // Legacy: an uncontinued card keeps the short-page rule.
  const legacy = linearStore([CARD], { threads, pageInfo: { [CARD.id]: undefined } });
  assert.equal((await fetchThreadComments({ issueIds: [CARD.id], token: "tok", fetchImpl: legacy.fetch })).length, 1);
  const wa = workspaceAgents();
  const run = await tick(legacy, wa, tickConfig({ comment_continuations: {} }));
  assert.equal(wa.calls(), 1, `an uncontinued card still dispatches\n${run.out.join("\n")}`);
});

test("COMMENT_CONTINUATIONS tick: a malformed comment_continuations refuses the tick before any read", async () => {
  const store = linearStore([CARD, CONT], {});
  await assert.rejects(tick(store, workspaceAgents(), tickConfig({ comment_continuations: { "SHU-140": ["SHU-140"] } })), /may not list itself/);
  assert.deepEqual(store.requests, []);
});

// ---------------------------------------------------------------------------
// The HOLD line and the card run's reader
// ---------------------------------------------------------------------------

test("LINEAR_HOLD_LINE: the hold line keeps retry_after first and adds source, status and code; card-run reads every form", () => {
  const header = linearRateLimitHold({ status: 400, headers: new Headers({ "Retry-After": "42" }) }, { errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] });
  assert.deepEqual(header, { seconds: 42, source: "header", status: 400, code: "RATELIMITED" });
  assert.equal(linearHoldLine(header), "HOLD=LINEAR_RATE_LIMITED retry_after=42 source=header status=400 code=RATELIMITED");
  const fallback = linearRateLimitHold({ status: 429, headers: new Headers() }, null);
  assert.equal(linearHoldLine(fallback), `HOLD=LINEAR_RATE_LIMITED retry_after=${LINEAR_RATE_LIMIT_FALLBACK_SECONDS} source=fallback status=429`);
  const extension = linearRateLimitHold({ status: 200 }, { errors: [{ message: "Too many requests", extensions: { retryAfter: 7 } }] });
  assert.equal(linearHoldLine(extension), "HOLD=LINEAR_RATE_LIMITED retry_after=7 source=extension status=200");
  // A code that is not a plain token never reaches the line.
  assert.equal(linearHoldLine({ seconds: 5, source: "header", status: 429, code: "bad code; rm" }), "HOLD=LINEAR_RATE_LIMITED retry_after=5 source=header status=429");

  for (const line of [
    "HOLD=LINEAR_RATE_LIMITED retry_after=42",
    "HOLD=LINEAR_RATE_LIMITED retry_after=42 source=header status=400 code=RATELIMITED",
    "HOLD=LINEAR_RATE_LIMITED retry_after=3600 source=fallback status=429",
    "HOLD=LINEAR_RATE_LIMITED retry_after=7 source=extension",
  ]) {
    assert.equal(TICK_HOLD_RE.exec(line)?.[1], /retry_after=(\d+)/.exec(line)[1], line);
    assert.deepEqual(tickOutcome(`${line}\n`, "run-1").hold, { retry_after_s: Number(/retry_after=(\d+)/.exec(line)[1]) }, line);
  }
  for (const line of [
    "HOLD=LINEAR_RATE_LIMITED retry_after=42 and more",
    "HOLD=LINEAR_RATE_LIMITED retry_after=42 source=elsewhere",
    "HOLD=LINEAR_RATE_LIMITED retry_after=42 status=400 source=header",
    "HOLD=LINEAR_RATE_LIMITED retry_after=42 code=lower",
    "HOLD=LINEAR_RATE_LIMITED retry_after=",
  ]) {
    assert.equal(TICK_HOLD_RE.test(line), false, line);
    assert.equal(tickOutcome(line, "run-1").outcome, "REFUSED", line);
  }
});

test("LINEAR_QUOTA_CLASSIFICATION: a reset-less quota refusal is the comment cap only on a comment write with a cap code; anything else is unclassified, and no message carries Linear's words", async () => {
  const answer = (errors, headers = new Headers()) => async () => ({ status: 400, ok: false, headers, json: async () => ({ errors }) });
  const quota = [{ message: "quota exceeded SECRET-DETAIL", extensions: { code: "USAGE_LIMIT_EXCEEDED" } }];
  const mutation = "mutation CoordinatorReserve($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }";
  // Linear's own text never reaches a message; only allowlisted codes do.
  const clean = (error) => !/SECRET|quota exceeded/.test(error.message);
  await assert.rejects(sendLinear(mutation, { issueId: CARD.id, body: "SECRET-BODY" }, "SECRET-TOKEN", answer(quota)), (error) => {
    assert.equal(error.code, "LINEAR_QUOTA_UNCLASSIFIED");
    assert.equal(error.operation, "commentCreate");
    assert.equal(error.message, `LINEAR_QUOTA_UNCLASSIFIED operation=commentCreate target=${CARD.id} status=400 — Linear refused with a quota error that states no reset and is not a known comment cap; not retried`);
    return clean(error);
  });
  await assert.rejects(sendLinear(mutation, { issueId: CARD.id, body: "b" }, "tok", answer([{ message: "x", extensions: { code: "COMMENT_LIMIT_EXCEEDED" } }])),
    (error) => error.code === "LINEAR_COMMENT_CAP" && error.capEvidence === "code" && /^LINEAR_COMMENT_CAP operation=commentCreate target=/.test(error.message));
  // A cap code on anything but a comment write is not the comment cap.
  await assert.rejects(sendLinear("mutation X { issueUpdate(id: \"a\") { success } }", {}, "tok", answer([{ message: "x", extensions: { code: "COMMENT_LIMIT_EXCEEDED" } }])),
    (error) => error.code === "LINEAR_QUOTA_UNCLASSIFIED" && error.operation === "mutation" && error.issueId === null);
  await assert.rejects(sendLinear("query CoordinatorIssues { issues { nodes { id } } }", {}, "tok", answer(quota)),
    (error) => error.code === "LINEAR_QUOTA_UNCLASSIFIED" && error.operation === "read" && clean(error));
  // The same refusal with a stated reset is the budget: a HOLD.
  await assert.rejects(sendLinear(mutation, { issueId: CARD.id, body: "b" }, "tok", answer(quota, new Headers({ "Retry-After": "30" }))),
    (error) => error.code === "LINEAR_RATE_LIMITED" && error.retryAfterSeconds === 30 && error.hold.source === "header" && clean(error));
});

// Linear sends its rate-limit headers on every answer. With budget left they
// say nothing about a refusal; only a bucket whose Remaining is spent does.
const T0 = Date.parse("2026-10-22T12:00:00.000Z");
function budgetHeaders(at, { requests = 4_999, requestsReset = 3_600_000, complexity = 2_999_000, complexityReset = 3_600_000, cost = 12 } = {}) {
  return new Headers({
    "X-RateLimit-Requests-Limit": "5000",
    "X-RateLimit-Requests-Remaining": String(requests),
    "X-RateLimit-Requests-Reset": String(at + requestsReset),
    "X-RateLimit-Complexity-Limit": "3000000",
    "X-RateLimit-Complexity-Remaining": String(complexity),
    "X-RateLimit-Complexity-Reset": String(at + complexityReset),
    "X-Complexity": String(cost),
  });
}
const COMMENT_WRITE = "mutation CoordinatorReserve($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }";
const refusal = (errors, headers) => ({ status: 400, ok: false, headers, json: async () => ({ errors }) });
const CAP_REFUSAL = [{ message: "x", extensions: { code: "COMMENT_LIMIT_EXCEEDED" } }];
const AMBIGUOUS_QUOTA = [{ message: "quota exceeded", extensions: { code: "USAGE_LIMIT_EXCEEDED" } }];

test("LINEAR_THROTTLE_CLASSIFICATION: a comment-cap refusal and an ambiguous quota refusal with budget left and ordinary reset headers never HOLD", async () => {
  for (const [errors, expected] of [[CAP_REFUSAL, "LINEAR_COMMENT_CAP"], [AMBIGUOUS_QUOTA, "LINEAR_QUOTA_UNCLASSIFIED"]]) {
    const fixed = refusal(errors, budgetHeaders(T0));
    assert.equal(isLinearRateLimited(fixed, { errors }), false, `${expected}: ordinary reset headers are not a throttle`);
    assert.equal(linearExhaustedBucket(fixed, T0), null, "no bucket is spent");
    await assert.rejects(sendLinear(COMMENT_WRITE, { issueId: CARD.id, body: "b" }, "tok", async () => refusal(errors, budgetHeaders(Date.now()))), (error) => {
      assert.equal(error.code, expected, "the refusal is classified, not held");
      assert.equal(error.hold, undefined);
      assert.doesNotMatch(error.message, /^HOLD=/);
      return true;
    });
  }
});

test("LINEAR_THROTTLE_CLASSIFICATION: a spent requests bucket and a spent complexity bucket each HOLD until their own bucket's reset", async () => {
  const cases = [
    // requests spent (resets in 120s); complexity has budget and a later reset
    ["requests", { requests: 0, requestsReset: 120_000, complexityReset: 3_600_000 }, 120],
    // complexity spent (resets in 300s); requests has budget and an earlier reset
    ["complexity", { requests: 4_000, requestsReset: 30_000, complexity: 0, complexityReset: 300_000 }, 300],
    // complexity left, but below this request's own X-Complexity
    ["complexity", { requests: 4_000, requestsReset: 30_000, complexity: 50, cost: 200, complexityReset: 300_000 }, 300],
  ];
  for (const [bucket, shape, seconds] of cases) {
    const fixed = refusal(AMBIGUOUS_QUOTA, budgetHeaders(T0, shape));
    assert.equal(isLinearRateLimited(fixed, { errors: AMBIGUOUS_QUOTA }), true, `a spent ${bucket} bucket is a throttle`);
    assert.deepEqual(linearExhaustedBucket(fixed, T0), { bucket, seconds, source: "header" });
    assert.deepEqual(linearRateLimitHold(fixed, { errors: AMBIGUOUS_QUOTA }, T0), { seconds, source: "header", status: 400, code: "USAGE_LIMIT_EXCEEDED" });
    await assert.rejects(sendLinear(COMMENT_WRITE, { issueId: CARD.id, body: "b" }, "tok", async () => refusal(AMBIGUOUS_QUOTA, budgetHeaders(Date.now(), shape))), (error) => {
      assert.equal(error.code, "LINEAR_RATE_LIMITED");
      assert.equal(error.hold.source, "header");
      assert.ok(error.retryAfterSeconds >= seconds - 2 && error.retryAfterSeconds <= seconds, `the wait is the ${bucket} bucket's own reset`);
      assert.match(error.message, new RegExp(`^HOLD=LINEAR_RATE_LIMITED retry_after=${error.retryAfterSeconds} source=header status=400 code=USAGE_LIMIT_EXCEEDED$`));
      return true;
    });
  }
});

test("LINEAR_COMMENT_CAP tick: a reset-less refusal of a write to a thread this tick read at Linear's cap is named the comment cap, by alias", async () => {
  const full = Array.from({ length: LINEAR_COMMENT_CAP }, (_, i) => comment(`old ${i}`, "2026-10-22T00:00:00Z"));
  const store = linearStore([CARD], { threads: { [CARD.id]: full } });
  const refusing = { ...store, fetch: async (url, opts) => (JSON.parse(opts.body).query.includes("commentCreate")
    ? { status: 400, ok: false, headers: budgetHeaders(Date.now()), json: async () => ({ errors: [{ message: "quota exceeded" }] }) }
    : store.fetch(url, opts)) };
  const wa = workspaceAgents();
  await assert.rejects(tick(refusing, wa, tickConfig({ comment_continuations: {} })), (error) => {
    assert.equal(error.code, "LINEAR_COMMENT_CAP");
    assert.equal(error.capEvidence, "comment_count");
    assert.equal(error.message, `LINEAR_COMMENT_CAP operation=commentCreate target=SHU-140 comments=${LINEAR_COMMENT_CAP} status=400 — the target's comment thread is full; list a continuation issue for it under comment_continuations in config.json`);
    return true;
  });
  assert.equal(wa.calls(), 0, "the reservation was refused: nothing launched");
});

// ---------------------------------------------------------------------------
// Merge readiness: identity and reads from the card, records on its continuation
// ---------------------------------------------------------------------------

async function mergeFixture({ continuation = "resolved", pageInfo = {} } = {}) {
  const { consumeMergeReadiness, parseMergeAttemptsFromComments } = await import("../merge-readiness.mjs");
  const { createReceipt, validateReceipt } = await import("../reconcile.mjs");
  const ACTOR = "trusted-linear-actor";
  const [HEAD, BASE, TREE, MERGE] = ["a", "c", "d", "f"].map((c) => c.repeat(40));
  const writerMade = createReceipt({ issue_id: "SHU-900", authorization_ref: "SHU-900", requested_worker: "codex-builder",
    repo: "example/repo", branch: "feat/routine", target_sha: BASE, attempt_id: "00000000-0000-4000-8000-000000000001" });
  const writer = { ...writerMade.receipt, stage: "COMPLETED", verdict_stage: "BUILD_READY", result_sha: HEAD, external_run_id: "codexrun_writer",
    worker_identity: "codex-author", adapter_status: "completed", evidence_links: ["https://example.test/build"], last_activity: "2026-09-14T00:01:00.000Z",
    timestamps: { ...writerMade.receipt.timestamps, launch: "2026-09-14T00:00:10.000Z", terminal: "2026-09-14T00:01:00.000Z" } };
  const reviewMade = createReceipt({ issue_id: "SHU-900", authorization_ref: "SHU-900", requested_worker: "claude-verifier", repo: "example/repo",
    branch: "feat/routine", target_sha: HEAD, role: "review", runtime: "claude-code", attempt_id: "00000000-0000-4000-8000-000000000002" });
  const review = { ...reviewMade.receipt, stage: "COMPLETED", verdict_stage: "PASS", result_sha: null, external_run_id: "clauderun_review",
    worker_identity: "claude-reviewer", adapter_status: "completed", evidence_links: ["https://example.test/verdict"], last_activity: "2026-09-14T00:02:00.000Z",
    timestamps: { ...reviewMade.receipt.timestamps, launch: "2026-09-14T00:01:10.000Z", terminal: "2026-09-14T00:02:00.000Z" },
    handoff: { source_attempt_id: reviewMade.receipt.attempt_id, target_sha: HEAD, verdict_stage: "PASS", action: "merge-readiness", hold_code: "MISSING_AUTHORITY" } };
  assert.equal(validateReceipt(review).valid, true);
  // The PASS and its writer live on the card's own (full) thread; the continuation starts empty.
  const threads = new Map([
    ["linear-900", [writer, review].map((receipt, i) => ({ body: receiptCommentBody(receipt), createdAt: `2026-09-14T00:0${i + 1}:00.000Z`, user: { id: ACTOR } }))],
    ["linear-901", []],
  ]);
  const issues = new Map([["linear-900", "SHU-900"], ["linear-901", "SHU-901"]]);
  const writes = [];
  let merged = false, mergeCalls = 0;
  const fetchImpl = async (url, request = {}) => {
    if (url === "https://api.linear.app/graphql") {
      const { query, variables } = JSON.parse(request.body);
      const thread = threads.get(variables.issueId);
      let data;
      if (query.includes("CoordinatorMergeIssue")) data = { issue: thread ? { id: variables.issueId, identifier: issues.get(variables.issueId), title: "Routine change",
        state: { name: "In Progress", type: "started" }, labels: { nodes: [] }, relations: { nodes: [] }, comments: { nodes: structuredClone(thread) } } : null };
      else if (query.includes("CoordinatorIssueComments")) {
        const info = Object.hasOwn(pageInfo, variables.issueId) ? pageInfo[variables.issueId] : { hasNextPage: false };
        data = { issue: { comments: { nodes: structuredClone(thread ?? []), ...(info === undefined ? {} : { pageInfo: info }) } } };
      }
      else if (query.includes("commentCreate")) {
        writes.push(variables.issueId);
        thread.push({ body: variables.body, createdAt: `2026-09-14T00:10:${String(writes.length).padStart(2, "0")}.000Z`, user: { id: ACTOR } });
        data = { commentCreate: { success: true, comment: { id: `c${writes.length}` } } };
      } else throw new Error(`unexpected Linear query ${query.slice(0, 60)}`);
      return { ok: true, status: 200, json: async () => ({ data }) };
    }
    if (url === "https://api.github.com/graphql") {
      return { ok: true, status: 200, json: async () => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }) };
    }
    const pathname = String(url).slice("https://api.github.com/repos/example/repo".length);
    if (request.method === "PUT" && pathname === "/pulls/7/merge") { mergeCalls++; merged = true; return { ok: true, status: 200, json: async () => ({ merged: true, sha: MERGE }) }; }
    let body;
    if (pathname.startsWith("/pulls?")) body = [{ number: 7, state: merged ? "closed" : "open", merged_at: merged ? "2026-09-14T00:20:00Z" : null, head: { sha: HEAD } }];
    else if (pathname === "/pulls/7") body = { number: 7, state: merged ? "closed" : "open", merged, merged_at: merged ? "2026-09-14T00:20:00Z" : null,
      merge_commit_sha: merged ? MERGE : null, draft: false, mergeable: true, mergeable_state: "clean",
      head: { ref: "feat/routine", sha: HEAD, repo: { full_name: "example/repo" } }, base: { ref: "main", sha: BASE }, labels: [] };
    else if (pathname === `/commits/${HEAD}` || pathname === `/commits/${MERGE}`) body = { commit: { tree: { sha: TREE } } };
    else if (pathname === "/branches/main") body = { protected: true, commit: { sha: BASE } };
    else if (pathname === "/branches/main/protection") body = { required_status_checks: { strict: true, contexts: [], checks: [{ context: "CI", app_id: 1 }] } };
    else if (pathname.startsWith("/compare/")) body = { status: "ahead", base_commit: { sha: BASE } };
    else if (pathname === `/commits/${HEAD}/status?per_page=100`) body = { statuses: [] };
    else if (pathname === `/commits/${HEAD}/check-runs?filter=latest&per_page=100`) body = { total_count: 1, check_runs: [{ name: "CI", status: "completed", conclusion: "success", app: { id: 1 } }] };
    else throw new Error(`unexpected GitHub path ${pathname}`);
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  const card = continuation === "resolved"
    ? { id: "SHU-900", linearId: "linear-900", commentIssueId: "linear-901", commentIssueIdentifier: "SHU-901", commentThreadIds: ["linear-900", "linear-901"] }
    : { id: "SHU-900", linearId: "linear-900", commentIssueId: null, commentIssueIdentifier: "SHU-901", commentThreadIds: null };
  const out = [];
  const consume = () => consumeMergeReadiness({ receipts: [writer, review], issues: [card], linearToken: "linear", githubToken: "github",
    config: { routine_merge_authority: { enabled: true, authority_ref: "SHU-259", repo: "example/repo", merge_method: "squash", max_per_tick: 1 }, linear_receipt_actor_ids: [ACTOR] },
    env: { ENABLE_ROUTINE_MERGE: "true" }, fetchImpl, now: () => new Date("2026-09-14T00:30:00.000Z"), stdout: (line) => out.push(line) });
  const attempts = () => parseMergeAttemptsFromComments([...threads.get("linear-900"), ...threads.get("linear-901")], [ACTOR]).records;
  return { consume, threads, writes, out, attempts, mergeCalls: () => mergeCalls };
}

test("COMMENT_CONTINUATIONS merge readiness: a card with a continuation binds its own identifier, finds the PASS on its own thread, records its attempt on the continuation, and lands once", async () => {
  const m = await mergeFixture();
  const first = await m.consume();
  assert.equal(first.merges, 1, m.out.join("\n"));
  assert.equal(m.mergeCalls(), 1);
  assert.ok(m.writes.length > 0);
  assert.deepEqual([...new Set(m.writes)], ["linear-901"], "every merge record is written on the continuation");
  assert.equal(m.threads.get("linear-900").length, 2, "the card's own thread is untouched");
  assert.equal(m.attempts().at(-1)?.state, "COMPLETED");
  assert.equal(m.attempts().at(-1)?.issue_id, "SHU-900", "the record keeps the card's identity");
  // A re-tick reads the COMPLETED record across the thread and does nothing.
  const written = m.writes.length;
  const again = await m.consume();
  assert.equal(again.merges, 0);
  assert.equal(m.mergeCalls(), 1, "no second merge");
  assert.equal(m.writes.length, written, "no second write");

  // An unresolved continuation holds with nothing written and nothing merged.
  const held = await mergeFixture({ continuation: "unresolved" });
  const result = await held.consume();
  assert.equal(result.merges, 0);
  assert.equal(held.mergeCalls(), 0);
  assert.deepEqual(held.writes, []);
  assert.match(held.out.join("\n"), /SHU-900 HOLD=EXPLICIT_HOLD — comment continuation unresolved/);
});

test("COMMENT_CONTINUATIONS completeness: merge readiness on a continued card whose thread page lacks pageInfo or a boolean hasNextPage records no attempt and merges nothing", async () => {
  for (const [label, info] of BAD_PAGE_INFO) {
    for (const bad of ["linear-900", "linear-901"]) {
      const m = await mergeFixture({ pageInfo: { [bad]: info } });
      const result = await m.consume();
      const where = `${label} pageInfo on ${bad}`;
      assert.equal(result.merges, 0, `${where}\n${m.out.join("\n")}`);
      assert.match(m.out.join("\n"), /SHU-900 HOLD=EXPLICIT_HOLD — Linear authority unavailable/, where);
      assert.equal(m.mergeCalls(), 0, `${where}: nothing merged`);
      assert.deepEqual(m.writes, [], `${where}: no merge-attempt record`);
    }
  }
});
