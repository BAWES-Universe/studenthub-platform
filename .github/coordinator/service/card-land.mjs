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
// It never moves the card: a merge never produces Done. Every network call has
// its own deadline, and the wait is bounded, so the run stays inside its unit's
// TimeoutStartSec. Nothing here throws: every stop is an outcome for the run
// report.
//
// The landing token is the only credential that can open and merge a pull
// request. It lives in its own root-only file that card-run alone reads; it is
// never in the coordinator's environment file, so neither the coordinator unit
// nor any worker can see it. Without it the run behaves as before and reports
// LAND_SKIPPED_NO_TOKEN.
import { sendLinear, fetchIssueComments, parseReceiptsFromComments, LINEAR_COMMENT_CREATE_MUTATION } from "../reconcile.mjs";
import { writeHandoffReceipt, validHandoff, handoffReceipt } from "../durable-handoff.mjs";
import { consumeMergeReadiness, parseMergeAttemptsFromComments } from "../merge-readiness.mjs";

export const CARD_LAND_ENV = "/srv/shu/card-land.env";
export const LAND_TOKEN_KEY = "SHU_LAND_GITHUB_TOKEN";
export const LAND_LIMITS = Object.freeze({
  waitMs: 30 * 60 * 1000,
  pollMs: 60 * 1000,
  requestTimeoutMs: 30 * 1000,
  // Green must hold on this many reads in a row, so a workflow queued a moment
  // after the others is not missed.
  greenReads: 2,
});
export const LAND_OUTCOMES = Object.freeze([
  "MERGED", "PR_OPENED_CI_RED", "CI_TIMEOUT", "MERGE_HOLD", "LAND_PAUSED", "LAND_SKIPPED_NO_TOKEN",
  "LAND_HEAD_MISMATCH", "LAND_ERROR",
]);
const SHA_RE = /^[0-9a-f]{40}$/;
const GREEN = new Set(["success", "neutral", "skipped"]);
const THREADS_QUERY = "query CardLandThreads($owner:String!,$name:String!,$number:Int!) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { isResolved } pageInfo { hasNextPage } } } } }";

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

