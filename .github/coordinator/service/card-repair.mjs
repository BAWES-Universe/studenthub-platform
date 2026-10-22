// Self-repair B2: the runner's half of one bounded landing repair (SHU-86).
//
// A timer run passed its independent review, opened its pull request, and then
// stopped at landing because a check went red (PR_OPENED_CI_RED). With the
// committed `landing_repair` switch on, the NEXT timer start (card-run.mjs)
// may run exactly one repair of that pull request: one revise of the passed
// head, fed the failing test output, re-reviewed by the same independent lane,
// and landed only on that new exact-head PASS. B1 (the coordinator) arms and
// routes it; this module holds what the host does around it:
//
//   * the round record `card-repair-<rev>-<id>.json`, written exclusively
//     (`wx`) once the evidence is read and the pause re-checked, before
//     anything is armed. It moves claimed -> armed -> finished. Any record
//     means no second round at that revision; a record that never reached
//     "finished" is REPAIR_INTERRUPTED, a terminal stop for the owner;
//   * the evidence: the failing check runs of the failed head, read with GET
//     only and bound by their immutable ids and their head_sha, and their job
//     logs, streamed as a rolling tail. Only lines shaped like test-failure
//     output are kept (an allow-list, never a redactor), and a kept line is
//     dropped whole if it carries anything that could be a secret;
//   * the prior-PASS provenance: the claim being repaired must name the very
//     pull request, head and episode whose trusted PASS is on the card;
//   * the weakening guard: before re-landing, the change from the failed head
//     to the repaired head may not skip, focus, delete, rename or loosen any
//     test, nor touch test scripts or test discovery. Anything it cannot read
//     whole refuses.
//
// Nothing here writes to GitHub or Linear.
import path from "node:path";
import { sendLinear, fetchIssueComments, parseReceiptsFromComments } from "../reconcile.mjs";
import { reviewVerdictProvenanceValid } from "../review-routing.mjs";
import { validReviewFindings, secretShaped } from "../review-findings.mjs";
import { repairEvidenceDigest, ACTIVATION_ID_RE } from "../single-run-activation.mjs";

export const REPAIR_TRIGGER = "PR_OPENED_CI_RED";
export const REPAIR_LIMITS = Object.freeze({
  // Each job log is read as a rolling tail of this many bytes: a log is read
  // to its end, but only its last 2 MiB of whole lines is ever held.
  logTailBytes: 2 * 1024 * 1024,
  // The evidence a revise is given, truncation marker included.
  evidenceChars: 4000,
  // At most this many failing jobs are read.
  maxRuns: 5,
  // Each JSON read, and each whole log read, has its own deadline.
  requestTimeoutMs: 30 * 1000,
  logTimeoutMs: 2 * 60 * 1000,
});
export const REPAIR_ROUND_STATES = Object.freeze(["claimed", "armed", "finished"]);
// Skips that write no record: the next timer start reads again.
export const REPAIR_SKIPS = Object.freeze(new Set(["REPAIR_NO_EVIDENCE", "REPAIR_NO_ACTIONS_READ", "REPAIR_UNREADABLE",
  "REPAIR_NOT_ELIGIBLE", "REPAIR_CLAIMED", "PAUSED"]));
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FAILING = new Set(["failure", "timed_out"]);

export const repairRecordPath = (paths, revision, id) => path.join(paths.stateDir, `card-repair-${revision}-${id}.json`);
export const repairAlertPath = (paths, revision, id) => path.join(paths.stateDir, `card-repair-${revision}-${id}.alerted.json`);
// One id per installed revision and card, so a crash can never mint a second.
export const repairActivationId = (id, revision) => `${String(id).toLowerCase()}-repair-${revision}`;

export function landingRepairOn(config) {
  return config?.landing_repair === true;
}

// A claim a repair may start from: this card's own timer run at this
// revision, which passed and stopped on red checks, with the pull request,
// the reviewed head and the episode it recorded (self-watch 0a).
export function repairCandidate(claim, { id, revision, repo }) {
  return claim?.card === id && claim.revision === revision && claim.outcome === "PASS" && claim.ok === true
    && claim.land === REPAIR_TRIGGER && REPO_RE.test(repo ?? "") && claim.repo === repo
    && Number.isSafeInteger(claim.pr) && claim.pr > 0 && SHA_RE.test(claim.reviewed_head ?? "")
    && ACTIVATION_ID_RE.test(claim.activation_id ?? "");
}

