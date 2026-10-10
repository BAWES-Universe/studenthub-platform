// SHU-86, second slice: the two steps an operator still did by hand before a
// card run. The committed dispatch_scope already names the card, so the run
// itself now makes the card pickable and gives it its starting branch:
//
//   * the card moves to Todo, only from a not-yet-started state (backlog or
//     unstarted) and only while no person or agent owns it. A card in triage,
//     in progress, in review, done or canceled is refused, never reopened.
//   * a card run's coordinator/<card> branch is created at the installed
//     revision when it does not exist. A branch that exists elsewhere is
//     refused, never moved: it may hold an earlier run's work.
//
// Credentials are the coordinator's own (/srv/shu/coordinator.env), read once
// by root, kept in memory and never printed. Every write is read back.
import { sendLinear } from "../reconcile.mjs";

export const COORDINATOR_ENV = "/srv/shu/coordinator.env";
export const TODO_STATE = "Todo";
export const MOVABLE_STATE_TYPES = Object.freeze(["backlog", "unstarted"]);
const SHA_RE = /^[0-9a-f]{40}$/;

function refuse(code, detail) {
  throw Object.assign(new Error(`${code}: ${detail}`), { code });
}

// The coordinator's GitHub and Linear tokens, from its own environment file.
// The file must be a regular file owned by the coordinator user with no group
// or other access. A refusal names keys and conditions only, never a value.
export function readCoordinatorCredentials(io, file = COORDINATOR_ENV) {
  const result = io.exec("id", ["-u", "shu-coordinator"]);
  const uid = Number(String(result.stdout ?? "").trim());
  if (result.status !== 0 || !Number.isInteger(uid) || uid <= 0) refuse("CARD_RUN_CREDENTIALS", "the shu-coordinator user cannot be resolved");
  let stat;
  try { stat = io.fs.lstatSync(file); } catch { refuse("CARD_RUN_CREDENTIALS", `${file} cannot be read`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    refuse("CARD_RUN_CREDENTIALS", `${file} must be a regular file owned by shu-coordinator with no group or other access`);
  }
  const raw = io.fs.readFileSync(file, "utf8");
  const credentials = {};
  for (const key of ["GITHUB_TOKEN", "LINEAR_API_TOKEN"]) {
    const matches = raw.split("\n").filter((line) => line.startsWith(`${key}=`));
    const value = matches.length === 1 ? matches[0].slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2") : "";
    if (!value || /[\s\\$\x00-\x1f]/.test(value)) refuse("CARD_RUN_CREDENTIALS", `${file} must hold exactly one usable ${key}`);
    credentials[key] = value;
  }
  return credentials;
}

export const CARD_QUERY = `
  query CardRunIssue($id: String!) {
    issue(id: $id) {
      id
      identifier
      updatedAt
      state { id name type }
      assignee { id }
      delegate { id }
      team { id states(filter: { name: { eq: "${TODO_STATE}" } }, first: 2) { nodes { id name type } } }
    }
  }`;

export const CARD_TODO_MUTATION = `
  mutation CardRunTodo($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success }
  }`;

async function readCard(io, credentials, id) {
  const data = await sendLinear(CARD_QUERY, { id }, credentials.LINEAR_API_TOKEN, io.fetch);
  const issue = data?.issue ?? data?.data?.issue ?? null;
  if (!issue || issue.identifier !== id) refuse("CARD_RUN_CARD_UNREADABLE", `${id} cannot be read from Linear`);
  return issue;
}

// What the card needs before the run, decided from its live state.
export function cardAction(issue) {
  if (issue.assignee || issue.delegate) return { action: "refuse", code: "CARD_RUN_CARD_OWNED", detail: `${issue.identifier} has an assignee or a delegate; a person or agent owns it` };
  if (issue.state?.name === TODO_STATE && issue.state?.type === "unstarted") return { action: "none" };
  if (!MOVABLE_STATE_TYPES.includes(issue.state?.type)) {
    return { action: "refuse", code: "CARD_RUN_CARD_STATE", detail: `${issue.identifier} is ${issue.state?.name ?? "in an unknown state"}; only a card that has not started moves to ${TODO_STATE}` };
  }
  const todo = (issue.team?.states?.nodes ?? []).filter((state) => state?.name === TODO_STATE && state?.type === "unstarted");
  if (todo.length !== 1) return { action: "refuse", code: "CARD_RUN_CARD_STATE", detail: `the team has no single unstarted ${TODO_STATE} state` };
  return { action: "move-to-todo", from: issue.state.name, stateId: todo[0].id };
}

async function checkCard(io, credentials, id) {
  const issue = await readCard(io, credentials, id);
  const decision = cardAction(issue);
  if (decision.action === "refuse") refuse(decision.code, decision.detail);
  return { issue, decision };
}

// Every state change made on the card after the given moment, oldest first.
// The whole history is read, so the answer does not depend on Linear's order.
export const CARD_HISTORY_QUERY = `
  query CardRunHistory($id: String!, $after: String) {
    issue(id: $id) {
      history(first: 50, after: $after) {
        nodes { createdAt fromState { id } toState { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
const HISTORY_MAX_PAGES = 20;

async function stateChangesSince(io, credentials, id, since) {
  const changes = [];
  let after = null;
  for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
    const data = await sendLinear(CARD_HISTORY_QUERY, { id, after }, credentials.LINEAR_API_TOKEN, io.fetch);
    const history = data?.issue?.history;
    if (!Array.isArray(history?.nodes)) refuse("CARD_RUN_CARD_READBACK", `${id}'s history cannot be read`);
    for (const entry of history.nodes) {
      if ((entry?.fromState || entry?.toState) && Date.parse(entry.createdAt) > since) changes.push(entry);
    }
    if (!history.pageInfo?.hasNextPage) return changes.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    after = history.pageInfo.endCursor;
  }
  refuse("CARD_RUN_CARD_READBACK", `${id}'s history is longer than this run reads`);
}

