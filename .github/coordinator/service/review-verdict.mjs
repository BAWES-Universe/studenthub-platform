// M18 G1 + G5 (CONTINUOUS-GATE.md): a box review's verdict on the pull request
// itself, and one metrics line per review.
//
// G1. When a review-only run (SHU-304) ends, its verdict is set as the commit
// status `orchestrator/review` on the exact head it reviewed, and posted once
// as a pull request comment:
//   - PASS: status success, "PASS at <short sha>"; comment first line
//     "PASS at <full sha>";
//   - BLOCKED: status failure, "BLOCK at <short sha>: <first line of the
//     findings>", at most 140 characters; comment first line
//     "BLOCK at <full sha>";
//   - while the review runs: status pending, "review running";
//   - no verdict (HOLD, a moved head, an expiry, any stop): no comment, and
//     only when this run set pending, status error "no verdict, will retry".
//     Never success.
// A status is bound to its SHA by GitHub, so a later push never inherits it.
// The SHA is the one the coordinator's tick named in its terminal line
// ("review-only verdict PASS at <sha>", decided from the validated callback's
// target_sha), and it must equal the head the run armed; anything else
// publishes no verdict. The review card's terminal receipt for the episode
// must also be read and agree on the verdict and the SHA; a receipt that is
// missing, unreadable or disagrees publishes no verdict.
//
// The writes go out with the landing token, the one credential the box already
// holds that may write to GitHub (card-land.mjs). Its statuses scope cannot be
// confirmed from here, so publishing is best effort: a missing token, a
// refused write or a failed read is a warning in the run report and never
// changes the verdict, the run's outcome or the claim. Nothing here throws.
// queue_config_review.publish_status false turns it off; absent means on.
//
// Duplicates: before posting, the pull request's comments are read whole, and
// one already carrying this verdict's first line and the orchestrator marker
// is the comment; a list that cannot be read posts nothing.
//
// G5. Every review that armed appends one JSON line to review-metrics.jsonl in
// the state directory: pr, head_sha, head_pushed_at, review_started_at,
// verdict_at, verdict (PASS, BLOCKED or HOLD), slot (the card worker) and
// dropped (true for HOLD). The run report summarises the last 24 hours in one
// line.
import path from "node:path";
import { sendLinear, fetchIssueComments, parseReceiptsFromComments } from "../reconcile.mjs";
import { boundedFetch, github } from "./card-land.mjs";

export const REVIEW_STATUS_CONTEXT = "orchestrator/review";
export const REVIEW_STATUS_DESCRIPTION_MAX = 140;
export const REVIEW_COMMENT_MARKER = "<!-- orchestrator-review v1 -->";
export const REVIEW_METRICS_FILE = "review-metrics.jsonl";
export const REVIEW_HOLD_DESCRIPTION = "no verdict, will retry";
export const REVIEW_PENDING_DESCRIPTION = "review running";
// Pages of 100 comments read before a post; a pull request with more is not
// posted on, rather than risk a duplicate.
export const REVIEW_COMMENT_PAGES = 10;
const REVIEW_SUMMARY_MAX = 6000;
const REVIEW_LINKS_MAX = 32;
const SHA_RE = /^[0-9a-f]{40}$/;
const VERDICT_RE = /^review-only verdict (PASS|BLOCKED) at ([0-9a-f]{40}) /;
const REVIEW_PASS_RE = /^review PASS — the episode is complete$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_ISSUE_QUERY = `
  query ReviewVerdictIssue($id: String!) {
    issue(id: $id) { id identifier }
  }`;

// The committed switch: on unless queue_config_review.publish_status is false.
export function publishStatusOn(config) {
  return config?.queue_config_review?.publish_status !== false;
}

// What a finished review run decided, from its own summary: PASS or BLOCKED
// at the exact head it armed, or HOLD. A verdict whose SHA is not the armed
// head is no verdict.
//
// A PASS from a lane whose requested worker matches its verdict ends the
// episode on the coordinator's generic line, "review PASS — the episode is
// complete" (single-run-activation.mjs), which names no SHA; the card run
// reports it as outcome PASS. That line is a PASS at the armed head only once
// the review card's terminal receipt agrees on PASS at that head, which
// finishReview requires before anything is published (2026-11-21: the first
// review on the installed G1, #595 at 136579c, passed this way and published
// nothing).
export function reviewVerdictOf(result) {
  const head = result?.review?.head;
  if (result?.kind !== "review" || !SHA_RE.test(head ?? "")) return null;
  if (result.outcome === "PASS" && REVIEW_PASS_RE.test(String(result.reason ?? ""))) return { verdict: "PASS", sha: head };
  const match = VERDICT_RE.exec(String(result.reason ?? ""));
  const outcome = match ? `REVIEW_${match[1]}` : null;
  if (match && result.outcome === outcome && match[2] === head) return { verdict: match[1], sha: head };
  return { verdict: "HOLD", sha: head, ...(match && match[2] !== head ? { mismatch: match[2] } : {}) };
}

