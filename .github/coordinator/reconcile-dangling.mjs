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
  "WORKER_LIVE",             // a worker process for this attempt is CONFIRMED still running
  "WORKER_STALE_RECORD",     // a sighted pid is provably not that process any more (gone, or a different start token)
  "WORKER_UNVERIFIED",       // a sighted pid is still there but its identity could not be established
  "WORKTREE_CHANGED",        // the attempt's worktree moved off its recorded scoped base
  "BRANCH_MOVED",            // the branch's remote head no longer equals the order's target_sha
  "PUSH_RECEIPT_PRESENT",    // a push/commit receipt exists: an external effect may have landed
  "EVIDENCE_MISSING",        // a required probe did not answer
  "EVIDENCE_STALE",          // a probe answered from before this invocation (cached snapshot)
  "WRITE_UNCONFIRMED",       // every condition held, but the Linear write did not confirm
]);

export function refusal(code, detail, evidence) {
  if (!RECONCILE_REFUSAL_CODES.includes(code)) throw new Error(`unknown reconcile refusal code: ${code}`);
  // `evidence` is the machine-readable half of the same statement the detail
  // string makes. A refusal that can only be read as prose cannot be
  // reconstructed after the fact, which is the whole reason this exists.
  return { ok: false, code, refusal: `RECONCILE_REFUSED: ${code}`, detail: detail ?? null, ...(evidence ? { evidence } : {}) };
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
// Default probes (each one is injectable; each stamps its own observation, from
// the one injected clock)
// ---------------------------------------------------------------------------
//
// THE CLOCK IS INJECTED, AND THERE IS EXACTLY ONE OF IT. Freshness is the only
// thing this operation compares timestamps for, and it compares a probe's
// observation against this invocation's start. Both instants must therefore come
// from the SAME clock: if a probe read the wall clock on its own while the
// invocation's start came from anywhere else, the comparison would measure the
// disagreement between two clocks rather than the age of the evidence. So every
// probe below takes `now` and stamps `now()`, reconcileDanglingAttempt() passes
// its own `now` to every probe it takes, and nothing here ever reads the wall
// clock behind the caller's back. nowIso is the default, used when no clock is
// injected; a caller that injects one gets an operation whose verdict is
// identical whether the host clock is correct, a year fast or a year slow.
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
export async function defaultSupervisorStatus({ receipt, env, now = nowIso }) {
  return { observed_at: now(), response: await sendSupervisorStatus({ receipt, env }) };
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
//
// The SOURCE FILE is carried out with the pid: a refusal that names a pid but
// not where that pid came from cannot be reconstructed afterwards, which is
// exactly the audit gap that made a vanished pid indistinguishable from a live
// worker.
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
      found.push({ pid: record.pid, process_token: typeof record.process_token === "string" ? record.process_token : null, source_path: file });
    }
  }
  return found;
}

