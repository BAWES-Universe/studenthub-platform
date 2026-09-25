// The OPERATOR side of the coordinator recovery request: the command that
// creates $SHU_WORKSPACE_STATE_DIR/recovery-request.json for the reviewed unit
// to consume.
//
// WHY THIS EXISTS
//   recovery-request.mjs is the SERVICE side. It reads exactly one path —
//   recoveryPaths() joins recovery-request.json onto the unit's own
//   SHU_WORKSPACE_STATE_DIR and looks nowhere else — and a request written
//   anywhere else is SILENTLY IGNORED: the entry point's one open() still fails
//   ENOENT, the wake is an ordinary dry-run tick, and NOTHING reports that a
//   request existed. Reader and writer live in the same module and cannot
//   disagree with each other, so the only thing that could ever drift was the
//   directory the OPERATOR was told to write into — and in #174 it had
//   (RECONCILE-DANGLING.md documented /srv/shu/state while the unit exports
//   /srv/shu/state/workspaces). Correcting the documented literal fixes today's
//   value; it does not close the failure mode, because the next hand-typed
//   STATE_DIR= is free to be wrong again and the wrongness is invisible.
//
//   So the operator does not supply the directory at all. This command OBTAINS
//   it from the deployed unit, and if it cannot obtain it — or if anything the
//   operator did supply disagrees with it — it REFUSES BY NAME and creates
//   NOTHING. A misrouted request can no longer look like a successful one.
//
// THE ORDER IS THE GUARANTEE
//   The unit's value is read and every supplied value is reconciled against it
//   BEFORE any file is created. There is no path through this module that
//   writes a staging file, a request file, or anything else, ahead of the
//   STATE_DIR decision — so a refusal leaves the state directory byte-identical
//   and no tick, then or later, can see a request.
//
// WHAT THIS COMMAND CANNOT DO
//   It writes ONE json file containing the five reviewed request fields and
//   exits. It starts nothing, enables nothing, arms nothing, never writes
//   ENABLE_DISPATCH in either direction, never edits the unit, and runs exactly
//   one external command: `systemctl show -p Environment --value
//   shu-coordinator.service`, which is a read. The recovery itself happens in
//   the service's own unit, on the operator's separate `systemctl start`.
//
// NO SECRET IS READ, COPIED OR PRINTED HERE. The request carries three
// non-secret identifiers and a marker; the success line prints the request's
// PATH and nothing else. The unit's Environment= block is parsed for one
// variable and is never echoed.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { UUID_RE, authorizationRefValid } from "../reconcile.mjs";
import {
  RECOVERY_OPERATION_NAMES,
  RECOVERY_REQUEST_FIELDS,
  RECOVERY_REQUEST_MARKER,
  recoveryPaths,
} from "./recovery-request.mjs";

// The unit whose deployed environment is the ONLY authority for the directory.
export const RECOVERY_UNIT = "shu-coordinator.service";
export const WORKSPACE_STATE_DIR_VARIABLE = "SHU_WORKSPACE_STATE_DIR";

// The operation this command may ask for. Like the service side's table, it is
// fixed at review time: there is no flag that can name another one.
export const REQUESTED_OPERATION = "reconcile-dangling";

// One read, no shell, fixed argv. Stated as data so a test can assert the exact
// command rather than trusting a comment.
export const UNIT_ENVIRONMENT_COMMAND = Object.freeze(
  ["systemctl", "show", "-p", "Environment", "--value", RECOVERY_UNIT],
);

export const REQUEST_STAGING_SUFFIX = ".staging";

// Refusals are BY NAME, like the operation's and the service channel's. The two
// that matter are the STATE_DIR pair: between them they make "the request went
// somewhere the tick never reads" impossible to reach.
export const REQUEST_REFUSAL_CODES = Object.freeze([
  "STATE_DIR_UNKNOWN",        // the unit's SHU_WORKSPACE_STATE_DIR could not be obtained or parsed
  "STATE_DIR_MISMATCH",       // a supplied directory is not the unit's deployed one
  "ATTEMPT_INVALID",          // --attempt is not a UUID
  "AUTHORIZATION_REF_INVALID",// --authorization-ref is not a card ref or a seeded fixture contract ref
  "REQUEST_ID_INVALID",       // --request-id is not a UUID
  "REQUEST_NOT_WRITTEN",      // every check held, but the file could not be created or renamed into place
]);

