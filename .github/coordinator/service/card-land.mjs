// SHU-306: a card run lands its own passed work.
//
// After the coordinator's tick reports the episode spent on a review PASS, and
// only once the revert has put the host back to dispatch off, the run (still
// holding its lock) takes the passed head to main:
//
//   1. it finds the open coordinator/<card> pull request, or opens exactly one,
//      and refuses unless its head is the head the review passed;
//   2. it waits, bounded, for that head's check runs and commit statuses, and
//      stops on red or at the bound without writing anything;
//   3. only on green it writes the card's merge-readiness handoff (the record
//      durable-handoff.mjs writes, through the same writer) and calls the
//      SHU-259 consumer in-process, with its two gates opened for this one call
//      only: the committed configuration stays disabled and the runtime gate is
//      never put in any environment;
//   4. only when the card's merge-attempt record reads COMPLETED it posts one
//      comment on the card naming the pull request and the merge commit.
//
// Self-repair B2: a landing repair (plan.repair) lands differently in four
// ways. It never finds or opens a pull request: it is handed the one it
// repairs and reads that one by number. Its repo, base, head branch, open
// state and head are checked before the wait, on every read during it, and
// once more right before the merge, whose call carries the expected head.
// Only check runs whose head_sha is the repaired head count. And before any
// wait, the change from the failed head to the repaired head must pass the
// weakening guard (card-repair.mjs), or the landing stops at
// REPAIR_TEST_WEAKENED with nothing handed off or merged.
//
// It never moves the card: a merge never produces Done. Every network call has
// its own deadline, and the wait is bounded, so the run stays inside its unit's
// TimeoutStartSec. Nothing here throws: every stop is an outcome for the run
// report.
//
// SHU-310: a review bot's low-severity thread used to hold a passed card for
// the whole wait, since the consumer merges only with no unresolved thread.
// With landing_thread_settle.enabled in the committed config (off by
// default), a thread whose comments all come from one allowlisted bot that
// labelled it low is settled: a follow-up note goes on the card, the landing
// replies on the thread, re-reads it whole, resolves it, and reads it again.
// Any change to it after it was classified, then or on any later read before
// the handoff, stops the landing; a change seen only once it is resolved
// reopens it. GitHub has no conditional resolve or merge on a thread, so the
// last check runs inside the SHU-259 consumer, right before its merge call.
// A resolved thread carrying a landing reply is checked again by every run.
// Any other thread still blocks.
//
// SHU-71 M10 (self-repair B3): with landing_thread_review.enabled, a read
// held only by unresolved review threads hands them, once per head, to the
// card's own review lane when every one of them is a listed bot's
// (card-threads.mjs). Only when it judges every thread not_applicable does
// the landing reply with its reason on each thread and resolve it, the same
// reply, re-read and resolve SHU-310 uses, and every resolved thread is held
// to that state until the merge. Anything else resolves nothing, and the
// landing ends as before with the must_fix threads named in its reason.
//
// The landing token is the only credential that can open and merge a pull
// request. It lives in its own root-only file that card-run alone reads; it is
// never in the coordinator's environment file, so neither the coordinator unit
// nor any worker can see it. Without it the run behaves as before and reports
// LAND_SKIPPED_NO_TOKEN.
import { sendLinear, fetchIssueComments, parseReceiptsFromComments, LINEAR_COMMENT_CREATE_MUTATION } from "../reconcile.mjs";
import { writeHandoffReceipt, validHandoff, handoffReceipt } from "../durable-handoff.mjs";
import { consumeMergeReadiness, parseMergeAttemptsFromComments } from "../merge-readiness.mjs";
import { externalPolicy, holdsRun, holdsStatus, holdsThread, advisoryNote } from "./external-checks.mjs";
import { readTestWeakening, repairPullIdentity } from "./card-repair.mjs";
import { REVIEW_LIMITS, threadReviewPolicy, reviewMarker, judgingLane, botThread, adjudicationPrompt, parseAdjudication, reviewReplyBody } from "./card-threads.mjs";

export const CARD_LAND_ENV = "/srv/shu/card-land.env";
export const LAND_TOKEN_KEY = "SHU_LAND_GITHUB_TOKEN";
export const LAND_LIMITS = Object.freeze({
  waitMs: 30 * 60 * 1000,
  pollMs: 60 * 1000,
  requestTimeoutMs: 30 * 1000,
  // A read that never reached its server is tried this many times in all.
  networkAttempts: 3,
  networkRetryWaitMs: 15 * 1000,
  // Green must hold on this many reads in a row, so a workflow queued a moment
  // after the others is not missed.
  greenReads: 2,
});
export const LAND_OUTCOMES = Object.freeze([
  "MERGED", "PR_OPENED_CI_RED", "CI_TIMEOUT", "MERGE_HOLD", "LAND_PAUSED", "LAND_SKIPPED_NO_TOKEN",
  "LAND_HEAD_MISMATCH", "LAND_ERROR", "THREADS_HELD",
]);
// Self-repair B2: the one outcome only a landing repair has.
export const REPAIR_LAND_OUTCOMES = Object.freeze(["REPAIR_TEST_WEAKENED"]);
const SHA_RE = /^[0-9a-f]{40}$/;
const GREEN = new Set(["success", "neutral", "skipped"]);
const THREAD_FIELDS = "id isResolved path line comments(first:20) { nodes { id url body updatedAt diffHunk author { __typename login } } pageInfo { hasNextPage } }";
const THREADS_QUERY = `query CardLandThreads($owner:String!,$name:String!,$number:Int!) { viewer { login } repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewDecision reviewThreads(first:100) { nodes { ${THREAD_FIELDS} } pageInfo { hasNextPage } } } } }`;
const THREAD_QUERY = `query CardLandThread($id:ID!) { viewer { login } node(id:$id) { ... on PullRequestReviewThread { ${THREAD_FIELDS} } } }`;
const THREAD_REPLY_MUTATION = "mutation CardLandThreadReply($id:ID!,$body:String!) { addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}) { comment { id } } }";
const THREAD_RESOLVE_MUTATION = "mutation CardLandThreadResolve($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }";
const THREAD_UNRESOLVE_MUTATION = "mutation CardLandThreadReopen($id:ID!) { unresolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }";

// SHU-310: which threads a landing may settle. Each bot reads its own label
// from a fixed place, so prose that quotes a label never counts.
const LOW_LABELS = Object.freeze({
  coderabbit: Object.freeze(["🟡 Minor", "🔵 Trivial", "🧹 Nitpick"]),
  sentry: Object.freeze(["LOW"]),
});
const HIGH_LABEL_RE = /🟠 Major|🔴 Critical|Severity: (?:MEDIUM|HIGH|CRITICAL)/;