// The first non-empty line, with its whitespace collapsed.
export function firstLine(text) {
  return String(text ?? "").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
}

function fit(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The commit status for a verdict, or for a run still going ("PENDING").
export function reviewStatus({ verdict, sha, summary = null }) {
  if (!SHA_RE.test(sha ?? "")) return null;
  const short = sha.slice(0, 7);
  if (verdict === "PASS") return { state: "success", description: `PASS at ${short}`, context: REVIEW_STATUS_CONTEXT };
  if (verdict === "BLOCKED") {
    const line = firstLine(summary);
    const head = `BLOCK at ${short}`;
    return { state: "failure", description: line ? fit(`${head}: ${line}`, REVIEW_STATUS_DESCRIPTION_MAX) : head, context: REVIEW_STATUS_CONTEXT };
  }
  if (verdict === "PENDING") return { state: "pending", description: REVIEW_PENDING_DESCRIPTION, context: REVIEW_STATUS_CONTEXT };
  if (verdict === "HOLD") return { state: "error", description: REVIEW_HOLD_DESCRIPTION, context: REVIEW_STATUS_CONTEXT };
  return null;
}

export function verdictHeadline(verdict, sha) {
  return `${verdict === "PASS" ? "PASS" : "BLOCK"} at ${sha}`;
}

// The reviewer's words go to GitHub as quoted data: no mention notifies anyone
// and nothing can close the marker.
function quoted(text) {
  return String(text).replace(/(^|[^A-Za-z0-9_.`])@(?=[A-Za-z0-9])/gm, "$1@\u200b").replace(/<!--|-->/g, " ");
}

export function verdictCommentBody({ verdict, sha, summary = null, links = [], card = null, activationId = null }) {
  const lines = [verdictHeadline(verdict, sha), ""];
  const text = typeof summary === "string" ? summary.trim() : "";
  lines.push(text ? fit(quoted(text), REVIEW_SUMMARY_MAX) : "The reviewer's summary could not be read; the receipt on the review card has it.");
  const evidence = (Array.isArray(links) ? links : []).filter((link) => typeof link === "string" && link.trim()).slice(0, REVIEW_LINKS_MAX);
  if (evidence.length) lines.push("", "Evidence:", ...evidence.map((link) => `- ${quoted(link.trim())}`));
  const where = [card, activationId].filter((part) => typeof part === "string" && part).join(", ");
  lines.push("", `Independent review by the StudentHub orchestrator${where ? ` (${where})` : ""}. ${REVIEW_COMMENT_MARKER}`);
  return lines.join("\n");
}

// A comment the orchestrator already posted for this verdict at this SHA.
export function isVerdictComment(body, verdict, sha) {
  const text = String(body ?? "");
  return text.split("\n")[0].trim() === verdictHeadline(verdict, sha) && text.includes(REVIEW_COMMENT_MARKER);
}

// The terminal receipt of this run's episode on the review card: its verdict,
// SHA, the reviewer's summary and evidence, and when it launched. Null when it
// cannot be read or does not agree with the verdict.
export async function readReviewTerminal({ fetchImpl, linearToken, actorIds, card, activationId, verdict, sha }) {
  if (!linearToken || !Array.isArray(actorIds) || actorIds.length === 0) return { terminal: null, warning: "the review card's receipts cannot be read (no Linear token or trusted actors)" };
  try {
    const issue = (await sendLinear(REVIEW_ISSUE_QUERY, { id: card }, linearToken, fetchImpl))?.issue;
    if (!issue?.id || issue.identifier !== card) return { terminal: null, warning: `${card} cannot be read from Linear` };
    const receipts = parseReceiptsFromComments(await fetchIssueComments({ issueId: issue.id, token: linearToken, fetchImpl }), actorIds);
    const terminal = receipts.filter((r) => r?.issue_id === card && r.episode_id === activationId && ["COMPLETED", "HOLD"].includes(r.stage)
      && ["PASS", "BLOCKED"].includes(r.verdict_stage))
      .sort((a, b) => String(a.last_activity ?? "").localeCompare(String(b.last_activity ?? ""))).at(-1) ?? null;
    if (!terminal) return { terminal: null, warning: `no terminal receipt of ${activationId} is on ${card}` };
    if (terminal.verdict_stage !== verdict || terminal.target_sha !== sha) {
      return { terminal: null, disagrees: true, warning: `the receipt on ${card} reads ${terminal.verdict_stage} at ${terminal.target_sha}, not ${verdict} at ${sha}` };
    }
    return { terminal };
  } catch (error) {
    return { terminal: null, warning: `the receipts of ${card} cannot be read (${String(error?.message ?? error).slice(0, 200)})` };
  }
}

// The reviewer's own words from a terminal receipt: a BLOCK's findings, or a
// PASS's summary note.
export function receiptFindings(terminal) {
  if (!terminal) return { summary: null, links: [] };
  const evidence = Array.isArray(terminal.evidence_links) ? terminal.evidence_links : [];
  if (terminal.verdict_stage === "BLOCKED") {
    const findings = terminal.review_findings ?? {};
    return { summary: typeof findings.summary === "string" ? findings.summary : null,
      links: [...(Array.isArray(findings.links) ? findings.links : []), ...evidence] };
  }
  const note = (Array.isArray(terminal.notes) ? terminal.notes : []).find((entry) => typeof entry === "string" && entry.startsWith("reviewer summary: "));
  let summary = null;
  if (note) { try { summary = JSON.parse(note.slice("reviewer summary: ".length)); } catch { summary = null; } }
  return { summary: typeof summary === "string" ? summary : null, links: evidence };
}

async function setStatus(gh, repo, sha, status, targetUrl = null) {
  const response = await gh("POST", `https://api.github.com/repos/${repo}/statuses/${sha}`, {
    state: status.state, description: status.description, context: status.context, ...(targetUrl ? { target_url: targetUrl } : {}) });
  if (response.status !== 201) throw new Error(`the ${status.state} status was not set (HTTP ${response.status})`);
}

async function findVerdictComment(gh, repo, pr, verdict, sha) {
  for (let page = 1; page <= REVIEW_COMMENT_PAGES; page += 1) {
    const response = await gh("GET", `https://api.github.com/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    const list = await response.json();
    if (response.status !== 200 || !Array.isArray(list)) throw new Error(`the comments of #${pr} cannot be read (HTTP ${response.status})`);
    const found = list.find((comment) => isVerdictComment(comment?.body, verdict, sha));
    if (found) return { url: typeof found.html_url === "string" ? found.html_url : null };
    if (list.length < 100) return null;
  }
  throw new Error(`#${pr} has more than ${REVIEW_COMMENT_PAGES * 100} comments`);
}

function writer(io, token, timeoutMs) {
  return github(boundedFetch(io, timeoutMs), token);
}

// The pending status as the run arms. Best effort: { set, warning }.
export async function publishPending({ io, token, repo, sha, timeoutMs }) {
  try {
    if (!token) return { set: false, warning: "no landing token, so no pending status" };
    await setStatus(writer(io, token, timeoutMs), repo, sha, reviewStatus({ verdict: "PENDING", sha }));
    return { set: true };
  } catch (error) {
    return { set: false, warning: String(error?.message ?? error).slice(0, 200) };
  }
}

// The verdict on the pull request: a comment once, then the status. HOLD posts
// no comment and sets error only over this run's own pending. Never throws.
export async function publishVerdict({ io, token, repo, pr, verdict, sha, summary = null, links = [], card = null, activationId = null,
  pendingSet = false, timeoutMs }) {
  const done = { status: null, comment: null, warnings: [] };
  if (!token) {
    if (verdict !== "HOLD" || pendingSet) done.warnings.push("no landing token, so the verdict was not published on GitHub");
    return done;
  }
  const gh = writer(io, token, timeoutMs);
  if (verdict === "HOLD") {
    if (!pendingSet) return done;
    try { await setStatus(gh, repo, sha, reviewStatus({ verdict, sha })); done.status = "error"; }
    catch (error) { done.warnings.push(String(error?.message ?? error).slice(0, 200)); }
    return done;
  }
  if (!["PASS", "BLOCKED"].includes(verdict) || !SHA_RE.test(sha ?? "") || !Number.isInteger(pr)) {
    done.warnings.push("no verdict to publish");
    return done;
  }
  let url = null;
  try {
    const existing = await findVerdictComment(gh, repo, pr, verdict, sha);
    if (existing) {
      done.comment = "exists";
      url = existing.url;
    } else {
      const response = await gh("POST", `https://api.github.com/repos/${repo}/issues/${pr}/comments`,
        { body: verdictCommentBody({ verdict, sha, summary, links, card, activationId }) });
      if (response.status !== 201) throw new Error(`the verdict comment was not posted (HTTP ${response.status})`);
      const posted = await response.json().catch(() => null);
      done.comment = "posted";
      url = typeof posted?.html_url === "string" ? posted.html_url : null;
    }
  } catch (error) {
    done.warnings.push(String(error?.message ?? error).slice(0, 200));
  }
  try {
    const status = reviewStatus({ verdict, sha, summary });
    await setStatus(gh, repo, sha, status, url);
    done.status = status.state;
  } catch (error) {
    done.warnings.push(String(error?.message ?? error).slice(0, 200));
  }
  return done;
}

// When the head commit was made, as GitHub records its committer date, or null.
export async function readHeadPushedAt({ io, token, repo, sha, timeoutMs }) {
  try {
    if (!token) return null;
    const response = await github(boundedFetch(io, timeoutMs), token)("GET", `https://api.github.com/repos/${repo}/commits/${sha}`);
    const json = await response.json();
    const at = json?.commit?.committer?.date;
    return response.status === 200 && typeof at === "string" && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null;
  } catch {
    return null;
  }
}

export function reviewMetricsPath(stateDir) {
  return path.join(stateDir, REVIEW_METRICS_FILE);
}

// One line per review. Appended, so two workers never lose each other's line.
export function appendReviewMetric(io, stateDir, entry) {
  const line = `${JSON.stringify({
    pr: entry.pr, head_sha: entry.head_sha, head_pushed_at: entry.head_pushed_at ?? null,
    review_started_at: entry.review_started_at ?? null, verdict_at: entry.verdict_at ?? null,
    verdict: entry.verdict, slot: entry.slot ?? null, dropped: entry.verdict === "HOLD",
  })}\n`;
  io.fs.appendFileSync(reviewMetricsPath(stateDir), line, { mode: 0o600 });
  return line;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The last 24 hours of review metrics, or null when there is no log. Lines
// that cannot be read are skipped; a review counts by its verdict_at.
export function summariseReviewMetrics(text, nowMs) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row?.verdict_at ?? "");
    if (!Number.isFinite(at) || at > nowMs || nowMs - at >= DAY_MS || !["PASS", "BLOCKED", "HOLD"].includes(row.verdict)) continue;
    rows.push({ ...row, at });
  }
  const verdicts = rows.filter((row) => row.verdict !== "HOLD");
  const waits = verdicts.map((row) => row.at - Date.parse(row.head_pushed_at ?? "")).filter((ms) => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
  return {
    reviews: rows.length,
    verdicts: verdicts.length,
    pass: verdicts.filter((row) => row.verdict === "PASS").length,
    dropped: rows.length - verdicts.length,
    median_ms: median(waits),
    p90_ms: percentile(waits, 90),
    timed: waits.length,
  };
}

export function readReviewMetrics(io, stateDir, { now = io.now() } = {}) {
  const file = reviewMetricsPath(stateDir);
  let text;
  try {
    const stat = io.fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    text = io.fs.readFileSync(file, "utf8");
  } catch { return null; }
  return summariseReviewMetrics(text, now.getTime());
}

export function reviewMetricsLine(metrics) {
  if (!metrics) return null;
  const minutes = (ms) => (ms === null ? "n/a" : `${Math.round(ms / 60000)} min`);
  const share = metrics.verdicts ? `${Math.round((100 * metrics.pass) / metrics.verdicts)}% PASS` : "no verdicts";
  return `Reviews: ${metrics.reviews} in the last 24 hours, ${share}; head to verdict median ${minutes(metrics.median_ms)}, `
    + `p90 ${minutes(metrics.p90_ms)} (${metrics.timed} timed); ${metrics.dropped} dropped with no verdict.`;
}

// One line on what the run put on GitHub, or the warning it met.
export function reviewPublishLine(publish) {
  if (!publish) return null;
  const done = [publish.status ? `status ${publish.status}` : null, publish.comment ? `comment ${publish.comment}` : null].filter(Boolean);
  const warnings = Array.isArray(publish.warnings) ? publish.warnings : [];
  if (!done.length && !warnings.length) return null;
  return `Review on GitHub (${REVIEW_STATUS_CONTEXT}): ${done.length ? done.join(", ") : "nothing set"}`
    + `${warnings.length ? `; warning: ${warnings.join("; ")}` : ""}.`;
}
