// SHU-86, second slice: the two steps an operator still did by hand before a
// card run. The committed dispatch_scope already names the card, so the run
// itself now makes the card pickable and gives it its starting branch:
//
//   * the card moves to Todo, only from a not-yet-started state (backlog or
//     unstarted) and only while no person or agent owns it. A card in triage,
//     in progress, in review, done or canceled is refused, never reopened.
//   * a card run's coordinator/<card> branch is created at main's current
//     tip (SHU-312), which must descend from the installed revision, when it
//     does not exist. A branch that exists elsewhere is refused, never moved:
//     it may hold an earlier run's work.
//
// Credentials are the coordinator's own (/srv/shu/coordinator.env), read once
// by root, kept in memory and never printed. Every write is read back.
//
// The coordinator's GitHub token is read-only by design, so the branch is not
// created through the API: it is pushed the way the push broker publishes a
// build, as the coordinator user over its deploy-key remote
// (SHU_PUSH_REMOTE_URL), with the broker's hardened git configuration. The
// token only reads the branch back.
import { sendLinear, resolveRepositoryOwnership, pullRequestClaimsIssue } from "../reconcile.mjs";
import { repairEligible, readOpenPulls } from "../repair-eligibility.mjs";
import { BROKER_GIT_CONFIG_ARGS, validateRepoUrl } from "../push-broker.mjs";
import { watchLine } from "./card-watch.mjs";
import { alertLine } from "./card-status.mjs";

export const COORDINATOR_ENV = "/srv/shu/coordinator.env";
export const COORDINATOR_USER = "shu-coordinator";
const GIT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const TODO_STATE = "Todo";
export const MOVABLE_STATE_TYPES = Object.freeze(["backlog", "unstarted"]);
const SHA_RE = /^[0-9a-f]{40}$/;

function refuse(code, detail) {
  throw Object.assign(new Error(`${code}: ${detail}`), { code });
}

// Self-heal: a refusal that names a read which may answer a moment later (a
// network failure, a 5xx or a 429 that outlasted its retries). The card-run
// timer gives such a start's run back, a bounded number of times.
function refuseTransient(code, detail) {
  throw Object.assign(new Error(`${code}: ${detail}`), { code, transient: true });
}

// Self-heal: every read card-prepare makes before arming (GitHub's branch and
// pull request reads, Linear's card and history reads) is tried again when it
// never reached its server (fetch's own TypeError) or was answered with a 5xx
// or a 429, a bounded number of times with a short wait. Only reads: a GitHub
// GET, or a Linear GraphQL query. A write (the Todo move, any mutation) goes
// through exactly once, because one whose answer was lost may have committed.
export const READ_ATTEMPTS = 3;
export const READ_RETRY_WAIT_MS = 5 * 1000;
const transientStatus = (status) => status === 429 || (Number.isInteger(status) && status >= 500);

export function retryableRead(url, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  if (method === "GET") return true;
  if (method !== "POST" || url !== "https://api.linear.app/graphql") return false;
  let query;
  try { query = JSON.parse(options.body).query; } catch { return false; }
  return typeof query === "string" && /^\s*query\b/.test(query);
}

export function readRetrying(io) {
  const fetchOnce = io.fetch;
  return { ...io, fetch: async (url, options = {}) => {
    if (!retryableRead(url, options)) return fetchOnce(url, options);
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await fetchOnce(url, options);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        if (attempt >= READ_ATTEMPTS) throw Object.assign(error, { transient: true });
        io.sleep(READ_RETRY_WAIT_MS);
        continue;
      }
      if (transientStatus(response?.status) && attempt < READ_ATTEMPTS) {
        io.sleep(READ_RETRY_WAIT_MS);
        continue;
      }
      if (typeof response?.json !== "function") return response;
      // The body is part of the read: an answer cut off mid-body is the same
      // blip, so it is read here and tried again too. Anything else the body
      // throws (not JSON) is handed to the caller as before.
      let body;
      let failure = null;
      try {
        body = await response.json();
      } catch (error) {
        if (error instanceof TypeError) {
          if (attempt >= READ_ATTEMPTS) throw Object.assign(error, { transient: true });
          io.sleep(READ_RETRY_WAIT_MS);
          continue;
        }
        failure = error;
      }
      return { ok: response.ok, status: response.status, headers: response.headers, json: async () => {
        if (failure) throw failure;
        return body;
      } };
    }
  } };
}

