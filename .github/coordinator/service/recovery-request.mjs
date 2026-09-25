// Operator-requested recovery, executed INSIDE the coordinator service's own unit.
//
// WHY THIS EXISTS
//   reconcile-dangling.mjs (#173) is a reviewed, reconciliation-only operation
//   that terminalizes ONE dangling LAUNCH_UNKNOWN attempt. It works, but it
//   cannot be run from an operator shell on the host: supervisorTransportSecret()
//   pins the credential directory to /run/credentials/shu-coordinator.service,
//   so a transient unit — even with the same uid and the same LoadCredential= —
//   materialises its credentials under its OWN unit name and the operation
//   refuses EVIDENCE_MISSING: ACT_CREDENTIAL_UNAVAILABLE. Measured twice on the
//   live host.
//
//   The fix is not to widen that pin (it is the guard that makes the transport
//   secret unreachable from anywhere but the reviewed unit) and not to swap the
//   unit's ExecStart for a one-off run (that replaces the reviewed command with
//   an unreviewed one, and leaves the unit in that state if the operator's
//   session dies). It is to let the ALREADY-REVIEWED unit, running its
//   ALREADY-REVIEWED ExecStart, be ASKED to perform the recovery instead of a
//   tick — so the operation inherits the existing systemd credential delivery
//   without any of it moving.
//
// THE MECHANISM
//   A single-use, attempt-bound request file, created 0600 by the service's own
//   uid inside the service's private state directory
//   ($SHU_WORKSPACE_STATE_DIR/recovery-request.json). coordinator-tick.mjs — the
//   unit's normal entry point, unchanged argv — consumes it before it would
//   otherwise tick, and invokes ONLY the recovery operation named in it.
//
//   CONSUMPTION IS UNCONDITIONAL AND HAPPENS BEFORE THE OPERATION RUNS. Whatever
//   the outcome, the request file is gone and its request_id is recorded in
//   recovery-consumed/, so:
//     - exactly one invocation can ever act on a given request file;
//     - a re-presented request_id is refused REQUEST_REPLAYED, by name, having
//       run nothing;
//     - a refusal can never wedge the timer into refusing forever — the next
//       wake finds no request and is an ordinary tick again.
//
// WHAT THIS PATH CANNOT DO
//   - It cannot dispatch or launch. RECOVERY_OPERATIONS is a frozen table with
//     exactly ONE entry, bound at module scope to reconcileDanglingAttempt; an
//     operation name that is not in it is refused REQUEST_OPERATION_UNKNOWN
//     before any I/O. This module imports no adapter, no dispatch entry point
//     and no launcher, performs no dynamic import, and the only names it takes
//     from reconcile.mjs are two validators (UUID_RE, authorizationRefValid).
//     The reviewed operation it does reach signs only `status` and returns from
//     supervisor.mjs submit()'s status branch before store.accept() and before
//     schedule(launch).
//   - It cannot run the tick. coordinatorEntry() takes one branch or the other,
//     never both, and a present request means the tick is not run at all.
//   - It cannot enable dispatch or arm anything. It never writes ENABLE_DISPATCH,
//     never touches the activation file, never starts or enables a unit or timer,
//     and it REFUSES outright (REQUEST_DISPATCH_ENABLED) if it is ever reached
//     with ENABLE_DISPATCH=true — recovery is a dispatch-off posture operation.
//
// WITH NO REQUEST PRESENT THE TICK IS UNCHANGED. The whole of this module's
// contribution to an ordinary wake is one open() that fails ENOENT. No probe
// runs, nothing is written, nothing is read from the board, and main() is then
// called with exactly the arguments it would have received before.
//
// NO SECRET IS EVER READ, COPIED, LOGGED OR PLACED IN ARGV HERE. The request
// carries three non-secret identifiers and a marker; the credential stays where
// systemd put it and is read only by the reviewed transport, inside the
// operation. A malformed request's bytes are NEVER echoed — only the shape
// violation is named — because an operator may paste anything into that file.

import fs from "node:fs";
import path from "node:path";

import { UUID_RE, authorizationRefValid } from "../reconcile.mjs";
import { reconcileDanglingAttempt } from "../reconcile-dangling.mjs";

export const RECOVERY_REQUEST_FILE = "recovery-request.json";
export const RECOVERY_CONSUMED_DIR = "recovery-consumed";
export const RECOVERY_REQUEST_MARKER = "coordinator-recovery v1";

