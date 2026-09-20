// Reviewed Phase-B composition. The CLI selects this boundary; it accepts no
// provider, callback, executable, URL or credential path from the operator.
import fs from 'node:fs';
import { measureBrokerRuntime } from './shu71-runtime.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sign, verify, createPublicKey } from 'node:crypto';
import { canonicalBytes, validateShu71Package } from '../shu71-activation-package.mjs';
import { createReseedAppendIo, verifyReseedCommit } from '../reseed-append-contract.mjs';
import { assertSupervisorLaunchEnvironment } from './units.mjs';
import { ACTIVATION_FILE } from './credential-delivery.mjs';
import { digest, activationError, reviewedCode, requireActivation as need, openActivationJournal, journalEffect, teardownActivation } from './shu71-journal.mjs';
const ROOT = '/srv/shu/state/shu71-evidence';
const REPO = 'BAWES-Universe/studenthub-platform';
const REMOTE = `https://github.com/${REPO}.git`;
const IDS = ['SHU-140', 'SHU-254'];
const SERVICES = ['shu-coordinator.timer', 'shu-coordinator.service', 'shu-supervisor.service'];
const GATES = SERVICES.filter(n => n.endsWith('.service')).map(n => `/etc/systemd/system/${n}.d/90-shu71.conf`);
const READBACK_CODES = ['DROPIN', 'ACTIVATION'].flatMap(kind =>
  ['MISSING', 'BYTES', 'CUSTODY', 'MODE', 'DIRECTORY', 'READ'].map(reason => `ACT_${kind}_READBACK_${reason}`));
