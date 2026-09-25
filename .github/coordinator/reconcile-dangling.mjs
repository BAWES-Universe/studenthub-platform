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
//     receipt produced by the reviewed state machine (nextReceiptState). On any
//     refusal it writes nothing at all and the slot is preserved.
//
// EVERY condition below is established INDEPENDENTLY, at run time, from a probe
// taken during this invocation. A probe whose observation predates this
// invocation is a cached snapshot and is refused as EVIDENCE_STALE, not
// believed.

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

// A live worker is detected from the process table, not from any record the
// coordinator wrote: the record is exactly what we are declaring untrustworthy.
export function defaultWorkerProcesses({ receipt }) {
  const pids = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    for (const file of ["cmdline", "environ"]) {
      let raw;
      try { raw = fs.readFileSync(path.join("/proc", entry, file), "utf8"); } catch { continue; }
      if (raw.includes(receipt.attempt_id)) { pids.push(Number(entry)); break; }
    }
  }
  return { observed_at: nowIso(), pids: pids.filter((pid) => pid !== process.pid) };
}

export function defaultWorktree({ receipt, env }) {
  const root = env.SHU_WORKTREE_ROOT;
  if (!root) return { observed_at: nowIso(), present: false, head: null, porcelain: null };
  const dir = path.join(root, receipt.attempt_id);
  if (!fs.existsSync(dir)) return { observed_at: nowIso(), present: false, head: null, porcelain: null };
  return {
    observed_at: nowIso(),
    present: true,
    head: gitIn(dir, ["rev-parse", "HEAD"]).trim(),
    porcelain: gitIn(dir, ["status", "--porcelain"]),
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
  return { observed_at: nowIso(), readable: true, record: fs.existsSync(file) ? file : null };
}

// Read-only by construction: SupervisorStore's constructor mkdirs its own tree,
// so this checks the four per-attempt paths directly instead of instantiating it.
export function defaultSupervisorStore({ receipt, env }) {
  const stateDir = env.SHU_SUPERVISOR_STATE_DIR;
  if (!stateDir) return { observed_at: nowIso(), readable: false, records: [] };
  const records = ["orders", "runs", "launches", "completions"]
    .filter((kind) => fs.existsSync(path.join(stateDir, kind, `${receipt.attempt_id}.json`)));
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
  const config = io.config ?? loadConfig(io.configPath);

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
  // The reviewed state machine performs the transition. LAUNCH_UNKNOWN -> HOLD
  // is the only edge used, and it stamps timestamps.terminal, so the slot is
  // released by exactly the rule the tick already applies.
  const transition = nextReceiptState(receipt, {
    type: "hold",
    at: now(),
    reason: `reconciled dangling ${RECONCILABLE_STAGE}: supervisor reported MISSING_CLAIM and no worker, worktree, branch or push effect exists for attempt ${attempt_id}`,
  });
  if (!transition.accepted) return refusal("NOT_DANGLING", transition.reason);

  await (io.postReceipt ?? defaultPostReceipt)({ receipt: transition.receipt, linearIssueId, env, config });
  return { ok: true, action: "TERMINALIZED", attempt_id, stage: transition.receipt.stage, receipt: transition.receipt, linearIssueId };
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
  const result = await reconcileDanglingAttempt({ attempt_id: args.attempt_id, env, io });
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