// The committed policy, or null when settling is off. On but malformed is a
// refusal, never a guess.
export function settlePolicy(config) {
  const policy = config?.landing_thread_settle;
  if (policy === undefined || policy?.enabled === false) return null;
  const bots = policy?.bots;
  const logins = Array.isArray(bots) ? bots.map((bot) => bot?.login) : [];
  if (policy?.enabled !== true || !Number.isInteger(policy.max_per_run) || policy.max_per_run < 1 || policy.max_per_run > 10
      || !Array.isArray(bots) || bots.length === 0 || new Set(logins).size !== logins.length
      || bots.some((bot) => !/^[a-z0-9-]+$/.test(bot?.login ?? "") || !Object.hasOwn(LOW_LABELS, bot?.labels ?? "")
        || Object.keys(bot).some((key) => key !== "login" && key !== "labels"))) {
    stop("LAND_ERROR", "landing_thread_settle in the committed config is malformed");
  }
  return { maxPerRun: policy.max_per_run, bots: new Map(bots.map((bot) => [bot.login, bot.labels])) };
}

// The label a bot put on its comment: "low", "high", or "none".
export function botSeverity(kind, body) {
  const text = String(body ?? "");
  if (HIGH_LABEL_RE.test(text)) return { level: "high" };
  const first = text.split("\n").find((line) => line.trim()) ?? "";
  if (kind === "coderabbit") {
    const parts = first.split("|").map((part) => part.trim().replace(/^[*_\s]+|[*_\s]+$/g, ""));
    const low = parts.filter((part) => LOW_LABELS.coderabbit.includes(part));
    const others = LOW_LABELS.coderabbit.filter((label) => !low.includes(label) && text.includes(label));
    if (low.length === 1 && others.length === 0) return { level: "low", label: low[0] };
    return { level: low.length || others.length ? "high" : "none" };
  }
  if (kind === "sentry") {
    const all = text.match(/<sub>Severity: [A-Z]+<\/sub>/g) ?? [];
    const inFirst = first.match(/<sub>Severity: ([A-Z]+)<\/sub>/);
    if (all.length === 1 && inFirst) return inFirst[1] === "LOW" ? { level: "low", label: "LOW" } : { level: "high" };
    return { level: all.length ? "high" : "none" };
  }
  return { level: "high" };
}

export function settleMarker(threadId) {
  return `<!-- card-land-settle ${threadId} -->`;
}

const commentKey = (comment) => `${comment?.id} ${comment?.updatedAt} ${comment?.body}`;

// A thread as the landing reads it: complete, with the landing's own replies
// (by the token's own login, carrying this thread's marker) set apart.
function readThread(node, viewer, markerFor = settleMarker) {
  const nodes = node?.comments?.nodes;
  if (typeof node?.id !== "string" || !Array.isArray(nodes) || nodes.length === 0 || node.comments.pageInfo?.hasNextPage !== false) return null;
  const marker = markerFor(node.id);
  const own = (comment) => typeof viewer === "string" && comment?.author?.login === viewer && String(comment?.body ?? "").includes(marker);
  return { id: node.id, isResolved: node.isResolved === true, url: nodes[0]?.url ?? null,
    others: nodes.filter((comment) => !own(comment)), replies: nodes.filter(own) };
}

// Settleable only when every comment but the landing's own reply comes from
// one allowlisted bot, the first carries that bot's low label and none
// carries a higher one.
export function classifyThread(node, viewer, policy) {
  const thread = readThread(node, viewer);
  if (!thread) return { settle: false, why: "the thread could not be read in full" };
  const [first] = thread.others;
  const login = first?.author?.login;
  const kind = policy.bots.get(login);
  if (!first || thread.replies.length > 1 || (thread.replies.length && thread.others.length === 0)) return { settle: false, why: "the thread is not a review bot's", url: thread.url };
  if (!kind || thread.others.some((comment) => comment?.author?.__typename !== "Bot" || comment?.author?.login !== login)) {
    return { settle: false, why: "a comment is not from an allowlisted review bot", url: thread.url };
  }
  const severity = botSeverity(kind, first.body);
  if (severity.level !== "low" || thread.others.slice(1).some((comment) => botSeverity(kind, comment.body).level === "high")) {
    return { settle: false, why: `${login} did not label it low`, url: thread.url };
  }
  return { settle: true, id: thread.id, url: thread.url, bot: login, severity: severity.label, first: first.body,
    snapshot: thread.others.map(commentKey), replied: thread.replies.length === 1 };
}

// A settled thread must stay exactly as the landing left it: resolved, with
// the same comments, until the handoff.
function signature(thread) {
  return JSON.stringify([...thread.others, ...thread.replies].map(commentKey));
}

function checkSettled(node, viewer, id, expected, markerFor = settleMarker) {
  const thread = readThread(node, viewer, markerFor);
  if (!thread || thread.id !== id || !thread.isResolved || signature(thread) !== expected) {
    stop("LAND_ERROR", `settled review thread ${thread?.url ?? id} changed before the handoff`);
  }
}

async function graphql(gh, query, variables) {
  const response = await gh("POST", "https://api.github.com/graphql", { query, variables });
  const json = await response.json();
  if (!response.ok || json?.errors?.length || !json?.data) stop("LAND_ERROR", `a GitHub GraphQL call failed (HTTP ${response.status})`);
  return json.data;
}

// The thread now, checked against what was classified: the same bot comments,
// unchanged, and exactly one landing reply.
async function rereadThread(gh, id, snapshot, markerFor = settleMarker) {
  const data = await graphql(gh, THREAD_QUERY, { id });
  const thread = readThread(data?.node, data?.viewer?.login, markerFor);
  if (!thread || thread.id !== id || thread.replies.length !== 1
      || JSON.stringify(thread.others.map(commentKey)) !== JSON.stringify(snapshot)) {
    stop("LAND_ERROR", `review thread ${thread?.url ?? id} changed after the landing classified it`);
  }
  return thread;
}