export const installedModule = '/usr/local/lib/shu71/coordinator/service/shu71-production.mjs';
export const shu71Boundary = Object.freeze({ fs, uid: () => process.getuid(), now: () => Date.now(),
  run: (file, args, options) => spawnSync(file, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', ...options }),
  // invocationId is a MEASUREMENT PORT, not a reviewed effect: systemd mints a
  // fresh InvocationID every time a unit starts and exports that start's own id
  // to its own processes as INVOCATION_ID, so reading it changes nothing on the
  // host. It is absent outside systemd, which is exactly an operator CLI run.
  fetch: (...args) => fetch(...args), sign: (bytes, key) => sign(null, bytes, key), invocationId: () => process.env.INVOCATION_ID });

// A HALT SAYS ITS OWN NAME. The catch that builds a halt record used to consult
// a hand-maintained allow-list of codes it was permitted to report, and every
// refusal the list had not been taught - SHU251_ENV_SUPERVISOR,
// SHU251_ENV_COORDINATOR, ACT_CREDENTIAL_UNAVAILABLE, every SHU71_RESEED_*, the
// whole journal family - was reported as the generic ACT_PRODUCTION_FAILED, so
// an operator could not read what had refused. The reviewed SHAPE decides now
// (shu71-journal.mjs, REFUSAL_CODE_PATTERN), so a newly named refusal is
// preserved by construction, and anything that is not a reviewed name - an
// error with no code, a non-string code, an errno, an AssertionError, arbitrary
// text - is still ACT_PRODUCTION_FAILED exactly as today.
export const haltCode = code => reviewedCode(code) ?? 'ACT_PRODUCTION_FAILED';

// A FAILED MEASUREMENT IS NOT A STATE CLAIM. measuredPredicate() maps a
// predicate that THREW to false, and every teardown site then raised the
// refusal the caller named - "a live companion survives this removal", "the
// mechanism is still installed as drift" - for a `systemctl show` that simply
// never answered. Those names are claims about the host that the code did not
// measure, and on the unattended path this family is evaluated roughly ten
// reads at a time, once a second, so one D-Bus hiccup was both a false refusal
// and a false accusation. A throw is now its own refusal, carrying the failing
// command; the site is exactly as fail-closed as it was - the value is never
// true, every refusal that fired still fires - and it never claims a state it
// did not read again.
export const measurementFailure = error => Object.assign(activationError('ACT_TEARDOWN_MEASUREMENT'),
  error?.command !== undefined ? { command: error.command } : {});
// No exception may bypass a check. A predicate evaluated as an argument of
// need() skips its own refusal when it throws, and the bare error is reported
// in place of the named one. Evaluate it into a value inside its own try/catch
// first: anything but a measured true is the refusal the caller named, and a
// throw is the named MEASUREMENT refusal rather than the caller's state claim.
export const measuredPredicate = predicate => { try { return predicate() === true; } catch (error) { throw measurementFailure(error); } };

// WHICH TERM OF A CONJUNCTION DISAGREED. A multi-leg binding check refused
// under one code with no way to tell a stale local ref from a moved remote from
// a GitHub answer that had not caught up. Each leg is named and evaluated IN
// ORDER, stopping at the first that is not a measured true - so the
// short-circuit, the number of commands and API calls a failing check makes,
// the code it raises and its conditions are all byte-unchanged, and the refusal
// gains the leg's NAME. The name is a reviewed literal from this module, held
// to a closed pattern here as well so nothing else can ever be reported as one;
// a leg's observed VALUE is never reported.
const BINDING_LEG_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export function requireLegs(legs, code) {
  for (const [leg, term] of legs) {
    if ((typeof term === 'function' ? term() : term) === true) continue;
    throw Object.assign(activationError(code), typeof leg === 'string' && BINDING_LEG_PATTERN.test(leg) ? { leg } : {});
  }
}
export const bindingLegRecord = error => typeof error?.leg === 'string' && BINDING_LEG_PATTERN.test(error.leg) ? { binding_leg: error.leg } : {};

// THE POST-PUSH READ-BACK RACE. `remote-push` pushes the reseed commit and then
// immediately READS the result back: `git/ref/heads/<branch>`, `git/ref/heads/main`
// and `compare/<old>...<next>`. GitHub answers those routes from replicas and does
// not compute a comparison for a just-written SHA instantly, so a landed push can
// be answered 404/5xx for a moment. A single transient answer failed the whole
// arming even though the push had succeeded and every required condition held -
// measured on the target host, where the ref, the ancestry and the token were all
// afterwards exactly what the step demands. These READ-ONLY GETs are therefore
// retried under this fixed policy, and NOTHING ELSE IS: the push, the Linear
// issueUpdate, signing, the activation write, the gate drop-ins, every systemctl
// action and every teardown step still fail on their first error.
//
// The bound is fixed and small: five attempts, backing off 1s, 2s, 4s, 8s, so one
// read waits at most 15s of sleep on top of its own five 10s request timeouts, and
// a per-invocation budget caps the TOTAL sleep this mechanism may add to a window
// however many reads race. Retrying also stops at the authorization expiry, so no
// retry can carry work past the window it was approved for.
export const READ_RETRY = Object.freeze({ attempts: 5, delaysMs: Object.freeze([1000, 2000, 4000, 8000]), budgetMs: 60000 });
// TRANSIENT ANSWERS ONLY. 404 is the post-push race itself (a ref or comparison
// the remote has not published yet); 408/425/429 and 5xx are the server asking to
// be asked again. A definitive refusal - 400, 401, 403, 410, 422 - is the answer
// rather than a race and is never retried, so a revoked token or a forbidden route
// still refuses immediately and is never retried into a later acceptance.
export const RETRYABLE_READ_STATUS = Object.freeze([404, 408, 409, 425, 429, 500, 502, 503, 504]);
export const API_REASONS = Object.freeze(['transport', 'response_not_ok', 'response_too_large', 'graphql_errors']);
// Closed vocabularies. An operation label is a route or a reviewed GraphQL
// operation name; a code is a GraphQL error code or a transport fault NAME.
// `%` is admitted because a branch segment is percent-encoded into its route
// (`git/ref/heads/coordinator%2FSHU-140`); no separator, space, quote or
// credential character is.
const API_OPERATION_PATTERN = /^[A-Za-z0-9:/%._-]{1,120}$/;
const API_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
// WHAT A FAILED CALL IS ALLOWED TO SAY ABOUT ITSELF. The halt record carried
// neither the route nor the status, so a real halt could not be attributed to a
// call at all. This reports the route (or reviewed operation name), the HTTP
// status, the transport fault name, the GraphQL error CODES and the attempt count
// - and nothing else. No token, header, URL, query, variable, response body or
// response text can reach it: every field is re-derived through a closed pattern
// or a numeric range here, and anything unrecognised is dropped. Idempotent on its
// own output, so re-sanitizing a detail that has already been through it is safe.
export function apiFailureDetail(detail = {}) {
  const record = {};
  record.operation = typeof detail.operation === 'string' && API_OPERATION_PATTERN.test(detail.operation) ? detail.operation : 'unknown';
  if (API_REASONS.includes(detail.reason)) record.reason = detail.reason;
  if (Number.isSafeInteger(detail.status) && detail.status >= 100 && detail.status <= 599) record.status = detail.status;
  if (typeof detail.fault === 'string' && API_CODE_PATTERN.test(detail.fault)) record.fault = detail.fault;
  const codes = (Array.isArray(detail.codes) ? detail.codes : []).filter(code => typeof code === 'string' && API_CODE_PATTERN.test(code));
  if (codes.length) record.codes = [...new Set(codes)].slice(0, 8);
  if (Number.isSafeInteger(detail.attempts) && detail.attempts > 0) record.attempts = detail.attempts;
  return record;
}
// GraphQL reports its refusals inside a 200. Only the CODES are named.
export const graphqlErrorCodes = errors => (Array.isArray(errors) ? errors : [])
  .flatMap(error => [error?.extensions?.code, error?.extensions?.type, error?.code]).filter(code => typeof code === 'string');
export const apiFailureRecord = error => {
  const detail = error?.api;
  return detail !== null && typeof detail === 'object' && !Array.isArray(detail) ? { api_failure: apiFailureDetail(detail) } : {};
};
// A RETRYABLE OUTCOME IS A MEASURED ONE. Only a transport/timeout fault or a
// transient HTTP status qualifies; a refusal that carries no measured API detail
// - including every non-API refusal - is not retryable at all.
// THE HOST-COMMAND READ POLICY, and it is deliberately not the API one. Every
// host process this module runs - `systemctl show`, `id`, and `git ls-remote`
// under setpriv - was final on its first failure, so a D-Bus hiccup, an EAGAIN
// under fork pressure or a socket reset on the remote's git front end aborted a
// whole arming or a whole teardown. Three attempts and 100/200 ms is the whole
// of it: these are local or near-local reads, not a post-push replica race, and
// a per-invocation sleep budget caps the TOTAL this mechanism may add however
// many reads fail.
//
// IT IS NOT GATED ON THE AUTHORIZATION EXPIRY, and that is deliberate: the
// teardown these reads serve runs precisely BECAUSE the window expired, so an
// expiry gate would switch the mechanism off exactly where it is needed. The
// bound is absolute instead - at most 300 ms per read and 2 s per invocation -
// rather than relative to a window.
export const COMMAND_RETRY = Object.freeze({ attempts: 3, delaysMs: Object.freeze([100, 200]), budgetMs: 2000 });
// THE ONLY RETRIED HOST COMMANDS, ENUMERATED RATHER THAN PATTERNED, so that no
// mutation can fall inside by accident. `systemctl show` reads one unit
// property, `id` reads an account, and `git ls-remote` reads the remote's refs;
// all three write nothing and repeating one can repeat only a read.
// daemon-reload, start, restart, stop, kill, enable and disable are absent, and
// so is every git verb that writes - push, update-ref - and every git verb that
// is not ls-remote. The COMMAND is retried, never the comparison made on its
// output: a command that succeeds and answers the wrong value still refuses on
// that first answer.
export const readOnlyCommand = (exe, argv) => {
  const args = Array.isArray(argv) ? argv : [];
  if (exe === '/usr/bin/systemctl') return args[0] === 'show';
  if (exe === '/usr/bin/id') return true;
  // git runs as the checkout identity under setpriv; its verb is the element
  // after `-C <checkout>`, which is how the argv is built at the one call site.
  if (exe === '/usr/bin/setpriv' && args.includes('/usr/bin/git')) {
    const at = args.indexOf('-C');
    return at >= 0 && args[at + 2] === 'ls-remote';
  }
  return false;
};
// WHAT A FAILED HOST COMMAND IS ALLOWED TO SAY ABOUT ITSELF. ACT_COMMAND_FAILED
// named no executable, no argument, no exit status and no signal, so a halt
// could not be attributed to a command at all - which of the three `ls-remote`
// sites, which systemctl verb, which unit. This reports the executable, the
// argv, the exit status, the terminating signal and the spawn fault's NAME, and
// nothing else.
//
// argv IS SAFE AND env IS NOT. git(..., { remote: true }) puts the GitHub token
// into the CHILD'S ENVIRONMENT as GIT_CONFIG_VALUE_0; the env object is never
// read here. stderr is not reported either: it is not guaranteed to be free of
// a header a credential helper or a transport error echoed. Every argv element
// must be a bare command token - letters, digits and the punctuation a path, a
// ref, a unit name, a flag or a `--force-with-lease=<ref>:<sha>` is made of -
// and anything else, including the `node -e` probe source, is reported as
// `unreportable` in its own position rather than echoed. Idempotent on its own
// output.
const COMMAND_EXECUTABLE_PATTERN = /^\/[A-Za-z0-9_./-]{1,120}$/;
const COMMAND_ARGUMENT_PATTERN = /^[A-Za-z0-9_@%:=+,./-]{1,120}$/;
export function commandFailureDetail(detail = {}) {
  const record = {};
  record.exe = typeof detail.exe === 'string' && COMMAND_EXECUTABLE_PATTERN.test(detail.exe) ? detail.exe : 'unknown';
  const argv = (Array.isArray(detail.argv) ? detail.argv : []).slice(0, 16)
    .map(value => typeof value === 'string' && COMMAND_ARGUMENT_PATTERN.test(value) ? value : 'unreportable');
  if (argv.length) record.argv = argv;
  if (Number.isSafeInteger(detail.status) && detail.status >= 0 && detail.status <= 255) record.status = detail.status;
  if (typeof detail.signal === 'string' && API_CODE_PATTERN.test(detail.signal)) record.signal = detail.signal;
  if (typeof detail.fault === 'string' && API_CODE_PATTERN.test(detail.fault)) record.fault = detail.fault;
  if (Number.isSafeInteger(detail.attempts) && detail.attempts > 0) record.attempts = detail.attempts;
  return record;
}
export const commandFailureRecord = error => {
  const detail = error?.command;
  return detail !== null && typeof detail === 'object' && !Array.isArray(detail) ? { command_failure: commandFailureDetail(detail) } : {};
};

export const retryableApiFailure = error => {
  const detail = error?.api;
  if (detail === null || typeof detail !== 'object') return false;
  if (detail.reason === 'transport') return true;
  return detail.reason === 'response_not_ok' && RETRYABLE_READ_STATUS.includes(detail.status);
};

// A fixture card is MEASURED off Linear as { state_id, assignee_id }, while the
// approved artifact is canonicalized - keys SORTED - before the owner signs it,
// so the identical card deserializes as { assignee_id, state_id }. Serialization
// equality compares the rendering, not the card, so on a real host it can never
// match and the window cannot arm at all. Compare the named FIELDS. Both sides
// are already closed to exactly these two keys (issue() constructs them;
// validateShu71Package's exactObject holds the artifact to them), and that
// closure is required here too so nothing but key ORDER is newly accepted.
export const FIXTURE_CARD_FIELDS = Object.freeze(['assignee_id', 'state_id']);
export const sameFixtureCard = (a, b) => [a, b].every(card => card !== null && typeof card === 'object' && !Array.isArray(card)
  && Object.keys(card).length === FIXTURE_CARD_FIELDS.length && FIXTURE_CARD_FIELDS.every(field => Object.hasOwn(card, field)))
  && FIXTURE_CARD_FIELDS.every(field => a[field] === b[field]);

export function createShu71Production(id, b = shu71Boundary) {
  need(/^[A-Za-z0-9_-]{8,64}$/.test(id) && id !== 'shu71abproof0007', 'ACT_ID_OR_EXPIRY_INVALID');
  need(b.uid() === 0, 'ACT_PROCESS_IDENTITY');
  const f = b.fs, C = f.constants, dir = `${ROOT}/${id}`;
  const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
  // Per-invocation host-command retry state, kept beside the command wrapper it
  // bounds. The budget is the TOTAL sleep this mechanism may add to one
  // invocation however many reads fail, so the bound holds across calls and not
  // merely within one.
  let commandRetryBudgetMs = COMMAND_RETRY.budgetMs;
  const commandRetries = [];
  const recordCommandRetry = (exe, argv, attempts) => {
    if (commandRetries.length < 16) commandRetries.push(commandFailureDetail({ exe, argv, attempts }));
  };
  const commandRetryRecord = () => commandRetries.length ? { command_read_retries: [...commandRetries] } : {};
  // A synchronous backoff, because every one of these reads is synchronous.
  // Atomics.wait parks the thread for the requested time rather than spinning.
  const commandWait = ms => (b.commandWait ?? (delay => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); }))(ms);
  // Name the failing command on the error the caller already raises. error.code
  // is never touched here, so the refusal keeps its existing name and
  // conditions and only gains the measured detail commandFailureDetail permits.
  const describeCommandFailure = (error, detail) => {
    try { error.command = commandFailureDetail({ ...error.command, ...detail }); } catch { /* evidence is best-effort, never a new refusal */ }
    return error;
  };
  // ONE MEASURED ATTEMPT. A boundary that THROWS is not a measured command
  // outcome and propagates exactly as it does today, unretried and undescribed;
  // only a command that ran and answered badly raises ACT_COMMAND_FAILED, under
  // the same name and the same condition as before, now carrying what ran.
  const runCommand = (exe, args, options) => {
    const r = b.run(exe, args, { env, ...options });
    try { need(!r.error && r.status === 0, 'ACT_COMMAND_FAILED'); }
    catch (error) {
      throw describeCommandFailure(error, { exe, argv: args, status: r.status,
        signal: r.signal, fault: r.error?.code ?? r.error?.name });
    }
    return String(r.stdout ?? '');
  };
  const command = (exe, args, options = {}) => {
    // THE RETRIED DOOR FOR HOST PROCESSES, and it opens onto READS ONLY.
    // Everything that is not in readOnlyCommand's enumerated set - every
    // systemctl verb but `show`, every git verb but `ls-remote`, the node
    // access probe, and the push - takes the branch above and is attempted
    // exactly once, exactly as today. What is retried is the CALL; the value it
    // returns is handed back unchanged, so a command that succeeds and answers
    // a wrong sha, a wrong ActiveState or a wrong account still refuses on that
    // first answer and no budget can convert it into a pass. When the attempts,
    // the budget or a non-command failure ends the loop the ORIGINAL error is
    // rethrown, so a persistent failure still refuses under ACT_COMMAND_FAILED.
    if (!readOnlyCommand(exe, args)) return runCommand(exe, args, options);
    for (let attempt = 1; ; attempt++) {
      try {
        const value = runCommand(exe, args, options);
        if (attempt > 1) recordCommandRetry(exe, args, attempt);
        return value;
      } catch (error) {
        const delay = COMMAND_RETRY.delaysMs[attempt - 1];
        if (error?.code !== 'ACT_COMMAND_FAILED') throw error;
        if (attempt >= COMMAND_RETRY.attempts || delay === undefined || delay > commandRetryBudgetMs) {
          if (attempt > 1) recordCommandRetry(exe, args, attempt);
          throw describeCommandFailure(error, { attempts: attempt });
        }
        commandRetryBudgetMs -= delay;
        commandWait(delay);
      }
    }
  };
  function coordinatorIdentity() {
    // These are OS system accounts, resolved by name from the host databases.
    const users = f.readFileSync('/etc/passwd', 'utf8').trim().split('\n').map(line => line.split(':'));
    const groups = f.readFileSync('/etc/group', 'utf8').trim().split('\n').map(line => line.split(':'));
    const us = users.filter(row => row[0] === 'shu-coordinator'), gs = groups.filter(row => row[0] === 'shu-coordinator');
    need(us.length === 1 && gs.length === 1, 'ACT_FILE_CUSTODY');
    const uid = Number(us[0][2]), gid = Number(gs[0][2]);
    need(Number.isSafeInteger(uid) && uid > 0 && gid > 0 && Number.isSafeInteger(gid) && Number(us[0][3]) === gid
      && !users.some(row => row[0] !== 'shu-coordinator' && Number(row[2]) === uid)
      && !groups.some(row => row[0] !== 'shu-coordinator' && Number(row[2]) === gid), 'ACT_FILE_CUSTODY');
    const shared = groups.filter(row => row[0] === 'shu-workspace');
    need(shared.length === 1 && shared[0][3].split(',').includes('shu-coordinator'), 'ACT_FILE_CUSTODY');
    return { uid, gid };
  }
  function privateRead(file, uid = 0, exactMode = null, gid = 0) {
    const fd = f.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const s = f.fstatSync(fd);
      need(s.isFile() && s.nlink === 1 && s.uid === uid && !(s.mode & 0o077) && s.size <= 4 * 1024 * 1024
        && (exactMode === null || s.gid === gid && (s.mode & 0o777) === exactMode), 'ACT_FILE_CUSTODY');
      return f.readFileSync(fd, 'utf8');
    } finally { f.closeSync(fd); }
  }
  function directory(target, mode = 0o700) {
    try { f.mkdirSync(target, { mode }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const s = f.lstatSync(target);
    need(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && !(s.mode & 0o022), 'ACT_FILE_CUSTODY');
  }
  function atomic(file, value, uid = 0, gid = 0, mode = 0o600) {
    const parent = path.dirname(file), name = `${file}.pending`;
    const parentStat = f.lstatSync(parent);
    const owner = parent === '/srv/shu/state' ? coordinatorIdentity() : { uid: 0, gid: 0 };
    need(parentStat.isDirectory() && !parentStat.isSymbolicLink() && parentStat.uid === owner.uid
      && (parent !== '/srv/shu/state' || parentStat.gid === owner.gid && (parentStat.mode & 0o7777) === 0o700)
      && !(parentStat.mode & 0o022), 'ACT_FILE_CUSTODY');
    try { f.unlinkSync(name); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const fd = f.openSync(name, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
    try { f.writeFileSync(fd, value); f.fchownSync(fd, uid, gid); f.fchmodSync(fd, mode); f.fsyncSync(fd); }
    finally { f.closeSync(fd); }
    f.renameSync(name, file);
    const parentFd = f.openSync(parent, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try { f.fsyncSync(parentFd); } finally { f.closeSync(parentFd); }
  }
  // Phase-bound read-back compares raw bytes, including the activation signature.
  // Open without following links and measure/read the same descriptor.
  function installedReadback(file, value, gid, mode, kind) {
    const code = reason => `ACT_${kind}_READBACK_${reason}`;
    let fd;
    try {
      if (kind === 'DROPIN') {
        const parent = f.lstatSync(path.dirname(file));
        need(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && parent.gid === 0
          && (parent.mode & 0o7777) === 0o755, code('DIRECTORY'));
      }
      const entry = f.lstatSync(file);
      need(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1, code('CUSTODY'));
      fd = f.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      const stat = f.fstatSync(fd);
      need(stat.isFile() && stat.nlink === 1 && stat.uid === 0 && stat.gid === gid, code('CUSTODY'));
      need((stat.mode & 0o7777) === mode, code('MODE'));
      const expected = Buffer.from(value);
      need(stat.size === expected.length && f.readFileSync(fd).equals(expected), code('BYTES'));
      if (kind === 'ACTIVATION') command('/usr/bin/setpriv', ['--reuid=shu-coordinator', '--regid=shu-coordinator', '--init-groups',
        '/usr/bin/node', '--input-type=module', '-e', `import fs from 'node:fs'; fs.accessSync(${JSON.stringify(file)}, fs.constants.R_OK);`]);
    } catch (error) {
      if (READBACK_CODES.includes(error.code)) throw error;
      need(false, code(error.code === 'ENOENT' ? 'MISSING' : 'READ'));
    } finally { if (fd !== undefined) f.closeSync(fd); }
  }
  const remove = file => {
    try { f.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const fd = f.openSync(path.dirname(file), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    try { f.fsyncSync(fd); } finally { f.closeSync(fd); }
  };
  // ONE CREDENTIAL RESOLUTION PER INVOCATION. This re-read
  // /srv/shu/coordinator.env - and /etc/passwd and /etc/group with it - on
  // EVERY API call and EVERY remote git call, so a single arming opened the
  // credential store a dozen times, and a rotation between two calls of the
  // same step authenticated the two halves of one run with two different
  // tokens. It is resolved at most once and reused now. It stays LAZY: an
  // action that needs no credential - a teardown on a host where the file was
  // already removed - still never reads it, so no path that succeeds today
  // starts refusing. The refusal, its two conditions and its key-names-only
  // evidence are unchanged.
  let resolvedCredentials = null;
  const credentials = () => (resolvedCredentials ??= readCredentials());
  function readCredentials() {
    const raw = privateRead('/srv/shu/coordinator.env', coordinatorIdentity().uid), result = {};
    for (const key of ['GITHUB_TOKEN', 'LINEAR_API_TOKEN']) {
      const matches = raw.split('\n').filter(line => line.startsWith(`${key}=`));
      need(matches.length === 1, 'ACT_CREDENTIAL_UNAVAILABLE');
      const value = matches[0].slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
      need(value.length > 0 && !/[\s\\$\x00-\x1f]/.test(value), 'ACT_CREDENTIAL_UNAVAILABLE');
      result[key] = value;
    }
    return result;
  }
  // Per-invocation retry state. The budget is the TOTAL sleep this mechanism may
  // add to one window however many reads race, so the bound holds across calls and
  // not merely within one. `authorizationEnds` is the approved expiry, set once the
  // owner-approved spec is in hand; while it is unset nothing is retried at all.
  let readRetryBudgetMs = READ_RETRY.budgetMs;
  let authorizationEnds = -Infinity;
  const readWait = ms => (b.readWait ?? (delay => new Promise(resolve => setTimeout(resolve, delay))))(ms);
  // A read that RACED and then succeeded leaves evidence of the race; a read that
  // never retried leaves none, so an unraced window's record is byte-identical to
  // today's. Bounded in length like every other reported detail.
  const readRetries = [];
  const recordReadRetry = (operation, attempts) => {
    if (readRetries.length < 16) readRetries.push(apiFailureDetail({ operation, attempts }));
  };
  const readRetryRecord = () => readRetries.length ? { api_read_retries: [...readRetries] } : {};
  // Name the failed call on the error the caller already raises. error.code is
  // never touched here, so every refusal keeps its existing name and conditions
  // and only gains the measured detail apiFailureDetail() permits.
  const describeApiFailure = (error, detail) => {
    try { error.api = apiFailureDetail({ ...error.api, ...detail }); } catch { /* evidence is best-effort, never a new refusal */ }
    return error;
  };
  async function api(url, options = {}, operation = 'unknown') {
    let result;
    try { result = await b.fetch(url, { ...options, signal: AbortSignal.timeout(10000) }); }
    catch (error) { throw describeApiFailure(error, { operation, reason: 'transport', fault: error?.name }); }
    try { need(result.ok, 'ACT_API_FAILED'); }
    catch (error) { throw describeApiFailure(error, { operation, reason: 'response_not_ok', status: result.status }); }
    const text = await result.text();
    try { need(Buffer.byteLength(text) <= 1024 * 1024, 'ACT_API_FAILED'); }
    catch (error) { throw describeApiFailure(error, { operation, reason: 'response_too_large', status: result.status }); }
    return JSON.parse(text);
  }
  const github = route => api(`https://api.github.com/repos/${REPO}/${route}`, {
    headers: { Authorization: `Bearer ${credentials().GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
  }, `github:${route}`);
  // THE RETRIED DOOR FOR API CALLS, and it opens onto READS ONLY. It is stated
  // once and reached through exactly two named wrappers - githubRead() and
  // linearRead() - and each of those is responsible for proving that what it
  // passes here is a read. github() sets no method, so every call it makes is a
  // GET that reads remote state and changes nothing; linearRead() requires the
  // reviewed operation name to begin `query:`, so the issueUpdate mutation
  // cannot reach this loop even if a later edit routed it here by mistake.
  //
  // IT RETRIES THE CALL, NEVER A COMPARISON. Any 2xx answer is returned to the
  // caller unchanged - including one carrying the WRONG sha, a compare status
  // that is not 'ahead', or a fixture card that is not the approved one - so a
  // genuine state mismatch still refuses on the first answer under
  // ACT_REF_BINDING / ACT_REVISION_BINDING / ACT_REMOTE_ANCESTRY /
  // ACT_WRONG_FIXTURE / ACT_PRIOR_STATE_DRIFT and the budget cannot convert it
  // into a pass. When the budget, the attempt count, the expiry or a definitive
  // status ends the loop, the ORIGINAL error is rethrown, so a persistent
  // failure still refuses under the same name as today.
  async function retriedRead(operation, call) {
    for (let attempt = 1; ; attempt++) {
      try {
        const value = await call();
        if (attempt > 1) recordReadRetry(operation, attempt);
        return value;
      } catch (error) {
        const delay = READ_RETRY.delaysMs[attempt - 1];
        if (attempt >= READ_RETRY.attempts || delay === undefined || !retryableApiFailure(error)
          || delay > readRetryBudgetMs || !(b.now() < authorizationEnds)) {
          if (attempt > 1) recordReadRetry(operation, attempt);
          throw describeApiFailure(error, { attempts: attempt });
        }
        readRetryBudgetMs -= delay;
        await readWait(delay);
      }
    }
  }
  const githubRead = route => retriedRead(`github:${route}`, () => github(route));
  const linearOperation = query => /^\s*(query|mutation)\s+([A-Za-z0-9_]+)/.exec(query)?.slice(1).join(':') ?? 'unknown';
  async function linear(query, variables) {
    const operation = `linear:${linearOperation(query)}`;
    const result = await api('https://api.linear.app/graphql', { method: 'POST',
      headers: { Authorization: credentials().LINEAR_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) }, operation);
    try { need(!result.errors && result.data, 'ACT_API_FAILED'); }
    catch (error) { throw describeApiFailure(error, { operation, reason: 'graphql_errors', codes: graphqlErrorCodes(result.errors) }); }
    return result.data;
  }
  // THE LINEAR READ DOOR. The fixture card is read at least four times per
  // arming - once per fixture at `binding`, twice inside each transition, once
  // per `ready-<id>` step - and each of those was a POST carrying a GraphQL
  // QUERY with no retry at all, so a single Linear 429, 5xx or socket timeout
  // aborted the whole arming under a bare ACT_API_FAILED. The query is a read:
  // it names one issue and asks for four fields. The guard below is the proof
  // that only a read reaches the retried loop, stated as a refusal rather than
  // as a comment: the operation name is re-derived from the query TEXT by
  // linearOperation(), and a query text that does not begin `query <Name>`
  // refuses before any call is made. `mutation Shu71Fixture` therefore cannot
  // pass, and the issueUpdate below still fails on its first error.
  const linearRead = (query, variables) => {
    const operation = `linear:${linearOperation(query)}`;
    need(operation.startsWith('linear:query:'), 'ACT_API_FAILED');
    return retriedRead(operation, () => linear(query, variables));
  };
  async function issue(t) {
    const { issue: v } = await linearRead('query Shu71Fixture($id: String!) { issue(id: $id) { id identifier state { id } assignee { id } } }', { id: t.linear_id });
    need(v?.identifier === t.issue_id && v.id === t.linear_id && v.state?.id, 'ACT_WRONG_FIXTURE');
    return { state_id: v.state.id, assignee_id: v.assignee?.id ?? null };
  }
  async function transition(t, target, restoring = false) {
    const current = await issue(t);
    if (sameFixtureCard(current, target)) return;
    need(restoring || sameFixtureCard(current, t.before), 'ACT_PRIOR_STATE_DRIFT');
    const result = await linear('mutation Shu71Fixture($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
      { id: t.linear_id, input: { stateId: target.state_id, assigneeId: target.assignee_id } });
    // A WRITE WE JUST MADE, READ BACK. The update reported success and the very
    // next read could still answer the PRE-update card, because Linear answers
    // reads from replicas - so a landed transition halted the whole arming on
    // ACT_PARTIAL_ARMING over a card that was already correct. This RE-READS.
    // The mutation above is issued exactly once and is never re-issued: it is
    // not a compare-and-set, the drift guard two lines up has already been
    // consumed, and re-writing could overwrite a concurrent human transition.
    // The re-read is bounded by the same attempt count, the same backoff, the
    // same shared per-invocation sleep budget and the same authorization expiry
    // as every other retried read, and it ACCEPTS ONLY the target card: an
    // update that never landed, a card a concurrent transition moved somewhere
    // else, and a card that stayed at `before` all run the loop out and refuse
    // ACT_PARTIAL_ARMING under exactly the name and condition they refuse under
    // today, because the comparison is re-MADE rather than softened.
    need(result.issueUpdate?.success === true, 'ACT_PARTIAL_ARMING');
    let observed = await issue(t), attempts = 1;
    while (!sameFixtureCard(observed, target) && attempts < READ_RETRY.attempts) {
      const delay = READ_RETRY.delaysMs[attempts - 1];
      if (delay === undefined || delay > readRetryBudgetMs || !(b.now() < authorizationEnds)) break;
      readRetryBudgetMs -= delay;
      await readWait(delay);
      observed = await issue(t);
      attempts++;
    }
    if (attempts > 1) recordReadRetry(`linear:readback:${t.issue_id}`, attempts);
    need(sameFixtureCard(observed, target), 'ACT_PARTIAL_ARMING');
  }
  function git(spec, args, options = {}) {
    // Git runs as the checkout identity, never as root with a safe.directory bypass.
    coordinatorIdentity();
    const gitEnv = { ...env };
    if (options.remote) {
      gitEnv.GIT_CONFIG_COUNT = '1'; gitEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      gitEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${credentials().GITHUB_TOKEN}`).toString('base64')}`;
    }
    return Buffer.from(command('/usr/bin/setpriv', ['--reuid=shu-coordinator', '--regid=shu-coordinator', '--init-groups', '/usr/bin/git',
      '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-C', spec.checkout, ...args], { env: gitEnv, input: options.input }));
  }
  const gitText = (spec, args, options) => git(spec, args, options).toString().trim();
  function verifyInstallation(spec) {
    const entries = gitText(spec, ['ls-tree', '-r', '-z', '--full-tree', spec.pkg.coordinator_revision, '--', '.github/coordinator']).split('\0').filter(Boolean);
    let entrypoint = false;
    for (const row of entries) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(\.github\/coordinator\/[a-zA-Z0-9_./-]+)$/.exec(row);
      need(match && !match[3].split('/').includes('..'), 'ACT_CODE_BINDING');
      const relative = match[3].slice('.github/coordinator/'.length);
      if (relative.split('/').includes('test')) continue;
      const file = `/usr/local/lib/shu71/coordinator/${relative}`;
      if (file === installedModule) entrypoint = true;
      let parent = path.dirname(file);
      while (parent !== '/') {
        const st = f.lstatSync(parent);
        need(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && !(st.mode & 0o022), 'ACT_CODE_BINDING');
        parent = path.dirname(parent);
      }
      const fd = f.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const st = f.fstatSync(fd);
        need(st.isFile() && st.nlink === 1 && st.uid === 0 && !(st.mode & 0o022), 'ACT_CODE_BINDING');
        need(gitText(spec, ['hash-object', '--stdin'], { input: f.readFileSync(fd) }) === match[2], 'ACT_CODE_BINDING');
      } finally { f.closeSync(fd); }
    }
    need(entrypoint, 'ACT_CODE_BINDING');
  }
  async function heads(spec, seeded = false) {
    const result = {};
    for (const fixture of spec.pkg.fixtures) {
      const expected = fixture.issue_id === 'SHU-140' && !seeded ? spec.pkg.reseed.expected_parent : fixture.seed_head;
      const ref = `refs/heads/${fixture.branch}`;
      const local = gitText(spec, ['rev-parse', '--verify', ref]);
      const remote = gitText(spec, ['ls-remote', '--refs', REMOTE, ref], { remote: true });
      const readback = await githubRead(`git/ref/heads/${encodeURIComponent(fixture.branch)}`);
      // The same three terms, in the same order, refusing under the same code -
      // and the refusal now says WHICH of them disagreed. The three values are
      // measured above exactly as before, so no read is added or removed.
      requireLegs([['local', local === expected], ['remote', remote === `${expected}\t${ref}`],
        ['readback', readback.object?.sha === expected]], 'ACT_REF_BINDING');
      result[fixture.branch] = expected;
    }
    const revision = spec.pkg.coordinator_revision;
    // Each leg is a THUNK, so the short-circuit of the conjunction it replaces
    // is preserved byte for byte: a disagreeing HEAD still means `status
    // --porcelain` is never run, and a disagreeing local ls-remote still means
    // the GitHub read-back is never requested. Only the failing leg's NAME is
    // added; every command, its order and the refusal code are unchanged.
    requireLegs([
      ['head', () => gitText(spec, ['rev-parse', 'HEAD']) === revision],
      ['main', () => gitText(spec, ['rev-parse', 'refs/heads/main']) === revision],
      ['clean', () => gitText(spec, ['status', '--porcelain']) === ''],
      ['tree', () => gitText(spec, ['rev-parse', 'HEAD^{tree}']) === spec.tree],
    ], 'ACT_REVISION_BINDING');
    // Two statements rather than two thunks, because the second leg is awaited:
    // the GitHub read-back is reached only when the local ls-remote agreed,
    // which is exactly the short-circuit of the `&&` this replaces.
    requireLegs([['remote_main', gitText(spec, ['ls-remote', '--refs', REMOTE, 'refs/heads/main'], { remote: true }) === `${revision}\trefs/heads/main`]], 'ACT_REVISION_BINDING');
    requireLegs([['readback_main', (await githubRead('git/ref/heads/main')).object?.sha === revision]], 'ACT_REVISION_BINDING');
    return result;
  }
  function authority() {
    const doc = JSON.parse(privateRead(`/etc/shu/approvals/${id}.shu71.json`));
    const ownerKey = privateRead('/etc/shu/approvals/shu71-owner.pub');
    need(createPublicKey(ownerKey).asymmetricKeyType === 'ed25519' && verify(null, canonicalBytes(doc.payload, false), ownerKey, Buffer.from(doc.signature, 'base64')), 'ACT_OWNER_APPROVAL');
    const spec = doc.payload;
    need(Object.keys(spec).sort().join() === ['kind', 'checkout', 'tree', 'pkg', 'binding'].sort().join()
      && spec.pkg?.signature === '' && spec.pkg?.activation?.signature === '', 'ACT_OWNER_APPROVAL');
    // Reuse every existing structural/trust-anchor guard before key use. The
    // only expected refusal here is the intentionally absent package signature;
    // the complete signed validation remains mandatory after signing.
    const unsigned = validateShu71Package({ pkg: spec.pkg,
      anchor: JSON.parse(f.readFileSync(new URL('../shu71-trust-anchor.json', import.meta.url), 'utf8')),
      revision: spec.pkg.coordinator_revision, mainRevision: spec.pkg.coordinator_revision,
      phase: 'revocation', now: new Date(b.now()) });
    need(unsigned.code === 'ACT_FORGED_ENVELOPE', 'ACT_OWNER_APPROVAL');
    need(spec.kind === 'shu71-production-v1' && spec.pkg?.activation_id === id && /^\/[a-zA-Z0-9_/-]+$/.test(spec.checkout)
      && !spec.checkout.split('/').includes('..') && /^[a-f0-9]{40}$/.test(spec.tree)
      && spec.pkg.evidence.journal_path === `${dir}/journal.jsonl` && spec.pkg.evidence.archive_path === `${dir}/activation.json`, 'ACT_OWNER_APPROVAL');
    need(spec.binding?.approvedExecutionRevision === spec.pkg.coordinator_revision && spec.binding.branch === spec.pkg.reseed.branch
      && ['expected_parent', 'expected_seed_head', 'patch_sha256'].every(k => spec.binding[k] === spec.pkg.reseed[k]), 'ACT_OWNER_APPROVAL');
    return spec;
  }
  async function execute(action) {
    let spec, journal, recovered = false;
    // THE PRE-ARM REGION NAMES ITS OWN REFUSALS. Everything from the action
    // vocabulary to the journal open sat OUTSIDE the covering try below, so
    // every refusal it raises - ACT_COMMAND_INVALID, ACT_FILE_CUSTODY from the
    // episode directories, the five ACT_OWNER_APPROVAL guards inside
    // authority(), ACT_JOURNAL_CUSTODY / _TORN / _INVALID, and every raw errno
    // from privateRead and atomic - escaped to the CLI's outer catch and was
    // printed as one fixed string with no episode, no path and no code. Those
    // are precisely the refusals that say the operator's approval document, the
    // episode custody or the journal is wrong: the ones an operator most needs
    // to read, and the ones that left no evidence at all.
    //
    // This handler ADDS THE NAME AND NOTHING ELSE. It runs no effect and
    // attempts no teardown: nothing in this region has established custody of
    // anything a teardown could act on, the covering handler's own teardown
    // branch is unchanged, and a pre-custody failure must not order effects
    // against an episode it never took custody of. Every refusal's condition,
    // its code and its ordering are byte-unchanged; a parse failure is reported
    // as ACT_PRODUCTION_FAILED exactly as today, because a SyntaxError carries
    // no reviewed code and its message quotes the offending source text.
    try {
      need(['run', 'resume', 'revoke', 'expire'].includes(action), 'ACT_COMMAND_INVALID');
      directory(ROOT); directory(dir);
      for (const target of [ROOT, dir]) {
        const s = f.lstatSync(target);
        need(s.uid === 0 && s.gid === 0 && (s.mode & 0o7777) === 0o700, 'ACT_FILE_CUSTODY');
      }
      try { spec = JSON.parse(privateRead(`${dir}/custody.json`)); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!spec) {
        spec = authority();
        // Independent cleanup authority precedes the journal and every mutation.
        atomic(`${dir}/custody.json`, JSON.stringify(spec));
      }
      need(spec.pkg?.activation_id === id, 'ACT_OWNER_APPROVAL');
      // Read retries may never outlive the authorization they are serving.
      authorizationEnds = Date.parse(spec.pkg.expires_at);
      try {
        try { privateRead(`${dir}/recovery.jsonl`); recovered = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        journal = openActivationJournal(dir, f, recovered ? 'recovery.jsonl' : 'journal.jsonl', coordinatorIdentity());
      }
      catch {
        // Preserve a damaged log byte-for-byte. Custody is enough to revoke the
        // exact episode, but never to resume forward signing or activation.
        recovered = true;
        try { journal = openActivationJournal(dir, f, 'recovery.jsonl', coordinatorIdentity()); }
        catch { journal = { entries: [], append() { throw new Error('ACT_EVIDENCE_WRITE_FAILED'); }, close() {} }; }
      }
      journal.recovered = recovered;
    } catch (error) {
      try { journal?.close(); } catch { /* the refusal is the outcome */ }
      return { ok: false, state: 'HALT', code: haltCode(error?.code),
        ...commandFailureRecord(error), ...apiFailureRecord(error), ...commandRetryRecord() };
    }
    const initial = journal.entries.find(e => e.event === 'APPROVED');
    try {
      if (!initial) journal.append({ event: 'APPROVED', spec });
      let active;
      try { active = JSON.parse(privateRead(`${ROOT}/active.json`)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (journal.entries.some(e => e.event === 'TEARDOWN_COMPLETE')) {
        // A successor owns the shared gates. This receipt is historical only.
        if (active && active.activation_id !== id) return { ok: true, state: 'REVOKED', activation_id: id, receipt_scope: 'retired_episode', physical_teardown_observed: false };
        try { observeTeardown(); observeRetiredExpiry(); }
        catch (error) { return { ok: false, state: 'HALT', code: error?.code === 'ACT_TEARDOWN_EXPIRY_SERVICE' ? error.code : 'ACT_TEARDOWN_DRIFT' }; }
        if (active) remove(`${ROOT}/active.json`);
        return { ok: true, state: 'REVOKED', activation_id: id, physical_teardown_observed: true };
      }
      if (active && active.activation_id !== id) return { ok: false, state: 'HALT', code: 'ACT_ACTIVATION_CONFLICT' };
      if (!active) atomic(`${ROOT}/active.json`, JSON.stringify({ activation_id: id }));
      if (recovered) {
        journal.recovered = true;
        return await cleanup(spec, journal, 'recovery', action === 'expire');
      }
      const expired = b.now() >= Date.parse(spec.pkg.expires_at);
      const teardownStarted = journal.entries.some(e => ['REVOKE_REQUESTED', 'AUTHORIZATION_EXPIRED', 'TEARDOWN_INCOMPLETE', 'TEARDOWN_COMPLETE'].includes(e.event));
      if (action === 'expire' && !expired && !teardownStarted) return { ok: true, state: 'NOT_EXPIRED' };
      if (action === 'revoke' || expired || teardownStarted || action === 'resume' && journal.entries.some(e => e.event === 'ARMED')) return await cleanup(spec, journal, expired ? 'expiry' : 'revoke', action === 'expire');
      journal.append({ event: 'RUN_ATTEMPT_STARTED' });
      need(b.now() >= Date.parse(spec.pkg.created_at) && !expired, 'ACT_ID_OR_EXPIRY_INVALID');
      // Lifecycle renders User/Group from spec.lifecycle.identity and verifies
      // the account's primary group. Resolve that installed identity, not uid=gid.
      const user = command('/usr/bin/systemctl', ['show', '--property=User', '--value', 'shu-supervisor.service']).trim();
      const group = command('/usr/bin/systemctl', ['show', '--property=Group', '--value', 'shu-supervisor.service']).trim();
      need(/^[a-z_][a-z0-9_-]*$/.test(user) && /^[a-z_][a-z0-9_-]*$/.test(group), 'ACT_FILE_CUSTODY');
      const uid = Number(command('/usr/bin/id', ['-u', user]).trim());
      const gid = Number(command('/usr/bin/id', ['-g', user]).trim());
      need(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0
        && command('/usr/bin/id', ['-gn', user]).trim() === group, 'ACT_FILE_CUSTODY');
      assertSupervisorLaunchEnvironment(privateRead('/etc/shu/supervisor.env', 0, 0o600), privateRead('/srv/shu/coordinator.env', uid, 0o600, gid));
      verifyInstallation(spec);
      const step = (name, fn, repeat = false) => journalEffect(journal, name, async () => {
        need(b.now() < Date.parse(spec.pkg.expires_at), 'ACT_ID_OR_EXPIRY_INVALID'); await fn();
      }, repeat);
      await step('binding', async () => {
        await heads(spec);
        for (const t of spec.pkg.issue_transitions) need(sameFixtureCard(await issue(t), t.before), 'ACT_PRIOR_STATE_DRIFT');
      });
      await step('sign', async () => {
        // If completion is ambiguous, never consume the key again. A durable
        // signed package is adoptable; otherwise fail into narrow teardown.
        let signed;
        try { signed = JSON.parse(privateRead(`${dir}/signed-package.json`)); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (!signed) {
          need(!journal.entries.some(e => e.event === 'SIGNING_STARTED'), 'ACT_SIGNING_AMBIGUOUS');
          journal.append({ event: 'SIGNING_STARTED' });
          const key = privateRead('/etc/shu/keys/shu71-activation-ed25519.pem');
          signed = structuredClone(spec.pkg);
          signed.activation.signature = b.sign(canonicalBytes(signed.activation), key).toString('base64');
          signed.signature = b.sign(canonicalBytes(signed), key).toString('base64');
          atomic(`${dir}/signed-package.json`, JSON.stringify(signed));
        }
        need(digest(canonicalBytes({ ...signed, activation: { ...signed.activation, signature: '' }, signature: '' }))
          === digest(canonicalBytes({ ...spec.pkg, activation: { ...spec.pkg.activation, signature: '' }, signature: '' })), 'ACT_OWNER_APPROVAL');
      });
      const pkg = JSON.parse(privateRead(`${dir}/signed-package.json`));
      // Validate every package guard before the first fixture/ref mutation.
      const checked = validateShu71Package({ pkg, anchor: JSON.parse(f.readFileSync(new URL('../shu71-trust-anchor.json', import.meta.url), 'utf8')),
        revision: pkg.coordinator_revision, mainRevision: pkg.coordinator_revision, now: new Date(b.now()),
        heads: Object.fromEntries(pkg.fixtures.map(v => [v.branch, v.issue_id === 'SHU-140' ? pkg.reseed.expected_parent : v.seed_head])),
        issues: pkg.fixtures.map(v => ({ issue_id: v.issue_id, linear_id: v.linear_id })) });
      // The validator already names WHICH of its guards refused -
      // ACT_STALE_SEED, ACT_TRUST_ANCHOR_INVALID, ACT_PACKAGE_MALFORMED - and
      // that name was discarded, so the halt said only "validation". Its own
      // reviewed CODE is carried through; its `detail` is free text authored
      // inside the validator and is not reported. The code, the condition and
      // the ordering of this refusal are unchanged.
      try { need(checked.ok, 'ACT_PACKAGE_VALIDATION'); }
      catch (error) { throw Object.assign(error, reviewedCode(checked.code) ? { package_code: checked.code } : {}); }
      await step('expiry-watch', () => installExpiry(spec));
      await step('local-reseed', async () => {
        const adapter = createReseedAppendIo({ git: (args, options) => git(spec, args, options), binding: spec.binding });
        const local = gitText(spec, ['rev-parse', `refs/heads/${pkg.reseed.branch}`]);
        if (local === pkg.reseed.expected_seed_head) adapter.observeReseed(pkg.reseed);
        else adapter.appendReseed(pkg.reseed);
      });
      await step('remote-push', async () => {
        const ref = `refs/heads/${pkg.reseed.branch}`, old = pkg.reseed.expected_parent, next = pkg.reseed.expected_seed_head;
        verifyReseedCommit({ git: (args, options) => git(spec, args, options), binding: spec.binding, oid: next });
        const observed = gitText(spec, ['ls-remote', '--refs', REMOTE, ref], { remote: true });
        if (observed !== `${next}\t${ref}`) {
          requireLegs([['lease', observed === `${old}\t${ref}`]], 'ACT_REF_BINDING');
          git(spec, ['merge-base', '--is-ancestor', old, next]);
          // THE PUSH IS A MUTATION AND IS NEVER RE-ISSUED. A push can LAND and
          // still report failure - a connection reset after the pack was
          // accepted, a spawn that hit the 30 s cap - and a re-push can never
          // succeed afterwards, because the lease is `=old` while the ref is
          // already `next`, so a retry here cannot converge by construction.
          // The recovery is therefore a RE-READ, and it accepts the step only
          // on the one value that means the mutation already happened. A ref
          // still at `old` means the push really did fail; a ref at any third
          // sha is someone else's write; both rethrow the ORIGINAL refusal,
          // ACT_COMMAND_FAILED, carrying the failing command. A read that
          // itself fails rethrows it too. Nothing here is accepted on trust
          // either: heads(spec, true) on the next line re-reads this same ref
          // from the remote AND from the GitHub API and requires it to equal
          // `next`, and the comparison below re-establishes the ancestry, so
          // every condition this recovery passes over is measured again
          // immediately afterwards before the step can complete.
          try { git(spec, ['push', '--porcelain', `--force-with-lease=${ref}:${old}`, REMOTE, `${next}:${ref}`], { remote: true }); }
          catch (error) {
            let after;
            try { after = gitText(spec, ['ls-remote', '--refs', REMOTE, ref], { remote: true }); }
            catch { throw error; }
            if (after !== `${next}\t${ref}`) throw error;
            // Recorded the same way every other read that raced is recorded,
            // and deliberately NOT as a new durable journal class: the reviewed
            // append inventory is closed, and the evidence a re-read adds
            // belongs with the other read-retry evidence rather than in a new
            // row shape of its own.
            recordReadRetry(`git:ls-remote:${pkg.reseed.branch}`, 2);
          }
        }
        await heads(spec, true);
        const comparison = await githubRead(`compare/${old}...${next}`);
        need(comparison.status === 'ahead' && comparison.merge_base_commit?.sha === old, 'ACT_REMOTE_ANCESTRY');
      });
      await step('evidence-broker', () => {
        atomic('/etc/systemd/system/shu71-evidence.service', renderEvidenceBroker(), 0, 0, 0o644);
        command('/usr/bin/systemctl', ['daemon-reload']);
        command('/usr/bin/systemctl', ['start', 'shu71-evidence.service']);
      });
      await step('broker-runtime', async () => {
        journal.append({ event: 'BROKER_RUNTIME_CHECK_STARTED' });
        // Type=simple can return from start before bind(). Retry absence only;
        // custody, mode, identity and measurement failures are immediate refusals.
        for (let attempt = 0; ; attempt++) {
          need(b.now() < Date.parse(spec.pkg.expires_at), 'ACT_ID_OR_EXPIRY_INVALID');
          try {
            const runtime = measureBrokerRuntime(b, env);
            journal.append({ event: 'BROKER_RUNTIME_MEASURED', ...runtime });
            atomic(`${dir}/broker-runtime.json`, JSON.stringify(runtime));
            break;
          } catch (e) {
            if (!['ACT_RUNTIME_DIRECTORY_MISSING', 'ACT_RUNTIME_SOCKET_MISSING'].includes(e.code) || attempt >= 19) throw e;
            await (b.runtimeWait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(50);
          }
        }
      }, true);
      for (const t of pkg.issue_transitions) await step(`ready-${t.issue_id}`, () => transition(t, t.ready));
      await step('activation', () => atomic(ACTIVATION_FILE, JSON.stringify(pkg.activation), 0, coordinatorIdentity().gid, 0o640));
      await step('activation-readback', () => installedReadback(ACTIVATION_FILE, JSON.stringify(pkg.activation), coordinatorIdentity().gid, 0o640, 'ACTIVATION'), true);
      await step('gate-install', () => {
        for (const file of GATES) { directory(path.dirname(file), 0o755); atomic(file, '[Service]\nEnvironment=ENABLE_DISPATCH=true\n', 0, 0, 0o644); }
      });
      await step('dropin-readback', () => {
        for (const file of GATES) installedReadback(file, '[Service]\nEnvironment=ENABLE_DISPATCH=true\n', 0, 0o644, 'DROPIN');
      }, /* remeasure on resume */ true);
      // ARMED IS A MEASURED CLAIM, NOT AN EXIT STATUS. A Type=simple unit's
      // start job is satisfied once the child has been forked and exec'd, so
      // `systemctl restart` exits 0 for a supervisor that dies a moment later,
      // and this step then appended ARMED and returned it - dispatch enabled
      // behind a supervisor that may not be running, which is the opposite of
      // a halt and costs more. The state the step claims is READ BACK from
      // systemd now, exactly as the broker step already reads back its socket,
      // and a supervisor that is not measurably active-and-running refuses by
      // its own name BEFORE the ARMED row is written. Nothing is retried here:
      // `restart` and `start` are mutations and are still issued exactly once
      // each. The two `show` reads that follow them are reads.
      //
      // The step also repeats. It was the only forward step whose effect a
      // resume could skip while still appending ARMED: `journalEffect` returns
      // early on a durable DONE row, so a process that died between this step
      // and the ARMED append resumed into an ARMED claim over gates written by
      // a process whose supervisor THIS invocation never restarted and never
      // measured. It is re-established and re-measured on every invocation now,
      // like activation-readback, dropin-readback and broker-runtime before it.
      await step('gate', () => {
        command('/usr/bin/systemctl', ['daemon-reload']);
        command('/usr/bin/systemctl', ['restart', 'shu-supervisor.service']);
        command('/usr/bin/systemctl', ['start', 'shu-coordinator.timer']);
        need(measuredPredicate(() => unitProperty('shu-supervisor.service', 'ActiveState') === 'active'
          && unitProperty('shu-supervisor.service', 'SubState') === 'running'), 'ACT_GATE_NOT_LIVE');
        need(measuredPredicate(() => unitProperty('shu-coordinator.timer', 'ActiveState') === 'active'), 'ACT_GATE_NOT_LIVE');
      }, /* re-establish and re-measure on resume */ true);
      journal.append({ event: 'ARMED', authorization_expires_at: pkg.expires_at, teardown_complete: false });
      return { ok: true, state: 'ARMED', activation_id: id, ...readRetryRecord(), ...commandRetryRecord() };
    } catch (error) {
      // A REFUSAL KEEPS ITS OWN NAME. This was a hand-maintained allow-list of
      // codes the halt was permitted to report, and every refusal reachable on
      // the arming path that the list had not been taught - SHU251_ENV_*,
      // ACT_CREDENTIAL_UNAVAILABLE, the twelve SHU71_RESEED_* names, the three
      // ACT_JOURNAL_* names - was reported as the generic ACT_PRODUCTION_FAILED,
      // so the operator read "production failed" for a missing GITHUB_TOKEN, a
      // torn journal or a seed that did not match its contract. haltCode()
      // admits a name by the reviewed SHAPE instead, so a newly named refusal
      // is preserved without editing this line; an error with no code, a
      // non-string code, an errno, an AssertionError or arbitrary text is still
      // ACT_PRODUCTION_FAILED exactly as before, and the shape itself is what
      // keeps the door closed - no token, header, URL or message text can be
      // spelled as one of three fixed prefixes followed by upper case.
      const code = haltCode(error?.code);
      // Name the documented configuration key the reviewed parser refused on.
      // Key names are public contract vocabulary; no value is ever reported.
      const named = typeof error?.key === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(error.key) ? { missing_key: error.key } : {};
      // WHICH call failed and WHAT happened. The halt this correction answers
      // reported ACT_API_FAILED with neither a route nor a status, so the failing
      // read could not be reconstructed from the evidence at all. The detail is
      // additive and sanitized by apiFailureDetail(); `code` is unchanged.
      // The same for the rest of the halt's evidence: WHICH host command failed
      // and with what status, WHICH leg of a multi-term binding check
      // disagreed, and WHICH of the package validator's own guards refused -
      // each re-derived through a closed pattern or a numeric range, each
      // carrying a name and never a value, and each absent from the record
      // entirely when the halt has nothing of that kind to report.
      const detail = { ...apiFailureRecord(error), ...commandFailureRecord(error), ...bindingLegRecord(error),
        ...(reviewedCode(error?.package_code) ? { package_code: error.package_code } : {}),
        ...readRetryRecord(), ...commandRetryRecord() };
      try { journal.append({ event: 'HALTED', code, ...named, ...detail }); } catch { /* safety effects still run */ }
      if (spec) return { ok: false, state: 'HALT', code, ...named, ...detail, teardown: await cleanup(spec, journal, 'failure', action === 'expire') };
      return { ok: false, state: 'HALT', code: 'ACT_OWNER_APPROVAL' };
    } finally { journal.close(); }
  }
  function installExpiry() {
    // Periodic + boot activation survives CLI death and reboot. Expiry time is
    // read from the authenticated durable snapshot, never from a timer argument.
    const service = `[Unit]\nDescription=SHU71 durable expiry ${id}\n[Service]\nType=oneshot\nUser=root\nRestart=on-failure\nRestartSec=1s\nExecStart=/usr/bin/node ${installedModule} expire ${id}\n`;
    const timer = `[Unit]\nDescription=SHU71 expiry wake ${id}\n[Timer]\nOnBootSec=1s\nOnUnitActiveSec=1s\nAccuracySec=1s\nUnit=shu71-expiry-${id}.service\n[Install]\nWantedBy=timers.target\n`;
    atomic(`/etc/systemd/system/shu71-expiry-${id}.service`, service, 0, 0, 0o644);
    atomic(`/etc/systemd/system/shu71-expiry-${id}.timer`, timer, 0, 0, 0o644);
    command('/usr/bin/systemctl', ['daemon-reload']);
    command('/usr/bin/systemctl', ['enable', '--now', `shu71-expiry-${id}.timer`]);
    // THE ONLY UNATTENDED TEARDOWN TRIGGER, MEASURED RATHER THAN ASSUMED. The
    // exit status of `enable --now` was taken as proof the mechanism took;
    // nothing read back whether the timer is actually enabled and active, nor
    // whether the two durable unit files are present and in root custody. If
    // the timer did not take, the `Expiry -> ExecStart ... expire <id>` wake
    // never fires and the window can stay armed past expires_at until an
    // operator notices - and every step after this one proceeded regardless.
    // This asserts the exact end state the teardown side already measures,
    // negated: both unit files present and held in root custody by the same
    // predicate retirement uses, the timer enabled, and the timer active. It
    // refuses by its own name rather than claiming an installation, and a read
    // that never answered refuses as ACT_TEARDOWN_MEASUREMENT rather than as
    // either. Reads only: nothing is issued a second time.
    need(measuredPredicate(() => EXPIRY_UNITS.every(file => !unitFileAbsent(file) && expiryUnitCustody(file))
      && ['enabled', 'enabled-runtime'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))
      && unitProperty(expiryTimerUnit, 'ActiveState') === 'active'), 'ACT_EXPIRY_NOT_INSTALLED');
  }
  // Whether this episode ever started the supervisor unit or installed its
  // expiry timer is a durable journal fact, never an inference from what the
  // host happens to show now. A halt before arming must still complete its own
  // teardown; a resource the journal says was never created, yet present or
  // running, is drift and refuses by name. A damaged log proves nothing about
  // non-creation, so recovery always takes the fail-closed path.
  const journalHas = (journal, event, step) => journal.entries.some(e => e.event === event && (step === undefined || e.step === step));
  // `never` is the only proof of non-creation, and it is durable: this journal
  // records a forward attempt of its own (RUN_ATTEMPT_STARTED), is not a
  // recovered log, and holds neither ARMED nor any intent to run the creating
  // step. A destroyed or recovered log proves nothing and is never `never`.
  function lifecyclePhase(journal, step) {
    if (journal.recovered || journalHas(journal, 'ARMED') || journalHas(journal, 'DONE', step)) return 'inconclusive';
    return journalHas(journal, 'RUN_ATTEMPT_STARTED') && !journalHas(journal, 'INTENT', step) ? 'never' : 'inconclusive';
  }
  const unitProperty = (name, property) => command('/usr/bin/systemctl', ['show', `--property=${property}`, '--value', name]).trim();
  const unitIdle = name => ['inactive', 'failed'].includes(unitProperty(name, 'ActiveState'));
  const unitFileAbsent = file => { try { f.lstatSync(file); return false; } catch (e) { if (e.code !== 'ENOENT') throw e; return true; } };
  // The expiry mechanism is two durable unit files, written by installExpiry as
  // root-owned 0644 regular files. Both are measured on disk: a systemctl
  // answer is a cache of what systemd loaded, never a substitute for the files.
  const expiryTimerUnit = `shu71-expiry-${id}.timer`;
  // The mechanism is TWO units, not one. The timer exists only to start the
  // companion service, and `disable --now <timer>` does not touch that service,
  // so a measurably live companion is a mechanism that is still running however
  // quiet the timer looks. Every tolerance below therefore measures BOTH units -
  // durable file, liveness and enablement - and a live companion has its own
  // refusal name so it is never reported as, or confused with, other drift.
  const expiryServiceUnit = `shu71-expiry-${id}.service`;
  const EXPIRY_UNITS = [`/etc/systemd/system/${expiryTimerUnit}`, `/etc/systemd/system/${expiryServiceUnit}`];
  // THE MECHANISM THIS TEARDOWN MUST PROVE GONE IS THE EXPIRY MECHANISM MINUS
  // THE INVOCATION PERFORMING THE REMOVAL. installExpiry() writes
  // `ExecStart=/usr/bin/node <installedModule> expire <id>` into
  // shu71-expiry-<id>.service and the timer's only job is to start it, so on the
  // timer-triggered path - the ONLY unattended path this mechanism exists for -
  // the companion service IS the process performing the teardown, and systemd
  // reports a running Type=oneshot unit as `activating`, which unitIdle() does
  // not accept. A refusal that fires on the very invocation doing the removal is
  // not defence in depth: it leaves the window torn down but not retired, dies
  // non-zero and is restarted by `Restart=on-failure` until the start limit
  // trips. So the companion's own LIVENESS term - and only that term - excludes
  // this invocation. The file and enablement terms of BOTH units are untouched.
  //
  // The exclusion is bounded by EXACT INVOCATION IDENTITY and by nothing else.
  // It is measured from a durable systemd fact, never from a flag, an
  // environment-presence test, or anything the removal path sets about itself:
  // `systemctl show -p InvocationID --value shu71-expiry-<id>.service` is the
  // id of the unit's CURRENT start, INVOCATION_ID is the id systemd exported to
  // this process's own start, and only exact string equality of two NON-EMPTY
  // values excludes. Where this process is not running under systemd the id is
  // absent (an operator CLI run) and NOTHING is excluded: any live companion
  // refuses by name. No live companion attributable to anything else is ever
  // tolerated, and no journal row, durable receipt or absence tolerance reaches
  // this term.
  const expiryCompanionIsThisInvocation = () => {
    const unit = unitProperty(expiryServiceUnit, 'InvocationID'), self = b.invocationId();
    return typeof self === 'string' && self !== '' && unit !== '' && unit === self;
  };
  // A COMPANION SURVIVES THIS REMOVAL when it is measurably NOT idle AND it is
  // NOT the invocation running this removal. Liveness is measured FIRST, so an
  // idle companion never consults the identity at all: an InvocationID left
  // behind by a start that has already exited is stale by construction and can
  // excuse nothing. Every site requires the NEGATION of this through
  // measuredPredicate(), so an unreadable id, a `show` that exits non-zero, a
  // boundary without the port, or any other throw is the named refusal.
  const expiryCompanionSurvivesRemoval = () => !unitIdle(expiryServiceUnit) && !expiryCompanionIsThisInvocation();
  // Custody terms, each pinned by its own control and killing mutant: the file
  // shape (a non-regular file replacing the unit refuses), one link, root user,
  // root group, and neither group- nor world-writable. `!s.isSymbolicLink()` is
  // an EQUIVALENT mutant and deliberately has no control of its own: `s` is an
  // lstat result, so a symlink is already `isFile() === false`, and removing
  // that term alone cannot change any outcome. It is retained as a statement of
  // the requirement at the point of measurement, not as a reachable branch.
  const expiryUnitCustody = file => {
    const s = f.lstatSync(file);
    return s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === 0 && s.gid === 0 && !(s.mode & 0o022);
  };
  // Absent, not enabled and not active - for EVERY unit of the mechanism, not
  // for the timer alone. Measured on the target host, disable exits 1 for a
  // unit whose file was never created; and enablement survives the unit file,
  // because it is an install symlink in <target>.wants/ that removing the unit
  // file does not take with it, so a unit whose file is gone can still answer
  // `enabled`. Each of the four unit/term pairs is written out rather than
  // folded into a loop so that each has its own mutant and its own control.
  const expiryRetired = () => EXPIRY_UNITS.every(unitFileAbsent)
    && unitIdle(expiryTimerUnit) && ['', 'not-found'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))
    && !expiryCompanionSurvivesRemoval() && ['', 'not-found'].includes(unitProperty(expiryServiceUnit, 'UnitFileState'));
  // A LIVE COMPANION IS ITS OWN REFUSAL. `disable --now <timer>` stops the
  // timer and leaves the service it triggers running, so a teardown that only
  // measured the timer reported a clean retirement over a service that was
  // still executing. This refuses by its own name, before the command that
  // would otherwise disable the timer around a live mechanism, and it is a
  // refusal rather than a stop: stopping is a new reviewed effect, and this
  // lane may not add one.
  const requireIdleExpiryCompanion = () => need(measuredPredicate(() => !expiryCompanionSurvivesRemoval()), 'ACT_TEARDOWN_EXPIRY_SERVICE');
  // After a completed teardown this episode must leave no expiry mechanism
  // behind, so a later wake that finds one re-created refuses by name too.
  function observeRetiredExpiry() { requireIdleExpiryCompanion(); need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT'); }
  function killSupervisorWorkers(journal) {
    const unit = 'shu-supervisor.service', phase = lifecyclePhase(journal, 'gate');
    // A unit the journal proves this episode never started, yet which is
    // running, is drift: refuse by name, never silently no-op. A stop this
    // teardown already ordered is measured before signalling again.
    if (phase === 'never' || journalHas(journal, 'INTENT', 'teardown:stop-shu-supervisor-service')) {
      const idle = unitIdle(unit);
      if (phase === 'never') { need(idle, 'ACT_TEARDOWN_DRIFT'); return; }
      if (idle) return;
    }
    // Otherwise the kill is issued exactly as before. Measured on the target
    // host it exits 1 for a unit that holds no processes; accept that refusal
    // only where the unit is measured idle, which is this step's obligation.
    try { command('/usr/bin/systemctl', ['kill', '--kill-whom=all', '--signal=SIGKILL', unit]); }
    catch (error) { need(error?.code === 'ACT_COMMAND_FAILED' && unitIdle(unit), 'ACT_TEARDOWN_DRIFT'); }
  }
  // THE RULE of this function, stated once at the top so that no later edit can
  // quietly make it conditional again: CUSTODY IS A PROPERTY OF THE REMOVAL,
  // NOT OF THE JOURNAL. Every durable expiry unit file that is PRESENT is
  // measured and must be held in root custody - regular file, not a symlink,
  // one link, uid 0, gid 0, neither group- nor world-writable - before this
  // teardown disables anything, and measured again immediately before the
  // unlink. A present file that fails custody refuses by name whatever
  // `installed`, `removing`, the durable receipt or a recovered log say: there
  // is no journal state that authorises removing a file we do not hold in
  // custody, and three separate rounds of this defect reopened exactly by
  // putting one more journal condition in front of that measurement.
  // The journal's only role here is ABSENCE. A missing unit file must be
  // accounted for - by the branch where the journal proves the mechanism was
  // never created, by the durable removal receipt that proves THIS teardown
  // already began the removal, or, where the journal vouches for nothing at
  // all, by a MEASURED fully retired mechanism rather than by any journal claim
  // - and in every one of those cases each PRESENT file still passes the
  // custody measurement above.
  function retireExpiryTimer(journal) {
    // What the journal proves, read once. Both are facts about ABSENCE only.
    // `installed`: this episode durably created the mechanism, so a unit file
    // that is gone is unexplained. `removing`: this teardown already began
    // unlinking, so a unit file that is gone is the completed half of its own
    // interrupted work rather than foreign drift. Neither is ever a custody
    // waiver, and neither may gate the custody measurement below.
    const installed = journalHas(journal, 'ARMED') || journalHas(journal, 'DONE', 'expiry-watch');
    const removing = journalHas(journal, 'EXPIRY_RETIREMENT_STARTED');
    // Journal-independent by construction: this predicate reads the disk and
    // nothing else, takes no journal argument, and is required before the
    // never-created branch, so no path through this function reaches an effect
    // without having measured every unit file that is actually there.
    const custodyOfPresentUnits = () => EXPIRY_UNITS.every(file => unitFileAbsent(file) || expiryUnitCustody(file));
    const requireCustodyOfPresentUnits = () => need(measuredPredicate(custodyOfPresentUnits), 'ACT_TEARDOWN_DRIFT');
    requireCustodyOfPresentUnits();
    if (lifecyclePhase(journal, 'expiry-watch') === 'never') { need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT'); return; }
    // Before any tolerance for ABSENCE is even consulted: a live companion is
    // a mechanism that is measurably still running, whatever the journal or the
    // durable files say, and it halts under its own name rather than being
    // absorbed into a generic drift refusal. Placed after the never-created
    // branch so that branch's own end-state measurement stays reachable.
    requireIdleExpiryCompanion();
    // Absence, accounted for. `disable --now` needs a unit file that exists,
    // and systemd will happily disable a unit it still holds loaded whose file
    // was deleted or replaced underneath it; that success must never absorb the
    // drift. So where the journal proves this episode installed the mechanism,
    // BOTH durable unit files must still be there unless the receipt explains
    // the gap; and where the journal proves nothing - a recovered log, or an
    // install interrupted before its durable DONE row - a gap is accepted only
    // against a measured, fully retired mechanism, never against the journal's
    // silence. A half-present mechanism nobody can account for is drift.
    // This clause reads the journal because it is about PRESENCE, which is what
    // the command it guards requires; the custody measurement above is not
    // conditioned on anything and must never become so.
    need(measuredPredicate(() => removing || EXPIRY_UNITS.every(file => !unitFileAbsent(file))
      || !installed && expiryRetired()), 'ACT_TEARDOWN_DRIFT');
    try { command('/usr/bin/systemctl', ['disable', '--now', expiryTimerUnit]); }
    catch (error) { need(measuredPredicate(() => error?.code === 'ACT_COMMAND_FAILED' && (removing || !installed && expiryRetired())), 'ACT_TEARDOWN_DRIFT'); }
    // Post-condition on the success path too: BOTH units end not active and not
    // enabled - the companion is measured here as well, because a disable that
    // starts or re-enables the service it triggers is exactly the drift the
    // exit status cannot report, and with the SAME invocation exclusion as the
    // refusal above, because a self-invocation is still `activating` here by
    // construction and must not trip ACT_TEARDOWN_DRIFT while a live companion
    // that is not this invocation still must - and the retirement itself removes both
    // durable unit files, with a daemon-reload wherever systemd still holds the
    // removed view. Invariant:
    // after a completed teardown the successor window's pre-mint gate must
    // pass, and this episode leaves no expiry mechanism behind, so the end
    // state satisfies the same predicate the never-created branch asserts.
    need(measuredPredicate(() => unitIdle(expiryTimerUnit)
      && !['enabled', 'enabled-runtime'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))
      && !expiryCompanionSurvivesRemoval()
      && !['enabled', 'enabled-runtime'].includes(unitProperty(expiryServiceUnit, 'UnitFileState'))), 'ACT_TEARDOWN_DRIFT');
    if (measuredPredicate(() => !EXPIRY_UNITS.every(unitFileAbsent))) {
      // Measured again, immediately before the unlink. `disable --now` has run
      // since the measurement at the top, so the file this loop is about to
      // remove is the one we must hold in custody NOW, not the one we held
      // before the command.
      requireCustodyOfPresentUnits();
      if (!removing) journal.append({ event: 'EXPIRY_RETIREMENT_STARTED' });
      for (const file of EXPIRY_UNITS) remove(file);
    }
    // systemd answers from the units it has loaded. Where it still holds the
    // removed view, refresh it and measure again; anything else is drift.
    if (!measuredPredicate(expiryRetired)) {
      command('/usr/bin/systemctl', ['daemon-reload']);
      need(measuredPredicate(expiryRetired), 'ACT_TEARDOWN_DRIFT');
    }
  }
  function cleanupWorkspaces(spec, journal) {
    need(journal.entries.some(e => e.event === 'DONE' && e.step === 'teardown:workers'), 'ACT_FIXTURE_CLEANUP');
    const state = '/srv/shu/state/workspaces', root = '/srv/shu/worktrees';
    const rootStat = f.lstatSync(root);
    need(rootStat.isDirectory() && !rootStat.isSymbolicLink() && (rootStat.mode & 0o7777) === 0o3770, 'ACT_FIXTURE_CLEANUP');
    // Authority sidecars are retained. Only episode-bound attempt directories
    // are removable, and a durable inode receipt precedes recursive removal.
    for (const name of f.readdirSync(state)) {
      if (!/^[a-f0-9-]{36}\.workspace\.json$/.test(name)) continue;
      const record = JSON.parse(privateRead(`${state}/${name}`, coordinatorIdentity().uid));
      if (record.episode_id !== id) continue;
      need(IDS.includes(record.issue_id) && record.repo === REPO && record.branch === `coordinator/${record.issue_id}`
        && name === `${record.attempt_id}.workspace.json`, 'ACT_FIXTURE_CLEANUP');
      const target = `${root}/${record.attempt_id}`;
      let st;
      try { st = f.lstatSync(target); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      need(st.isDirectory() && !st.isSymbolicLink() && [coordinatorIdentity().uid, 995, 994].includes(st.uid), 'ACT_FIXTURE_CLEANUP');
      const earlier = journal.entries.find(e => e.event === 'FIXTURE_REMOVE_INTENT' && e.attempt_id === record.attempt_id);
      need(!earlier || earlier.dev === st.dev && earlier.ino === st.ino && earlier.uid === st.uid, 'ACT_FIXTURE_CLEANUP');
      if (!earlier) journal.append({ event: 'FIXTURE_REMOVE_INTENT', attempt_id: record.attempt_id, dev: st.dev, ino: st.ino, uid: st.uid });
      // The service cgroup has already been killed and admission stopped. rm
      // does not follow symlinks; mounted filesystems are refused below.
      const walk = p => {
        const s = f.lstatSync(p);
        need(s.dev === rootStat.dev, 'ACT_FIXTURE_CLEANUP');
        if (s.isDirectory() && !s.isSymbolicLink()) for (const n of f.readdirSync(p)) walk(path.join(p, n));
      };
      walk(target);
      f.rmSync(target, { recursive: true, force: false });
    }
  }
  function observeGateFiles() {
    for (const file of GATES) {
      const fd = f.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const st = f.fstatSync(fd);
        need(st.isFile() && st.uid === 0 && st.nlink === 1 && !(st.mode & 0o022)
          && f.readFileSync(fd, 'utf8') === '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 'ACT_TEARDOWN_DRIFT');
      } finally { f.closeSync(fd); }
    }
  }
  function observeTeardown() {
    observeGateFiles();
    let absent = false;
    try { f.lstatSync(ACTIVATION_FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; absent = true; }
    need(absent, 'ACT_TEARDOWN_DRIFT');
    for (const name of [...SERVICES, 'shu71-evidence.service']) {
      need(['inactive', 'failed'].includes(command('/usr/bin/systemctl', ['show', '--property=ActiveState', '--value', name]).trim()), 'ACT_TEARDOWN_DRIFT');
    }
  }
  // THE ONE THING A RUN CHANGES OUTSIDE ITSELF. Everything else this window
  // touches - the gate drop-ins, the activation credential, the units, the
  // fixture cards, the attempt directories - is restored or removed by the
  // effects above, and the signed package promises `teardown = restore`. The
  // fixture lane's BRANCH was not. An approved window armed through `sign`,
  // `expiry-watch`, `local-reseed` and `remote-push`, the push LANDED, the run
  // then halted on a later read, and its teardown reported ok:true,
  // TEARDOWN_COMPLETE, failures:[] over a remote branch still carrying the
  // reseed commit and a local branch still carrying it too. The next mint
  // refused MINT_LINEAGE - correctly, because the mint requires that branch at
  // its retained parent, the reseed being performed BY the arming rather than
  // left behind by it - and the window could not be re-approved until a hand
  // repair moved three refs back. The repair is reviewed code now.
  //
  // WHAT IS RESTORED, AND ON WHAT CONDITION. The run knows exactly what it
  // published: `expected_seed_head` for `refs/heads/<branch>`, returning to
  // `expected_parent`. Each of the three refs the mint reads - the remote ref,
  // the checkout's local ref, and the checkout's remote-tracking ref - is
  // MEASURED first and then moved only when it holds EXACTLY the value this run
  // published. A ref already at the retained parent is a no-op: nothing was
  // published, or the restoration already happened. Any other value is someone
  // else's write, and it REFUSES by name rather than being overwritten; the
  // measured values are durable in the journal, so the refusal says which value
  // it found. The remote update carries `--force-with-lease=<ref>:<published>`,
  // so even the refusal's own race - a foreign write landing between the read
  // and the push - cannot clobber it; and the local updates are
  // `update-ref <ref> <parent> <published>`, which is the same compare-and-set
  // at the ref lock.
  //
  // THIS DOES NOT WEAKEN THE MINT. The mint's MINT_LINEAGE refusal on an
  // unexplained branch advance is correct behaviour and is untouched: a branch
  // this teardown refused to restore still stops the next window, which is the
  // point. Nor does it widen any mutation: each restoration is issued AT MOST
  // ONCE per invocation (`issued`), a refused restore stays refused, and a push
  // that reports failure is recovered by a RE-READ that accepts only the one
  // value meaning the mutation already happened - never by pushing again.
  //
  // WHEN IT MEASURES AT ALL. `local-reseed` is the step that creates the
  // published commit and the first step that could move any of these refs, so
  // its durable INTENT row is what proves this episode may have published
  // something. Without it - a pre-arm refusal, a revoke of a window that never
  // ran - nothing is measured, no remote is contacted and no credential is
  // read, exactly as the fixture-card restores above are gated on their own
  // `ready-<id>` intent. A recovered log proves nothing about non-creation and
  // always measures, fail-closed.
  const branchRestoresIssued = new Set();
  const measureLocalRef = (spec, ref) => gitText(spec, ['for-each-ref', '--format=%(objectname)', ref]);
  const measureRemoteRef = (spec, ref) => {
    const [value, name] = gitText(spec, ['ls-remote', '--refs', REMOTE, ref], { remote: true }).split('\t');
    return name === ref && /^[a-f0-9]{40}$/.test(value) ? value : '';
  };
  function restorePublishedRefs(spec, journal) {
    if (!(journal.recovered || journalHas(journal, 'INTENT', 'local-reseed'))) return;
    const { branch, expected_parent: parent, expected_seed_head: published } = spec.pkg.reseed;
    const ref = `refs/heads/${branch}`, tracking = `refs/remotes/origin/${branch}`;
    const measured = { remote: measureRemoteRef(spec, ref), local: measureLocalRef(spec, ref), tracking: measureLocalRef(spec, tracking) };
    journal.append({ event: 'BRANCH_RESTORE_MEASURED', branch, ...measured });
    // A ref is restorable only when it holds exactly what this run published.
    // Every other value - including an absent head - is refused under its own
    // name, and the mutation is never issued twice in one invocation.
    const restorable = (kind, value) => {
      if (value === parent) return false;
      need(value === published, 'ACT_TEARDOWN_BRANCH_FOREIGN');
      need(!branchRestoresIssued.has(kind), 'ACT_TEARDOWN_BRANCH_REATTEMPT');
      branchRestoresIssued.add(kind);
      return true;
    };
    if (restorable('remote', measured.remote)) {
      // The lease is pinned to the exact value this run published, so a branch
      // moved by anyone else between the measurement and this command is
      // refused by git itself rather than overwritten.
      try { git(spec, ['push', '--porcelain', `--force-with-lease=${ref}:${published}`, REMOTE, `${parent}:${ref}`], { remote: true }); }
      catch (error) {
        // A push can LAND and still report failure. The recovery is a RE-READ
        // that accepts only the one value meaning the mutation already
        // happened; anything else - including a read that itself fails -
        // rethrows the original refusal, and the push is never re-issued.
        let after;
        try { after = measureRemoteRef(spec, ref); } catch { throw error; }
        if (after !== parent) throw error;
        recordReadRetry(`git:ls-remote:${branch}`, 2);
      }
      need(measureRemoteRef(spec, ref) === parent, 'ACT_TEARDOWN_BRANCH_REMOTE');
    }
    if (restorable('local', measured.local)) {
      git(spec, ['update-ref', ref, parent, published]);
      need(measureLocalRef(spec, ref) === parent, 'ACT_TEARDOWN_BRANCH_LOCAL');
    }
    // The remote-tracking ref is a LOCAL CACHE of the remote's ref, and the
    // mint reads it as one of the three terms of its lineage check, so a box
    // left with `refs/remotes/origin/<branch>` at the published head is not
    // restored. It is the one ref here this run never creates: where the
    // checkout has no such ref at all there is nothing of ours to move and
    // nothing is invented, while a tracking ref holding a third value is
    // refused exactly like the other two.
    if (measured.tracking !== '' && restorable('tracking', measured.tracking)) {
      git(spec, ['update-ref', tracking, parent, published]);
      need(measureLocalRef(spec, tracking) === parent, 'ACT_TEARDOWN_BRANCH_TRACKING');
    }
  }
  async function cleanup(spec, journal, reason, automatic = false) {
    // Separate from either journal so damaged-log recovery cannot reset the
    // automatic budget. Reserve durably before ordinary effects, including crash
    // retries; counter failure has its own independent gate-disarm fallback.
    // Explicit resume/revoke remain available without resetting this budget.
    let exhausted = false;
    let evidenceUnavailable = false;
    if (automatic) {
      try {
        let attempts = 0;
        try { attempts = JSON.parse(privateRead(`${dir}/automatic-teardown.json`)).attempts; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        need(Number.isSafeInteger(attempts) && attempts >= 0 && attempts <= 32, 'ACT_RETRY_BUDGET_INVALID');
        if (attempts >= 32) exhausted = true;
        else atomic(`${dir}/automatic-teardown.json`, JSON.stringify({ attempts: attempts + 1 }));
        if (exhausted === true) {
          // A counter alone cannot prove that the allowance was spent. Missing
          // evidence (including damaged-log recovery) takes the safety fallback,
          // never permission to reset the counter or replay ordinary effects.
          evidenceUnavailable = journal.recovered;
          const reservations = journal.entries.filter(e => e.event === 'AUTOMATIC_TEARDOWN_RESERVED');
          need(reservations.length === 32 && reservations.every((e, i) => e.attempts === i + 1), 'ACT_RETRY_BUDGET_INVALID');
        } else journal.append({ event: 'AUTOMATIC_TEARDOWN_RESERVED', attempts: attempts + 1 });
      } catch (error) {
        // Counter storage must never veto the independent disk gate disarm.
        // Do not rely on journal availability or issue commands without a reservation.
        const failures = [];
        for (const file of GATES) {
          try { directory(path.dirname(file), 0o755); atomic(file, '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 0, 0, 0o644); }
          catch { failures.push('ACT_TEARDOWN_GATE'); }
        }
        try { remove(ACTIVATION_FILE); }
        catch { failures.push('ACT_TEARDOWN_ACTIVATION'); }
        return { ok: false, state: 'HALT', code: evidenceUnavailable ? 'ACT_RETRY_BUDGET_EXHAUSTED' : 'ACT_RETRY_BUDGET_UNAVAILABLE',
          // Every cause that is neither the counter's own refusal nor a parse
          // failure - an ACT_FILE_CUSTODY on the counter file, a raw errno -
          // was reported as "unavailable", which says only that something went
          // wrong. Both existing outcomes are produced by the same two
          // conditions in the same order; a third, reviewed cause is named
          // instead of being flattened into the default.
          budget_error: error.code === 'ACT_RETRY_BUDGET_INVALID' || error instanceof SyntaxError ? 'ACT_RETRY_BUDGET_INVALID'
            : reviewedCode(error?.code) ?? 'ACT_RETRY_BUDGET_UNAVAILABLE',
          failures, operator_action: 'resume_or_revoke' };
      }
    }

    const effects = [
      ['gate', () => { for (const file of GATES) { directory(path.dirname(file), 0o755); atomic(file, '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', 0, 0, 0o644); } }],
      ['activation', () => remove(ACTIVATION_FILE)],
      ['workers', () => killSupervisorWorkers(journal)],
      ...SERVICES.map(name => [`stop-${name.replaceAll('.', '-')}`, () => {
        command('/usr/bin/systemctl', ['stop', name]);
        need(['inactive', 'failed'].includes(command('/usr/bin/systemctl', ['show', '--property=ActiveState', '--value', name]).trim()), 'ACT_SERVICE_CLEANUP');
      }]),
      ['reload', () => command('/usr/bin/systemctl', ['daemon-reload'])],
      ...IDS.map(id => [`restore-${id.toLowerCase()}`, async () => {
        const t = spec.pkg.issue_transitions.find(t => t.issue_id === id);
        need(t, 'ACT_WRONG_FIXTURE');
        if (journal.recovered || journal.entries.some(e => e.event === 'INTENT' && e.step === `ready-${id}`)) await transition(t, t.restore, true);
      }]),
      // The published branch is restored here: after the timer, the coordinator
      // and the supervisor have been stopped, so nothing on this host can be
      // pushing to that lane while its refs are moved back, and before the
      // archive and the observation that close the receipt.
      ['restore-branch', () => restorePublishedRefs(spec, journal)],
      ['fixtures', () => cleanupWorkspaces(spec, journal)],
      ['evidence-broker', () => command('/usr/bin/systemctl', ['stop', 'shu71-evidence.service'])],
      ['archive', () => atomic(`${dir}/activation.json`, JSON.stringify({ activation_id: id, pkg: spec.pkg, retained: true, broker_runtime: (() => { const last = journal.entries.findLast(e => ['RUN_ATTEMPT_STARTED', 'BROKER_RUNTIME_CHECK_STARTED', 'BROKER_RUNTIME_MEASURED'].includes(e.event)); if (last?.event !== 'BROKER_RUNTIME_MEASURED') return null; const { rows, coordinator_access, kernel_connect } = last; return { rows, coordinator_access, kernel_connect }; })() }))],
      ['manifest', () => atomic(`${dir}/manifest.json`, JSON.stringify({ activation_id: id,
        journal_sha256: digest(JSON.stringify(journal.entries)), authorization_expired: reason === 'expiry' }))],
    ];
    // Observation must run on every retry, even when earlier DONE rows exist.
    effects.push(['observation', observeTeardown]);
    // Retire the retry mechanism only after every effect and observation passed.
    effects.push(
      ['expiry-timer', () => {
        // Defence in depth, kept deliberately: teardownActivation() already
        // refuses this step when any earlier effect failed (shu71-journal.mjs,
        // `if (step === 'expiry-timer' && failures.length)`), throwing
        // ACT_CLEANUP_FAILED independently. This precondition is the same
        // requirement stated against the durable journal rows rather than
        // against one process's in-memory failure list, so a retry in a fresh
        // process that re-reads the log reaches it too.
        need(journal.entries.filter(e => e.event === 'INTENT' && e.step.startsWith('teardown:') && e.step !== 'teardown:expiry-timer' && e.step !== 'teardown:manifest')
          .every(e => journal.entries.some(v => v.event === 'DONE' && v.step === e.step)), 'ACT_CLEANUP_FAILED');
        observeTeardown();
        retireExpiryTimer(journal);
      }],
    );
    if (exhausted) {
      const refusal = { ok: false, state: 'HALT', code: 'ACT_RETRY_BUDGET_EXHAUSTED', operator_action: 'resume_or_revoke' };
      // No repair after exhaustion. Reap a physically safe episode only when
      // all non-observational work is already durably complete. Check files
      // first so an armed gate still costs zero commands or writes per wake.
      try {
        observeGateFiles();
        need(effects.filter(([step]) => !['observation', 'expiry-timer'].includes(step))
          .every(([step]) => journal.entries.some(e => e.event === 'DONE' && e.step === `teardown:${step}`)), 'ACT_CLEANUP_FAILED');
        JSON.parse(privateRead(`${dir}/automatic-teardown.json`));
        if (journal.entries.some(e => e.event === 'SETTLEMENT_STARTED')) return refusal;
        observeTeardown();
        // The journal, not a plantable counter boolean, consumes this allowance.
        // Reserve there first: interruption at either durable write cannot reuse it.
        journal.append({ event: 'SETTLEMENT_STARTED' });
        // One durable settlement allowance; interruption requires explicit recovery.
        atomic(`${dir}/automatic-teardown.json`, JSON.stringify({ attempts: 32, settlement_started: true }));
      } catch { return refusal; }
      const result = await teardownActivation(journal, effects.filter(([step]) => ['observation', 'expiry-timer'].includes(step)), reason);
      if (result.ok) remove(`${ROOT}/active.json`);
      return result;
    }
    const result = await teardownActivation(journal, effects, reason);
    if (result.ok) {
      // A retired episode's periodic wake must never tear down its successor.
      remove(`${ROOT}/active.json`);

    }
    return result;
  }
  return Object.freeze({ execute });
}

export function renderEvidenceBroker() {
  return `[Unit]\nDescription=SHU71 bounded fixture evidence\n[Service]\nUser=shu71-evidence\nGroup=shu-workspace\nEnvironmentFile=/srv/shu/coordinator.env\nRuntimeDirectory=shu71-evidence\nRuntimeDirectoryMode=0750\nUMask=0007\nExecStart=/usr/bin/node /usr/local/lib/shu71/coordinator/service/fixture-evidence-broker.mjs\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\nRestart=on-failure\n`;
}

// A kernel lock survives exceptions and is automatically released on death.
// No JS API can replace the production boundary through CLI input.
export async function shu71Cli(argv) {
  const [action, id] = argv;
  need(argv.length === 2 && ['run', 'resume', 'revoke', 'expire'].includes(action) && /^[A-Za-z0-9_-]{8,64}$/.test(id ?? ''), 'ACT_COMMAND_INVALID');
  return createShu71Production(id).execute(action);
}
// `env -i` stays: this boundary accepts no operator environment. The one
// value carried across is INVOCATION_ID, and it is carried because without
// it the inner process cannot know that it IS the expiry companion and the
// timer-triggered teardown refuses itself. Carrying it grants nothing on
// its own: the teardown only ever compares it for EXACT EQUALITY against
// the unit's own reported InvocationID, so any value that is not that
// durable systemd fact excludes nothing and a live companion still refuses
// by name. Passed as one argv element, so no value can inject a second
// assignment, and omitted entirely when absent so `INVOCATION_ID=` is
// never invented.
//
// P154D-07. THAT PROPAGATION IS LOAD-BEARING, SO IT IS NAMED AND TESTABLE
// RATHER THAN INLINE AND UNPINNED. Delete the invocation element and every
// measurement on either side of the lock still passes while the companion's
// identity is wiped on the real host, the exclusion never applies, and the
// timer-triggered teardown refuses itself - the exact regression the exclusion
// exists to prevent. This is also the ONLY place this correction widens what
// crosses a boundary deliberately built to carry no operator environment, so
// the width is stated here as a pure function of ONE argument and pinned by its
// own controls: `env -i` wipes, exactly three assignments cross, the invocation
// element is built from this argument and from nothing else, it sits
// immediately after `SHU71_LOCKED=1` and before `/usr/bin/node`, it is ONE argv
// element so no value can inject a second assignment, and an absent or EMPTY
// value produces no element at all rather than an invented `INVOCATION_ID=`.
export function lockedReexecCommand(invocation, argv = []) {
  return Object.freeze(['/usr/bin/flock', '--nonblock', '/run/lock/shu71-production.lock', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'SHU71_LOCKED=1',
    ...(invocation ? [`INVOCATION_ID=${invocation}`] : []), '/usr/bin/node', installedModule, ...argv]);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (process.env.SHU71_LOCKED !== '1') {
      need(process.getuid() === 0, 'ACT_PROCESS_IDENTITY');
      const [exe, ...args] = lockedReexecCommand(process.env.INVOCATION_ID, argv);
      const r = spawnSync(exe, args, { stdio: 'inherit' });
      process.exitCode = r.status ?? 1;
    } else {
      const result = await shu71Cli(argv); process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.ok ? 0 : 1;
    }
  // The last door. Anything that escapes shu71Cli - the argv refusal, a
  // constructor refusal, a pre-arm refusal the module could not report itself -
  // reached here and was printed as one fixed string, so the CLI's only
  // evidence of a refusal said nothing about which refusal it was. It reports
  // the reviewed name now, through the same closed shape the halt record uses;
  // anything that is not a reviewed name still prints exactly the line it
  // printed before.
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: haltCode(error?.code) }) + '\n'); process.exitCode = 1; }
}
