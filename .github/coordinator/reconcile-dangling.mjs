// Reconciliation-only recovery for ONE dangling LAUNCH_UNKNOWN attempt.
//
// WHY THIS IS A SEPARATE ENTRY POINT
//   reconcile.mjs counts a receipt as active unless its stage is in
//   TERMINAL_STAGES (["COMPLETED","FAILED","HOLD"]), so a chain left at
//   LAUNCH_UNKNOWN holds the single max_dispatch slot forever: nothing can
//   terminate it, because LAUNCH_UNKNOWN is resolved by a supervisor decision
//   about a claim the supervisor never accepted. A dispatch-off tick prints
//   "DRY-RUN (dispatch disabled, no writes)" and makes zero writes, so the tick
//   can never repair this. This module is invoked BY HAND, by an operator, for
//   exactly one attempt_id.
//
//   It imports FROM reconcile.mjs and reconcile.mjs never imports it, so no
//   tick path can reach this code. The tick's dry-run and dispatch-off
//   semantics are untouched and stay strictly read-only.
//
// WHAT IT WILL NOT DO
//   - It never sends a supervisor `submit`. In supervisor.mjs `submit()` the
//     status branch returns BEFORE `store.accept()` and before any
//     `schedule(() => this.launch(...))`, so a submit would mint a durable
//     order, a branch claim, a run record, a launch marker and a child process.
//     Only operation "status" is ever signed here, and sendSupervisorStatus()
//     refuses any other operation before it reaches the socket.
//   - It never reads ENABLE_DISPATCH, never arms or consumes an activation,
//     never loads an adapter module, never retries, resumes or launches
//     anything.
//   - On success it writes at most ONE Linear comment: the terminal HOLD
//     receipt produced by the reviewed state machine (nextReceiptState). On
//     every refusal but WRITE_UNCONFIRMED it writes nothing at all and the slot
//     is preserved; WRITE_UNCONFIRMED is the write itself failing to confirm,
//     and re-running is the repair (a landed write refuses ALREADY_TERMINAL).
//
// EVERY condition below is established INDEPENDENTLY, at run time, from a probe
// taken during this invocation. A probe whose observation predates this
// invocation is a cached snapshot and is refused as EVIDENCE_STALE, not
// believed. And every condition is an ABSENCE claim, so no probe may ever
// report an empty result it did not actually establish: an unset environment
// variable, an unlistable directory and a read fault are each EVIDENCE_MISSING
// by name, never "I looked and there is nothing there". See RECONCILE-DANGLING.md.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  LINEAR_COMMENT_CREATE_MUTATION,
  TERMINAL_STAGES,
  UUID_RE,
  fetchLinearBoard,
  loadConfig,
  measureBranchHead,
  nextReceiptState,
  parseReceiptsFromComments,
  receiptCommentBody,
  sendLinear,
} from "./reconcile.mjs";
import { signedSupervisorRequest, submitToSupervisor } from "./supervisor.mjs";
import { supervisorOrder } from "./supervisor-dispatch.mjs";
import { supervisorTransportSecret } from "./service/credential-delivery.mjs";
import { prePushRecordPath } from "./push-broker.mjs";

// The ONE stage this operation is allowed to terminalize. RESERVED is repaired
// by the tick; RUNNING has a live claim; the terminal stages are already done.
export const RECONCILABLE_STAGE = "LAUNCH_UNKNOWN";

// The four per-attempt record kinds SupervisorStore keeps. Its constructor
// ensureDir()s every one of them, so a state dir that is missing any of them is
// not a supervisor store this operation is entitled to draw conclusions from.
export const SUPERVISOR_RECORD_KINDS = Object.freeze(["orders", "runs", "launches", "completions"]);