// Settles one classified thread. Every write is sent once: a write whose
// answer is lost stops the landing, and a later run finds its marker.
async function settleThread(ctx, entry) {
  const { gh, issue, linearToken, fetchImpl, actorIds, card, prNumber, head, audit } = ctx;
  const marker = settleMarker(entry.id);
  const notes = await fetchIssueComments({ issueId: issue.id, token: linearToken, fetchImpl });
  if (!notes.some((comment) => actorIds.includes(comment?.user?.id) && String(comment?.body ?? "").includes(marker))) {
    // Quoted, with no comment markers or code fences, so the bot's text can
    // never read as a record on the card.
    const finding = String(entry.first ?? "").replace(/<!--|-->/g, " ").replace(/```/g, "'''").slice(0, 1500);
    const body = [marker, `Follow-up from pull request #${prNumber}: ${entry.bot} labelled a review thread ${entry.severity} after the independent PASS at ${head}. The landing settled it so ${card} could land; it is left for a later card.`,
      `Thread: ${entry.url}`, "", ...finding.split("\n").map((line) => `> ${line}`)].join("\n");
    const posted = await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: issue.id, body }, linearToken, fetchImpl);
    if (posted?.commentCreate?.success !== true) stop("LAND_ERROR", `the follow-up note for review thread ${entry.url} was not written`);
  }
  let reply = null;
  if (!entry.replied) {
    reply = [marker, `Not blocking this landing: ${entry.bot} labelled it ${entry.severity}, after an independent PASS at ${head}. A follow-up note is on ${card}.`].join("\n");
  }
  const after = await replyAndResolve(gh, entry, reply, settleMarker);
  audit.settled.push({ url: entry.url, bot: entry.bot, severity: entry.severity });
  return after;
}

// Replies on a thread (unless reply is null), re-reads it whole against what
// was judged, resolves it and reads it once more. Every write is sent once; a
// change seen only once it is resolved reopens it. Returns the resolved
// thread's signature.
async function replyAndResolve(gh, entry, reply, markerFor) {
  if (reply !== null) {
    const data = await graphql(gh, THREAD_REPLY_MUTATION, { id: entry.id, body: reply });
    if (!data?.addPullRequestReviewThreadReply?.comment?.id) stop("LAND_ERROR", `the reply on review thread ${entry.url} was not written`);
  }
  const before = await rereadThread(gh, entry.id, entry.snapshot, markerFor);
  if (before.isResolved) stop("LAND_ERROR", `review thread ${entry.url} was resolved by someone else`);
  const resolved = await graphql(gh, THREAD_RESOLVE_MUTATION, { id: entry.id });
  if (resolved?.resolveReviewThread?.thread?.isResolved !== true) stop("LAND_ERROR", `review thread ${entry.url} was not resolved`);
  let after;
  try {
    after = await rereadThread(gh, entry.id, entry.snapshot, markerFor);
    if (!after.isResolved || JSON.stringify(after.replies.map(commentKey)) !== JSON.stringify(before.replies.map(commentKey))) {
      stop("LAND_ERROR", `review thread ${entry.url} changed while it was being resolved`);
    }
  } catch (error) {
    // A comment that landed between the last read and the resolve: the
    // thread goes back to unresolved, so it blocks again. Sent once.
    let reopened = false;
    try { reopened = (await graphql(gh, THREAD_UNRESOLVE_MUTATION, { id: entry.id }))?.unresolveReviewThread?.thread?.isResolved === false; } catch { /* reported below */ }
    throw Object.assign(new Error(`${error.message}; ${reopened ? "it was reopened" : "it could not be reopened"}`), { landOutcome: error.landOutcome ?? "LAND_ERROR" });
  }
  return signature(after);
}

// Every resolved thread that carries a landing reply, from this run or an
// earlier one, must still be a settleable bot thread that ends in that reply.
// M10: a thread the review lane judged, in this run or an earlier one, must
// still end in the judgement's reply, whether or not settling is on.
function checkLandingResolved(nodes, viewer, policy) {
  for (const node of nodes) {
    if (node?.isResolved !== true) continue;
    const judged = (node?.comments?.nodes ?? []).some((comment) => comment?.author?.login === viewer && String(comment?.body ?? "").includes("<!-- card-land-review "));
    if (judged) {
      const last = node.comments.nodes.at(-1);
      if (last?.author?.login !== viewer || !String(last?.body ?? "").startsWith(`${reviewMarker(node.id)}\n`)) {
        stop("LAND_ERROR", `review thread ${node?.comments?.nodes?.[0]?.url ?? node.id} was resolved on the review lane's judgement but no longer ends in it`);
      }
    }
    if (!policy) continue;
    const ours = (node?.comments?.nodes ?? []).some((comment) => comment?.author?.login === viewer && String(comment?.body ?? "").includes("<!-- card-land-settle "));
    if (!ours) continue;
    const entry = classifyThread(node, viewer, policy);
    const last = node.comments.nodes.at(-1);
    if (!entry.settle || !entry.replied || !String(last?.body ?? "").includes(settleMarker(node.id))) {
      stop("LAND_ERROR", `review thread ${entry.url ?? node.id} was settled by a landing but no longer reads as a low review bot thread`);
    }
  }
}

// The whole thread list, checked: settled threads exactly as left, and every
// landing-settled thread still settleable.
// M10: threads the review lane judged are held the same way, by their own
// marker.
async function guardThreads(gh, { repo, number }, settled, policy, reviewed = new Map()) {
  const [owner, name] = repo.split("/");
  const data = await graphql(gh, THREADS_QUERY, { owner, name, number });
  const page = data?.repository?.pullRequest?.reviewThreads;
  if (!Array.isArray(page?.nodes) || page.pageInfo?.hasNextPage !== false) stop("LAND_ERROR", "the review threads could not be read in full");
  const viewer = data.viewer?.login;
  for (const [id, expected] of settled) checkSettled(page.nodes.find((node) => node?.id === id), viewer, id, expected);
  for (const [id, expected] of reviewed) checkSettled(page.nodes.find((node) => node?.id === id), viewer, id, expected, reviewMarker);
  checkLandingResolved(page.nodes, viewer, policy);
}

function stop(code, detail) {
  throw Object.assign(new Error(detail), { landOutcome: code });
}