// Exactly these fields, no more and no less. An unknown key is a refusal, not
// something to ignore: "ignore what you do not understand" is how a field like
// enable_dispatch or adapter gets smuggled past a reviewer into a request the
// service will act on.
export const RECOVERY_REQUEST_FIELDS = Object.freeze([
  "request", "operation", "request_id", "attempt_id", "authorization_ref",
]);

// THE OPERATION TABLE IS THE WHOLE AUTHORITY OF THIS CHANNEL. It is frozen, it
// has one entry, and that entry is the reviewed reconciliation-only operation.
// There is no fallback, no name-to-path resolution and no dynamic import, so the
// set of things a request can cause to happen is fixed at review time and is
// visible in this one object.
export const RECOVERY_OPERATIONS = Object.freeze({
  "reconcile-dangling": reconcileDanglingAttempt,
});
export const RECOVERY_OPERATION_NAMES = Object.freeze(Object.keys(RECOVERY_OPERATIONS));

// Refusals are BY NAME, like the operation's own. Each names a different repair.
export const RECOVERY_REFUSAL_CODES = Object.freeze([
  "REQUEST_UNREADABLE",        // a request exists but could not be opened or read
  "REQUEST_INSECURE",          // wrong mode, wrong owner, not a regular file, or a symlink
  "REQUEST_MALFORMED",         // not JSON, or not exactly the reviewed field set
  "REQUEST_OPERATION_UNKNOWN", // the named operation is not in RECOVERY_OPERATIONS
  "REQUEST_ATTEMPT_INVALID",   // attempt_id is not a UUID
  "REQUEST_UNAUTHORIZED",      // authorization_ref is not a real card or fixture contract ref
  "REQUEST_UNRECORDED",        // the single-use ledger could not be written, so single use is not guaranteed
  "REQUEST_REPLAYED",          // this request_id was already consumed
  "REQUEST_DISPATCH_ENABLED",  // ENABLE_DISPATCH is true; recovery is a dispatch-off operation
  "REQUEST_OPERATION_FAILED",  // the reviewed operation did not complete
]);

// Refusals exit 2, which the unit lists in SuccessExitStatus=. A refusal must
// not trip Restart=on-failure: the request is already consumed, so a restart
// could only re-run an ordinary tick, and three of them would hit
// StartLimitBurst= and leave the unit failed for a refusal that was correct.
export const RECOVERY_REFUSED_EXIT = 2;

export function recoveryRefusal(code, detail) {
  if (!RECOVERY_REFUSAL_CODES.includes(code)) throw new Error(`unknown recovery refusal code: ${code}`);
  return { ok: false, code, refusal: `RECOVERY_REFUSED: ${code}`, detail: detail ?? null };
}

// The channel exists only where the unit put the service's private state
// directory. No state dir means no channel, which means no request — never a
// guessed path and never a fallback into a world-writable one.
export function recoveryPaths(env = process.env) {
  const stateDir = env?.SHU_WORKSPACE_STATE_DIR;
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) return null;
  return {
    stateDir,
    request: path.join(stateDir, RECOVERY_REQUEST_FILE),
    consumed: path.join(stateDir, RECOVERY_CONSUMED_DIR),
  };
}

// Best effort by design: the request lives in the service's own 0700 state
// directory, and a request that cannot be removed is reported in the refusal
// detail rather than silently retried on the next wake.
function discard(file, fsImpl) {
  try { fsImpl.unlinkSync(file); return true; }
  catch (error) { return error?.code === "ENOENT"; }
}