export const REQUEST_REFUSED_EXIT = 3;
export const REQUEST_USAGE_EXIT = 2;
export const REQUEST_WRITTEN_PREFIX = "REQUEST_WRITTEN path=";

export const REQUEST_FLAGS = Object.freeze([
  "--attempt", "--authorization-ref", "--state-dir", "--request-id",
]);

export const REQUEST_USAGE =
  "usage: node .github/coordinator/service/request-recovery.mjs --attempt <uuid> --authorization-ref <ref>" +
  " [--state-dir <dir>] [--request-id <uuid>]";

export function requestRefusal(code, detail) {
  if (!REQUEST_REFUSAL_CODES.includes(code)) throw new Error(`unknown request refusal code: ${code}`);
  return { ok: false, code, refusal: `RECOVERY_REQUEST_REFUSED: ${code}`, detail: detail ?? null };
}

export function requestRefusalLine(refusal) {
  return `${refusal.refusal}${refusal.detail ? ` — ${refusal.detail}` : ""}; nothing written`;
}

// STRICT ARGV. Exactly the flags above, each at most once, each with a value.
// An unknown flag is a usage error and not something to ignore: "ignore what you
// do not understand" is how --enable-dispatch gets typed, accepted and believed.
export function parseRequestArgv(argv) {
  const fail = (reason) => ({ ok: false, reason });
  if (!Array.isArray(argv)) return fail("no arguments");
  if (argv.length === 0) return fail("no arguments");
  if (argv.length % 2 !== 0) return fail("every flag takes exactly one value");
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!REQUEST_FLAGS.includes(flag)) return fail(`unknown flag ${JSON.stringify(String(flag))}`);
    if (Object.prototype.hasOwnProperty.call(options, flag)) return fail(`${flag} was given more than once`);
    if (typeof value !== "string" || value === "" || value.startsWith("--")) {
      return fail(`${flag} requires a value`);
    }
    options[flag] = value;
  }
  for (const required of ["--attempt", "--authorization-ref"]) {
    if (!Object.prototype.hasOwnProperty.call(options, required)) return fail(`${required} is required`);
  }
  return {
    ok: true,
    options: {
      attempt_id: options["--attempt"],
      authorization_ref: options["--authorization-ref"],
      // SUPPLIED, NEVER TRUSTED. This value is only ever compared to the unit's
      // own; it is never what gets written to.
      supplied_state_dir: options["--state-dir"] ?? null,
      request_id: options["--request-id"] ?? null,
    },
  };
}

// Strict parse of `systemctl show -p Environment --value <unit>`: a whitespace
// separated list of NAME=VALUE, where systemd quotes a value that needs it.
// Returns the assignments in order, or null — and null means REFUSE, never
// "assume there was nothing there". Anything this parser is not certain of is
// unparseable by construction: a value it cannot read is exactly the case the
// STATE_DIR guard exists for.
export function parseUnitEnvironment(raw) {
  if (typeof raw !== "string") return null;
  const assignments = [];
  let i = 0;
  while (i < raw.length) {
    if (/\s/.test(raw[i])) { i += 1; continue; }
    const nameStart = i;
    while (i < raw.length && /[A-Za-z0-9_]/.test(raw[i])) i += 1;
    const name = raw.slice(nameStart, i);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
    if (raw[i] !== "=") return null;
    i += 1;
    let value = "";
    if (raw[i] === '"') {
      i += 1;
      let closed = false;
      while (i < raw.length) {
        if (raw[i] === "\\") {
          if (i + 1 >= raw.length) return null;
          value += raw[i + 1];
          i += 2;
          continue;
        }
        if (raw[i] === '"') { i += 1; closed = true; break; }
        value += raw[i];
        i += 1;
      }
      if (!closed) return null;
      if (i < raw.length && !/\s/.test(raw[i])) return null;
    } else {
      while (i < raw.length && !/\s/.test(raw[i])) {
        // An unquoted quote or backslash means systemd's own quoting rules were
        // not what we think they are. Refuse rather than guess a directory.
        if (raw[i] === '"' || raw[i] === "\\") return null;
        value += raw[i];
        i += 1;
      }
    }
    if (value.includes("\0")) return null;
    assignments.push([name, value]);
  }
  return assignments;
}