// The landing token, or null when there is none. The file is root's alone: a
// regular file, never a link, owned by root with no group or other access. A
// refusal names the key and the condition, never a value.
export function readLandToken(io, file = CARD_LAND_ENV) {
  if (!file) return { token: null, reason: "no landing token file is configured" };
  let stat;
  try { stat = io.fs.lstatSync(file); } catch (error) {
    if (error?.code === "ENOENT") return { token: null, reason: `${file} does not exist` };
    return { token: null, refused: `${file} cannot be read` };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0) {
    return { token: null, refused: `${file} must be a regular file owned by root with no group or other access` };
  }
  const lines = String(io.fs.readFileSync(file, "utf8")).split("\n").filter((line) => line.startsWith(`${LAND_TOKEN_KEY}=`));
  if (lines.length === 0) return { token: null, reason: `${file} holds no ${LAND_TOKEN_KEY}` };
  const value = lines.length === 1 ? lines[0].slice(LAND_TOKEN_KEY.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2") : "";
  if (!value || /[\s\\$\x00-\x1f]/.test(value)) return { token: null, refused: `${file} must hold exactly one usable ${LAND_TOKEN_KEY}` };
  return { token: value };
}

// A request that only reads: a GET, or a GraphQL document that opens as a
// query (leading whitespace and # comments aside). Anything else, a mutation
// or a body that cannot be read, counts as a write.
export function isReadRequest(url, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  if (method === "GET") return true;
  if (method !== "POST" || !String(url).endsWith("/graphql")) return false;
  try {
    const query = JSON.parse(options.body).query;
    if (typeof query !== "string") return false;
    return /^(?:query\b|\{)/.test(query.replace(/^(?:\s+|#[^\n]*)*/, ""));
  } catch { return false; }
}

// fetch's own "fetch failed" hides why; the cause's code (ECONNRESET,
// ENOTFOUND, UND_ERR_CONNECT_TIMEOUT...) is what says it.
export function networkReason(error) {
  const cause = error?.cause;
  const detail = cause?.code ?? cause?.message;
  return `${String(error?.message ?? error)}${detail ? ` (${detail})` : ""}`;
}

// A fetch whose answer, body included, arrives within the deadline or not at
// all. The SHU-259 consumer is handed this one too, so its calls are bounded.
// A read that never reached its server (fetch's own TypeError) is tried again
// a bounded number of times: the first self-landing run lost its landing to
// one. A write is never sent twice here: opening the pull request reads the
// list before and after a lost answer, and a Linear mutation or merge that may
// have landed is never repeated.
export function boundedFetch(io, timeoutMs, { attempts = LAND_LIMITS.networkAttempts, waitMs = LAND_LIMITS.networkRetryWaitMs } = {}) {
  const once = async (url, options) => {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller?.abort(); reject(new Error(`no answer within ${timeoutMs} ms`)); }, timeoutMs);
    });
    try {
      return await Promise.race([(async () => {
        const response = await io.fetch(url, { ...options, ...(controller ? { signal: controller.signal } : {}) });
        const body = await response.json().catch(() => null);
        return { ok: response.ok, status: response.status, headers: response.headers ?? { get: () => null }, json: async () => body };
      })(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
  return async (url, options = {}) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(url, options);
      } catch (error) {
        if (!(error instanceof TypeError) || attempt >= attempts || !isReadRequest(url, options)) {
          if (error instanceof TypeError) throw new TypeError(networkReason(error), { cause: error.cause });
          throw error;
        }
        // Asynchronous, so a sibling request in the same Promise.all keeps
        // its own deadline while this one waits.
        await (io.delay ? io.delay(waitMs) : new Promise((resolve) => setTimeout(resolve, waitMs)));
      }
    }
  };
}

const CARD_LAND_ISSUE_QUERY = `
  query CardLandIssue($id: String!) {
    issue(id: $id) { id identifier title }
  }`;

export function mergeCommentMarker(attemptId) {
  return `<!-- card-land-merged ${attemptId} -->`;
}

export function pullRequestBody({ card, activationId, head }) {
  return [
    `Refs ${card}`,
    "",
    `Opened by card run ${activationId} after its review passed at ${head}.`,
    `The run report is on SHU-71 (marker \`card-run-report ${activationId}\`).`,
  ].join("\n");
}

// The terminal PASS of this run's episode: the newest receipt on the card's
// branch, written by a trusted actor, completed with a PASS at an exact head.
function passedTerminal(receipts, { card, repo, branch, activationId }) {
  const ids = receipts.map((r) => r.attempt_id);
  if (new Set(ids).size !== ids.length) stop("LAND_ERROR", "the card's receipts disagree on an attempt");
  const lineage = receipts.filter((r) => r?.issue_id === card && r.repo === repo && r.branch === branch)
    .sort((a, b) => String(a.last_activity ?? "").localeCompare(String(b.last_activity ?? "")));
  const terminal = lineage.at(-1);
  if (!terminal || terminal.episode_id !== activationId || terminal.stage !== "COMPLETED" || terminal.verdict_stage !== "PASS" || !SHA_RE.test(terminal.target_sha ?? "")) {
    stop("LAND_ERROR", `no exact-head PASS of episode ${activationId} is the newest receipt on ${branch}`);
  }
  return { terminal, lineage };
}

export function github(fetchImpl, token) {
  return (method, url, body) => fetchImpl(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "shu-card-land",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function openPulls(gh, repo, branch) {
  const [owner] = repo.split("/");
  const response = await gh("GET", `https://api.github.com/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
  const list = await response.json();
  if (!response.ok || !Array.isArray(list) || list.length >= 100) stop("LAND_ERROR", `the open pull requests of ${branch} cannot be read (HTTP ${response.status})`);
  if (list.length > 1) stop("LAND_ERROR", `${branch} has ${list.length} open pull requests`);
  return list[0] ?? null;
}

// Finds the open pull request, or opens one. A POST whose answer is lost, or
// refused, is never sent again: the list is read once more instead.
async function findOrOpenPull(gh, { repo, branch, card, title, activationId, head }) {
  const existing = await openPulls(gh, repo, branch);
  if (existing) return { pr: existing, opened: false };
  let created = null;
  try {
    const response = await gh("POST", `https://api.github.com/repos/${repo}/pulls`, {
      title: `[${card}] ${title}`, head: branch, base: "main", body: pullRequestBody({ card, activationId, head }),
    });
    const json = await response.json();
    if (response.status === 201 && Number.isInteger(json?.number)) created = json;
  } catch { /* the answer was lost: read the list again below */ }
  if (created) return { pr: created, opened: true };
  const found = await openPulls(gh, repo, branch);
  if (!found) stop("LAND_ERROR", `no pull request of ${branch} could be opened or found`);
  // The answer was lost or refused: whoever opened the one found, it is not
  // reported as this run's.
  return { pr: found, opened: false };
}

function headMatches(pr, { repo, branch, head }) {
  return pr?.head?.sha === head && pr?.head?.ref === branch && pr?.head?.repo?.full_name === repo && pr?.base?.ref === "main";
}

// A commit's check runs and commit statuses, judged whole: unreadable or too
// many to read in one page is not green, any completed run that is not green
// or any failed status is red, nothing reported or anything still running is
// not green yet.
// With an external policy, only this repository's own CI and the outside
// checks the committed config names are judged; the rest are advisory and
// only reported (see external-checks.mjs).
//
// Self-repair B2: with `head`, only check runs whose head_sha is that head
// count at all; a stale run is neither red nor green.
export function judgeChecks(runsResponse, runs, statusResponse, status, external = null, { head = null } = {}) {
  const listed = runs?.check_runs;
  const allRuns = head && Array.isArray(listed) ? listed.filter((run) => run?.head_sha === head) : listed;
  const allStatuses = status?.statuses;
  if (!runsResponse?.ok || !statusResponse?.ok || !Array.isArray(allRuns) || !Array.isArray(allStatuses)
      || (runs.total_count ?? 0) > 100 || allStatuses.length >= 100) {
    return { green: false, note: "the checks could not be read in full" };
  }
  const checkRuns = external ? allRuns.filter((run) => holdsRun(run, external)) : allRuns;
  const statuses = external ? allStatuses.filter((item) => holdsStatus(item, external)) : allStatuses;
  const advisory = external ? {
    runs: allRuns.filter((run) => !holdsRun(run, external) && !(run?.status === "completed" && GREEN.has(run?.conclusion))),
    statuses: allStatuses.filter((item) => !holdsStatus(item, external) && item?.state !== "success"),
  } : null;
  const red = [
    ...checkRuns.filter((run) => run?.status === "completed" && !GREEN.has(run?.conclusion)).map((run) => `${run?.name}: ${run?.conclusion}`),
    ...statuses.filter((item) => ["failure", "error"].includes(item?.state)).map((item) => `${item?.context}: ${item?.state}`),
  ];
  if (red.length) return { red };
  const pending = checkRuns.some((run) => run?.status !== "completed") || statuses.some((item) => item?.state !== "success");
  if (checkRuns.length + statuses.length === 0) return { green: false, note: "no check has reported yet" };
  if (pending) return { green: false, note: "checks are still running" };
  return { green: true, ...(advisory ? { advisory } : {}) };
}

// SHU-322: the same judgement of any commit, such as main's tip, read with
// whatever token the caller's client carries.
export async function readCommitChecks(gh, repo, sha) {
  const [runsResponse, statusResponse] = await Promise.all([
    gh("GET", `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`),
    gh("GET", `https://api.github.com/repos/${repo}/commits/${sha}/status?per_page=100`),
  ]);
  const [runs, status] = await Promise.all([runsResponse.json(), statusResponse.json()]);
  return judgeChecks(runsResponse, runs, statusResponse, status);
}

// One read of the head's checks and the pull request's own state.
async function checkState(gh, { repo, number, head, branch, settled, policy, external, reviewed }) {
  const [owner, name] = repo.split("/");
  const [runsResponse, statusResponse, pullResponse, threadsResponse] = await Promise.all([
    gh("GET", `https://api.github.com/repos/${repo}/commits/${head}/check-runs?filter=latest&per_page=100`),
    gh("GET", `https://api.github.com/repos/${repo}/commits/${head}/status?per_page=100`),
    gh("GET", `https://api.github.com/repos/${repo}/pulls/${number}`),
    gh("POST", "https://api.github.com/graphql", { query: THREADS_QUERY, variables: { owner, name, number } }),
  ]);
  const [runs, status, pull, threads] = await Promise.all([runsResponse.json(), statusResponse.json(), pullResponse.json(), threadsResponse.json()]);
  // Self-repair B2: a repair's pull request must stay the very one it repairs.
  const binding = gh.repairBinding ?? null;
  const wrong = binding && pullResponse.ok && pull ? repairPullIdentity(pull, { repo, number, branch }) : null;
  if (wrong) return { identity: wrong };
  if (pullResponse.ok && pull && !headMatches(pull, { repo, branch, head })) return { moved: true, sha: pull?.head?.sha ?? null };
  if (!pullResponse.ok) return { green: false, note: "the checks could not be read in full" };
  const judged = judgeChecks(runsResponse, runs, statusResponse, status, external, binding ? { head } : undefined);
  if (!judged.green) return judged;
  // GitHub reads "unstable" when a check outside branch protection is not
  // green; with everything that holds already green, that is only advisory.
  const mergeable = pull.mergeable_state === "clean" || (external && pull.mergeable_state === "unstable");
  if (pull.mergeable !== true || !mergeable) {
    // M10: GitHub reads "blocked" while a conversation it requires resolved
    // is open, an advisory bot's included; the review lane may see those.
    // A required approval or requested changes block it too, so the threads
    // go to the lane only when no review decision is outstanding.
    const decision = threads?.data?.repository?.pullRequest?.reviewDecision;
    const blockedBy = pull.mergeable_state === "blocked" && reviewed && decision !== "REVIEW_REQUIRED" && decision !== "CHANGES_REQUESTED"
      ? unresolvedThreads(threadsResponse, threads) : null;
    return { green: false, note: `the pull request reads mergeable_state ${pull.mergeable_state ?? "unknown"}`,
      ...(blockedBy?.length ? { unresolved: blockedBy, viewer: threads.data.viewer?.login } : {}) };
  }
  // The SHU-259 consumer holds for good on any unresolved review thread, so a
  // thread (a review bot's included) keeps the run waiting before the handoff.
  const page = threads?.data?.repository?.pullRequest?.reviewThreads;
  if (!threadsResponse.ok || threads?.errors?.length || !Array.isArray(page?.nodes) || page.pageInfo?.hasNextPage !== false) {
    return { green: false, note: "the review threads could not be read in full" };
  }
  const viewer = threads.data.viewer?.login;
  for (const [id, expected] of settled ?? []) checkSettled(page.nodes.find((node) => node?.id === id), viewer, id, expected);
  for (const [id, expected] of reviewed ?? []) checkSettled(page.nodes.find((node) => node?.id === id), viewer, id, expected, reviewMarker);
  checkLandingResolved(page.nodes, viewer, policy);
  const unresolved = page.nodes.filter((thread) => thread?.isResolved !== true);
  const open = external ? unresolved.filter((thread) => holdsThread(thread, external)) : unresolved;
  if (open.length) return { green: false, note: `${open.length} review thread(s) are unresolved`, open, viewer, ...(reviewed ? { unresolved } : {}) };
  const advisory = external ? advisoryNote({ ...judged.advisory, threads: unresolved.filter((thread) => !holdsThread(thread, external)) }) : null;
  return { green: true, ...(advisory ? { advisory } : {}) };
}

// The unresolved threads of a thread read, or null when it was not read whole.
function unresolvedThreads(threadsResponse, threads) {
  const page = threads?.data?.repository?.pullRequest?.reviewThreads;
  if (!threadsResponse.ok || threads?.errors?.length || !Array.isArray(page?.nodes) || page.pageInfo?.hasNextPage !== false) return null;
  return page.nodes.filter((thread) => thread?.isResolved !== true);
}

// settle, when given, is handed the unresolved threads of a read on which
// nothing else stood in the way. It may end the wait with an outcome.
// M10: review, when given, is handed every unresolved thread of a read held
// only by threads. It may end the wait with an outcome, and once it resolved
// threads the wait runs long enough for green to hold again.
async function waitForGreen(io, gh, target, limits, settle, review) {
  let deadline = io.now().getTime() + limits.waitMs;
  let streak = 0;
  let last = "no read yet";
  for (;;) {
    let state;
    try { state = await checkState(gh, target); } catch (error) {
      if (error.landOutcome) throw error;
      state = { green: false, note: `a read failed: ${error.message}` };
    }
    if (state.identity) stop("LAND_ERROR", `the repaired pull request changed during the wait: ${state.identity}`);
    if (state.moved) stop("LAND_HEAD_MISMATCH", `the pull request head moved to ${state.sha} after the review passed ${target.head}`);
    if (state.red) return { outcome: "PR_OPENED_CI_RED", reason: `red: ${state.red.join(", ")}` };
    streak = state.green ? streak + 1 : 0;
    if (streak >= limits.greenReads) return { outcome: "GREEN", ...(state.advisory ? { advisory: state.advisory } : {}) };
    if (!state.green) last = state.note;
    if (state.open && settle) {
      const step = await settle(state.open, state.viewer);
      if (step.outcome) return step;
      last = step.note;
    }
    if (state.unresolved && review) {
      const step = await review(state.unresolved, deadline - io.now().getTime());
      if (step.outcome) return step;
      if (step.note) last = step.note;
      if (step.resolved) deadline = Math.max(deadline, io.now().getTime() + (limits.greenReads + 1) * limits.pollMs);
    }
    if (io.now().getTime() >= deadline) return { outcome: "CI_TIMEOUT", reason: `not green within ${Math.round(limits.waitMs / 60000)} minutes: ${last}` };
    io.sleep(limits.pollMs);
  }
}

// M10: a promise that settles within ms, or rejects.
function withDeadline(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 60000)} minutes`)), ms); })])
    .finally(() => clearTimeout(timer));
}

// M10: the files the threads point at, at the passed head, for the review
// lane's workspace. A file that cannot be read, or is too large, is left out.
async function commentedFiles(gh, repo, head, threads) {
  const files = [];
  for (const file of [...new Set(threads.map((thread) => thread.path).filter(Boolean))]) {
    try {
      const response = await gh("GET", `https://api.github.com/repos/${repo}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${head}`);
      const json = await response.json();
      if (!response.ok || json?.type !== "file" || json?.encoding !== "base64" || !(json.size <= REVIEW_LIMITS.fileBytes)) continue;
      files.push({ path: file, text: Buffer.from(String(json.content ?? ""), "base64").toString("utf8") });
    } catch { /* left out */ }
  }
  return files;
}