// A fetch whose answer, body included, arrives within the deadline or not at
// all. The SHU-259 consumer is handed this one too, so its calls are bounded.
export function boundedFetch(io, timeoutMs) {
  return async (url, options = {}) => {
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

function github(fetchImpl, token) {
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

// One read of the head's checks and the pull request's own state.
async function checkState(gh, { repo, number, head, branch }) {
  const [owner, name] = repo.split("/");
  const [runsResponse, statusResponse, pullResponse, threadsResponse] = await Promise.all([
    gh("GET", `https://api.github.com/repos/${repo}/commits/${head}/check-runs?filter=latest&per_page=100`),
    gh("GET", `https://api.github.com/repos/${repo}/commits/${head}/status?per_page=100`),
    gh("GET", `https://api.github.com/repos/${repo}/pulls/${number}`),
    gh("POST", "https://api.github.com/graphql", { query: THREADS_QUERY, variables: { owner, name, number } }),
  ]);
  const [runs, status, pull, threads] = await Promise.all([runsResponse.json(), statusResponse.json(), pullResponse.json(), threadsResponse.json()]);
  if (pullResponse.ok && pull && !headMatches(pull, { repo, branch, head })) return { moved: true, sha: pull?.head?.sha ?? null };
  const checkRuns = runs?.check_runs;
  const statuses = status?.statuses;
  if (!runsResponse.ok || !statusResponse.ok || !pullResponse.ok || !Array.isArray(checkRuns) || !Array.isArray(statuses)
      || (runs.total_count ?? 0) > 100 || statuses.length >= 100) {
    return { green: false, note: "the checks could not be read in full" };
  }
  const red = [
    ...checkRuns.filter((run) => run?.status === "completed" && !GREEN.has(run?.conclusion)).map((run) => `${run?.name}: ${run?.conclusion}`),
    ...statuses.filter((item) => ["failure", "error"].includes(item?.state)).map((item) => `${item?.context}: ${item?.state}`),
  ];
  if (red.length) return { red };
  const pending = checkRuns.some((run) => run?.status !== "completed") || statuses.some((item) => item?.state !== "success");
  if (checkRuns.length + statuses.length === 0) return { green: false, note: "no check has reported yet" };
  if (pending) return { green: false, note: "checks are still running" };
  if (pull.mergeable !== true || pull.mergeable_state !== "clean") return { green: false, note: `the pull request reads mergeable_state ${pull.mergeable_state ?? "unknown"}` };
  // The SHU-259 consumer holds for good on any unresolved review thread, so a
  // thread (a review bot's included) keeps the run waiting before the handoff.
  const page = threads?.data?.repository?.pullRequest?.reviewThreads;
  if (!threadsResponse.ok || threads?.errors?.length || !Array.isArray(page?.nodes) || page.pageInfo?.hasNextPage !== false) {
    return { green: false, note: "the review threads could not be read in full" };
  }
  const open = page.nodes.filter((thread) => thread?.isResolved !== true).length;
  if (open) return { green: false, note: `${open} review thread(s) are unresolved` };
  return { green: true };
}

async function waitForGreen(io, gh, target, limits) {
  const deadline = io.now().getTime() + limits.waitMs;
  let streak = 0;
  let last = "no read yet";
  for (;;) {
    let state;
    try { state = await checkState(gh, target); } catch (error) { state = { green: false, note: `a read failed: ${error.message}` }; }
    if (state.moved) stop("LAND_HEAD_MISMATCH", `the pull request head moved to ${state.sha} after the review passed ${target.head}`);
    if (state.red) return { outcome: "PR_OPENED_CI_RED", reason: `red: ${state.red.join(", ")}` };
    streak = state.green ? streak + 1 : 0;
    if (streak >= limits.greenReads) return { outcome: "GREEN" };
    if (!state.green) last = state.note;
    if (io.now().getTime() >= deadline) return { outcome: "CI_TIMEOUT", reason: `not green within ${Math.round(limits.waitMs / 60000)} minutes: ${last}` };
    io.sleep(limits.pollMs);
  }
}

// The run's landing. Returns an outcome, never throws.
export async function landCard({ io, plan, config, credentials, landToken, pausePath, limits = LAND_LIMITS }) {
  const result = (outcome, extra = {}) => ({ outcome, ...extra });
  if (!landToken) return result("LAND_SKIPPED_NO_TOKEN", { reason: "no landing token" });
  const card = plan.id;
  const branch = plan.branch;
  const repo = config?.pilot_repo;
  const activationId = plan.record.activation_id;
  const paused = () => Boolean(pausePath) && io.fs.existsSync(pausePath);
  const fetchImpl = boundedFetch(io, limits.requestTimeoutMs);
  const gh = github(fetchImpl, landToken);
  const linearToken = credentials?.LINEAR_API_TOKEN;
  const actorIds = config?.linear_receipt_actor_ids;
  let pr = null;
  try {
    if (paused()) return result("LAND_PAUSED", { reason: `${pausePath} exists; nothing was opened` });
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "") || !branch) stop("LAND_ERROR", "pilot_repo or the card branch is missing");
    if (config?.routine_merge_authority?.repo !== repo) stop("LAND_ERROR", "the committed merge authority does not name the pilot repository");
    if (!linearToken || !Array.isArray(actorIds) || actorIds.length === 0) stop("LAND_ERROR", "the coordinator's Linear token or trusted receipt actors are missing");
    const issue = (await sendLinear(CARD_LAND_ISSUE_QUERY, { id: card }, linearToken, fetchImpl))?.issue;
    if (!issue?.id || issue.identifier !== card || typeof issue.title !== "string") stop("LAND_ERROR", `${card} cannot be read from Linear`);
    const before = parseReceiptsFromComments(await fetchIssueComments({ issueId: issue.id, token: linearToken, fetchImpl }), actorIds);
    const { terminal } = passedTerminal(before, { card, repo, branch, activationId });
    const head = terminal.target_sha;

    const opened = await findOrOpenPull(gh, { repo, branch, card, title: issue.title, activationId, head });
    pr = opened.pr;
    if (!headMatches(pr, { repo, branch, head })) {
      stop("LAND_HEAD_MISMATCH", `pull request #${pr?.number} is at ${pr?.head?.sha ?? "an unknown head"}, not the passed ${head}`);
    }
    const prFields = { pr: pr.number, opened: opened.opened, head };

    const checks = await waitForGreen(io, gh, { repo, number: pr.number, head, branch }, limits);
    if (checks.outcome !== "GREEN") return result(checks.outcome, { ...prFields, reason: checks.reason });

    if (paused()) return result("LAND_PAUSED", { ...prFields, reason: `${pausePath} exists; the pull request stays open and unmerged` });

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
      if (record.state === "HOLD") return result("MERGE_HOLD", { ...prFields, hold_code: record.hold_code, attempt_id: record.attempt_id, reason: record.reason });
      stop("LAND_ERROR", `the merge attempt ${record.attempt_id} reads ${record.state}`);
    }

    const marker = mergeCommentMarker(record.attempt_id);
    let commented = thread.some((comment) => String(comment?.body ?? "").includes(marker));
    if (!commented) {
      const body = [marker, `Merged by card run ${activationId}: pull request #${pr.number} landed on main as ${record.merge_commit_sha}.`].join("\n");
      const posted = await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: issue.id, body }, linearToken, fetchImpl);
      commented = posted?.commentCreate?.success === true;
    }
    return result("MERGED", { ...prFields, merge_commit: record.merge_commit_sha, attempt_id: record.attempt_id, commented });
  } catch (error) {
    return result(error.landOutcome ?? "LAND_ERROR", { ...(pr?.number ? { pr: pr.number } : {}), reason: String(error.message ?? error) });
  }
}