// The one read of the deployed unit. `{ ok: true, raw }` or `{ ok: false, reason }`
// — a command that did not run, did not exit 0, or produced nothing is a
// FAILURE TO MEASURE and never an empty environment.
export function readUnitEnvironment({ exec = spawnSync, unit = RECOVERY_UNIT } = {}) {
  const [command, ...args] = UNIT_ENVIRONMENT_COMMAND;
  const argv = unit === RECOVERY_UNIT ? args : [...args.slice(0, -1), unit];
  let result;
  try {
    result = exec(command, argv, { encoding: "utf8" });
  } catch (error) {
    return { ok: false, reason: `\`${command} ${argv.join(" ")}\` could not be run: ${error?.code ?? error?.message ?? "unknown"}` };
  }
  if (!result || typeof result !== "object") return { ok: false, reason: `\`${command} ${argv.join(" ")}\` returned no result` };
  if (result.error) return { ok: false, reason: `\`${command} ${argv.join(" ")}\` could not be run: ${result.error?.code ?? result.error?.message ?? "unknown"}` };
  if (result.status !== 0) return { ok: false, reason: `\`${command} ${argv.join(" ")}\` exited ${result.status ?? "on a signal"}` };
  if (typeof result.stdout !== "string") return { ok: false, reason: `\`${command} ${argv.join(" ")}\` produced no output` };
  return { ok: true, raw: result.stdout };
}

// The deployed directory, or a named reason it is unknown. Exactly one
// assignment of the variable, an absolute already-normalised path, or refuse.
export function unitStateDir(raw) {
  const assignments = parseUnitEnvironment(raw);
  if (assignments === null) {
    return { ok: false, reason: `the unit's Environment= block could not be parsed, so ${WORKSPACE_STATE_DIR_VARIABLE} is unknown` };
  }
  const values = assignments.filter(([name]) => name === WORKSPACE_STATE_DIR_VARIABLE).map(([, value]) => value);
  if (values.length === 0) {
    return { ok: false, reason: `the unit declares no ${WORKSPACE_STATE_DIR_VARIABLE}` };
  }
  if (values.length > 1) {
    return { ok: false, reason: `the unit declares ${WORKSPACE_STATE_DIR_VARIABLE} ${values.length} times, so the request directory is ambiguous` };
  }
  const [value] = values;
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    return { ok: false, reason: `the unit's ${WORKSPACE_STATE_DIR_VARIABLE} is not an absolute normalised path` };
  }
  return { ok: true, stateDir: value };
}

// THE ONLY WRITE. Private by umask, created exclusively under a staging name,
// chmod'd to exactly 0600, then renamed into place — so the entry point can
// never open a half-written request, and a failure at any step removes the
// staging file instead of leaving residue behind.
export function writeRecoveryRequest({ stateDir, request, fsImpl = fs, umaskImpl = (mask) => process.umask(mask) }) {
  const where = recoveryPaths({ [WORKSPACE_STATE_DIR_VARIABLE]: stateDir });
  // recoveryPaths() is the READER's own join. If it declines the directory there
  // is no channel, and a request written on a guess of what it would have
  // returned is exactly the silent no-op this module exists to prevent.
  if (!where) {
    return requestRefusal("STATE_DIR_UNKNOWN",
      `${WORKSPACE_STATE_DIR_VARIABLE}=${JSON.stringify(String(stateDir))} is not a directory the service side resolves a request path from`);
  }
  const staging = `${where.request}${REQUEST_STAGING_SUFFIX}`;
  const body = `${JSON.stringify(request, [...RECOVERY_REQUEST_FIELDS])}\n`;

  const previousMask = umaskImpl(0o077);
  try {
    // "wx" is O_CREAT|O_EXCL: it never clobbers a staging file this invocation
    // did not create, and O_EXCL refuses to follow a symlink planted at that
    // name, so the request cannot be diverted out of the unit's state dir.
    fsImpl.writeFileSync(staging, body, { mode: 0o600, flag: "wx" });
  } catch (error) {
    umaskImpl(previousMask);
    return requestRefusal("REQUEST_NOT_WRITTEN",
      `the staging file ${staging} could not be created: ${error?.code ?? "unknown"}`);
  }
  umaskImpl(previousMask);

  try {
    fsImpl.chmodSync(staging, 0o600);
    fsImpl.renameSync(staging, where.request);
  } catch (error) {
    try { fsImpl.unlinkSync(staging); } catch { /* the staging file is this invocation's own */ }
    return requestRefusal("REQUEST_NOT_WRITTEN",
      `the request could not be placed at ${where.request}: ${error?.code ?? "unknown"}`);
  }
  return { ok: true, path: where.request, request };
}