// Self-repair B2: the repaired pull request, read by its number; never found
// by branch and never opened.
async function repairPull(gh, { repo, branch, number }) {
  const response = await gh("GET", `https://api.github.com/repos/${repo}/pulls/${number}`);
  const pull = await response.json();
  if (!response.ok || !pull) stop("LAND_ERROR", `the repaired pull request #${number} cannot be read (HTTP ${response.status})`);
  const wrong = repairPullIdentity(pull, { repo, number, branch });
  if (wrong) stop("LAND_ERROR", `the repaired pull request is not the one repaired: ${wrong}`);
  return { pr: pull, opened: false };
}

// Self-repair B2: the last look before the merge call. The pull request is
// still the repaired one at the repaired head, and that head's own checks are
// still green. Returns null, or what stops the merge.
async function repairLastCheck(gh, { repo, number, branch, head, external }) {
  const [pullResponse, runsResponse, statusResponse] = await Promise.all([
    gh("GET", `https://api.github.com/repos/${repo}/pulls/${number}`),
    gh("GET", `https://api.github.com/repos/${repo}/commits/${head}/check-runs?filter=latest&per_page=100`),
    gh("GET", `https://api.github.com/repos/${repo}/commits/${head}/status?per_page=100`),
  ]);
  const [pull, runs, status] = await Promise.all([pullResponse.json(), runsResponse.json(), statusResponse.json()]);
  if (!pullResponse.ok || !pull) return { outcome: "LAND_ERROR", reason: `pull request #${number} cannot be read right before the merge` };
  const wrong = repairPullIdentity(pull, { repo, number, branch });
  if (wrong) return { outcome: "LAND_ERROR", reason: `right before the merge: ${wrong}` };
  if (!headMatches(pull, { repo, branch, head })) {
    return { outcome: "LAND_HEAD_MISMATCH", reason: `the pull request head moved to ${pull.head?.sha ?? "an unknown head"} right before the merge of ${head}` };
  }
  const judged = judgeChecks(runsResponse, runs, statusResponse, status, external, { head });
  if (!judged.green) return { outcome: "MERGE_HOLD", reason: `right before the merge the checks of ${head} are not green: ${judged.red ? `red: ${judged.red.join(", ")}` : judged.note}` };
  return null;
}