// The card is read again here, after the branch step, so the decision is made
// on its state just before the write, never on the first snapshot. Linear has
// no conditional update, so the move is checked afterwards against the card's
// history: the only state change since that read must be this run's own, from
// the state it read to Todo. If anyone else moved the card in between, the
// card goes back to the state they set and the run is refused.
async function prepareCardState(io, credentials, id, apply) {
  const { issue, decision } = await checkCard(io, credentials, id);
  if (decision.action === "none" || !apply) return { card: id, state: issue.state.name, action: decision.action };
  const since = Date.parse(issue.updatedAt);
  if (!Number.isFinite(since)) refuse("CARD_RUN_CARD_UNREADABLE", `${id} has no readable updatedAt`);
  await sendLinear(CARD_TODO_MUTATION, { id: issue.id, stateId: decision.stateId }, credentials.LINEAR_API_TOKEN, io.fetch);
  const changes = await stateChangesSince(io, credentials, issue.id, since);
  if (changes.length === 0) refuse("CARD_RUN_CARD_READBACK", `${id} did not move to ${TODO_STATE}`);
  const mine = changes.filter((entry) => entry.toState?.id === decision.stateId).at(-1);
  // Linear cannot make a put-back conditional either. It is sent only while
  // the card still sits in this run's Todo with no state change after the
  // run's own move, which leaves the shortest window this API allows; any
  // later change wins and the card is left as it is.
  const putBack = async (stateId) => {
    if (!mine || !stateId || stateId === decision.stateId) return false;
    const current = await readCard(io, credentials, id);
    const later = await stateChangesSince(io, credentials, issue.id, Date.parse(mine.createdAt));
    if (current.state?.id !== decision.stateId || later.length !== 0) return false;
    await sendLinear(CARD_TODO_MUTATION, { id: issue.id, stateId }, credentials.LINEAR_API_TOKEN, io.fetch);
    return true;
  };
  const left = (restored, what) => restored
    ? `it was put back to ${what} and the run stops`
    : "it was not put back, because it changed again or the change cannot be told apart; check the card by hand";
  const own = changes.length === 1 && mine === changes[0] && mine.fromState?.id === issue.state.id;
  if (!own) {
    // Someone moved the card between the read and the move: theirs is the
    // state the run's move overwrote.
    const theirs = mine?.fromState?.id;
    const restored = theirs !== issue.state.id && await putBack(theirs);
    refuse("CARD_RUN_CARD_RACE", `${id} changed state while this run moved it to ${TODO_STATE}; ${left(restored, "the state set meanwhile")}`);
  }
  const after = await readCard(io, credentials, id);
  if (cardAction(after).action !== "none") {
    // Claimed between the read and the move: the run's move is undone, so
    // the owner finds the card where it was.
    const restored = await putBack(issue.state.id);
    refuse("CARD_RUN_CARD_READBACK", `${id} did not read back as an unowned ${TODO_STATE} card; ${left(restored, issue.state.name)}`);
  }
  return { card: id, state: after.state.name, action: decision.action, from: decision.from };
}