// Obtain, reconcile, validate, and only then write. Returns the refusal or the
// success; it prints nothing and decides nothing about exit codes.
export function requestRecovery({ options, env = process.env, io = {} } = {}) {
  // 1. OBTAIN. Nothing has been created and nothing can be until this succeeds.
  const read = (io.unitEnvironment ?? readUnitEnvironment)({ exec: io.exec, unit: io.unit });
  if (!read.ok) return requestRefusal("STATE_DIR_UNKNOWN", read.reason);
  const resolved = unitStateDir(read.raw);
  if (!resolved.ok) return requestRefusal("STATE_DIR_UNKNOWN", resolved.reason);
  const stateDir = resolved.stateDir;

  // 2. RECONCILE. Every directory the operator brought to this invocation — the
  // flag and the ambient variable alike — must BE the unit's, or the request is
  // refused. Neither is ever written to; they exist here only to be checked.
  const supplied = [
    ["--state-dir", options.supplied_state_dir],
    [`${WORKSPACE_STATE_DIR_VARIABLE} in the environment`, env?.[WORKSPACE_STATE_DIR_VARIABLE] ?? null],
  ];
  for (const [origin, value] of supplied) {
    if (value === null || value === undefined) continue;
    if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== stateDir) {
      return requestRefusal("STATE_DIR_MISMATCH",
        `${origin} is ${JSON.stringify(String(value))}, but ${RECOVERY_UNIT} declares ${WORKSPACE_STATE_DIR_VARIABLE}=${stateDir};` +
        ` a request written anywhere but ${recoveryPaths({ [WORKSPACE_STATE_DIR_VARIABLE]: stateDir }).request} is silently ignored`);
    }
  }

  // 3. VALIDATE the identifiers, with the same validators the service side uses,
  // so a request this command creates cannot be one the service must refuse.
  if (typeof options.attempt_id !== "string" || !UUID_RE.test(options.attempt_id)) {
    return requestRefusal("ATTEMPT_INVALID", "--attempt must be the UUID of exactly one attempt");
  }
  if (!authorizationRefValid(options.authorization_ref)) {
    return requestRefusal("AUTHORIZATION_REF_INVALID", "--authorization-ref must be a card ref (SHU-<n>) or a seeded fixture contract ref");
  }
  const requestId = options.request_id ?? (io.requestId ?? randomUUID)();
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return requestRefusal("REQUEST_ID_INVALID", "--request-id must be a UUID, so the request can be recorded and a replay recognised");
  }

  // 4. WRITE, to the unit's own directory and nowhere else.
  return writeRecoveryRequest({
    stateDir,
    request: {
      request: RECOVERY_REQUEST_MARKER,
      operation: REQUESTED_OPERATION,
      request_id: requestId,
      attempt_id: options.attempt_id,
      authorization_ref: options.authorization_ref,
    },
    fsImpl: io.fsImpl,
    ...(io.umask ? { umaskImpl: io.umask } : {}),
  });
}

// The CLI. Exit 0 written, 2 bad usage, 3 refused by name (nothing created).
export function main(argv, env = process.env, io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));

  const parsed = parseRequestArgv(argv);
  if (!parsed.ok) {
    err(`RECOVERY_REQUEST_USAGE: ${parsed.reason}`);
    err(REQUEST_USAGE);
    return REQUEST_USAGE_EXIT;
  }

  const result = requestRecovery({ options: parsed.options, env, io });
  if (!result.ok) {
    err(requestRefusalLine(result));
    return REQUEST_REFUSED_EXIT;
  }
  // THE PATH, AND NOTHING ELSE. No identifiers beyond the file it created, and
  // never any part of the unit's environment.
  out(`${REQUEST_WRITTEN_PREFIX}${result.path}`);
  return 0;
}

// The operation table is stated on the service side; this assertion keeps the
// name this command can ask for inside it, at module load, with no I/O.
if (!RECOVERY_OPERATION_NAMES.includes(REQUESTED_OPERATION)) {
  throw new Error(`request-recovery names an operation the service cannot run: ${REQUESTED_OPERATION}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
