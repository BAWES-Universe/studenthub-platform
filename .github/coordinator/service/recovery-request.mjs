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
//     - a refusal REMOVES the request, so the next wake finds none and is an
//       ordinary tick again. The one case where that cannot hold is an object at
//       the request path that will not unlink — a directory there, an operator's
//       `cp -r`/rsync of a staging tree, a state dir that is not a directory. Left
//       as an ordinary refusal it would refuse on EVERY wake forever, and because
//       the unit lists SuccessExitStatus=2 systemd would keep reporting success
//       while the coordinator silently never ticked again. So it is its own
//       refusal name, REQUEST_UNREMOVABLE, with its own exit code
//       (RECOVERY_WEDGED_EXIT) that the unit does NOT list: the wedge fails the
//       unit and is visible to `systemctl is-failed` instead of being silent.
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
  "REQUEST_TOO_LARGE",         // larger than a reviewed request can be, refused before its bytes are read
  "REQUEST_OPERATION_UNKNOWN", // the named operation is not in RECOVERY_OPERATIONS
  "REQUEST_ATTEMPT_INVALID",   // attempt_id is not a UUID
  "REQUEST_UNAUTHORIZED",      // authorization_ref is not a real card or fixture contract ref
  "REQUEST_UNRECORDED",        // the single-use ledger could not be written, so single use is not guaranteed
  "REQUEST_REPLAYED",          // this request_id was already consumed
  "REQUEST_UNREMOVABLE",       // the object at the request path outlived the refusal: every later wake would refuse it again
  "REQUEST_DISPATCH_ENABLED",  // ENABLE_DISPATCH is true; recovery is a dispatch-off operation
  "REQUEST_OPERATION_FAILED",  // the reviewed operation did not complete
]);

// Refusals exit 2, which the unit lists in SuccessExitStatus=. A refusal must
// not trip Restart=on-failure: the request is already consumed, so a restart
// could only re-run an ordinary tick, and three of them would hit
// StartLimitBurst= and leave the unit failed for a refusal that was correct.
export const RECOVERY_REFUSED_EXIT = 2;

// THE ONE REFUSAL THAT MUST *NOT* LOOK LIKE SUCCESS. Every refusal above ends
// with the request gone, so the next wake is an ordinary tick and reporting
// success is the truth. REQUEST_UNREMOVABLE is the opposite: the object at the
// request path is still there, so every later wake refuses the same thing and the
// coordinator never ticks again. Exiting 2 there would hide a stopped coordinator
// behind a green `systemctl status` — the unit lists 2 as success. This code is
// deliberately NOT in SuccessExitStatus=, so the wedge fails the unit, is visible
// to `systemctl is-failed`, and is distinct from a refusal (2), a bad-usage exit
// (2) and the ExecStart flock's --conflict-exit-code 2.
export const RECOVERY_WEDGED_EXIT = 4;
export const RECOVERY_WEDGED_CODES = Object.freeze(["REQUEST_UNREMOVABLE"]);

// A request can only be as big as the five reviewed short fields. The cap is
// judged from the fstat already in hand, so an operator who pastes a gigabyte
// into that file is refused BY NAME without those bytes entering the unit.
export const RECOVERY_REQUEST_MAX_BYTES = 4096;

export function recoveryRefusal(code, detail) {
  if (!RECOVERY_REFUSAL_CODES.includes(code)) throw new Error(`unknown recovery refusal code: ${code}`);
  return { ok: false, code, refusal: `RECOVERY_REFUSED: ${code}`, detail: detail ?? null };
}