export function repairSkip(code, detail) {
  throw Object.assign(new Error(`${code}: ${detail}`), { code, repairSkip: true });
}

// ---------------------------------------------------------------------------
// The round record
// ---------------------------------------------------------------------------

export function readRound(io, file) {
  try { return JSON.parse(io.fs.readFileSync(file, "utf8")); } catch { return null; }
}

// The first write is exclusive: a record already there is another round.
export function claimRound(io, file, record) {
  try {
    io.fs.writeFileSync(file, `${JSON.stringify({ ...record, state: "claimed" })}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") repairSkip("REPAIR_CLAIMED", `a repair round is already recorded: ${file}`);
    throw error;
  }
  return { file, record: { ...record, state: "claimed" } };
}

// Later states replace the whole record by rename, so a reader never sees
// half of one. A state may only move forward.
export function advanceRound(io, round, state, fields = {}) {
  const from = REPAIR_ROUND_STATES.indexOf(round.record.state);
  const to = REPAIR_ROUND_STATES.indexOf(state);
  if (to <= from) throw Object.assign(new Error(`a repair round cannot go from ${round.record.state} to ${state}`), { code: "CARD_RUN_REPAIR_ROUND" });
  const record = { ...round.record, ...fields, state };
  const temporary = `${round.file}.tmp`;
  io.fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  io.fs.renameSync(temporary, round.file);
  round.record = record;
  return record;
}

// ---------------------------------------------------------------------------
// Evidence: an allow-list of test-failure lines
// ---------------------------------------------------------------------------

// ANSI CSI and OSC sequences and single-character escapes.
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
// GitHub prefixes every log line with its own timestamp; others appear inline.
const LEADING_STAMP_RE = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?\s?/;
const STAMP_RE = /\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?/g;
const CLOCK_RE = /^\[\d\d:\d\d:\d\d(?:\.\d+)?\]\s?/;

export function cleanLogLine(raw) {
  return String(raw ?? "").replace(ANSI_RE, "").replace(LEADING_STAMP_RE, "").replace(STAMP_RE, "").replace(CLOCK_RE, "")
    .replace(/[\x00-\x08\x0a-\x1f\x7f]/g, "").trim();
}

// A stack frame pointing into the repository: a relative path, or one under
// the Actions workspace (/home/runner/work/<repo>/<repo>/), never a
// dependency or a runtime-internal frame. The workspace prefix is cut.
const FRAME_RE = /^at\s+(?:[^()]*?\s\()?(?:file:\/\/)?([^\s()]+?):(\d+)(?::(\d+))?\)?$/;
const WORKSPACE_RE = /^\/home\/runner\/work\/[^/]+\/[^/]+\//;
export function repositoryFrame(line) {
  const match = FRAME_RE.exec(line);
  if (!match) return null;
  let file = match[1];
  const workspace = WORKSPACE_RE.exec(file);
  if (workspace) file = file.slice(workspace[0].length);
  else if (file.startsWith("/") || /^[A-Za-z]:/.test(file)) return null;
  if (!/^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/.test(file)) return null;
  if (file.startsWith("node:") || file.split("/").some((part) => part === ".." || part === "node_modules")) return null;
  return line.replace(match[1], file);
}

const FAILURE_RES = Object.freeze([
  /^(?:#\s*)?not ok\b/, // TAP failure header
  /^✖\s/, // spec reporter failure header
  /^(?:[A-Za-z_$][\w$]*\.)*(?:[A-Z][\w$]*)?(?:Error|Exception)\b(?:\s*\[[A-Z0-9_]+\])?:\s/, // AssertionError [ERR_ASSERTION]: ...
  /^error:\s/, // the error line of a TAP diagnostic block
  /^##\[error\]/, // an Actions error annotation
  /^(?:expected|actual|received)\b/i, // expected/actual lines
]);

// What could carry a secret, judged on the whole line: an assignment (also
// escaped or encoded), a secret-ish word, URL credentials, a long hex or
// base64 run, or any token shape review-findings.mjs already refuses.
const SECRET_WORD_RE = /key|token|secret|passw|pwd|bearer|authori[sz]|credential|cookie|private/i;
const ASSIGNMENT_RE = /(?<![=!<>])=(?![=>])|\\x3d|\\u003d|\\075|%3d|&#0*61;|&#x0*3d;|&equals;/i;
const URL_CREDENTIAL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#]*@|\/\/[^\s/?#:@]+:[^\s/?#@]*@/;
const HEX_RUN_RE = /[0-9A-Fa-f]{32,}/;
const BASE64_RUN_RE = /[A-Za-z0-9+/_=-]{32,}/g;
export function secretIndicator(line) {
  const text = String(line ?? "");
  if (SECRET_WORD_RE.test(text) || ASSIGNMENT_RE.test(text) || URL_CREDENTIAL_RE.test(text) || HEX_RUN_RE.test(text)) return true;
  for (const run of text.match(BASE64_RUN_RE) ?? []) {
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)) return true;
  }
  return secretShaped(text);
}

// One line of a log as evidence, or null: cleaned, kept only when it is shaped
// like test-failure output, dropped whole when it could carry a secret.
export function evidenceLine(raw) {
  const line = cleanLogLine(raw);
  if (!line) return null;
  const kept = FAILURE_RES.some((re) => re.test(line)) ? line : repositoryFrame(line);
  if (kept === null || secretIndicator(kept)) return null;
  return kept;
}

// Lines assembled across chunks, of which only the last `maxBytes` of whole
// lines are kept. A line longer than the whole tail is never judged in part:
// it is dropped up to its end.
export function createLineTail(maxBytes = REPAIR_LIMITS.logTailBytes) {
  const lines = [];
  let bytes = 0;
  let carry = "";
  let overlong = false;
  const keep = (line) => {
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
    while (bytes > maxBytes && lines.length) bytes -= Buffer.byteLength(lines.shift()) + 1;
  };
  return {
    push(text) {
      const parts = `${carry}${text}`.split("\n");
      carry = parts.pop();
      for (const part of parts) {
        if (overlong) { overlong = false; continue; }
        keep(part);
      }
      if (Buffer.byteLength(carry) > maxBytes) { carry = ""; overlong = true; }
    },
    end() {
      if (carry && !overlong) keep(carry);
      carry = "";
      overlong = false;
      return lines;
    },
  };
}

async function* bodyChunks(body) {
  if (!body) return;
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }
  if (typeof body[Symbol.asyncIterator] === "function") { yield* body; return; }
  throw new Error("the log has no readable body");
}

function withDeadline(timeoutMs, what, run) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller?.abort(); reject(new Error(`${what} did not answer within ${timeoutMs} ms`)); }, timeoutMs);
  });
  return Promise.race([run(controller?.signal), deadline]).finally(() => clearTimeout(timer));
}

const headersFor = (token) => ({ Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
  "User-Agent": "shu-card-repair", "X-GitHub-Api-Version": "2022-11-28" });

// A GET whose JSON body arrives within the deadline. Only GET is ever sent.
export async function getJson(io, url, token, timeoutMs = REPAIR_LIMITS.requestTimeoutMs) {
  return withDeadline(timeoutMs, url.replace("https://api.github.com", ""), async (signal) => {
    const response = await io.fetch(url, { method: "GET", headers: headersFor(token), ...(signal ? { signal } : {}) });
    const body = await response.json().catch(() => null);
    return { status: response.status, ok: response.status === 200, body };
  });
}

// A job's log, streamed: GitHub answers with a redirect to the log file,
// which fetch follows (dropping the Authorization header on the way).
export async function readLogTail(io, url, token, { maxBytes = REPAIR_LIMITS.logTailBytes, timeoutMs = REPAIR_LIMITS.logTimeoutMs } = {}) {
  return withDeadline(timeoutMs, "the job log", async (signal) => {
    const response = await io.fetch(url, { method: "GET", redirect: "follow", headers: headersFor(token), ...(signal ? { signal } : {}) });
    if (response.status !== 200) {
      try { await response.body?.cancel?.(); } catch { /* nothing to release */ }
      return { status: response.status, lines: null };
    }
    const tail = createLineTail(maxBytes);
    const decoder = new TextDecoder("utf-8");
    for await (const chunk of bodyChunks(response.body)) tail.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    tail.push(decoder.decode());
    return { status: 200, lines: tail.end() };
  });
}

// The evidence text, capped with the truncation marked. Whole lines only.
export function evidenceText(sections, max = REPAIR_LIMITS.evidenceChars) {
  const lines = [];
  for (const { id, lines: kept } of sections) {
    if (!kept.length) continue;
    lines.push(`check run ${id}:`, ...kept);
  }
  const full = lines.join("\n");
  if (full.length <= max) return { text: full, truncated: false };
  const marker = `\n[evidence truncated: ${full.length} characters cut to ${max}]`;
  let text = "";
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length + marker.length > max) break;
    text = next;
  }
  return { text: `${text}${marker}`, truncated: true };
}

const permissionStatus = (status) => status === 401 || status === 403 || status === 404;

// The failing output of the failed head: its failing Actions check runs, each
// bound by id and head_sha (a run of any other head is stale and never
// counts), each job read back to confirm both, and each log filtered. Every
// failure to read is a named skip; nothing is written.
export async function readRepairEvidence({ io, token, repo, head, limits = REPAIR_LIMITS }) {
  if (!token) repairSkip("REPAIR_UNREADABLE", "the coordinator's GitHub token is unavailable");
  const api = `https://api.github.com/repos/${repo}`;
  let runs;
  try { runs = await getJson(io, `${api}/commits/${head}/check-runs?filter=latest&per_page=100`, token, limits.requestTimeoutMs); } catch (error) {
    repairSkip("REPAIR_UNREADABLE", `the check runs of ${head} cannot be read (${error.message})`);
  }
  if (!runs.ok || !Array.isArray(runs.body?.check_runs) || (runs.body.total_count ?? 0) > 100) {
    repairSkip("REPAIR_UNREADABLE", `the check runs of ${head} cannot be read in full (HTTP ${runs.status})`);
  }
  const failing = runs.body.check_runs.filter((run) => run?.status === "completed" && FAILING.has(run?.conclusion)
    && run?.app?.slug === "github-actions" && Number.isSafeInteger(run?.id) && run.id > 0 && run.head_sha === head)
    .sort((a, b) => a.id - b.id).slice(0, limits.maxRuns);
  if (!failing.length) repairSkip("REPAIR_NO_EVIDENCE", `no failing Actions check run is bound to ${head}`);
  const sections = [];
  const bound = [];
  for (const run of failing) {
    let job;
    try { job = await getJson(io, `${api}/actions/jobs/${run.id}`, token, limits.requestTimeoutMs); } catch (error) {
      repairSkip("REPAIR_UNREADABLE", `job ${run.id} cannot be read (${error.message})`);
    }
    if (permissionStatus(job.status)) repairSkip("REPAIR_NO_ACTIONS_READ", `the coordinator token cannot read Actions job ${run.id} (HTTP ${job.status}); it needs Actions: read`);
    if (!job.ok) repairSkip("REPAIR_UNREADABLE", `job ${run.id} cannot be read (HTTP ${job.status})`);
    // The job must be the run it was listed as, at the failed head.
    if (job.body?.id !== run.id || job.body?.head_sha !== head) continue;
    let log;
    try { log = await readLogTail(io, `${api}/actions/jobs/${run.id}/logs`, token, { maxBytes: limits.logTailBytes, timeoutMs: limits.logTimeoutMs }); } catch (error) {
      repairSkip("REPAIR_UNREADABLE", `the log of job ${run.id} cannot be read (${error.message})`);
    }
    if (permissionStatus(log.status)) repairSkip("REPAIR_NO_ACTIONS_READ", `the coordinator token cannot read the log of job ${run.id} (HTTP ${log.status}); it needs Actions: read`);
    if (log.status !== 200) repairSkip("REPAIR_UNREADABLE", `the log of job ${run.id} cannot be read (HTTP ${log.status})`);
    bound.push({ id: run.id, head_sha: head });
    sections.push({ id: run.id, lines: log.lines.map(evidenceLine).filter((line) => line !== null) });
  }
  if (!sections.some((section) => section.lines.length)) repairSkip("REPAIR_NO_EVIDENCE", `no test-failure line survived the filter for ${head}`);
  // Escaping can grow the text past what a work order carries, so the cap
  // shrinks until the findings are valid; findings that never are refuse.
  for (let max = limits.evidenceChars; max >= 200; max = Math.floor(max * 0.8)) {
    const { text, truncated } = evidenceText(sections, max);
    const findings = { verdict_stage: "BLOCKED", source: "ci", target_sha: head, summary: text,
      links: bound.map(({ id }) => `check-run/${id}@${head}`) };
    if (validReviewFindings(findings)) return { findings, digest: repairEvidenceDigest(findings), check_runs: bound, truncated };
  }
  repairSkip("REPAIR_NO_EVIDENCE", "the evidence cannot be carried as valid findings");
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

// The pull request being repaired, read now: the claim's number, in the pilot
// repository, from coordinator/<card> into main, open, still at the head the
// review passed. Anything else is not this repair's pull request.
export function repairPullIdentity(pull, { repo, number, branch }) {
  if (pull?.number !== number) return `pull request #${pull?.number ?? "?"} is not #${number}`;
  if (pull.base?.repo?.full_name !== repo || pull.head?.repo?.full_name !== repo) return `#${number} is not a ${repo} pull request from that repository`;
  if (pull.base?.ref !== "main") return `#${number} is based on ${pull.base?.ref ?? "an unknown branch"}, not main`;
  if (pull.head?.ref !== branch) return `#${number} is from ${pull.head?.ref ?? "an unknown branch"}, not ${branch}`;
  if (pull.state !== "open" || pull.merged === true) return `#${number} is ${pull.merged === true ? "merged" : pull.state ?? "in an unknown state"}, not open`;
  return null;
}

export async function readRepairPull({ io, token, repo, number, branch, head, timeoutMs = REPAIR_LIMITS.requestTimeoutMs }) {
  let read;
  try { read = await getJson(io, `https://api.github.com/repos/${repo}/pulls/${number}`, token, timeoutMs); } catch (error) {
    repairSkip("REPAIR_UNREADABLE", `pull request #${number} cannot be read (${error.message})`);
  }
  if (!read.ok || !read.body) repairSkip("REPAIR_UNREADABLE", `pull request #${number} cannot be read (HTTP ${read.status})`);
  const wrong = repairPullIdentity(read.body, { repo, number, branch });
  if (wrong) repairSkip("REPAIR_NOT_ELIGIBLE", wrong);
  if (read.body.head?.sha !== head) repairSkip("REPAIR_NOT_ELIGIBLE", `#${number} is at ${read.body.head?.sha ?? "an unknown head"}, not the failed head ${head}`);
  return read.body;
}

const REPAIR_ISSUE_QUERY = `
  query CardRepairIssue($id: String!) {
    issue(id: $id) { id identifier }
  }`;

// The PASS being repaired: on the card, by a trusted actor, the newest
// receipt on its branch, of the claim's own episode, COMPLETED with PASS at
// the claim's reviewed head, and an independent review by its provenance.
export async function priorPass({ fetchImpl, linearToken, actorIds, card, repo, claim }) {
  if (!linearToken || !Array.isArray(actorIds) || actorIds.length === 0) repairSkip("REPAIR_UNREADABLE", "the coordinator's Linear token or trusted receipt actors are missing");
  let receipts;
  try {
    const issue = (await sendLinear(REPAIR_ISSUE_QUERY, { id: card }, linearToken, fetchImpl))?.issue;
    if (!issue?.id || issue.identifier !== card) repairSkip("REPAIR_UNREADABLE", `${card} cannot be read from Linear`);
    receipts = parseReceiptsFromComments(await fetchIssueComments({ issueId: issue.id, token: linearToken, fetchImpl }), actorIds);
  } catch (error) {
    if (error.repairSkip) throw error;
    repairSkip("REPAIR_UNREADABLE", `the receipts of ${card} cannot be read (${error.message})`);
  }
  const ids = receipts.map((r) => r.attempt_id);
  if (new Set(ids).size !== ids.length) repairSkip("REPAIR_NOT_ELIGIBLE", "the card's receipts disagree on an attempt");
  const branch = `coordinator/${card}`;
  const terminal = receipts.filter((r) => r?.issue_id === card && r.repo === repo && r.branch === branch)
    .sort((a, b) => String(a.last_activity ?? "").localeCompare(String(b.last_activity ?? ""))).at(-1);
  if (!terminal || terminal.episode_id !== claim.activation_id || terminal.stage !== "COMPLETED" || terminal.verdict_stage !== "PASS"
      || terminal.target_sha !== claim.reviewed_head) {
    repairSkip("REPAIR_NOT_ELIGIBLE", `no PASS of episode ${claim.activation_id} at ${claim.reviewed_head} is the newest receipt on ${branch}`);
  }
  const provenance = reviewVerdictProvenanceValid(terminal, receipts);
  if (!provenance.ok) repairSkip("REPAIR_NOT_ELIGIBLE", `the PASS being repaired has no trusted provenance (${provenance.reason})`);
  return terminal;
}

// ---------------------------------------------------------------------------
// The weakening guard
// ---------------------------------------------------------------------------

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);
export function isTestPath(file) {
  const parts = String(file ?? "").split("/");
  const base = parts.at(-1);
  return /\.(?:test|spec)\.[A-Za-z0-9]+$/.test(base) || /(?:^|[._-])test\.[A-Za-z0-9]+$/.test(base)
    || parts.slice(0, -1).some((part) => TEST_DIRS.has(part));
}

// Files that decide which tests run, how, or which are ignored.
const RUNNER_CONFIG_RES = Object.freeze([
  /^(?:jest|vitest|vite|playwright|mocha|ava|karma|cypress|wdio|c8|nyc|tap|uvu|node-test)\.(?:config|workspace)(?:\.[A-Za-z0-9-]+)*$/i,
  /^\.(?:mocharc|c8rc|nycrc|taprc|avarc)(?:\.[A-Za-z0-9-]+)*$/i,
  /^\.[A-Za-z0-9_-]*ignore$/,
  /^tsconfig(?:\.[A-Za-z0-9-]+)*\.json$/,
  /^turbo\.json$/,
]);
export function isTestConfigPath(file) {
  const name = String(file ?? "");
  const base = name.split("/").at(-1);
  if (name.startsWith(".github/workflows/") || name.startsWith(".github/actions/")) return true;
  return RUNNER_CONFIG_RES.some((re) => re.test(base));
}

// Whitespace-tolerant forms that skip, focus or postpone a test.
const WEAKENING_RES = Object.freeze([
  /\.\s*(?:skip|only|todo)\b/,
  /\b(?:xit|xdescribe|xtest|xcontext|xspecify)\b/,
  /\b(?:fit|fdescribe|ftest)\s*\(/,
  /\b(?:skip|todo|only)\s*:\s*(?:true|["'`])/,
  /\{\s*(?:skip|todo|only)\b/,
]);
// A line that declares a case.
const CASE_RE = /\b(?:test|it|describe|suite|context|specify)\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)*\(/;
// An assertion: a node:assert, expect, should or t.* call (tap, ava,
// node:test's t.assert), or a Chai should chain, which may end in a property
// (`x.should.be.true`) or a call (`x.should.equal(1)`, `should.exist(x)`); a
// chain counts once. A test file may change its assertions, never lose one.
const ASSERT_RE = /\b(?:assert(?:\s*\.\s*\w+)?|expect|should|t\s*\.\s*(?:assert\s*\.\s*\w+|is|not|ok|notOk|equal|same|deepEqual|strictEqual|match|throws|rejects|true|false))\s*\(|\.\s*should\b|\bshould\s*\.\s*\w+/g;
// The executable part of a line: string contents and comments assert nothing,
// so an assertion moved into `// ...` or a logged string is a dropped one.
const codeOf = (line) => {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) { quote = null; out += c; }
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") { quote = c; out += c; continue; }
    if (c === "/" && line[i + 1] === "/") break;
    if (c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
};
// A commented-out line asserts nothing.
const assertions = (lines) => lines.filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
  .reduce((count, line) => count + (codeOf(line).match(ASSERT_RE)?.length ?? 0), 0);

// A unified diff's own lines, or null when it is not one.
export function patchLines(patch) {
  if (typeof patch !== "string") return null;
  const added = [];
  const removed = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith(" ") || line === "") continue;
    else return null;
  }
  return { added, removed };
}

// package.json is judged by what it declares, not by its diff: the test*
// scripts and the runner keys must read the same at both heads.
const PACKAGE_RUNNER_KEYS = Object.freeze(["jest", "vitest", "mocha", "ava", "c8", "nyc", "tap", "workspaces"]);
export function packageTestSurface(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const scripts = parsed.scripts ?? {};
  if (typeof scripts !== "object" || Array.isArray(scripts)) return null;
  return JSON.stringify({
    scripts: Object.keys(scripts).filter((name) => /^(?:pre|post)?test/i.test(name)).sort().map((name) => [name, scripts[name]]),
    runner: PACKAGE_RUNNER_KEYS.filter((key) => Object.hasOwn(parsed, key)).map((key) => [key, parsed[key]]),
  });
}

// Judges the change base..head from GitHub's compare and, for each changed
// package.json, the file at both heads. `readFile(path, ref)` returns the text
// or null. Returns { ok } or { ok: false, reason }.
export async function testWeakening({ compare, base, head, readFile }) {
  const refuse = (reason) => ({ ok: false, reason });
  if (!compare || typeof compare !== "object") return refuse("the change cannot be read");
  if (!(compare.status === "ahead" || compare.status === "identical") || compare.behind_by !== 0
      || compare.merge_base_commit?.sha !== base) {
    return refuse(`the repaired head ${head} does not build on the failed head ${base}`);
  }
  const files = compare.files ?? [];
  if (!Array.isArray(files) || files.length >= 300) return refuse("the change's files cannot be read in full");
  for (const file of files) {
    const name = file?.filename;
    const previous = file?.previous_filename;
    if (typeof name !== "string" || !name) return refuse("a changed file has no name");
    const names = [name, ...(typeof previous === "string" ? [previous] : [])];
    if (!["added", "modified", "removed", "renamed", "changed"].includes(file.status)) return refuse(`${name} changed in a way the guard cannot read (${file.status})`);
    if (names.some(isTestPath) && (file.status === "removed" || file.status === "renamed" || (previous !== undefined && previous !== name))) {
      return refuse(`test file ${previous ?? name} was ${file.status === "removed" ? "deleted" : "renamed or moved"}`);
    }
    if (names.some(isTestConfigPath)) return refuse(`${name} decides which tests run`);
    if (names.some((entry) => entry.split("/").at(-1) === "package.json")) {
      if (file.status !== "modified" && file.status !== "changed") return refuse(`${name} was ${file.status}`);
      let before;
      let after;
      try { [before, after] = await Promise.all([readFile(name, base), readFile(name, head)]); } catch { before = null; after = null; }
      const was = typeof before === "string" ? packageTestSurface(before) : null;
      const now = typeof after === "string" ? packageTestSurface(after) : null;
      if (was === null || now === null) return refuse(`${name} cannot be read at both heads`);
      if (was !== now) return refuse(`${name} changes its test scripts or test runner configuration`);
    }
    if (file.status === "removed") continue;
    const lines = patchLines(file.patch);
    if (!lines) return refuse(`${name} has no readable diff`);
    const weakening = lines.added.find((line) => WEAKENING_RES.some((re) => re.test(line)));
    if (weakening !== undefined) return refuse(`${name} adds a skipped, focused or postponed test`);
    if (isTestPath(name) && lines.removed.some((line) => CASE_RE.test(line))) return refuse(`${name} removes a line that declares a test case`);
    if (isTestPath(name) && assertions(lines.removed) > assertions(lines.added)) return refuse(`${name} removes an assertion`);
  }
  return { ok: true };
}

// The guard as the landing runs it: GitHub's compare and file reads, GET only.
export async function readTestWeakening(gh, { repo, base, head }) {
  const api = `https://api.github.com/repos/${repo}`;
  let compare = null;
  try {
    const response = await gh("GET", `${api}/compare/${base}...${head}?per_page=100`);
    const body = await response.json();
    compare = response.ok ? body : null;
  } catch { compare = null; }
  const readFile = async (file, ref) => {
    const response = await gh("GET", `${api}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`);
    const body = await response.json();
    if (!response.ok || body?.encoding !== "base64" || typeof body.content !== "string") return null;
    return Buffer.from(body.content, "base64").toString("utf8");
  };
  return testWeakening({ compare, base, head, readFile });
}