function shapeRefusal(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return recoveryRefusal("REQUEST_MALFORMED", "the request is not a JSON object");
  }
  const got = Object.keys(parsed).sort();
  const want = [...RECOVERY_REQUEST_FIELDS].sort();
  if (got.length !== want.length || got.some((key, i) => key !== want[i])) {
    // The KEYS are named, never the values: the file's contents are operator
    // input and must not be echoed into the journal.
    return recoveryRefusal("REQUEST_MALFORMED", `the request must carry exactly the fields ${want.join(", ")}; it carries ${got.join(", ") || "none"}`);
  }
  if (parsed.request !== RECOVERY_REQUEST_MARKER) {
    return recoveryRefusal("REQUEST_MALFORMED", `the request marker must be "${RECOVERY_REQUEST_MARKER}"`);
  }
  if (typeof parsed.request_id !== "string" || !UUID_RE.test(parsed.request_id)) {
    return recoveryRefusal("REQUEST_MALFORMED", "request_id must be a UUID, so the request can be recorded and a replay recognised");
  }
  if (typeof parsed.operation !== "string" || !RECOVERY_OPERATION_NAMES.includes(parsed.operation)) {
    return recoveryRefusal("REQUEST_OPERATION_UNKNOWN", `the only operation this channel can name is ${RECOVERY_OPERATION_NAMES.join(", ")}`);
  }
  if (typeof parsed.attempt_id !== "string" || !UUID_RE.test(parsed.attempt_id)) {
    return recoveryRefusal("REQUEST_ATTEMPT_INVALID", "attempt_id must be a UUID naming exactly one attempt");
  }
  if (!authorizationRefValid(parsed.authorization_ref)) {
    return recoveryRefusal("REQUEST_UNAUTHORIZED", "authorization_ref must be a card ref (SHU-<n>) or a seeded fixture contract ref");
  }
  return null;
}