// Refusals are BY NAME. There is deliberately no generic failure code: an
// operator who is told "refused" must be told which independently-established
// condition did not hold, because each one implies a different repair.
export const RECONCILE_REFUSAL_CODES = Object.freeze([
  "ALREADY_TERMINAL",        // the chain is already COMPLETED/FAILED/HOLD; nothing to free
  "NOT_DANGLING",            // resolved stage is live (RESERVED/RUNNING), not a dangling launch
  "SUPERVISOR_CLAIM_PRESENT",// the supervisor knows this attempt: it is not ours to terminalize
  "WORKER_LIVE",             // a worker process for this attempt is still running
  "WORKTREE_CHANGED",        // the attempt's worktree moved off its recorded scoped base
  "BRANCH_MOVED",            // the branch's remote head no longer equals the order's target_sha
  "PUSH_RECEIPT_PRESENT",    // a push/commit receipt exists: an external effect may have landed
  "EVIDENCE_MISSING",        // a required probe did not answer
  "EVIDENCE_STALE",          // a probe answered from before this invocation (cached snapshot)
  "WRITE_UNCONFIRMED",       // every condition held, but the Linear write did not confirm
]);

export function refusal(code, detail) {
  if (!RECONCILE_REFUSAL_CODES.includes(code)) throw new Error(`unknown reconcile refusal code: ${code}`);
  return { ok: false, code, refusal: `RECONCILE_REFUSED: ${code}`, detail: detail ?? null };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

// A probe counts only if it ANSWERED and answered DURING this invocation. The
// second half is the whole point of "checked independently at run time": a
// result carried over from an earlier tick, an earlier operator session or a
// stored report describes a host that may since have changed, and terminalizing
// on it would release the slot on the strength of a memory.
export function probeFreshness(probe, startedAt) {
  if (!probe || typeof probe !== "object") return refusal("EVIDENCE_MISSING", "probe did not answer");
  const observed = Date.parse(probe.observed_at ?? "");
  if (!Number.isFinite(observed)) return refusal("EVIDENCE_MISSING", "probe carried no observation time");
  const started = Date.parse(startedAt ?? "");
  if (!Number.isFinite(started)) return refusal("EVIDENCE_MISSING", "invocation carried no start time");
  if (observed < started) return refusal("EVIDENCE_STALE", `observed at ${probe.observed_at}, before this run started at ${startedAt}`);
  return null;
}

// ---------------------------------------------------------------------------
// Condition 1 — the supervisor's own signed answer, status ONLY
// ---------------------------------------------------------------------------

// Signing and sending are one function so the operation string cannot drift
// apart from what is signed. "status" is the only value this module will sign:
// supervisor.submit() dispatches on request.operation and returns from the
// status branch before store.accept(), so anything else here would create the
// very claim we are asserting does not exist.
export function sendSupervisorStatus({ receipt, env = process.env, transport = submitToSupervisor, operation = "status" }) {
  if (operation !== "status") throw new Error("reconcile-dangling may only send the supervisor `status` operation");
  const request = signedSupervisorRequest(supervisorOrder(receipt), supervisorTransportSecret(env), operation);
  return transport({ socketPath: env.SHU_SUPERVISOR_SOCKET, request });
}

// MISSING_CLAIM is the supervisor stating, over its own authenticated
// transport, that it holds no durable order for this attempt. Any other answer
// — an accepted/running stage, a different hold code, or a reply that carries
// no hold code at all (a transport fault) — leaves the claim unestablished.
export function supervisorDisownsAttempt(response) {
  if (!response || typeof response !== "object") return refusal("EVIDENCE_MISSING", "supervisor did not answer");
  if (response.ok === true) return refusal("SUPERVISOR_CLAIM_PRESENT", `supervisor answered stage ${response.stage ?? "?"}`);
  if (typeof response.hold_code !== "string") {
    return refusal("EVIDENCE_MISSING", `supervisor answer carried no hold_code: ${response.reason ?? "no reason given"}`);
  }
  if (response.hold_code !== "MISSING_CLAIM") {
    return refusal("SUPERVISOR_CLAIM_PRESENT", `supervisor answered hold_code ${response.hold_code}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default probes (each one is injectable; each one stamps its own observation)
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

function gitIn(dir, args) {
  return execFileSync("git", ["-c", `safe.directory=${dir}`, "-C", dir, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
}

// The supervisor probe is a probe like any other: it stamps its own observation
// and it never lets a transport fault masquerade as an answer. A reply with no
// hold_code is read as EVIDENCE_MISSING downstream, never as "no claim".
export async function defaultSupervisorStatus({ receipt, env }) {
  return { observed_at: nowIso(), response: await sendSupervisorStatus({ receipt, env }) };
}

// Every on-disk probe below reads directory ENTRIES, never fs.existsSync().
// existsSync() answers `false` on EACCES, EIO and ENOTDIR exactly as it does on
// a genuinely absent path, so an UNREADABLE directory would be reported as an
// EMPTY one — "I could not look" rendered as "I looked and there is nothing".
// Every condition here is an absence claim, so that one confusion is the whole
// failure mode: it releases the slot on evidence that was never gathered.
// readdirSync() throws instead, and a throwing probe is EVIDENCE_MISSING.
function entriesOf(dir) {
  return fs.readdirSync(dir);
}

// The worker's pid, as the SUPERVISOR itself recorded it. This is the only
// place the attempt_id and a pid are ever bound together: supervisor-worker.mjs
// forks the child with EMPTY argv and supervisorChildEnvironment() is a fixed
// allow-list of variable NAMES that carries no attempt_id, so no scan of
// /proc/<pid>/cmdline or /proc/<pid>/environ can ever see a real worker.
// markLaunch() writes `pid` before the child is even reaped, and writeRun()
// records `pid` plus the kernel's process-start token.
function recordedWorkerIdentities({ receipt, env }) {
  const stateDir = env.SHU_SUPERVISOR_STATE_DIR;
  if (!stateDir) return [];
  const found = [];
  for (const kind of SUPERVISOR_RECORD_KINDS) {
    const file = path.join(stateDir, kind, `${receipt.attempt_id}.json`);
    // The directory must be listable — a missing or unreadable record directory
    // is a store we could not read, and must never be read as "no worker". This
    // throws so take() names it EVIDENCE_MISSING.
    const entries = entriesOf(path.join(stateDir, kind));
    // Only the absence of THIS file, inside a directory we did list, is a real
    // absence.
    if (!entries.includes(path.basename(file))) continue;
    const raw = fs.readFileSync(file, "utf8");
    let record;
    try { record = JSON.parse(raw); } catch { throw new Error(`${kind} record for the attempt is unparseable`); }
    if (Number.isInteger(record?.pid) && record.pid > 0) {
      found.push({ pid: record.pid, process_token: typeof record.process_token === "string" ? record.process_token : null });
    }
  }
  return found;
}

// Field 22 of /proc/<pid>/stat, counted after the comm field's closing paren —
// the same slice supervisor-worker.mjs takes for `processStartToken`. It is
// what distinguishes our worker from an unrelated process that inherited its
// pid after it died.
function processStartToken(procRoot, pid) {
  const stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

// A live worker is detected from the process table, never from a coordinator
// receipt: the receipt is exactly what we are declaring untrustworthy. Three
// independent sightings, because a worker that the supervisor forked is
// invisible to a naive argv/environ scan (see recordedWorkerIdentities):
//   (a) a pid the SUPERVISOR recorded for this attempt that is still alive,
//   (b) any process whose cwd is inside the attempt's own worktree,
//   (c) any process carrying the attempt_id in argv or the environment.
// Reading /proc itself is never optional: if the process table cannot be
// listed, this throws and the operation refuses EVIDENCE_MISSING.
export function defaultWorkerProcesses({ receipt, env, procRoot = "/proc" }) {
  const live = entriesOf(procRoot).filter((entry) => /^\d+$/.test(entry));
  const pids = new Set();

  for (const { pid, process_token } of recordedWorkerIdentities({ receipt, env })) {
    if (!live.includes(String(pid))) continue;
    // A recorded token that no longer matches means the pid was recycled: that
    // process is somebody else's. An unrecorded token cannot exonerate anyone,
    // so an untokened live pid still counts as live.
    if (process_token) {
      let token = null;
      try { token = processStartToken(procRoot, pid); } catch { token = null; }
      if (token && token !== process_token) continue;
    }
    pids.add(pid);
  }

  const worktreeDir = env.SHU_WORKTREE_ROOT ? path.join(env.SHU_WORKTREE_ROOT, receipt.attempt_id) : null;
  for (const entry of live) {
    const pid = Number(entry);
    if (worktreeDir) {
      // readlink, not a substring: the cwd of a supervisor-forked worker is the
      // attempt worktree even though its command line says nothing at all.
      // A cwd we may not read (another uid) is skipped, never counted absent.
      let cwd = null;
      try { cwd = fs.readlinkSync(path.join(procRoot, entry, "cwd")); } catch { cwd = null; }
      if (cwd && (cwd === worktreeDir || cwd.startsWith(`${worktreeDir}${path.sep}`))) { pids.add(pid); continue; }
    }
    for (const file of ["cmdline", "environ"]) {
      let raw;
      try { raw = fs.readFileSync(path.join(procRoot, entry, file), "utf8"); } catch { continue; }
      if (raw.includes(receipt.attempt_id)) { pids.add(pid); break; }
    }
  }
  return { observed_at: nowIso(), pids: [...pids].filter((pid) => pid !== process.pid).sort((a, b) => a - b) };
}

// An UNCONFIGURED worktree root is not evidence that the worktree is absent; it
// is evidence that nobody looked. Reporting `present: false` for it would skip
// the HEAD and porcelain comparison entirely and fail OPEN — the operation would
// terminalize over a worktree that had moved off its base and was dirty, having
// never measured it. `root_configured` is the flag the caller refuses on, the
// same way `readable` works for the push-receipt and supervisor-store probes.
export function defaultWorktree({ receipt, env, gitImpl = gitIn }) {
  const root = env.SHU_WORKTREE_ROOT;
  if (!root) return { observed_at: nowIso(), root_configured: false, present: false, head: null, porcelain: null };
  const entries = entriesOf(root);
  if (!entries.includes(receipt.attempt_id)) {
    return { observed_at: nowIso(), root_configured: true, present: false, head: null, porcelain: null };
  }
  const dir = path.join(root, receipt.attempt_id);
  return {
    observed_at: nowIso(),
    root_configured: true,
    present: true,
    head: gitImpl(dir, ["rev-parse", "HEAD"]).trim(),
    porcelain: gitImpl(dir, ["status", "--porcelain"]),
  };
}

export async function defaultBranchHead({ receipt, env, fetchImpl = fetch }) {
  const measured = await measureBranchHead({ repo: receipt.repo, branch: receipt.branch, token: env.GITHUB_TOKEN ?? "", fetchImpl });
  return { observed_at: nowIso(), ok: measured.ok, sha: measured.sha };
}

export function defaultPushReceipt({ receipt, env }) {
  const stateDir = env.SHU_WORKSPACE_STATE_DIR;
  if (!stateDir) return { observed_at: nowIso(), readable: false, record: null };
  const file = prePushRecordPath(stateDir, receipt.attempt_id);
  // `readable` is only true once the directory has actually been listed.
  let entries;
  try { entries = entriesOf(stateDir); }
  catch { return { observed_at: nowIso(), readable: false, record: null }; }
  return { observed_at: nowIso(), readable: true, record: entries.includes(path.basename(file)) ? file : null };
}

// Read-only by construction: SupervisorStore's constructor mkdirs its own tree,
// so this lists the four per-attempt record directories instead of
// instantiating it.
//
// This is the check that must stay INDEPENDENT of the supervisor's own status
// answer, because status() returns hold_code MISSING_CLAIM from a CATCH-ALL:
// any read fault inside it — an unreadable orders/, a truncated run record —
// produces the same "no claim" answer as a genuine absence. That is only a
// second opinion if this probe can prove it really read the store, so
// `readable: true` requires ALL FOUR directories to have been listed. A state
// dir that a real supervisor has ever used always has all four (the store's
// constructor creates them), so anything less is a store we cannot vouch for.
export function defaultSupervisorStore({ receipt, env }) {
  const stateDir = env.SHU_SUPERVISOR_STATE_DIR;
  if (!stateDir) return { observed_at: nowIso(), readable: false, records: [] };
  const records = [];
  for (const kind of SUPERVISOR_RECORD_KINDS) {
    let entries;
    try { entries = entriesOf(path.join(stateDir, kind)); }
    catch { return { observed_at: nowIso(), readable: false, records: [] }; }
    if (entries.includes(`${receipt.attempt_id}.json`)) records.push(kind);
  }
  return { observed_at: nowIso(), readable: true, records };
}

export async function defaultReadReceipts({ config, env, fetchImpl = fetch }) {
  const { issues, commentsByIssue } = await fetchLinearBoard({
    token: env.LINEAR_API_TOKEN ?? "", repo: config.pilot_repo, team: config.team ?? "SHU",
    repoLabelMap: config.repo_label_map, fetchImpl, readComments: true,
  });
  const receipts = [];
  const linearIdByAttempt = new Map();
  for (const issue of issues) {
    const read = commentsByIssue.get(issue.linearId ?? issue.id) ?? commentsByIssue.get(issue.id);
    if (!read || read.error) continue;
    for (const receipt of parseReceiptsFromComments(read.comments, config.linear_receipt_actor_ids)) {
      receipts.push(receipt);
      if (!linearIdByAttempt.has(receipt.attempt_id)) linearIdByAttempt.set(receipt.attempt_id, issue.linearId ?? issue.id);
    }
  }
  return { observed_at: nowIso(), receipts, linearIdByAttempt };
}

export async function defaultPostReceipt({ receipt, linearIssueId, env, fetchImpl = fetch }) {
  await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId: linearIssueId, body: receiptCommentBody(receipt) },
    env.LINEAR_API_TOKEN ?? "", fetchImpl);
}

// ---------------------------------------------------------------------------
// Chain resolution
// ---------------------------------------------------------------------------

// The dangling chain is several comment records of ONE attempt_id. Resolve it
// the way the tick does — newest last_activity wins — so this operation and the
// tick can never disagree about which record is current.
export function resolveChain(receipts, attempt_id) {
  const chain = (receipts ?? []).filter((r) => r && r.attempt_id === attempt_id);
  if (!chain.length) return null;
  return chain.reduce((newest, r) => (String(r.last_activity ?? "") > String(newest.last_activity ?? "") ? r : newest));
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

export async function reconcileDanglingAttempt({
  attempt_id,
  env = process.env,
  io = {},
  now = nowIso,
} = {}) {
  const startedAt = now();
  let config;
  // Configuration that cannot be loaded is EVIDENCE_MISSING by name, not an
  // escaping exception: nothing has been established and nothing was written.
  try { config = io.config ?? loadConfig(io.configPath); }
  catch (error) { return refusal("EVIDENCE_MISSING", `configuration could not be loaded: ${error?.message ?? "loadConfig failed"}`); }

  // A probe that throws has not established anything. It is EVIDENCE_MISSING by
  // name, never an escaping exception and never a generic failure: an operator
  // reading "the process table could not be read" must not be able to confuse
  // it with "the process table is empty".
  const take = async (label, probe, args) => {
    let value;
    try { value = await probe(args); }
    catch (error) { return { refused: refusal("EVIDENCE_MISSING", `${label}: ${error?.code || error?.message || "probe threw"}`) }; }
    const stale = probeFreshness(value, startedAt);
    return stale ? { refused: stale } : { value };
  };

  if (typeof attempt_id !== "string" || !UUID_RE.test(attempt_id)) {
    return refusal("EVIDENCE_MISSING", "an attempt_id UUID is required");
  }

  // --- durable receipts -----------------------------------------------------
  const readTaken = await take("durable receipts", io.readReceipts ?? defaultReadReceipts, { attempt_id, config, env });
  if (readTaken.refused) return readTaken.refused;
  const read = readTaken.value;

  const receipt = resolveChain(read.receipts, attempt_id);
  if (!receipt) return refusal("EVIDENCE_MISSING", `no durable receipt for attempt ${attempt_id}`);

  // Idempotence, established before ANY supervisor contact and before any
  // probe: a second invocation after terminalization does nothing at all.
  if (TERMINAL_STAGES.includes(receipt.stage)) {
    return refusal("ALREADY_TERMINAL", `attempt ${attempt_id} is already ${receipt.stage}`);
  }
  if (receipt.stage !== RECONCILABLE_STAGE) {
    return refusal("NOT_DANGLING", `attempt ${attempt_id} is at ${receipt.stage}, not ${RECONCILABLE_STAGE}`);
  }

  const linearIssueId = io.linearIssueId ?? read.linearIdByAttempt?.get(attempt_id) ?? null;
  if (!linearIssueId) return refusal("EVIDENCE_MISSING", "the attempt's Linear issue could not be resolved");

  // --- Condition 1: the supervisor's own signed status answer ---------------
  const statusTaken = await take("supervisor status", io.supervisorStatus ?? defaultSupervisorStatus, { receipt, env });
  if (statusTaken.refused) return statusTaken.refused;
  const claimed = supervisorDisownsAttempt(statusTaken.value.response);
  if (claimed) return claimed;

  // --- Condition 2: no worker, no external effect ---------------------------
  // Each probe is taken here, now, and each is checked for freshness before its
  // content is believed.
  const workersTaken = await take("worker processes", io.workerProcesses ?? defaultWorkerProcesses, { receipt, env });
  if (workersTaken.refused) return workersTaken.refused;
  const workers = workersTaken.value;
  if (!Array.isArray(workers.pids)) return refusal("EVIDENCE_MISSING", "the process table could not be read");
  if (workers.pids.length) return refusal("WORKER_LIVE", `live worker process(es) ${workers.pids.join(",")}`);

  const worktreeTaken = await take("attempt worktree", io.worktree ?? defaultWorktree, { receipt, env });
  if (worktreeTaken.refused) return worktreeTaken.refused;
  const worktree = worktreeTaken.value;
  if (typeof receipt.scoped_base_sha !== "string" || !receipt.scoped_base_sha) {
    return refusal("EVIDENCE_MISSING", "the receipt records no scoped_base_sha to compare the worktree against");
  }
  // The worktree root must have been configured, or the worktree was never
  // measured and `present: false` means "nobody looked", not "nothing there".
  if (worktree.root_configured !== true) {
    return refusal("EVIDENCE_MISSING", "SHU_WORKTREE_ROOT is not configured, so the attempt worktree was never measured");
  }
  if (worktree.present) {
    if (typeof worktree.head !== "string" || typeof worktree.porcelain !== "string") {
      return refusal("EVIDENCE_MISSING", "the worktree could not be measured");
    }
    if (worktree.head !== receipt.scoped_base_sha) {
      return refusal("WORKTREE_CHANGED", `worktree HEAD ${worktree.head} != scoped_base_sha ${receipt.scoped_base_sha}`);
    }
    if (worktree.porcelain !== "") return refusal("WORKTREE_CHANGED", "worktree has uncommitted changes");
  }

  const branchTaken = await take("remote branch head", io.branchHead ?? defaultBranchHead, { receipt, env, config });
  if (branchTaken.refused) return branchTaken.refused;
  const branch = branchTaken.value;
  if (branch.ok !== true) return refusal("EVIDENCE_MISSING", "the branch's remote head could not be read");
  if (branch.sha !== receipt.target_sha) {
    return refusal("BRANCH_MOVED", `remote head ${branch.sha ?? "absent"} != target_sha ${receipt.target_sha}`);
  }

  const pushTaken = await take("push/commit receipts", io.pushReceipt ?? defaultPushReceipt, { receipt, env });
  if (pushTaken.refused) return pushTaken.refused;
  const push = pushTaken.value;
  if (push.readable !== true) return refusal("EVIDENCE_MISSING", "push/commit receipts could not be read");
  if (push.record) return refusal("PUSH_RECEIPT_PRESENT", `push receipt ${push.record}`);

  const storeTaken = await take("supervisor store", io.supervisorStore ?? defaultSupervisorStore, { receipt, env });
  if (storeTaken.refused) return storeTaken.refused;
  const store = storeTaken.value;
  if (store.readable !== true) return refusal("EVIDENCE_MISSING", "the supervisor store could not be read");
  if (store.records?.length) return refusal("SUPERVISOR_CLAIM_PRESENT", `supervisor store records ${store.records.join(",")}`);

  // --- terminalize ----------------------------------------------------------
  const terminal = terminalizeReceipt(receipt, { attempt_id, at: now() });
  if (!terminal.ok) return terminal;

  // A write that did not confirm is reported BY NAME like everything else. The
  // operator must never be left reading a stack trace to work out whether the
  // HOLD comment landed, which is the one moment the naming discipline is for.
  try {
    await (io.postReceipt ?? defaultPostReceipt)({ receipt: terminal.receipt, linearIssueId, env, config });
  } catch (error) {
    return refusal("WRITE_UNCONFIRMED", `the terminal HOLD comment did not confirm: ${error?.message ?? "write failed"}`);
  }
  return { ok: true, action: "TERMINALIZED", attempt_id, stage: terminal.receipt.stage, receipt: terminal.receipt, linearIssueId };
}

// The reviewed state machine performs the transition. LAUNCH_UNKNOWN -> HOLD is
// the only edge used, and it stamps timestamps.terminal, so the slot is released
// by exactly the rule the tick already applies. A rejected transition is a
// refusal by name: the state machine, not this module, has the last word on
// whether a stage may be terminalized.
export function terminalizeReceipt(receipt, { attempt_id, at }) {
  const transition = nextReceiptState(receipt, {
    type: "hold",
    at,
    reason: `reconciled dangling ${RECONCILABLE_STAGE}: supervisor reported MISSING_CLAIM and no worker, worktree, branch or push effect exists for attempt ${attempt_id}`,
  });
  if (!transition.accepted) return refusal("NOT_DANGLING", transition.reason);
  return { ok: true, receipt: transition.receipt };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseReconcileArgs(argv = []) {
  const at = argv.indexOf("--reconcile-dangling");
  if (at === -1) return { ok: false, reason: "usage: node .github/coordinator/reconcile-dangling.mjs --reconcile-dangling <attempt_id>" };
  const value = argv[at + 1];
  if (!value || !UUID_RE.test(value)) return { ok: false, reason: "--reconcile-dangling requires an attempt_id UUID" };
  if (argv.length !== 2) return { ok: false, reason: "--reconcile-dangling takes exactly one argument and no other flags" };
  return { ok: true, attempt_id: value };
}

export async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const out = io.stdout ?? ((line) => console.log(line));
  const args = parseReconcileArgs(argv);
  if (!args.ok) {
    out(args.reason);
    return 2;
  }
  const result = await reconcileDanglingAttempt({ attempt_id: args.attempt_id, env, io, ...(io.now ? { now: io.now } : {}) });
  if (result.ok) {
    out(`RECONCILE_TERMINALIZED attempt=${result.attempt_id} stage=${result.stage} slot=released`);
    return 0;
  }
  out(`${result.refusal}${result.detail ? ` — ${result.detail}` : ""}; slot preserved, nothing written`);
  return 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