// The exit code a refusal deserves: 2 for a refusal the next wake recovers from
// on its own, RECOVERY_WEDGED_EXIT for one it does not.
export function recoveryRefusalExit(refusal) {
  return RECOVERY_WEDGED_CODES.includes(refusal?.code) ? RECOVERY_WEDGED_EXIT : RECOVERY_REFUSED_EXIT;
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

// Remove the request, and say why if it did not go. ENOENT is removal: something
// else already took it, and the channel is empty either way.
function release(file, fsImpl) {
  try { fsImpl.unlinkSync(file); return { removed: true, code: null }; }
  catch (error) {
    if (error?.code === "ENOENT") return { removed: true, code: null };
    return { removed: false, code: error?.code ?? "unknown" };
  }
}

// EVERY REFUSAL GOES THROUGH HERE, because a refusal is only survivable if the
// request is GONE afterwards. If the object at the request path outlives the
// refusal, the refusal that actually happened is not the one we were about to
// report — it is "this path will refuse every wake from now on", which is a
// different fact with a different repair and a different exit code. Naming it
// REQUEST_UNREMOVABLE keeps the original reason in the detail while making the
// wedge, not the symptom, the thing the operator is told about.
function refuseReleasing(where, fsImpl, refusal) {
  const released = release(where.request, fsImpl);
  if (released.removed) return { present: true, refusal };
  return {
    present: true,
    refusal: recoveryRefusal("REQUEST_UNREMOVABLE",
      `${refusal.code} was refused, but the object at ${where.request} could not be removed (${released.code}),`
      + " so every later wake would refuse it again and the coordinator would never tick:"
      + " remove that path by hand — nothing was consumed and no operation ran"),
  };
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
    return refuseReleasing(where, fsImpl, error?.code === "ELOOP"
      ? recoveryRefusal("REQUEST_INSECURE", "the request path is a symbolic link")
      : recoveryRefusal("REQUEST_UNREADABLE", `the request could not be opened: ${error?.code ?? "unknown"}`));
  }

  const refuse = (refusal) => refuseReleasing(where, fsImpl, refusal);

  let stat;
  let raw;
  try {
    // Judged from the OPEN DESCRIPTOR, never from a second lookup of the path:
    // a stat-then-open pair can be raced into checking one file and reading
    // another. `isFile` is asked before the read so a directory at the request
    // path is named for what it is instead of surfacing as an EISDIR read fault.
    stat = fsImpl.fstatSync(fd);
    if (!stat.isFile()) return refuse(recoveryRefusal("REQUEST_INSECURE", "the request is not a regular file"));
    // THE SIZE IS JUDGED BEFORE THE BYTES ARE READ. stat is already in hand from
    // the fstat above, and an operator may paste anything into this file, so the
    // refusal costs one comparison instead of reading the whole file into the
    // unit's memory first and only then finding it unparseable.
    if (stat.size > RECOVERY_REQUEST_MAX_BYTES) {
      return refuse(recoveryRefusal("REQUEST_TOO_LARGE",
        `the request is ${stat.size} bytes, over the ${RECOVERY_REQUEST_MAX_BYTES}-byte cap;`
        + ` a reviewed request carries exactly ${RECOVERY_REQUEST_FIELDS.length} short fields`));
    }
    raw = fsImpl.readFileSync(fd, "utf8");
  } catch (error) {
    return refuseReleasing(where, fsImpl,
      recoveryRefusal("REQUEST_UNREADABLE", `the request could not be read: ${error?.code ?? "unknown"}`));
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
  const released = release(where.request, fsImpl);
  if (!released.removed) {
    return {
      present: true,
      refusal: recoveryRefusal("REQUEST_UNREMOVABLE",
        `the consumed request at ${where.request} could not be removed (${released.code}), so single use cannot be`
        + " guaranteed and every later wake would refuse it again: remove that path by hand —"
        + ` request_id ${request.request_id} is already spent, so issue a new one if the recovery must run`),
    };
  }
  return { present: true, request };
}

// THE SUFFIX IS A CLAIM ABOUT WHAT HAPPENED, so it is chosen per refusal rather
// than appended to all of them. WRITE_UNCONFIRMED is the single refusal that
// means the terminal HOLD comment MAY HAVE LANDED; telling an operator "nothing
// written" there tells them the opposite of the truth, and the documented repair
// (re-run the recovery) only makes sense if they know the write is unconfirmed
// rather than absent.
export const RECOVERY_NOTHING_WRITTEN_SUFFIX = "; nothing written, slot preserved";
export const RECOVERY_UNCONFIRMED_SUFFIX =
  "; slot preserved, but the write was NOT confirmed and may have landed — re-run the recovery to repair";

export function recoveryRefusalLine(refusal) {
  const suffix = refusal?.code === "WRITE_UNCONFIRMED" ? RECOVERY_UNCONFIRMED_SUFFIX : RECOVERY_NOTHING_WRITTEN_SUFFIX;
  return `${refusal.refusal}${refusal.detail ? ` — ${refusal.detail}` : ""}${suffix}`;
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
    return { present: true, exitCode: recoveryRefusalExit(taken.refusal) };
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
  // The operation's own code travels with its line, so WRITE_UNCONFIRMED keeps
  // meaning "the write may have landed" here too — this is the operator-facing
  // host path, which is exactly where getting that backwards costs the most.
  out(recoveryRefusalLine({
    refusal: result?.refusal ?? "RECOVERY_REFUSED: REQUEST_OPERATION_FAILED",
    detail: result?.detail ?? null,
    code: result?.code ?? null,
  }));
  return { present: true, exitCode: RECOVERY_REFUSED_EXIT };
}