// Read, judge, and CONSUME — in that order, with consumption unconditional once
// a request is present. Returns one of:
//   { present: false }                      no request; the caller ticks as before
//   { present: true, refusal }              refused by name; nothing was run
//   { present: true, request }              a valid, now single-use-consumed request
export function consumeRecoveryRequest({ env = process.env, paths = undefined, fsImpl = fs } = {}) {
  const where = paths ?? recoveryPaths(env);
  if (!where) return { present: false };

  let fd;
  try {
    // O_NOFOLLOW: the request must be a real file in the service's own state
    // directory, never a link pointing at something else.
    fd = fsImpl.openSync(where.request, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    // THE ORDINARY WAKE ENDS HERE, having done exactly one failed open.
    if (error?.code === "ENOENT") return { present: false };
    const insecure = error?.code === "ELOOP";
    const removed = discard(where.request, fsImpl);
    return {
      present: true,
      refusal: insecure
        ? recoveryRefusal("REQUEST_INSECURE", `the request path is a symbolic link${removed ? "" : " and could not be removed"}`)
        : recoveryRefusal("REQUEST_UNREADABLE", `the request could not be opened: ${error?.code ?? "unknown"}${removed ? "" : "; it could not be removed either"}`),
    };
  }

  const refuse = (refusal) => { discard(where.request, fsImpl); return { present: true, refusal }; };

  let stat;
  let raw;
  try {
    // Judged from the OPEN DESCRIPTOR, never from a second lookup of the path:
    // a stat-then-open pair can be raced into checking one file and reading
    // another. `isFile` is asked before the read so a directory at the request
    // path is named for what it is instead of surfacing as an EISDIR read fault.
    stat = fsImpl.fstatSync(fd);
    if (!stat.isFile()) return refuse(recoveryRefusal("REQUEST_INSECURE", "the request is not a regular file"));
    raw = fsImpl.readFileSync(fd, "utf8");
  } catch (error) {
    discard(where.request, fsImpl);
    return { present: true, refusal: recoveryRefusal("REQUEST_UNREADABLE", `the request could not be read: ${error?.code ?? "unknown"}`) };
  } finally {
    try { fsImpl.closeSync(fd); } catch { /* the descriptor is this process's own */ }
  }

  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    return refuse(recoveryRefusal("REQUEST_INSECURE", `the request is mode ${mode.toString(8).padStart(4, "0")}, not 0600`));
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return refuse(recoveryRefusal("REQUEST_INSECURE", `the request is owned by uid ${stat.uid}, not the service's own uid ${process.getuid()}`));
  }

  let parsed;
  // The bytes are operator input. A parse failure names the failure, never the
  // content.
  try { parsed = JSON.parse(raw); }
  catch { return refuse(recoveryRefusal("REQUEST_MALFORMED", "the request is not parseable JSON")); }

  const bad = shapeRefusal(parsed);
  if (bad) return refuse(bad);

  const request = Object.freeze({
    request: parsed.request,
    operation: parsed.operation,
    request_id: parsed.request_id,
    attempt_id: parsed.attempt_id,
    authorization_ref: parsed.authorization_ref,
  });

  // SINGLE USE. The ledger entry is created with O_EXCL ("wx"), so the very
  // first invocation to record this request_id is the only one that may act on
  // it; every later presentation of the same id loses the create and is refused
  // REQUEST_REPLAYED having run nothing. The entry holds the canonical request
  // and no timestamp: journald records when, and a clock has no business
  // deciding whether a request is valid.
  const record = path.join(where.consumed, `${request.request_id}.json`);
  try {
    fsImpl.mkdirSync(where.consumed, { recursive: true, mode: 0o700 });
    fsImpl.writeFileSync(record, `${JSON.stringify(request, RECOVERY_REQUEST_FIELDS, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const replay = error?.code === "EEXIST";
    return refuse(replay
      ? recoveryRefusal("REQUEST_REPLAYED", `request ${request.request_id} was already consumed; issue a new request_id if the recovery must run again`)
      : recoveryRefusal("REQUEST_UNRECORDED", `the single-use record could not be written: ${error?.code ?? "unknown"}`));
  }

  // Recorded, so the request may now be released. Removing it last means a crash
  // between the two leaves a request whose id is already spent — which the next
  // wake refuses REQUEST_REPLAYED. That is the fail-closed direction.
  if (!discard(where.request, fsImpl)) {
    return { present: true, refusal: recoveryRefusal("REQUEST_UNREADABLE", "the consumed request could not be removed, so single use cannot be guaranteed") };
  }
  return { present: true, request };
}

export function recoveryRefusalLine(refusal) {
  return `${refusal.refusal}${refusal.detail ? ` — ${refusal.detail}` : ""}; nothing written, slot preserved`;
}

export function recoveryTerminalizedLine(request, result) {
  return `RECOVERY_TERMINALIZED attempt=${request.attempt_id} stage=${result.stage} slot=released` +
    ` authorization_ref=${request.authorization_ref} request_id=${request.request_id}`;
}

// The service's recovery branch. Returns { present, exitCode }; present:false
// means the caller must tick exactly as it always did.
export async function runRecoveryRequest({ env = process.env, io = {}, out = (line) => console.log(line) } = {}) {
  const taken = (io.consume ?? consumeRecoveryRequest)({ env, paths: io.paths, fsImpl: io.fsImpl });
  if (!taken.present) return { present: false, exitCode: null };
  if (taken.refusal) {
    out(recoveryRefusalLine(taken.refusal));
    return { present: true, exitCode: RECOVERY_REFUSED_EXIT };
  }
  const request = taken.request;

  // Recovery is a DISPATCH-OFF posture operation. Reaching it with dispatch
  // enabled means the host is not in the posture this was reviewed for, so it
  // refuses rather than proceeding — and it never writes ENABLE_DISPATCH itself,
  // in either direction.
  if (env?.ENABLE_DISPATCH === "true") {
    out(recoveryRefusalLine(recoveryRefusal("REQUEST_DISPATCH_ENABLED", "ENABLE_DISPATCH is true; recovery runs only with dispatch off and the timer disabled")));
    return { present: true, exitCode: RECOVERY_REFUSED_EXIT };
  }

  // EXACT BINDING: the operation is called with this request's attempt_id and
  // nothing else. There is no argv, no scope, no adapter and no target to pass.
  const operation = io.operation ?? RECOVERY_OPERATIONS[request.operation];
  let result;
  try {
    result = await operation({ attempt_id: request.attempt_id, env, io: io.operationIo ?? {}, now: io.now });
  } catch (error) {
    out(recoveryRefusalLine(recoveryRefusal("REQUEST_OPERATION_FAILED", `the recovery operation did not complete: ${error?.message ?? "operation threw"}`)));
    return { present: true, exitCode: RECOVERY_REFUSED_EXIT };
  }

  if (result?.ok === true) {
    out(recoveryTerminalizedLine(request, result));
    return { present: true, exitCode: 0 };
  }
  // The operation's own named refusal is reported verbatim: it, not this module,
  // decided, and its vocabulary is the one RECONCILE-DANGLING.md documents.
  out(recoveryRefusalLine({ refusal: result?.refusal ?? "RECOVERY_REFUSED: REQUEST_OPERATION_FAILED", detail: result?.detail ?? null }));
  return { present: true, exitCode: RECOVERY_REFUSED_EXIT };
}