// Self-heal: whether a refusal before arming may pass on a later start. Only
// a read that failed transiently, or the branch read-back GitHub may still
// lag on, and only while the card itself was not yet written: a definitive
// answer (the card's labels, owner or state, a contract, a dirty checkout, a
// branch with its own commit) never is.
export function retryableRefusal(error) {
  if (!error || error.afterCardWrite === true) return false;
  if (error.transient === true) return true;
  const code = String(error.code ?? "");
  return code === "CARD_RUN_BRANCH_READBACK" || code === "LINEAR_RATE_LIMITED" || /^LINEAR_HTTP_(429|5\d\d)$/.test(code);
}

// The coordinator's GitHub and Linear tokens and its push remote, from its
// own environment file.
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
  // The push remote is only needed to create a branch, so a run report can
  // still be posted without it; the push itself refuses when it is missing.
  for (const key of ["GITHUB_TOKEN", "LINEAR_API_TOKEN", "SHU_PUSH_REMOTE_URL"]) {
    const matches = raw.split("\n").filter((line) => line.startsWith(`${key}=`));
    if (key === "SHU_PUSH_REMOTE_URL" && matches.length === 0) continue;
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
      labels { nodes { name } }
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
//
// Self-repair B1: `repair` ({ repair, owners, pulls, repo }) is given only for
// a landing-repair plan (B2 wires it). Such a card was moved and assigned by
// Linear's GitHub integration when its pull request opened, so the owned and
// not-started rules are replaced by the coordinator's own repair predicate
// (repair-eligibility.mjs), and the answer is never a move: a repair leaves
// the card where it is. Without `repair` nothing below changes.
export function cardAction(issue, repair = null) {
  if (repair) {
    const eligible = repairEligible({
      issue: { id: issue.identifier, state: issue.state?.name ?? null, assignee: issue.assignee ?? null, delegate: issue.delegate ?? null },
      repair: repair.repair, owners: repair.owners, pulls: repair.pulls, repo: repair.repo,
    });
    if (!eligible.ok) return { action: "refuse", code: "CARD_RUN_REPAIR_INELIGIBLE", detail: `${issue.identifier}: ${eligible.reason}` };
    const owned = resolveRepositoryOwnership((issue.labels?.nodes ?? []).map((label) => label?.name));
    if (owned.error) return { action: "refuse", code: "CARD_RUN_CARD_LABELS", detail: `${issue.identifier}: ${owned.error}` };
    return { action: "none" };
  }
  if (issue.assignee || issue.delegate) return { action: "refuse", code: "CARD_RUN_CARD_OWNED", detail: `${issue.identifier} has an assignee or a delegate; a person or agent owns it` };
  // The coordinator never dispatches a card without exactly one known
  // repo:<name> label (reconcile Rule 10). Refuse it here, before arming, so
  // a run never sits armed on a card that can't be dispatched.
  const ownership = resolveRepositoryOwnership((issue.labels?.nodes ?? []).map((label) => label?.name));
  if (ownership.error) return { action: "refuse", code: "CARD_RUN_CARD_LABELS", detail: `${issue.identifier}: ${ownership.error}` };
  if (issue.state?.name === TODO_STATE && issue.state?.type === "unstarted") return { action: "none" };
  if (!MOVABLE_STATE_TYPES.includes(issue.state?.type)) {
    return { action: "refuse", code: "CARD_RUN_CARD_STATE", detail: `${issue.identifier} is ${issue.state?.name ?? "in an unknown state"}; only a card that has not started moves to ${TODO_STATE}` };
  }
  const todo = (issue.team?.states?.nodes ?? []).filter((state) => state?.name === TODO_STATE && state?.type === "unstarted");
  if (todo.length !== 1) return { action: "refuse", code: "CARD_RUN_CARD_STATE", detail: `the team has no single unstarted ${TODO_STATE} state` };
  return { action: "move-to-todo", from: issue.state.name, stateId: todo[0].id };
}

async function checkCard(io, credentials, id, repair = null) {
  const issue = await readCard(io, credentials, id);
  const decision = cardAction(issue, repair);
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
  // Self-heal: from the move on the card may have changed, so no refusal
  // after it gives the run back.
  try {
    return await moveCardToTodo(io, credentials, id, issue, decision, since);
  } catch (error) {
    throw Object.assign(error, { afterCardWrite: true });
  }
}

async function moveCardToTodo(io, credentials, id, issue, decision, since) {
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
  if (transientStatus(status)) refuseTransient("CARD_RUN_BRANCH_UNREADABLE", `${branch} cannot be read (HTTP ${status})`);
  const sha = json?.object?.sha;
  if (status !== 200 || json?.ref !== `refs/heads/${branch}` || !SHA_RE.test(sha ?? "")) refuse("CARD_RUN_BRANCH_UNREADABLE", `${branch} cannot be read (HTTP ${status})`);
  return sha;
}

// The card's branch, made as the coordinator user against the coordinator's own
// push remote: never forced, hooks and credential helpers off, explicit refs.
// With dryRun, the remote still authenticates the push, so a key that cannot
// write is found before a run.
//
// Like the push broker, git runs in an empty bare repository the coordinator
// user just made, never in the installed checkout: the checkout's own config
// could rewrite the destination (url.*.insteadOf or pushInsteadOf), and a fresh
// repository has none. The checkout's objects are reached as an alternate, a
// plain path read. SSH never prompts and every remote step is bounded in time,
// so a stalled remote cannot hold the run's lock.
// The SSH program is the broker's own route on the host: plain ssh as the
// coordinator user, whose ~/.ssh holds the deploy key. SHU_PUSH_SSH_COMMAND
// never reaches the broker there (it is not an adapter key), and C39 pins that.
//
// SHU-312: the branch starts from main as the remote has it now, not from the
// installed revision, so the second card of a queue starts after the first
// card's merge and its pull request is not behind main. The trust is not
// quite the same: the card may build on commits merged after the install.
// Those commits are already on protected main, so the card does not bring
// them in, and main must descend from the installed revision, so history the
// install was made from is never rewritten under a card. The coordinator's
// own code and contracts still come from the installed revision only, and the
// exact-head review and merge check bind the head the card produced.
export const PUSH_TIMEOUT_SECONDS = 300;
export const PUSH_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4";
export const CARD_BASE_REF = "refs/heads/card-base";

// A command run as the coordinator user, in an empty environment but for its
// home, a fixed PATH, no global or system git config, no prompts and the
// broker's SSH route. SHU-322 runs its checkout merge through the same door.
export function coordinatorRunner(io) {
  const account = io.exec("getent", ["passwd", COORDINATOR_USER]);
  const home = String(account.stdout ?? "").trim().split(":")[5] ?? "";
  if (account.status !== 0 || !home.startsWith("/")) refuse("CARD_RUN_BRANCH_CREATE", `the ${COORDINATOR_USER} home directory cannot be resolved`);
  const env = [`HOME=${home}`, `PATH=${GIT_PATH}`, "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
    "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", `GIT_SSH_COMMAND=${PUSH_SSH_COMMAND}`];
  const asCoordinator = (args) => io.exec("runuser", ["-u", COORDINATOR_USER, "--", "env", "-i", ...env, ...args]);
  return asCoordinator;
}

export function inPushRepository(io, credentials, repo, checkout, work) {
  if (!validateRepoUrl(credentials.SHU_PUSH_REMOTE_URL, { allowedRepo: repo }).ok) {
    refuse("CARD_RUN_BRANCH_CREATE", `SHU_PUSH_REMOTE_URL is not the ${repo} remote`);
  }
  const asCoordinator = coordinatorRunner(io);
  const made = asCoordinator(["mktemp", "-d", "/tmp/shu-card-push-XXXXXXXX"]);
  const dir = String(made.stdout ?? "").trim();
  if (made.status !== 0 || !/^\/tmp\/shu-card-push-[A-Za-z0-9]{8}$/.test(dir)) refuse("CARD_RUN_BRANCH_CREATE", `a push repository could not be made as ${COORDINATOR_USER}`);
  try {
    const init = asCoordinator(["git", ...BROKER_GIT_CONFIG_ARGS, "init", "--bare", "-q", dir]);
    if (init.status !== 0) refuse("CARD_RUN_BRANCH_CREATE", `a push repository could not be made as ${COORDINATOR_USER} (git exit ${init.status})`);
    // git's own output can name the remote; callers report only exit statuses.
    const git = (args) => asCoordinator([`GIT_ALTERNATE_OBJECT_DIRECTORIES=${checkout}/.git/objects`,
      "timeout", "--kill-after=10", String(PUSH_TIMEOUT_SECONDS),
      "git", ...BROKER_GIT_CONFIG_ARGS, `--git-dir=${dir}`, ...args]);
    return work(git);
  } finally {
    asCoordinator(["rm", "-rf", "--", dir]);
  }
}

const exitText = (status) => (status === 124 ? `timed out after ${PUSH_TIMEOUT_SECONDS}s` : `git exit ${status}`);

// Main as the remote has it now, refused unless it descends from the revision.
// SHU-322: a main that does not descend is a definite answer, not a failed
// read, so that refusal carries the tip and says so.
// Self-heal: with `sleep`, a fetch that failed but did not time out is tried
// again (a read: it moves only this run's own scratch ref), and a fetch that
// never succeeded is a transient refusal.
export function mainTip(git, credentials, revision, sleep = null) {
  const fetchMain = () => git(["fetch", "--no-tags", "--no-recurse-submodules", credentials.SHU_PUSH_REMOTE_URL, `refs/heads/main:${CARD_BASE_REF}`]);
  let fetched = fetchMain();
  for (let attempt = 1; sleep && fetched.status !== 0 && fetched.status !== 124 && attempt < READ_ATTEMPTS; attempt += 1) {
    sleep(READ_RETRY_WAIT_MS);
    fetched = fetchMain();
  }
  if (fetched.status !== 0) refuseTransient("CARD_RUN_BASE", `main could not be fetched as ${COORDINATOR_USER} (${exitText(fetched.status)})`);
  const read = git(["rev-parse", "--verify", `${CARD_BASE_REF}^{commit}`]);
  const tip = String(read.stdout ?? "").trim();
  if (read.status !== 0 || !SHA_RE.test(tip)) refuse("CARD_RUN_BASE", "the fetched main cannot be read");
  const ancestor = git(["merge-base", "--is-ancestor", revision, tip]);
  if (ancestor.status === 1) {
    throw Object.assign(new Error(`CARD_RUN_BASE: main at ${tip} does not descend from the installed revision ${revision}`),
      { code: "CARD_RUN_BASE", notDescendant: true, tip });
  }
  if (ancestor.status !== 0) refuse("CARD_RUN_BASE", `main's ancestry cannot be checked (${exitText(ancestor.status)})`);
  return tip;
}

export const BRANCH_READBACK_ATTEMPTS = 6;
export const BRANCH_READBACK_WAIT_MS = 2 * 1000;

async function prepareBranch(io, credentials, repo, checkout, branch, revision, apply) {
  const head = await branchHead(io, credentials, repo, branch);
  const tip = inPushRepository(io, credentials, repo, checkout, (git) => {
    const base = mainTip(git, credentials, revision, (ms) => io.sleep(ms));
    if (head === base) return base;
    // SHU-327, 2026-10-20: a card that stopped without landing leaves its
    // branch at the main it started from, and the install that re-arms the
    // queue then refused it on every start. A branch main already contains
    // holds no commit main lacks, so it moves forward to main; one with a
    // commit of its own is never moved.
    if (head !== null) {
      const contained = git(["merge-base", "--is-ancestor", head, base]);
      if (contained.status !== 0) refuse("CARD_RUN_BRANCH_NOT_AT_TARGET", `${branch} is at ${head}, not main at ${base}, and main does not contain it; such a branch is never moved`);
    }
    // The lease names the head read above, or none: the remote applies the
    // push only while the branch is still there (or still absent), so a branch
    // someone creates or moves after the read is refused, never moved.
    const push = git(["push", "--no-verify", `--force-with-lease=refs/heads/${branch}:${head ?? ""}`, ...(apply ? [] : ["--dry-run"]),
      credentials.SHU_PUSH_REMOTE_URL, `${base}:refs/heads/${branch}`]);
    if (push.status !== 0) refuse("CARD_RUN_BRANCH_CREATE", `${branch} could not be ${apply ? "pushed" : "pushed in a dry run"} as ${COORDINATOR_USER} (${exitText(push.status)})`);
    return base;
  });
  if (head === tip) return { branch, head, base: tip, action: "none" };
  const action = head === null ? "create" : "advance";
  if (!apply) return { branch, head, base: tip, action, ...(head === null ? {} : { from: head }) };
  // SHU-332, 2026-10-23: GitHub's ref API can still answer with the head from
  // before an accepted push for a few seconds, and the run refused a branch it
  // had just created. Only that lag is waited out; any other head refuses now.
  let after = await branchHead(io, credentials, repo, branch);
  for (let read = 1; after === head && read < BRANCH_READBACK_ATTEMPTS; read += 1) {
    io.sleep(BRANCH_READBACK_WAIT_MS);
    after = await branchHead(io, credentials, repo, branch);
  }
  if (after !== tip) refuse("CARD_RUN_BRANCH_READBACK", `${branch} reads back at ${after}, not ${tip}`);
  return { branch, head: after, base: tip, action, ...(head === null ? {} : { from: head }) };
}

// Self-repair B1: the repair predicate's input for card-prepare. Every open
// pull request is read (all pages) as the coordinator, and only a complete
// read can admit the card; the predicate refuses anything less.
export async function repairCardInput(io, credentials, repo, id, repair) {
  const read = await readOpenPulls({ repo, token: credentials.GITHUB_TOKEN, fetchImpl: io.fetch });
  return {
    repair,
    owners: repair.owners ?? [],
    repo,
    pulls: { complete: read.complete === true, items: (read.items ?? []).filter((pr) => pullRequestClaimsIssue(pr, id)), reason: read.reason ?? null },
  };
}

// Makes the planned card ready to run, or with apply false says what it would
// do. Nothing is written until the card is known to be movable; then the
// branch comes first, so a card is moved only once its branch is right, and
// the card is read again just before it is moved.
//
// Self-repair B1: with `repair` (the record's repair_pr and initial_target_sha
// plus the configured owners), the card must pass the repair predicate on both
// reads and is never moved, and its branch is left alone: it holds the pull
// request's head, which the repair revises in place. Today's callers pass no
// repair and keep the path above unchanged.
export async function prepareRun({ io, plan, revision, repo, checkout, credentials, apply = true, repair = null }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) refuse("CARD_RUN_CONFIG", "pilot_repo must name one GitHub repository");
  if (!String(checkout ?? "").startsWith("/")) refuse("CARD_RUN_CONFIG", "the installed checkout needs an absolute path");
  io = readRetrying(io);
  if (repair) {
    await checkCard(io, credentials, plan.id, await repairCardInput(io, credentials, repo, plan.id, repair));
    // Read again just before answering, as prepareCardState does. A repair's
    // decision is never a move (cardAction returns "none" or refuses), so the
    // card is only checked here, never written.
    const { issue, decision } = await checkCard(io, credentials, plan.id, await repairCardInput(io, credentials, repo, plan.id, repair));
    return { branch: null, card: { card: plan.id, state: issue.state.name, action: decision.action } };
  }
  await checkCard(io, credentials, plan.id);
  const branch = plan.branch ? await prepareBranch(io, credentials, repo, checkout, plan.branch, revision, apply) : null;
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
  query CardRunReportIssue($id: String!, $marker: String!) {
    issue(id: $id) { id identifier comments(first: 1, filter: { body: { contains: $marker } }) { nodes { id } } }
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
  NOT_STARTED: "the run refused before arming",
  // A done queue's timer start that refused to install main (SHU-322 Card B).
  NEEDS_OWNER: "main changes more than a reviewed card queue, so a person installs it",
  // SHU-306: what landing a passed card came to.
  MERGED: "its pull request went green and the SHU-259 consumer merged it",
  PR_OPENED_CI_RED: "its pull request is open but a check is red; nothing was handed off or merged",
  CI_TIMEOUT: "its pull request did not go green within the landing bound; nothing was handed off or merged",
  MERGE_HOLD: "the SHU-259 consumer held the merge",
  LAND_PAUSED: "the pause file was present, so landing stopped",
  LAND_SKIPPED_NO_TOKEN: "no landing token is installed, so the pull request waits to be opened and merged by hand",
  LAND_HEAD_MISMATCH: "the pull request head is not the head the review passed; nothing was handed off or merged",
  LAND_ERROR: "landing failed",
  // SHU-310
  THREADS_HELD: "more review bot threads were settleable than one run may settle; nothing was handed off or merged",
  // Self-repair B2
  REPAIR_INTERRUPTED: "a landing repair round was claimed but never finished; it is never run again at this revision",
  REPAIR_TEST_WEAKENED: "the repair skipped, removed or loosened a test, or changed how tests run; nothing was handed off or merged",
});