// The run's landing. Returns an outcome, never throws.
export async function landCard({ io, plan, config, credentials, landToken, pausePath, limits = LAND_LIMITS, adjudicate = null }) {
  // SHU-310: what settling did, on every outcome, when it is on.
  let policy = null;
  const audit = { settled: [], blocking: [] };
  // M10: what the review lane judged, on every outcome, when it is on.
  const reviewOn = config?.landing_thread_review?.enabled === true;
  const judged = { judged: false, resolved: [], must_fix: [], held: null };
  // Carried whenever the committed config turns settling on, even when the
  // run stops before it reads the policy, or because the policy is malformed.
  const settleOn = config?.landing_thread_settle?.enabled === true;
  const result = (outcome, extra = {}) => ({ outcome, ...extra, ...(settleOn ? { threads: audit } : {}), ...(reviewOn ? { thread_review: judged } : {}) });
  if (!landToken) return result("LAND_SKIPPED_NO_TOKEN", { reason: "no landing token" });
  const card = plan.id;
  const branch = plan.branch;
  const repo = config?.pilot_repo;
  // Self-repair B2: the repair this landing finishes, or null.
  const repair = plan.repair ?? null;
  let repairHeld = null;
  const activationId = plan.record.activation_id;
  const paused = () => Boolean(pausePath) && io.fs.existsSync(pausePath);
  const fetchImpl = boundedFetch(io, limits.requestTimeoutMs, { attempts: limits.networkAttempts, waitMs: limits.networkRetryWaitMs });
  const gh = github(fetchImpl, landToken);
  const linearToken = credentials?.LINEAR_API_TOKEN;
  const actorIds = config?.linear_receipt_actor_ids;
  let pr = null;
  // The head the run's terminal PASS reviewed, once read: every later outcome,
  // an error included, carries it for diagnosis. reviewed_head is set only
  // once the pull request is seen at that head, and never on a head mismatch,
  // so a claim never names a head the pull request did not carry.
  let head = null;
  let reviewedHead = null;
  try {
    if (paused()) return result("LAND_PAUSED", { reason: `${pausePath} exists; nothing was opened` });
    policy = settlePolicy(config);
    const review = threadReviewPolicy(config);
    if (review?.error) stop("LAND_ERROR", review.error);
    const external = externalPolicy(config);
    if (!external) stop("LAND_ERROR", "external_checks in the committed config is malformed");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "") || !branch) stop("LAND_ERROR", "pilot_repo or the card branch is missing");
    if (config?.routine_merge_authority?.repo !== repo) stop("LAND_ERROR", "the committed merge authority does not name the pilot repository");
    if (!linearToken || !Array.isArray(actorIds) || actorIds.length === 0) stop("LAND_ERROR", "the coordinator's Linear token or trusted receipt actors are missing");
    const issue = (await sendLinear(CARD_LAND_ISSUE_QUERY, { id: card }, linearToken, fetchImpl))?.issue;
    if (!issue?.id || issue.identifier !== card || typeof issue.title !== "string") stop("LAND_ERROR", `${card} cannot be read from Linear`);
    const before = parseReceiptsFromComments(await fetchIssueComments({ issueId: issue.id, token: linearToken, fetchImpl }), actorIds);
    const { terminal } = passedTerminal(before, { card, repo, branch, activationId });
    head = terminal.target_sha;

    const opened = repair ? await repairPull(gh, { repo, branch, number: repair.pr })
      : await findOrOpenPull(gh, { repo, branch, card, title: issue.title, activationId, head });
    if (repair) gh.repairBinding = { number: repair.pr };
    pr = opened.pr;
    if (!headMatches(pr, { repo, branch, head })) {
      stop("LAND_HEAD_MISMATCH", `pull request #${pr?.number} is at ${pr?.head?.sha ?? "an unknown head"}, not the passed ${head}`);
    }
    reviewedHead = head;
    const prFields = { pr: pr.number, opened: opened.opened, head, reviewed_head: head };
    // Self-repair B2: the repaired head must not have weakened a test.
    if (repair) {
      const guard = await readTestWeakening(gh, { repo, base: repair.failed_head, head });
      if (!guard.ok) return result("REPAIR_TEST_WEAKENED", { ...prFields, reason: guard.reason });
    }

    // SHU-310: settles review bot threads only when every unresolved thread
    // is settleable and the run stays within its limit.
    const settled = new Map();
    const ctx = { gh, issue, linearToken, fetchImpl, actorIds, card, prNumber: pr.number, head, audit };
    const settle = policy && (async (open, viewer) => {
      const entries = open.map((node) => classifyThread(node, viewer, policy));
      const blocking = entries.filter((entry) => !entry.settle);
      audit.blocking = blocking.map(({ url, why }) => ({ url, why }));
      if (blocking.length) {
        return { note: `${blocking.length} review thread(s) are unresolved and not settleable: ${blocking.map(({ url, why }) => `${url ?? "a thread"} (${why})`).join(", ")}` };
      }
      if (audit.settled.length + entries.length > policy.maxPerRun) {
        return { outcome: "THREADS_HELD", reason: `${entries.length} review bot thread(s) would take this run past its limit of ${policy.maxPerRun}: ${entries.map(({ url }) => url).join(", ")}` };
      }
      if (paused()) return { outcome: "LAND_PAUSED", reason: `${pausePath} exists; no review thread was settled and the pull request stays open and unmerged` };
      for (const entry of entries) settled.set(entry.id, await settleThread(ctx, entry));
      return { note: `${entries.length} review bot thread(s) settled; green must hold again` };
    });
    // M10: the review lane judges bot threads, once for this head.
    const reviewed = review ? new Map() : null;
    const judge = review && (async (unresolved, leftMs) => {
      if (judged.judged) return { note: judged.held };
      const threads = unresolved.map((node) => botThread(node, review));
      const others = threads.filter((thread) => !thread.id);
      if (others.length) {
        return { note: `${others.length} unresolved review thread(s) are not for the review lane: ${others.map(({ url, why }) => `${url ?? "a thread"} (${why})`).join(", ")}` };
      }
      // The lane runs inside the landing's wait, so the run stays within its
      // unit's start timeout; with too little left it is not started at all.
      if (!(leftMs >= review.timeoutMs)) return { note: "too little of the landing's wait is left for the review lane to judge the bot threads" };
      judged.judged = true;
      const held = (why) => { judged.held = why; return { note: why }; };
      if (threads.length > review.maxThreads) return held(`${threads.length} review bot thread(s) are more than the review lane judges at once (${review.maxThreads})`);
      const lane = judgingLane(plan.record, terminal);
      if (!lane.lane) return held(`the review bot threads were not judged: ${lane.why}`);
      if (paused()) return { outcome: "LAND_PAUSED", reason: `${pausePath} exists; no review thread was judged and the pull request stays open and unmerged` };
      const files = await commentedFiles(gh, repo, head, threads);
      const prompt = adjudicationPrompt({ card, lane: lane.lane, pr: pr.number, head, threads, files });
      if (!prompt) return held("the review bot threads are too long to put to the review lane");
      let answer;
      try {
        answer = await withDeadline(adjudicate ? adjudicate({ lane: lane.lane, head, prompt, files, timeoutMs: review.timeoutMs })
          : Promise.reject(new Error("no review lane launcher was given")), review.timeoutMs);
      } catch (error) {
        return held(`the review lane did not judge the bot threads: ${String(error?.message ?? error)}`);
      }
      const parsed = parseAdjudication(answer, threads.map((thread) => thread.id));
      if (!parsed.ok) return held(`the review lane's answer on the bot threads was unusable: ${parsed.reason}`);
      judged.must_fix = threads.filter((thread) => parsed.verdicts.get(thread.id).verdict === "must_fix")
        .map((thread) => ({ url: thread.url, reason: parsed.verdicts.get(thread.id).reason }));
      if (judged.must_fix.length) {
        return held(`the review lane judged ${judged.must_fix.length} bot thread(s) must_fix: ${judged.must_fix.map(({ url, reason }) => `${url} (${reason})`).join("; ")}`);
      }
      if (paused()) return { outcome: "LAND_PAUSED", reason: `${pausePath} exists; no review thread was resolved and the pull request stays open and unmerged` };
      // Nothing is written unless the pull request is still at the head that
      // passed and every thread is still exactly what was judged.
      const now = await (await gh("GET", `https://api.github.com/repos/${repo}/pulls/${pr.number}`)).json();
      if (!headMatches(now, { repo, branch, head })) stop("LAND_HEAD_MISMATCH", `the pull request head moved to ${now?.head?.sha ?? "an unknown head"} while the review lane judged its threads`);
      const entries = [];
      for (const thread of threads) {
        const data = await graphql(gh, THREAD_QUERY, { id: thread.id });
        const read = readThread(data?.node, data?.viewer?.login, reviewMarker);
        const again = botThread(data?.node, review);
        const was = unresolved.find((node) => node?.id === thread.id);
        if (!read || !again.id || read.replies.length || JSON.stringify(read.others.map(commentKey)) !== JSON.stringify(readThread(was, null, reviewMarker)?.others.map(commentKey))) {
          return held(`review thread ${thread.url} changed while the review lane judged it; nothing was resolved`);
        }
        entries.push({ id: thread.id, url: thread.url, snapshot: read.others.map(commentKey) });
      }
      for (const entry of entries) {
        const reply = reviewReplyBody({ threadId: entry.id, card, lane: lane.lane, head, reason: parsed.verdicts.get(entry.id).reason });
        reviewed.set(entry.id, await replyAndResolve(gh, entry, reply, reviewMarker));
        judged.resolved.push({ url: entry.url, reason: parsed.verdicts.get(entry.id).reason });
      }
      return { note: `the review lane judged ${entries.length} bot thread(s) not applicable and they were resolved; green must hold again`, resolved: true };
    });
    const checks = await waitForGreen(io, gh, { repo, number: pr.number, head, branch, settled, policy, external, reviewed }, limits, settle || undefined, judge || undefined);
    if (checks.outcome !== "GREEN") return result(checks.outcome, { ...prFields, reason: checks.reason });
    audit.blocking = [];

    if (paused()) return result("LAND_PAUSED", { ...prFields, reason: `${pausePath} exists; the pull request stays open and unmerged` });
    if (policy || reviewed?.size) await guardThreads(gh, { repo, number: pr.number }, settled, policy, reviewed ?? undefined);

    // The handoff: the terminal PASS plus merge-readiness, the very record the
    // coordinator's own consumer writes, through its writer.
    const decision = { action: "merge-readiness", hold_code: "MISSING_AUTHORITY" };
    if (terminal.handoff) {
      if (!validHandoff(terminal) || JSON.stringify(terminal.handoff) !== JSON.stringify(handoffReceipt(terminal, head, decision).handoff)) {
        stop("LAND_ERROR", "the PASS already carries a different handoff");
      }
    } else {
      if (!validHandoff(handoffReceipt(terminal, head, decision))) stop("LAND_ERROR", "the PASS cannot carry a merge-readiness handoff");
      await writeHandoffReceipt({ terminal, target: head, decision, issueId: issue.id, linearToken, fetchImpl });
    }

    // What the consumer reads: the trusted thread as it is now, cut to this
    // card's branch, with no handoff but this PASS's own.
    const after = parseReceiptsFromComments(await fetchIssueComments({ issueId: issue.id, token: linearToken, fetchImpl }), actorIds);
    const source = after.find((r) => r.attempt_id === terminal.attempt_id && r.handoff?.action === "merge-readiness" && r.handoff.target_sha === head);
    if (!source) stop("LAND_ERROR", "the handoff did not read back");
    const receipts = after.filter((r) => r.issue_id === card && r.repo === repo && r.branch === branch && (!r.handoff || r === source));
    const lines = [];
    const consumed = await consumeMergeReadiness({
      receipts,
      issues: [{ id: card, linearId: issue.id }],
      linearToken,
      githubToken: landToken,
      config: { ...config, routine_merge_authority: { ...config.routine_merge_authority, enabled: true } },
      env: { ENABLE_ROUTINE_MERGE: "true" },
      requireAllChecks: true,
      // Only what holds the landing above holds the merge.
      externalPolicy: external,
      // SHU-310: the consumer runs the thread check once more right before
      // its merge call, and holds on a failure.
      ...(policy || reviewed?.size ? { beforeMerge: async () => { await guardThreads(gh, { repo, number: pr.number }, settled, policy, reviewed ?? undefined); return { ok: true }; } } : {}),
      // Self-repair B2: a repair's last look, after the thread check when there is one.
      ...(repair ? { beforeMerge: async () => {
        if (policy !== null || reviewed?.size) await guardThreads(gh, { repo, number: pr.number }, settled, policy, reviewed ?? undefined);
        repairHeld = await repairLastCheck(gh, { repo, number: pr.number, branch, head, external });
        return { ok: repairHeld === null };
      } } : {}),
      fetchImpl,
      stdout: (line) => lines.push(line),
      now: () => io.now(),
    });
    if (consumed.error) stop("LAND_ERROR", consumed.error);

    const thread = await fetchIssueComments({ issueId: issue.id, token: linearToken, fetchImpl });
    const parsed = parseMergeAttemptsFromComments(thread, actorIds);
    const record = parsed.records.find((r) => r.source_attempt_id === terminal.attempt_id && r.approved_head_sha === head);
    if (!record || parsed.conflicts.has(record.attempt_id)) stop("LAND_ERROR", `no merge attempt was recorded${lines.length ? `: ${lines.at(-1)}` : ""}`);
    // Only a COMPLETED record is a merge; a HOLD is final for its attempt.
    const completed = record.state === "COMPLETED";
    if (!completed) {
      // Self-repair B2: a merge the repair's last look stopped says why.
      if (record.state === "HOLD" && repairHeld) {
        if (repairHeld.outcome === "MERGE_HOLD") return result("MERGE_HOLD", { ...prFields, hold_code: record.hold_code, attempt_id: record.attempt_id, reason: repairHeld.reason });
        stop(repairHeld.outcome, repairHeld.reason);
      }
      if (record.state === "HOLD") return result("MERGE_HOLD", { ...prFields, hold_code: record.hold_code, attempt_id: record.attempt_id, reason: record.reason });
      stop("LAND_ERROR", `the merge attempt ${record.attempt_id} reads ${record.state}`);
    }

    const marker = mergeCommentMarker(record.attempt_id);
    let commented = thread.some((comment) => String(comment?.body ?? "").includes(marker));
    if (!commented) {
      const body = [marker, `Merged by card run ${activationId}: pull request #${pr.number} landed on main as ${record.merge_commit_sha}.`,
        ...(checks.advisory ? [`${checks.advisory[0].toUpperCase()}${checks.advisory.length > 300 ? `${checks.advisory.slice(1, 299)}…` : checks.advisory.slice(1)}.`] : [])].join("\n");
      const posted = await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: issue.id, body }, linearToken, fetchImpl);
      commented = posted?.commentCreate?.success === true;
    }
    return result("MERGED", { ...prFields, merge_commit: record.merge_commit_sha, attempt_id: record.attempt_id, commented,
      ...(checks.advisory ? { advisory: checks.advisory } : {}) });
  } catch (error) {
    const outcome = error.landOutcome ?? "LAND_ERROR";
    return result(outcome, { ...(pr?.number ? { pr: pr.number } : {}), ...(head ? { head } : {}),
      ...(reviewedHead && outcome !== "LAND_HEAD_MISMATCH" ? { reviewed_head: reviewedHead } : {}),
      reason: String(error.message ?? error) });
  }
}