// Field 22 of /proc/<pid>/stat, counted after the comm field's closing paren —
// the same slice supervisor-worker.mjs takes for `processStartToken`. It is
// what distinguishes our worker from an unrelated process that inherited its
// pid after it died.
export function processStartToken(procRoot, pid) {
  const stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

// A COMMAND LINE IS NEVER CAPTURED. Not redacted, not truncated, not quoted —
// not captured at all.
//
// An earlier revision of this module carried a redacted `cmdline` in the refusal
// detail, in `evidence.sightings` and on stdout (which on the host is the unit's
// journal), on the theory that a blacklist of credential-looking shapes could
// make third-party argv safe to persist. It cannot. The sighting sources are
// (b) cwd-inside-the-worktree and (c) attempt_id-in-argv, so the argv captured
// is whatever the agent shelled out to — curl, gh, psql, mysql — and a blacklist
// has to enumerate every way a credential can be spelled. A review demonstrated
// six shapes that a keyword blacklist still published end to end through main(),
// including `X-Api-Key: <value>` and a secret passed as the entry after a short
// flag. Each instance was individually fixable and the class was not, so the
// MECHANISM is rejected rather than extended: there is no longer any code path
// that can persist or print an argument value.
//
// /proc/<pid>/cmdline and /proc/<pid>/environ are still READ — sighting (c)
// matches the attempt_id against them — and the bytes are discarded in the same
// expression that tests them. They are never stored on a sighting, never
// rendered into an audit line, and never interpolated into an error message.
//
// What the audit line carries instead is STRUCTURED METADATA the kernel owns and
// a process cannot choose the contents of: the pid, the owning uid, the
// process-start token then and now, which sighting source supplied the pid and
// from which file, the record-token comparison, the identity comparison, and
// which of those checks actually decided. That is enough to reconstruct any
// refusal from the log alone — see RECONCILE-DANGLING.md — and none of it can
// carry a credential.

// The stable identity of a pid AT ONE INSTANT: whether /proc/<pid> is there at
// all, the uid that owns it, and the kernel's process-start token. Every field
// distinguishes "absent" from "unreadable", because the whole point of
// re-checking is that "I could not look" must never render as a fact.
export function readProcessIdentity(procRoot, pid) {
  const dir = path.join(procRoot, String(pid));
  let stat;
  try { stat = fs.statSync(dir); }
  catch (error) { return { pid, exists: false, exists_known: error?.code === "ENOENT", start_token: null, uid: null }; }
  if (!stat.isDirectory()) return { pid, exists: false, exists_known: true, start_token: null, uid: null };
  // The owning uid comes from the /proc/<pid> directory itself, so it is the
  // kernel's answer and not anything the process supplied. It is what tells an
  // operator "this was the runner" from "this was somebody's shell" now that no
  // command line is carried.
  const uid = Number.isInteger(stat.uid) ? stat.uid : null;
  let start_token = null;
  try { start_token = processStartToken(procRoot, pid) ?? null; } catch { start_token = null; }
  return { pid, exists: true, exists_known: true, start_token, uid };
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
//
// Each sighting now carries a STABLE IDENTITY captured at match time — the pid,
// the owning uid and the kernel's process-start token — plus the file that
// supplied the pid. No command line and no argument value is ever captured. `pids` stays exactly what it was (the pids that would
// have been reported live), so no existing guard is weakened; `sightings` is
// what the re-check and the audit trail are built from.
export function defaultWorkerProcesses({ receipt, env, procRoot = "/proc", now = nowIso }) {
  const live = entriesOf(procRoot).filter((entry) => /^\d+$/.test(entry));
  const sightings = new Map();
  // The record-token comparison, over ALL the record tokens that named this pid.
  // It is fail-closed: ANY recorded token that disagrees with the live start
  // token decides `false`, even if another record agrees. RECORD ORDER MUST NOT
  // BE ABLE TO DECIDE A DISPOSITION — an earlier untokened record used to win
  // every field of a pid's sighting and silently suppress a later record's
  // disagreeing `process_token`, which flipped RECORD_TOKEN_MISMATCH into
  // CONFIRMED_LIVE and dropped the disagreement out of the audit line entirely.
  const recordTokenMatch = (recordedTokens, observedToken) => {
    const named = recordedTokens.filter((token) => typeof token === "string" && token !== "");
    if (!named.length) return null;      // no record named a token: nothing to compare
    if (!observedToken) return null;     // no live token to compare it against
    return !named.some((token) => token !== observedToken);
  };

  const note = (pid, sighting) => {
    const seen = sightings.get(pid);
    if (!seen) { sightings.set(pid, sighting); return; }
    // Later sightings only ADD evidence; none of them may overwrite what an
    // earlier one established. The new source is deduplicated against the FIRST
    // source too, or one pid named by two record kinds renders
    // `source=supervisor_record+supervisor_record`.
    if (sighting.source !== seen.source && !seen.also_seen_by.includes(sighting.source)) {
      seen.also_seen_by.push(sighting.source);
    }
    // Every file that supplied the pid is kept, in read order, so a line naming
    // two record tokens also names the two records they came from.
    for (const sourcePath of sighting.source_paths) {
      if (!seen.source_paths.includes(sourcePath)) seen.source_paths.push(sourcePath);
    }
    // CONFLICTING TOKEN EVIDENCE IS PRESERVED, never replaced. Both records'
    // tokens stay on the sighting and both reach the audit line, and the
    // comparison is re-run over all of them, so a disagreement always decides no
    // matter which record was read first. Re-running can only move the answer
    // towards a mismatch: adding a token can turn `null` into true or false and
    // true into false, and can never turn false back into true.
    for (const token of sighting.recorded_tokens) seen.recorded_tokens.push(token);
    seen.record_token_match = recordTokenMatch(seen.recorded_tokens, seen.observed_token);
    if (seen.recorded_token === null) seen.recorded_token = sighting.recorded_token ?? null;
    // A later sighting from a NON-record source is not just another way of saying
    // the same thing: a process whose cwd is the attempt's worktree, or that
    // carries the attempt_id, was bound to this attempt BY OBSERVATION. A
    // supervisor record's stale process_token can never exonerate a process we
    // can see working here, so that binding is recorded rather than dropped —
    // and `record_token_match` is still never cleared, because the record's
    // disagreement with the kernel remains a fact and stays in the audit line.
    if (sighting.source !== "supervisor_record") seen.independently_bound = true;
  };

  for (const { pid, process_token, source_path } of recordedWorkerIdentities({ receipt, env })) {
    // A record naming a pid that is not in the process table at all never was a
    // sighting: nothing was seen, so there is nothing to confirm or to refuse
    // over. The supervisor-store guard below still answers for that record.
    if (!live.includes(String(pid))) continue;
    const identity = readProcessIdentity(procRoot, pid);
    // A recorded token that no longer matches means the pid was recycled: that
    // process is somebody else's. An unrecorded token cannot exonerate anyone,
    // so an untokened live pid still counts as SIGHTED — and the fact that THIS
    // record carried no token is itself recorded, as a null in `recorded_tokens`,
    // so a later record's token can never be read as this record's.
    const recorded_tokens = [process_token ?? null];
    note(pid, {
      pid,
      source: "supervisor_record",
      also_seen_by: [],
      source_path,
      source_paths: [source_path],
      recorded_token: process_token ?? null,
      recorded_tokens,
      observed_token: identity.start_token,
      observed_uid: identity.uid,
      record_token_match: recordTokenMatch(recorded_tokens, identity.start_token),
      // A record alone binds the pid to the attempt only as well as the record
      // is trusted, and the record is exactly what is in question here.
      independently_bound: false,
    });
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
      if (cwd && (cwd === worktreeDir || cwd.startsWith(`${worktreeDir}${path.sep}`))) {
        const identity = readProcessIdentity(procRoot, pid);
        const source_path = path.join(procRoot, entry, "cwd");
        note(pid, {
          pid, source: "worktree_cwd", also_seen_by: [], source_path, source_paths: [source_path],
          recorded_token: null, recorded_tokens: [], observed_token: identity.start_token,
          observed_uid: identity.uid, record_token_match: null,
          independently_bound: true,
        });
        continue;
      }
    }
    for (const file of ["cmdline", "environ"]) {
      let raw;
      try { raw = fs.readFileSync(path.join(procRoot, entry, file), "utf8"); } catch { continue; }
      if (raw.includes(receipt.attempt_id)) {
        const identity = readProcessIdentity(procRoot, pid);
        // `raw` is tested and then dropped: the only thing this scan carries out
        // is WHICH FILE matched, never a byte of what was in it.
        const source_path = path.join(procRoot, entry, file);
        note(pid, {
          pid, source: "attempt_id_scan", also_seen_by: [], source_path, source_paths: [source_path],
          recorded_token: null, recorded_tokens: [], observed_token: identity.start_token,
          observed_uid: identity.uid, record_token_match: null,
          independently_bound: true,
        });
        break;
      }
    }
  }

  const ours = (sighting) => sighting.pid !== process.pid;
  const kept = [...sightings.values()].filter(ours).sort((a, b) => a.pid - b.pid);
  return {
    observed_at: now(),
    // UNCHANGED semantics, and unchanged from BEFORE the sightings existed: a
    // record-token mismatch was never a live pid, and still is not — but it
    // never suppressed a pid that a cwd or argv scan had independently seen
    // either, and it still must not. Dropping those would make this probe report
    // FEWER live pids than the code it replaced.
    pids: kept.filter((s) => s.record_token_match !== false || s.independently_bound === true).map((s) => s.pid),
    sightings: kept,
  };
}

// The RE-CHECK. Everything above happened at match time; between then and the
// verdict a process can exit, and its pid can be handed to something else. This
// probe looks again, by pid, and reports what is there NOW — never a judgement,
// only the second observation the classifier compares against the first.
export function defaultWorkerLiveness({ sightings, procRoot = "/proc", now = nowIso }) {
  const list = Array.isArray(sightings) ? sightings : [];
  return { observed_at: now(), observations: list.map((s) => readProcessIdentity(procRoot, s.pid)) };
}

// Match time vs re-check time. A sighting is a CONFIRMED live worker only if
// the pid is still there AND the kernel says it is still the same process. Every
// other outcome is named, and the name says what was and was not verified.
export const WORKER_DISPOSITIONS = Object.freeze({
  CONFIRMED_LIVE: "pid still present and its process-start token is unchanged since the sighting",
  VANISHED: "/proc/<pid> is gone: the sighted process exited before the verdict",
  PRESENCE_UNREADABLE: "/proc/<pid> could not be read at the re-check: the pid was neither observed present nor proved gone",
  TOKEN_CHANGED: "the process-start token changed since the sighting: the pid was reused by another process",
  RECORD_TOKEN_MISMATCH: "the record's process_token does not match the live process's start token, and no independent sighting binds the pid to this attempt",
  UNVERIFIED: "the pid is still present but its process-start token could not be read at the sighting or at the re-check",
  UNOBSERVED: "the liveness re-check returned no observation for this pid",
});

export function classifyWorkerSighting(sighting, observation) {
  if (!observation || observation.pid !== sighting.pid) return { disposition: "UNOBSERVED", check: "liveness re-check" };
  // "I could not look" must never render as a fact, and the fact VANISHED states
  // is that the process is provably gone. readProcessIdentity reports
  // `exists_known: false` when /proc/<pid> could not be stat'ed for any reason
  // other than ENOENT — EACCES, EPERM, an I/O error — so only a KNOWN absence
  // may be called VANISHED. Everything else fails closed as unverified.
  if (observation.exists !== true && observation.exists_known !== true) {
    return { disposition: "PRESENCE_UNREADABLE", check: "/proc/<pid> presence at re-check (unreadable)" };
  }
  if (observation.exists !== true) return { disposition: "VANISHED", check: "/proc/<pid> presence at re-check" };
  // An independently-bound process — seen working in the attempt worktree, or
  // carrying the attempt_id — is not exonerated by a record that disagrees with
  // the kernel. It falls through to the token checks below, which can only
  // reach CONFIRMED_LIVE, TOKEN_CHANGED or UNVERIFIED: never a release.
  if (sighting.record_token_match === false && sighting.independently_bound !== true) {
    return { disposition: "RECORD_TOKEN_MISMATCH", check: "record process_token vs live start token" };
  }
  if (!sighting.observed_token || !observation.start_token) return { disposition: "UNVERIFIED", check: "/proc/<pid>/stat field 22 readability" };
  if (observation.start_token !== sighting.observed_token) return { disposition: "TOKEN_CHANGED", check: "process-start token at sighting vs re-check" };
  return { disposition: "CONFIRMED_LIVE", check: "process-start token at sighting vs re-check" };
}

// One line per sighting, and it is the WHOLE evidence: which pid, which uid owns
// it, where the pid came from, the token then and now (or the reason there is
// none), what the record-token and identity comparisons concluded, and which of
// them actually decided. A refusal built from these lines can be reconstructed
// from the log alone, with no access to the host it happened on.
//
// EVERY FIELD IS STRUCTURED METADATA THE KERNEL OWNS. There is no command line
// and no argument value here, in any form, redacted or otherwise — see the note
// above readProcessIdentity for why that mechanism was removed rather than
// extended.
// What the re-check saw, and never more than it saw: a token, or the REASON
// there is no token. "absent" is a claim that /proc/<pid> was looked at and was
// not there, so it is reserved for an absence the kernel actually confirmed.
function tokenAtRecheck(observation) {
  if (!observation) return "unobserved";
  if (observation.start_token) return observation.start_token;
  if (observation.exists === true) return "unreadable";
  return observation.exists_known === true ? "absent" : "unreadable";
}

// EVERY record token that named this pid, in the order the records were read and
// aligned with `source_path`, with `none` standing for a record that carried no
// token at all. Two records that disagree both appear: the disagreement is the
// fact, and losing it to record order is exactly the defect this renders around.
function recordedTokens(sighting) {
  const tokens = Array.isArray(sighting.recorded_tokens) ? sighting.recorded_tokens : null;
  // A caller-built sighting (an injected probe) may carry only the scalar.
  if (!tokens?.length) return sighting.recorded_token ? String(sighting.recorded_token) : "none";
  return tokens.map((token) => (token ? String(token) : "none")).join("+");
}

// What the RECORD comparison concluded, stated even when it was not the check
// that decided: a retained mismatch under an independent binding has to remain
// visible, or the line cannot show that a record disagreed at all.
function recordTokenCheck(sighting) {
  if (sighting.record_token_match === true) return "match";
  if (sighting.record_token_match === false) return "mismatch";
  const tokens = Array.isArray(sighting.recorded_tokens) ? sighting.recorded_tokens : [];
  const named = tokens.some((token) => typeof token === "string" && token !== "") || Boolean(sighting.recorded_token);
  return named ? "uncomparable" : "no_record_token";
}

// What the IDENTITY comparison — the sighting's start token against the
// re-check's — concluded. `not_reached` is the honest answer for a sighting the
// record comparison decided before the identity comparison ran: the line must
// never imply an identity result that was never established.
const IDENTITY_CHECK_RESULTS = Object.freeze({
  CONFIRMED_LIVE: "start_token_unchanged",
  TOKEN_CHANGED: "start_token_changed",
  UNVERIFIED: "start_token_unreadable",
  VANISHED: "pid_absent",
  PRESENCE_UNREADABLE: "presence_unreadable",
  UNOBSERVED: "not_observed",
  RECORD_TOKEN_MISMATCH: "not_reached",
});

export function describeWorkerSighting(verdict) {
  const { sighting, observation, disposition, check } = verdict;
  const sources = [sighting.source, ...sighting.also_seen_by].join("+");
  const paths = Array.isArray(sighting.source_paths) && sighting.source_paths.length
    ? sighting.source_paths.join(",") : sighting.source_path;
  return [
    `pid=${sighting.pid}`,
    // The owning uid, from the kernel's own /proc/<pid> inode: the one piece of
    // "which process was this" that no process can author.
    `uid=${Number.isInteger(sighting.observed_uid) ? sighting.observed_uid : "unreadable"}`,
    `disposition=${disposition}`,
    `check=${check}`,
    `source=${sources}`,
    `source_path=${paths}`,
    `recorded_token=${recordedTokens(sighting)}`,
    `record_token_check=${recordTokenCheck(sighting)}`,
    `token_at_sighting=${sighting.observed_token ?? "unreadable"}`,
    `token_at_recheck=${tokenAtRecheck(observation)}`,
    `identity_check=${IDENTITY_CHECK_RESULTS[disposition] ?? "unknown"}`,
    // Why a record that disagrees with the kernel did, or did not, decide this
    // sighting — without it the line cannot explain its own disposition.
    `independently_bound=${sighting.independently_bound === true ? "yes" : "no"}`,
  ].join(" ");
}

// The verdict over ALL sightings, in strict precedence:
//   confirmed  -> WORKER_LIVE      (proved live; recovery can never proceed)
//   unverified -> WORKER_UNVERIFIED(neither proved nor disproved; fail closed)
//   disproved  -> WORKER_STALE_RECORD (proved NOT the sighted process any more)
// A sighting that was never in the process table at match time is not here at
// all: nothing was seen, so there is nothing to disprove.
export function workerVerdict(sightings, observations) {
  const byPid = new Map((observations ?? []).map((o) => [o?.pid, o]));
  const verdicts = (sightings ?? []).map((sighting) => {
    const observation = byPid.get(sighting.pid) ?? null;
    return { sighting, observation, ...classifyWorkerSighting(sighting, observation) };
  });
  const of = (...names) => verdicts.filter((v) => names.includes(v.disposition));
  return {
    verdicts,
    confirmed: of("CONFIRMED_LIVE"),
    unverified: of("UNVERIFIED", "UNOBSERVED", "PRESENCE_UNREADABLE"),
    disproved: of("VANISHED", "TOKEN_CHANGED", "RECORD_TOKEN_MISMATCH"),
  };
}

// An UNCONFIGURED worktree root is not evidence that the worktree is absent; it
// is evidence that nobody looked. Reporting `present: false` for it would skip
// the HEAD and porcelain comparison entirely and fail OPEN — the operation would
// terminalize over a worktree that had moved off its base and was dirty, having
// never measured it. `root_configured` is the flag the caller refuses on, the
// same way `readable` works for the push-receipt and supervisor-store probes.
export function defaultWorktree({ receipt, env, gitImpl = gitIn, now = nowIso }) {
  const root = env.SHU_WORKTREE_ROOT;
  if (!root) return { observed_at: now(), root_configured: false, present: false, head: null, porcelain: null };
  const entries = entriesOf(root);
  if (!entries.includes(receipt.attempt_id)) {
    return { observed_at: now(), root_configured: true, present: false, head: null, porcelain: null };
  }
  const dir = path.join(root, receipt.attempt_id);
  return {
    observed_at: now(),
    root_configured: true,
    present: true,
    head: gitImpl(dir, ["rev-parse", "HEAD"]).trim(),
    porcelain: gitImpl(dir, ["status", "--porcelain"]),
  };
}

export async function defaultBranchHead({ receipt, env, fetchImpl = fetch, now = nowIso }) {
  const measured = await measureBranchHead({ repo: receipt.repo, branch: receipt.branch, token: env.GITHUB_TOKEN ?? "", fetchImpl });
  return { observed_at: now(), ok: measured.ok, sha: measured.sha };
}

export function defaultPushReceipt({ receipt, env, now = nowIso }) {
  const stateDir = env.SHU_WORKSPACE_STATE_DIR;
  if (!stateDir) return { observed_at: now(), readable: false, record: null };
  const file = prePushRecordPath(stateDir, receipt.attempt_id);
  // `readable` is only true once the directory has actually been listed.
  let entries;
  try { entries = entriesOf(stateDir); }
  catch { return { observed_at: now(), readable: false, record: null }; }
  return { observed_at: now(), readable: true, record: entries.includes(path.basename(file)) ? file : null };
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
export function defaultSupervisorStore({ receipt, env, now = nowIso }) {
  const stateDir = env.SHU_SUPERVISOR_STATE_DIR;
  if (!stateDir) return { observed_at: now(), readable: false, records: [] };
  const records = [];
  for (const kind of SUPERVISOR_RECORD_KINDS) {
    let entries;
    try { entries = entriesOf(path.join(stateDir, kind)); }
    catch { return { observed_at: now(), readable: false, records: [] }; }
    if (entries.includes(`${receipt.attempt_id}.json`)) records.push(kind);
  }
  return { observed_at: now(), readable: true, records };
}

export async function defaultReadReceipts({ config, env, fetchImpl = fetch, now = nowIso }) {
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
  return { observed_at: now(), receipts, linearIdByAttempt };
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
  // `now` is handed to the probe, not just used to judge it: the observation and
  // the start instant it is compared against must come from ONE clock, or
  // freshness measures clock skew instead of the age of the evidence. An
  // injected probe is free to ignore it; every shipped probe stamps it.
  const take = async (label, probe, args) => {
    let value;
    try { value = await probe({ ...args, now }); }
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
  // A probe that reports pids but no sightings has told us a number and nothing
  // else: there is no identity to re-check and no audit line to write. That is
  // an unanswered probe, not an empty one.
  if (!Array.isArray(workers.sightings)) {
    return refusal("EVIDENCE_MISSING", "the worker probe reported no sightings, so no pid identity could be established");
  }

  // THE RE-CHECK. Everything above is match-time evidence. A pid that has since
  // vanished, or that now carries a different kernel process-start token, is not
  // the process we saw, and calling it a confirmed live worker is how a refusal
  // becomes unauditable: the operator is told a pid that no longer exists.
  const livenessTaken = await take("worker liveness", io.workerLiveness ?? defaultWorkerLiveness, { receipt, env, sightings: workers.sightings });
  if (livenessTaken.refused) return livenessTaken.refused;
  if (!Array.isArray(livenessTaken.value.observations)) {
    return refusal("EVIDENCE_MISSING", "the worker liveness re-check did not answer");
  }
  const verdict = workerVerdict(workers.sightings, livenessTaken.value.observations);
  const workerAudit = (group) => ({ sightings: group.map((v) => describeWorkerSighting(v)) });

  // Proved live: the pid is still there and the kernel says it is still the same
  // process. This is the ONLY thing that may be called WORKER_LIVE.
  if (verdict.confirmed.length) {
    return refusal("WORKER_LIVE", `confirmed live worker process(es) ${verdict.confirmed.map((v) => v.sighting.pid).join(",")} — ${verdict.confirmed.map(describeWorkerSighting).join(" | ")}`,
      workerAudit(verdict.confirmed));
  }
  // Neither proved nor disproved: the pid is still there but we could not
  // establish that it is ours. Fail closed, under its own name, and say exactly
  // which check could not be completed.
  if (verdict.unverified.length) {
    return refusal("WORKER_UNVERIFIED", `pid(s) ${verdict.unverified.map((v) => v.sighting.pid).join(",")} sighted but not verified as this attempt's worker — ${verdict.unverified.map(describeWorkerSighting).join(" | ")}`,
      workerAudit(verdict.unverified));
  }
  // Proved NOT the sighted process any more. The world changed under this
  // invocation, so nothing here is terminalized on it: the operator re-runs and
  // gets a verdict taken over one consistent observation of the host.
  if (verdict.disproved.length) {
    return refusal("WORKER_STALE_RECORD", `no live worker: pid(s) ${verdict.disproved.map((v) => v.sighting.pid).join(",")} were sighted and are provably not that process now — ${verdict.disproved.map(describeWorkerSighting).join(" | ")}`,
      workerAudit(verdict.disproved));
  }

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
  // The journal must carry the evidence, not just the verdict. One line per
  // sighting — pid, uid, source file, token then and now, the record-token and
  // identity comparisons and which check decided — so the refusal can be
  // reconstructed from the log alone. Structured metadata only: no command line
  // and no argument value is ever printed here.
  for (const line of result.evidence?.sightings ?? []) out(`WORKER_SIGHTING ${line}`);
  return 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