async function github(io, credentials, method, url, body) {
  const response = await io.fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${credentials.GITHUB_TOKEN}`,
      "User-Agent": "shu-card-run",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function branchHead(io, credentials, repo, branch) {
  const { status, json } = await github(io, credentials, "GET", `https://api.github.com/repos/${repo}/git/ref/heads/${branch}`);
  if (status === 404) return null;
  const sha = json?.object?.sha;
  if (status !== 200 || json?.ref !== `refs/heads/${branch}` || !SHA_RE.test(sha ?? "")) refuse("CARD_RUN_BRANCH_UNREADABLE", `${branch} cannot be read (HTTP ${status})`);
  return sha;
}

async function prepareBranch(io, credentials, repo, branch, revision, apply) {
  const head = await branchHead(io, credentials, repo, branch);
  if (head === revision) return { branch, head, action: "none" };
  if (head !== null) refuse("CARD_RUN_BRANCH_NOT_AT_TARGET", `${branch} is at ${head}, not ${revision}; an existing branch is never moved`);
  if (!apply) return { branch, head: null, action: "create" };
  const { status } = await github(io, credentials, "POST", `https://api.github.com/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: revision });
  if (status !== 201) refuse("CARD_RUN_BRANCH_CREATE", `${branch} could not be created (HTTP ${status})`);
  const after = await branchHead(io, credentials, repo, branch);
  if (after !== revision) refuse("CARD_RUN_BRANCH_READBACK", `${branch} reads back at ${after}, not ${revision}`);
  return { branch, head: after, action: "create" };
}

// Makes the planned card ready to run, or with apply false says what it would
// do. Nothing is written until the card is known to be movable; then the
// branch comes first, so a card is moved only once its branch is right, and
// the card is read again just before it is moved.
export async function prepareRun({ io, plan, revision, repo, credentials, apply = true }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) refuse("CARD_RUN_CONFIG", "pilot_repo must name one GitHub repository");
  await checkCard(io, credentials, plan.id);
  const branch = plan.branch ? await prepareBranch(io, credentials, repo, plan.branch, revision, apply) : null;
  const card = await prepareCardState(io, credentials, plan.id, apply);
  return { branch, card };
}

// SHU-86, third slice: the run reports itself. After the revert, one comment
// goes on the SHU-71 tracking card, the card coordinator stop lines already
// go to, never on the run's own card, whose comments the coordinator reads.
// The report is plain words from closed vocabularies plus the coordinator's
// own reason, flattened and cut short. Posting it never changes the run's
// result: a report that cannot be posted is recorded in the output instead.
export const REPORT_ISSUE = "SHU-71";
const REPORT_REASON_MAX = 300;
export const REPORT_TIMEOUT_MS = 30 * 1000;

export const REPORT_ISSUE_QUERY = `
  query CardRunReportIssue($id: String!) {
    issue(id: $id) { id identifier }
  }`;

export const REPORT_COMMENT_MUTATION = `
  mutation CardRunReportComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success }
  }`;

export const RUN_OUTCOME_TEXT = Object.freeze({
  PASS: "the review passed at the exact head; the pull request waits to be merged",
  REVIEW_PASS: "the review-only run passed the pull request",
  REVIEW_BLOCKED: "the review-only run blocked the pull request",
  STOPPED: "the coordinator stopped the episode",
  REFUSED: "the coordinator refused the run",
  EXPIRED: "the run window closed before the episode ended",
  NOT_ELIGIBLE: "the card was not eligible on the first tick",
  ERROR: "the run failed",
});

export function reportMarker(activationId) {
  return `<!-- card-run-report ${activationId} -->`;
}

// One line, no markup that could open or close a comment, and short.
export function plainReason(text) {
  const flat = String(text ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/<!--|-->/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > REPORT_REASON_MAX ? `${flat.slice(0, REPORT_REASON_MAX - 1)}…` : flat;
}

export function renderRunReport(result) {
  const lines = [
    reportMarker(result.activation_id),
    `Card run on ${result.card} (${result.kind}): ${result.outcome}, ${RUN_OUTCOME_TEXT[result.outcome] ?? "an outcome this runner does not know"}.`,
  ];
  if (result.reason) lines.push(`Reason: ${plainReason(result.reason)}`);
  const card = result.prepared?.card;
  const branch = result.prepared?.branch;
  const before = [
    card ? (card.action === "move-to-todo" ? `moved ${card.card} from ${plainReason(card.from)} to Todo` : `${card.card} was already in Todo`) : null,
    branch ? (branch.action === "create" ? `created ${branch.branch}` : `${branch.branch} was already at the revision`) : null,
  ].filter(Boolean);
  if (before.length) lines.push(`Before arming: ${before.join("; ")}.`);
  lines.push(`Ticks: ${result.ticks?.length ?? 0}.`);
  lines.push(result.revert?.reverted
    ? "The host is reverted and idle."
    : `The revert did not finish (${result.revert?.code ?? "unknown"}); check the host before the next run.`);
  return lines.join("\n");
}

// Each Linear call of the report gets its own deadline, so a stalled request
// cannot keep the run from returning.
function bounded(promise, timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Linear did not answer within ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export async function postRunReport({ io, credentials, result, timeoutMs = REPORT_TIMEOUT_MS }) {
  try {
    if (!credentials?.LINEAR_API_TOKEN) return { posted: false, issue: REPORT_ISSUE, code: "CARD_RUN_REPORT", reason: "no coordinator credentials" };
    const send = (query, variables) => bounded(sendLinear(query, variables, credentials.LINEAR_API_TOKEN, io.fetch), timeoutMs);
    const data = await send(REPORT_ISSUE_QUERY, { id: REPORT_ISSUE });
    const issue = data?.issue ?? null;
    if (!issue?.id || issue.identifier !== REPORT_ISSUE) return { posted: false, issue: REPORT_ISSUE, code: "CARD_RUN_REPORT", reason: `${REPORT_ISSUE} cannot be read from Linear` };
    const posted = await send(REPORT_COMMENT_MUTATION, { issueId: issue.id, body: renderRunReport(result) });
    if (posted?.commentCreate?.success !== true) return { posted: false, issue: REPORT_ISSUE, code: "CARD_RUN_REPORT", reason: "Linear did not accept the comment" };
    return { posted: true, issue: REPORT_ISSUE };
  } catch (error) {
    return { posted: false, issue: REPORT_ISSUE, code: "CARD_RUN_REPORT", reason: plainReason(error.message) };
  }
}