// How a held merge recovers: the attempt's HOLD is final, so only a new
// installed revision runs the card again; a crashed run's lock is cleared by hand.
export const MERGE_HOLD_RECOVERY = "A merge-attempt HOLD is terminal for its attempt: a new installed revision re-arms the card, and a stale /run/lock/shu-card-run.lock is cleared by hand.";

function landingLines(land) {
  const code = land.outcome === "MERGE_HOLD" && land.hold_code ? `MERGE_HOLD ${plainReason(land.hold_code)}` : land.outcome;
  const lines = [`Landing: ${code}, ${RUN_OUTCOME_TEXT[land.outcome] ?? "an outcome this runner does not know"}.`];
  const where = [
    Number.isInteger(land.pr) ? `pull request #${land.pr}${land.opened ? " (opened by this run)" : ""}` : null,
    /^[0-9a-f]{40}$/.test(land.merge_commit ?? "") ? `merge commit ${land.merge_commit}` : null,
  ].filter(Boolean);
  if (where.length) lines.push(`Landed: ${where.join("; ")}.`);
  if (land.reason) lines.push(`Landing reason: ${plainReason(land.reason)}`);
  for (const thread of land.threads?.settled ?? []) {
    lines.push(`Settled review thread: ${plainReason(`${thread.bot} ${thread.severity} ${thread.url}`)}`);
  }
  for (const thread of land.threads?.blocking ?? []) {
    lines.push(`Blocking review thread: ${plainReason(`${thread.url ?? "unknown"} (${thread.why})`)}`);
  }
  if (land.outcome === "MERGE_HOLD") lines.push(MERGE_HOLD_RECOVERY);
  return lines;
}

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
  // Self-watch 0e: a run that needs the owner says so first.
  const alert = alertLine(result);
  if (alert) lines.push(alert);
  if (result.trigger === "timer") lines.push(`Started by the card-run timer, once for revision ${result.revision}.`);
  // SHU-321: which pull request a review run judged, and at which head.
  if (result.kind === "review" && result.review) lines.push(`Reviewed pull request #${result.review.pr} at ${result.review.head}, from base ${result.review.base}.`);
  // Self-repair B2: which pull request a landing repair worked on, and from what.
  if (result.repair) {
    lines.push(`Landing repair of pull request #${result.repair.pr}: one revise of ${result.repair.failed_head} after episode ${plainReason(result.repair.repair_of)}, from ${result.repair.check_runs?.length ?? 0} failing check run(s).`);
  }
  if (result.reason) lines.push(`Reason: ${plainReason(result.reason)}`);
  // Self-heal: a refused start whose run was given back says so.
  if (Number.isInteger(result.retry?.attempt)) {
    lines.push(`This refusal may pass on its own, so the card's run at this revision was given back (${result.retry.attempt} of ${result.retry.of}): the next timer start tries it again.`);
  }
  const card = result.prepared?.card;
  const branch = result.prepared?.branch;
  const before = [
    card ? (card.action === "move-to-todo" ? `moved ${card.card} from ${plainReason(card.from)} to Todo` : `${card.card} was already in Todo`) : null,
    branch ? (branch.action === "create" ? `created ${branch.branch}${branch.base ? ` from main at ${branch.base}` : ""}`
      : branch.action === "advance" ? `moved ${branch.branch} forward from ${branch.from} to main at ${branch.base}`
      : `${branch.branch} was already at ${branch.base ? `main at ${branch.base}` : "the revision"}`) : null,
  ].filter(Boolean);
  if (before.length) lines.push(`Before arming: ${before.join("; ")}.`);
  if (result.outcome === "REPAIR_INTERRUPTED") {
    lines.push("Nothing was armed by this start; the interrupted repair is never run again at this revision.");
    return lines.join("\n");
  }
  lines.push(`Ticks: ${result.ticks?.length ?? 0}.`);
  if (result.watch) lines.push(watchLine(result.watch));
  if (result.land) lines.push(...landingLines(result.land));
  lines.push(result.outcome === "NOT_STARTED" ? "Nothing was armed, so there was nothing to revert."
    : result.revert?.reverted ? "The host is reverted and idle."
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

// A request that never reached Linear (fetch's own TypeError, "fetch failed")
// is tried again a bounded number of times: the first timer run lost its report
// that way. Linear's answers and the deadline are never retried. A comment whose
// send failed may still have been created, so before every try the card is read
// for this run's report marker, and a report already there is never posted again.
export const REPORT_ATTEMPTS = 3;
export const REPORT_RETRY_WAIT_MS = 15 * 1000;

// SHU-322: the self-install reports through the same path with its own
// renderer; the marker still comes from the result's activation_id.
export async function postRunReport({ io, credentials, result, timeoutMs = REPORT_TIMEOUT_MS, render = renderRunReport, marker: markerText = null }) {
  try {
    if (!credentials?.LINEAR_API_TOKEN) return { posted: false, issue: REPORT_ISSUE, code: "CARD_RUN_REPORT", reason: "no coordinator credentials" };
    const send = (query, variables) => bounded(sendLinear(query, variables, credentials.LINEAR_API_TOKEN, io.fetch), timeoutMs);
    const body = render(result);
    const marker = markerText ?? reportMarker(result.activation_id);
    for (let attempt = 1; ; attempt += 1) {
      let posted;
      try {
        const data = await send(REPORT_ISSUE_QUERY, { id: REPORT_ISSUE, marker });
        const issue = data?.issue ?? null;
        const found = issue?.comments?.nodes;
        if (!issue?.id || issue.identifier !== REPORT_ISSUE || !Array.isArray(found)) return { posted: false, issue: REPORT_ISSUE, code: "CARD_RUN_REPORT", reason: `${REPORT_ISSUE} cannot be read from Linear` };
        if (found.length) return { posted: true, issue: REPORT_ISSUE };
        posted = await send(REPORT_COMMENT_MUTATION, { issueId: issue.id, body });
      } catch (error) {
        if (!(error instanceof TypeError) || attempt >= REPORT_ATTEMPTS) throw error;
        io.sleep(REPORT_RETRY_WAIT_MS);
        continue;
      }
      if (posted?.commentCreate?.success !== true) return { posted: false, issue: REPORT_ISSUE, code: "CARD_RUN_REPORT", reason: "Linear did not accept the comment" };
      return { posted: true, issue: REPORT_ISSUE };
    }
  } catch (error) {
    return { posted: false, issue: REPORT_ISSUE, code: "CARD_RUN_REPORT", reason: plainReason(error.message) };
  }
}
