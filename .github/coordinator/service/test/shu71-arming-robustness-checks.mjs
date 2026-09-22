// SHU-71 arming and lifecycle robustness: the round's controls, its mutations
// and the mutant loader, kept out of the .test.mjs file so the SAME check
// functions drive this file test-by-test, the round's mutant x control matrix,
// and its RED measurement against the pre-fix revision - one definition, three
// readers, no re-implementation that could drift from what is committed.
//
// An independent read-only audit of the arming and lifecycle path found that
// the post-push read-back defect was one instance of a class, and enumerated
// the rest of it. Three groups of controls answer the three shapes the class
// takes.
//
// G1 - A TRANSIENT READ FAILURE REPORTED AS A CLAIM ABOUT THE WORLD. A
// `systemctl show` that never answered was reported as "a live companion
// survives this removal"; ARMED was returned on the exit status of `systemctl
// restart` with nothing measuring whether the supervisor was running; the
// expiry mechanism - the only unattended teardown trigger there is - was
// installed on the exit status of `enable --now` with no read-back at all, so a
// window could arm with no automatic expiry. Each claim is MEASURED now, or
// refuses.
//
// G2 - READS THAT WERE FINAL ON THEIR FIRST FAILURE. The Linear fixture-card
// query, the three `git ls-remote` sites, `systemctl show`, `id`, and the
// read-back of a Linear write we had just made. Each is retried through a
// read-only door under a bounded policy; no mutation is, and no COMPARISON is,
// so a persistent failure and a genuinely wrong value still refuse under
// exactly the name and the condition they refuse under today.
//
// G3 - REFUSALS THAT NAMED NOTHING. ACT_COMMAND_FAILED named no executable,
// argument, status or signal; a halt's allow-list flattened every refusal it
// had not been taught into ACT_PRODUCTION_FAILED; the pre-arm region's refusals
// escaped the module entirely and printed one fixed string; multi-leg binding
// checks refused under one code; the package validator's own name was dropped;
// the teardown recorded step codes without causes. Every one of those names is
// reported now, through a closed pattern or a numeric range - no token, header,
// URL, query, variable, response body or response text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { READ_RETRY, COMMAND_RETRY, commandFailureDetail, haltCode, readOnlyCommand } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { environmentText, supervisorEnvironment, coordinatorText } from './shu71-supervisor-environment-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
export const keys = ephemeralPublicSource();
export const moduleUrl = new URL('../shu71-production.mjs', import.meta.url);
export const source = fs.readFileSync(moduleUrl, 'utf8');
export const journalUrl = new URL('../shu71-journal.mjs', import.meta.url);
export const journalSource = fs.readFileSync(journalUrl, 'utf8');
export const unitsUrl = new URL('../units.mjs', import.meta.url);
export const unitsSource = fs.readFileSync(unitsUrl, 'utf8');

const ACTIVATION = '/srv/shu/state/shu71-activation.json';
const SUPERVISOR = 'shu-supervisor.service';
const TIMER = 'shu-coordinator.timer';
const LINEAR = 'https://api.linear.app/graphql';
// Secrets the disposable fixture plants behind every call this module makes,
// plus the exact shapes a credential rides in on through a git child: the
// extraheader config VALUE and its base64 payload.
const POISON = ['GITHUB_POISON', 'LINEAR_POISON', 's'.repeat(40), 'Authorization', 'Bearer', 'x-access-token',
  Buffer.from('x-access-token:GITHUB_POISON').toString('base64'), 'extraheader'];

export const fixture = (t, options) => productionFixture(t, keys, undefined, null, options);
const clean = h => { h.boundary.commandWait = () => {}; return h; };
export const noSecret = (label, ...values) => {
  const text = values.map(value => JSON.stringify(value ?? null)).join('\n');
  for (const secret of POISON) assert.ok(!text.includes(secret), `${label} ${secret}`);
};
const commandEvents = (h, needle) => h.events.filter(e => e.startsWith('command:') && e.includes(needle));
const expiryUnits = h => [`/etc/systemd/system/shu71-expiry-${h.id}.timer`, `/etc/systemd/system/shu71-expiry-${h.id}.service`];

// A programmable layer over the fixture's interpreted host-process boundary.
// `answer` is called with the executable, the argv joined, and that exact
// command's attempt number. Returning undefined lets the fixture answer for
// real; returning a result object replaces the answer.
export function interceptCommands(h, answer) {
  const inner = h.boundary.run;
  const calls = [], delays = [];
  h.boundary.commandWait = ms => { delays.push(ms); };
  h.boundary.run = (exe, argv, options) => {
    const key = `${exe} ${argv.join(' ')}`;
    calls.push(key);
    const planned = answer(exe, argv.join(' '), calls.filter(c => c === key).length, argv);
    if (planned === undefined) return inner(exe, argv, options);
    return planned;
  };
  // `repeated` is the longest run of IDENTICAL consecutive commands: a bounded
  // retry of one command is always consecutive, so a run of one is a proof that
  // the command was attempted exactly once however many times the whole
  // invocation reaches it.
  const repeated = needle => {
    let best = 0, run = 0, previous = null;
    for (const key of calls) {
      run = key === previous ? run + 1 : 1;
      previous = key;
      if (key.includes(needle)) best = Math.max(best, run);
    }
    return best;
  };
  return { calls, delays, repeated, count: needle => calls.filter(c => c.includes(needle)).length };
}

// The same for the Linear transport. `answer` sees the operation kind derived
// from the query text, the variables, and that operation's attempt number.
export function interceptLinear(h, answer) {
  const inner = h.boundary.fetch;
  const calls = [], delays = [];
  h.boundary.readWait = async ms => { delays.push(ms); };
  h.boundary.fetch = async (url, options) => {
    if (url !== LINEAR) return inner(url, options);
    const body = JSON.parse(options.body);
    const kind = body.query.trim().startsWith('mutation') ? 'mutation' : 'query';
    calls.push(`${kind}:${body.variables.id}`);
    const planned = answer(kind, body.variables, calls.filter(c => c === `${kind}:${body.variables.id}`).length);
    if (planned === undefined) return inner(url, options);
    return planned;
  };
  return { calls, delays, count: needle => calls.filter(c => c.startsWith(needle)).length };
}
const failed = { status: 1, stdout: '' };
const replied = value => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const apiFailure = status => ({ ok: false, status, text: async () => '{}' });
const card = (transition, state) => replied({ data: { issue: { id: transition.linear_id, identifier: transition.issue_id,
  state: { id: state.state_id }, assignee: state.assignee_id && { id: state.assignee_id } } } });
const armed = async (create, h) => {
  const result = await create(h.id, h.boundary).execute('run').catch(error => ({ state: `threw:${error?.code ?? error?.message}` }));
  assert.equal(result.state, 'ARMED', `B6_WINDOW_ARMS ${JSON.stringify(result)}`);
  return result;
};

// ------------------------------------------------- G1: measured, not claimed

// A `systemctl show` that never answered was raised as ACT_TEARDOWN_EXPIRY_SERVICE:
// the refusal asserts that a LIVE COMPANION SERVICE survives this teardown - a
// claim about the host that a failed read cannot support, on the unattended
// path where this predicate family runs about ten reads at a time, once a
// second. The companion here is measurably idle and the read is the only thing
// wrong, so the pre-fix module accuses it anyway.
export async function measurementIsNotAStateClaimCheck(create, h) {
  await armed(create, clean(h));
  const commands = interceptCommands(h, (exe, key) =>
    exe === '/usr/bin/systemctl' && key.includes('show --property=ActiveState') && key.endsWith(`shu71-expiry-${h.id}.service`) ? failed : undefined);
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(result.state, 'HALT', 'B6_MEASUREMENT_FAILURE_REFUSES');
  assert.ok(result.failures.includes('ACT_TEARDOWN_MEASUREMENT'), `B6_MEASUREMENT_NOT_A_STATE_CLAIM ${JSON.stringify(result.failures)}`);
  assert.ok(!result.failures.includes('ACT_TEARDOWN_EXPIRY_SERVICE'), 'B6_MEASUREMENT_NOT_A_STATE_CLAIM');
  // The read that failed is named, and the budget bounded how many times it
  // was attempted: three, not one and not unboundedly many.
  assert.equal(commands.count('show --property=ActiveState --value shu71-expiry-'), COMMAND_RETRY.attempts, 'B6_MEASUREMENT_READ_BOUNDED');
  assert.deepEqual(commands.delays, [...COMMAND_RETRY.delaysMs], 'B6_MEASUREMENT_READ_BOUNDED');
  noSecret('B6_MEASUREMENT_CARRIES_NO_SECRET', result, h.journal());
}

// The same read failing ONCE is a hiccup, and the teardown completes. Pre-fix
// this halted the whole unattended teardown and, under Restart=on-failure at a
// one-second wake, did so until the start limit tripped.
export async function transientMeasurementRetriedCheck(create, h) {
  await armed(create, clean(h));
  const commands = interceptCommands(h, (exe, key, attempt) =>
    exe === '/usr/bin/systemctl' && key.includes('show --property=ActiveState') && key.endsWith(`shu71-expiry-${h.id}.service`) && attempt === 1
      ? failed : undefined);
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(result.state, 'REVOKED', `B6_TRANSIENT_MEASUREMENT_RETRIED ${JSON.stringify(result)}`);
  assert.deepEqual(result.failures, [], 'B6_TRANSIENT_MEASUREMENT_RETRIED');
  assert.deepEqual(commands.delays, [COMMAND_RETRY.delaysMs[0]], 'B6_TRANSIENT_MEASUREMENT_RETRIED');
  for (const unit of expiryUnits(h)) assert.equal(h.exists(unit), false, 'B6_TRANSIENT_MEASUREMENT_RETRIED');
}

// A MEASURED FALSE IS STILL THE CALLER'S OWN REFUSAL. The companion really is
// live and is not this invocation: the teardown must still refuse by the
// companion's own name, on the FIRST measurement, with no retry at all - a
// successful read is never repeated.
export async function liveCompanionStillRefusesCheck(create, h) {
  await armed(create, clean(h));
  const commands = interceptCommands(h, () => undefined);
  h.active.set(`shu71-expiry-${h.id}.service`, 'active');
  h.selfInvocation.id = null;
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(result.state, 'HALT', 'B6_LIVE_COMPANION_STILL_REFUSES');
  assert.ok(result.failures.includes('ACT_TEARDOWN_EXPIRY_SERVICE'), `B6_LIVE_COMPANION_STILL_REFUSES ${JSON.stringify(result.failures)}`);
  assert.ok(!result.failures.includes('ACT_TEARDOWN_MEASUREMENT'), 'B6_LIVE_COMPANION_STILL_REFUSES');
  assert.deepEqual(commands.delays, [], 'B6_SUCCESSFUL_READ_NEVER_RETRIED');
}

// ARMED WAS RETURNED ON AN EXIT STATUS. A Type=simple unit's start job is
// satisfied once the child has been forked and exec'd, so `restart` exits 0 for
// a supervisor that dies immediately afterwards - and the pre-fix module
// appended ARMED and returned it, leaving dispatch enabled behind a supervisor
// that is not running. That is not a halt; it is the opposite, and it costs
// more.
export async function gateLivenessRefusedCheck(create, h, variant = 'inactive') {
  clean(h);
  const commands = interceptCommands(h, (exe, key) => {
    if (exe !== '/usr/bin/systemctl') return undefined;
    // `restart` exits 0 and the unit does not come up: the start job was
    // satisfied, the process was not.
    if (variant === 'inactive' && key === `restart ${SUPERVISOR}`) return { status: 0, stdout: '' };
    if (variant === 'timer' && key === `start ${TIMER}`) return { status: 0, stdout: '' };
    return undefined;
  });
  // active-but-not-running: systemd has the unit but its main process is gone.
  if (variant === 'substate') h.systemd.subStates.set(SUPERVISOR, 'dead');
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'HALT', `B6_GATE_LIVENESS_MEASURED_${variant}`);
  assert.equal(result.code, 'ACT_GATE_NOT_LIVE', `B6_GATE_LIVENESS_MEASURED_${variant}`);
  assert.ok(!h.journal().some(e => e.event === 'ARMED'), `B6_GATE_NOT_LIVE_NEVER_ARMS_${variant}`);
  assert.equal(h.exists(ACTIVATION), false, `B6_GATE_NOT_LIVE_NEVER_ARMS_${variant}`);
  assert.equal(commands.count(`restart ${SUPERVISOR}`), 1, `B6_GATE_MUTATION_NOT_RETRIED_${variant}`);
  noSecret(`B6_GATE_HALT_CARRIES_NO_SECRET_${variant}`, result, h.journal());
}

// THE RESUME THAT SKIPPED THE RESTART. `gate` was the only forward step whose
// effect a resume could skip while still appending ARMED: a durable DONE row
// returned early, so an invocation that died between the step and the ARMED
// append resumed into an ARMED claim over a supervisor THIS process never
// restarted and never measured. The step repeats now, so the resume
// re-establishes and re-measures it.
export async function gateResumeRemeasuresCheck(create, h) {
  clean(h);
  let dead = false;
  // PROCESS LOSS immediately after the gate step's durable DONE row and before
  // the ARMED append: once dead, every effect refuses, including the
  // exception-path teardown, so the durable log is left exactly in the state a
  // killed process leaves it in - DONE gate, no ARMED, no teardown row.
  h.faults.after = name => dead || (dead = name.startsWith('write:') && /journal\.jsonl$/.test(name)
    && h.journal().at(-1)?.step === 'gate' && h.journal().at(-1)?.event === 'DONE');
  h.faults.before = () => dead;
  await create(h.id, h.boundary).execute('run').catch(() => {});
  h.faults.after = null; h.faults.before = null;
  const rows = h.journal();
  assert.equal(rows.at(-1)?.event, 'DONE', `B6_GATE_RESUME_FIXTURE ${JSON.stringify(rows.at(-1))}`);
  assert.equal(rows.at(-1)?.step, 'gate', 'B6_GATE_RESUME_FIXTURE');
  assert.ok(!rows.some(e => e.event === 'ARMED'), 'B6_GATE_RESUME_FIXTURE');
  const commands = interceptCommands(h, () => undefined);
  const result = await create(h.id, h.boundary).execute('resume').catch(error => ({ state: `threw:${error?.code}` }));
  assert.equal(result.state, 'ARMED', `B6_GATE_RESUME_REMEASURES ${JSON.stringify(result)}`);
  assert.equal(commands.count(`restart ${SUPERVISOR}`), 1, 'B6_GATE_RESUME_REMEASURES');
}

// THE ONLY UNATTENDED TEARDOWN TRIGGER, INSTALLED ON AN EXIT STATUS. Nothing
// read back whether the timer took, so a window could arm with NO automatic
// expiry at all and stay armed past expires_at until an operator noticed -
// while every later step proceeded as though the mechanism were in place.
export async function expiryInstallationMeasuredCheck(create, h, variant = 'inactive') {
  clean(h);
  const commands = interceptCommands(h, (exe, key, attempt, argv) => {
    if (exe !== '/usr/bin/systemctl' || argv[0] !== 'enable') return undefined;
    // `enable --now` exits 0 and the mechanism did not take, each way it can.
    if (variant === 'inactive') { h.enabled.add(argv.at(-1)); h.wants.add(argv.at(-1)); return { status: 0, stdout: '' }; }
    if (variant === 'disabled') { h.active.set(argv.at(-1), 'active'); return { status: 0, stdout: '' }; }
    return undefined;
  });
  // The durable unit file is gone although systemd answers enabled and active.
  if (variant === 'unitfile') h.faults.after = name => {
    if (name !== `command:/usr/bin/systemctl:enable --now shu71-expiry-${h.id}.timer`) return false;
    fs.unlinkSync(path.join(h.root, `/etc/systemd/system/shu71-expiry-${h.id}.service`));
    return false;
  };
  const result = await create(h.id, h.boundary).execute('run');
  h.faults.after = null;
  assert.equal(result.state, 'HALT', `B6_EXPIRY_INSTALLATION_MEASURED_${variant}`);
  assert.equal(result.code, 'ACT_EXPIRY_NOT_INSTALLED', `B6_EXPIRY_INSTALLATION_MEASURED_${variant}`);
  assert.ok(!h.journal().some(e => e.event === 'ARMED'), `B6_EXPIRY_NOT_INSTALLED_NEVER_ARMS_${variant}`);
  assert.equal(h.exists(ACTIVATION), false, `B6_EXPIRY_NOT_INSTALLED_NEVER_ARMS_${variant}`);
  assert.equal(commands.count('enable --now'), 1, `B6_EXPIRY_MUTATION_NOT_RETRIED_${variant}`);
}

// ----------------------------------------------- G2: the remaining raced reads

// THE LINEAR FIXTURE-CARD READ. It is made at least four times per arming and
// had no retry at all, so one Linear 429 or 5xx aborted the whole window under
// a bare ACT_API_FAILED. It is a GraphQL QUERY - it names one issue and asks
// for four fields - and it is retried through the same door and the same four
// bounds as the GitHub GETs.
export async function linearQueryRaceCheck(create, h) {
  clean(h);
  const linear = interceptLinear(h, (kind, variables, attempt) => kind === 'query' && attempt === 1 ? apiFailure(503) : undefined);
  const result = await armed(create, h);
  assert.ok(result.api_read_retries?.some(entry => entry.operation === 'linear:query:Shu71Fixture' && entry.attempts === 2),
    `B6_LINEAR_QUERY_RACE_RETRIED ${JSON.stringify(result.api_read_retries)}`);
  assert.deepEqual(linear.delays, [READ_RETRY.delaysMs[0], READ_RETRY.delaysMs[0]], 'B6_LINEAR_QUERY_RACE_RETRIED');
  assert.ok(h.exists(ACTIVATION), 'B6_LINEAR_QUERY_RACE_RETRIED');
}

// Retry is not tolerance: when every answer fails, the window refuses under
// exactly the name it refuses under today, having spent the bound and nothing
// more, and nothing is armed.
export async function linearQueryPersistentCheck(create, h) {
  clean(h);
  const linear = interceptLinear(h, kind => kind === 'query' ? apiFailure(503) : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_API_FAILED', 'B6_LINEAR_QUERY_PERSISTENT_REFUSED');
  assert.equal(result.state, 'HALT', 'B6_LINEAR_QUERY_PERSISTENT_REFUSED');
  assert.equal(result.api_failure?.operation, 'linear:query:Shu71Fixture', 'B6_LINEAR_QUERY_PERSISTENT_REFUSED');
  assert.equal(result.api_failure?.attempts, READ_RETRY.attempts, 'B6_LINEAR_QUERY_PERSISTENT_REFUSED');
  assert.equal(linear.count('query:'), READ_RETRY.attempts, 'B6_LINEAR_QUERY_PERSISTENT_REFUSED');
  assert.equal(h.exists(ACTIVATION), false, 'B6_LINEAR_QUERY_PERSISTENT_REFUSED');
  noSecret('B6_LINEAR_HALT_CARRIES_NO_SECRET', result, h.journal());
}

// A WRONG CARD IS NOT A RACE. The query ANSWERS, 200, with a card that is
// neither the approved `before` nor the target: a correct retry never sees the
// difference, because the read succeeded, so the comparison refuses
// ACT_PRIOR_STATE_DRIFT on that first answer and the route is not read again.
export async function linearDriftNotRetriedCheck(create, h) {
  clean(h);
  const drifted = { state_id: 'drifted-state', assignee_id: null };
  const linear = interceptLinear(h, (kind, variables) => kind === 'query' ? card(
    h.spec.pkg.issue_transitions.find(t => t.linear_id === variables.id), drifted) : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_PRIOR_STATE_DRIFT', `B6_LINEAR_DRIFT_NOT_RETRIED ${JSON.stringify(result)}`);
  assert.equal(linear.count('query:'), 1, 'B6_LINEAR_DRIFT_NOT_RETRIED');
  assert.deepEqual(linear.delays, [], 'B6_LINEAR_DRIFT_NOT_RETRIED');
  assert.equal(h.exists(ACTIVATION), false, 'B6_LINEAR_DRIFT_NOT_RETRIED');
}

// The same claim at the identity guard: an answering read whose issue is the
// wrong one refuses ACT_WRONG_FIXTURE on the first answer.
export async function linearWrongFixtureNotRetriedCheck(create, h) {
  clean(h);
  const linear = interceptLinear(h, kind => kind === 'query'
    ? replied({ data: { issue: { id: 'foreign', identifier: 'SHU-999', state: { id: 'x' }, assignee: null } } }) : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_WRONG_FIXTURE', 'B6_LINEAR_WRONG_FIXTURE_NOT_RETRIED');
  assert.equal(linear.count('query:'), 1, 'B6_LINEAR_WRONG_FIXTURE_NOT_RETRIED');
  assert.deepEqual(linear.delays, [], 'B6_LINEAR_WRONG_FIXTURE_NOT_RETRIED');
}

// THE WRITE WE JUST MADE, READ BACK. issueUpdate reports success and the very
// next read can still answer the PRE-update card, because Linear answers reads
// from replicas - so a landed transition halted the whole arming on
// ACT_PARTIAL_ARMING over a card that was already correct.
export async function cardReadbackStaleCheck(create, h) {
  clean(h);
  const stale = new Map();
  const linear = interceptLinear(h, (kind, variables, attempt) => {
    const transition = h.spec.pkg.issue_transitions.find(t => t.linear_id === variables.id);
    if (kind !== 'query' || !stale.has(variables.id)) return undefined;
    // The first read after the mutation is answered from a stale replica.
    if (stale.get(variables.id) === true) { stale.set(variables.id, false); return card(transition, transition.before); }
    return undefined;
  });
  const outer = h.boundary.fetch;
  h.boundary.fetch = async (url, options) => {
    const result = await outer(url, options);
    if (url === LINEAR && JSON.parse(options.body).query.trim().startsWith('mutation')) stale.set(JSON.parse(options.body).variables.id, true);
    return result;
  };
  const result = await armed(create, h);
  assert.ok(result.api_read_retries?.some(entry => /^linear:readback:SHU-/.test(entry.operation) && entry.attempts === 2),
    `B6_CARD_READBACK_STALE_RETRIED ${JSON.stringify(result.api_read_retries)}`);
  assert.equal(linear.count('mutation:'), h.spec.pkg.issue_transitions.length, 'B6_CARD_MUTATION_ISSUED_ONCE');
  for (const transition of h.spec.pkg.issue_transitions) assert.deepEqual(h.states.get(transition.issue_id), transition.ready, 'B6_CARD_READBACK_STALE_RETRIED');
}

// THE MUTATION IS NEVER RE-ISSUED, AND THE READ-BACK ACCEPTS ONLY THE TARGET.
// `never` never lands the write at all; `elsewhere` lands a card that is
// neither `before` nor `target`, as a concurrent human transition would. Both
// run the bounded re-read out and refuse ACT_PARTIAL_ARMING under exactly the
// name they refuse under today, and in both the update is issued exactly once.
export async function cardReadbackRefusesCheck(create, h, variant = 'never') {
  clean(h);
  const transitions = h.spec.pkg.issue_transitions;
  let writes = 0, readbacks = 0, writesAtRefusal = null;
  interceptLinear(h, (kind, variables) => {
    if (kind === 'mutation') { writes++; return undefined; }
    // Only the read-backs of the FIRST landed write are answered from a
    // replica that never catches up, and only as many of them as the bound
    // allows; the teardown's own restore afterwards sees real state.
    if (writes !== 1 || readbacks >= READ_RETRY.attempts) return undefined;
    readbacks++;
    // How many writes this transition had issued by the time its bounded
    // re-read ran out: the teardown's own restore afterwards issues its own.
    if (readbacks === READ_RETRY.attempts) writesAtRefusal = writes;
    return card(transitions.find(t => t.linear_id === variables.id),
      variant === 'never' ? transitions.find(t => t.linear_id === variables.id).before
        : { state_id: 'moved-by-someone-else', assignee_id: null });
  });
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_PARTIAL_ARMING', `B6_CARD_READBACK_REFUSES_${variant} ${JSON.stringify(result)}`);
  assert.equal(result.state, 'HALT', `B6_CARD_READBACK_REFUSES_${variant}`);
  assert.equal(writesAtRefusal, 1, `B6_CARD_MUTATION_NEVER_REISSUED_${variant}`);
  assert.equal(readbacks, READ_RETRY.attempts, `B6_CARD_READBACK_BOUNDED_${variant}`);
  assert.equal(h.exists(ACTIVATION), false, `B6_CARD_READBACK_REFUSES_${variant}`);
}

// `git ls-remote` OVER HTTPS, THREE SITES, NO RETRY. Each is a network read
// executed through setpriv, each was final on its first non-zero exit, and the
// refusal named neither the site nor the executable nor the status. One
// transient failure and the window still arms.
export async function lsRemoteRaceCheck(create, h) {
  clean(h);
  const commands = interceptCommands(h, (exe, key, attempt) =>
    key.includes(' ls-remote ') && key.endsWith('refs/heads/coordinator/SHU-140') && attempt === 1 ? failed : undefined);
  const result = await armed(create, h);
  assert.ok(result.command_read_retries?.some(entry => entry.exe === '/usr/bin/setpriv' && entry.argv.includes('ls-remote') && entry.attempts === 2),
    `B6_LS_REMOTE_RACE_RETRIED ${JSON.stringify(result.command_read_retries)}`);
  assert.deepEqual(commands.delays, [COMMAND_RETRY.delaysMs[0]], 'B6_LS_REMOTE_RACE_RETRIED');
  noSecret('B6_LS_REMOTE_RETRY_CARRIES_NO_SECRET', result, h.journal());
}

// A persistent failure refuses under ACT_COMMAND_FAILED exactly as today - and
// the halt now says WHICH command failed, with what status, after how many
// attempts, carrying the argv and NEVER the child's environment, which is where
// the GitHub token travels as GIT_CONFIG_VALUE_0.
export async function lsRemotePersistentCheck(create, h) {
  clean(h);
  const commands = interceptCommands(h, (exe, key) =>
    key.includes(' ls-remote ') && key.endsWith('refs/heads/coordinator/SHU-140') ? failed : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_COMMAND_FAILED', 'B6_LS_REMOTE_PERSISTENT_REFUSED');
  assert.equal(result.command_failure?.exe, '/usr/bin/setpriv', `B6_COMMAND_FAILURE_NAMED ${JSON.stringify(result.command_failure)}`);
  assert.ok(result.command_failure?.argv.includes('ls-remote'), 'B6_COMMAND_FAILURE_NAMED');
  assert.ok(result.command_failure?.argv.includes('refs/heads/coordinator/SHU-140'), 'B6_COMMAND_FAILURE_NAMED');
  assert.equal(result.command_failure?.status, 1, 'B6_COMMAND_FAILURE_NAMED');
  assert.equal(result.command_failure?.attempts, COMMAND_RETRY.attempts, 'B6_COMMAND_FAILURE_NAMED');
  // `repeated`, not `count`: SHU-280's fourteenth round gives the teardown's
  // final observation its own reading of this ref on every path, so the
  // INVOCATION now reaches this command again after the halt. What this
  // control pins is unchanged and is what `repeated` states - the longest run
  // of identical consecutive attempts, which is exactly the retry bound.
  assert.equal(commands.repeated(' ls-remote '), COMMAND_RETRY.attempts, 'B6_LS_REMOTE_PERSISTENT_BOUNDED');
  const halted = h.journal().filter(e => e.event === 'HALTED');
  assert.equal(halted.at(-1)?.command_failure?.status, 1, 'B6_COMMAND_FAILURE_IN_JOURNAL');
  noSecret('B6_COMMAND_FAILURE_CARRIES_NO_SECRET', result, h.journal());
}

// A WRONG SHA IS NOT A RACE, at the host-process door too. `ls-remote` SUCCEEDS
// and answers a sha that is not the approved one: the read is never repeated
// and the comparison refuses on that first answer - now naming which of the
// three legs of the binding check disagreed.
export async function lsRemoteWrongShaCheck(create, h) {
  clean(h);
  const commands = interceptCommands(h, (exe, key, attempt, argv) =>
    key.includes(' ls-remote ') && key.endsWith('refs/heads/coordinator/SHU-140')
      ? { status: 0, stdout: `${'f'.repeat(40)}\t${argv.at(-1)}\n` } : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_REF_BINDING', 'B6_LS_REMOTE_WRONG_SHA_NOT_RETRIED');
  assert.equal(result.binding_leg, 'remote', `B6_BINDING_LEG_NAMED ${JSON.stringify(result)}`);
  // `repeated` for the same reason as above: the teardown's own observation
  // reads this ref once more, and "not retried" is a statement about
  // consecutive attempts, not about how often the invocation reaches it.
  assert.equal(commands.repeated(' ls-remote '), 1, 'B6_LS_REMOTE_WRONG_SHA_NOT_RETRIED');
  assert.deepEqual(commands.delays, [], 'B6_LS_REMOTE_WRONG_SHA_NOT_RETRIED');
  assert.equal(h.exists(ACTIVATION), false, 'B6_LS_REMOTE_WRONG_SHA_NOT_RETRIED');
}

// A LANDED PUSH THAT REPORTED FAILURE. The push is a MUTATION and is never
// re-issued - a re-push cannot converge, because after a landed push the lease
// `=old` is stale while the ref is already `next`. The recovery is a RE-READ
// that accepts the step only on the one value that means the mutation already
// happened, and everything it passes over is re-measured immediately afterwards
// by heads() and by the ancestry comparison.
export async function pushLandedThenFailedCheck(create, h) {
  clean(h);
  const inner = h.boundary.run;
  let pushes = 0;
  h.boundary.run = (exe, argv, options) => {
    if (!argv.includes('push')) return inner(exe, argv, options);
    pushes++;
    // The push LANDS - the fixture advances the remote - and then reports
    // failure, exactly as a reset connection after an accepted pack does.
    inner(exe, argv, options);
    return failed;
  };
  const result = await armed(create, h);
  assert.equal(pushes, 1, 'B6_PUSH_NEVER_REISSUED');
  assert.ok(result.api_read_retries?.some(entry => entry.operation.startsWith('git:ls-remote:')), `B6_PUSH_READ_BACK_RECORDED ${JSON.stringify(result)}`);
}

// The recovery accepts exactly one value and nothing else. `old` means the push
// really did fail; `third` is someone else's write. Both rethrow the ORIGINAL
// refusal, ACT_COMMAND_FAILED, and the push is still attempted exactly once.
export async function pushFailedRefusesCheck(create, h, variant = 'old') {
  clean(h);
  const inner = h.boundary.run;
  let pushes = 0;
  h.boundary.run = (exe, argv, options) => {
    if (argv.includes('push')) { pushes++; return failed; }
    if (variant === 'third' && argv.includes('ls-remote') && argv.at(-1).endsWith('SHU-140') && pushes > 0)
      return { status: 0, stdout: `${'a'.repeat(40)}\t${argv.at(-1)}\n` };
    return inner(exe, argv, options);
  };
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_COMMAND_FAILED', `B6_PUSH_FAILURE_REFUSED_${variant} ${JSON.stringify(result)}`);
  assert.equal(pushes, 1, `B6_PUSH_NEVER_REISSUED_${variant}`);
  assert.equal(result.api_read_retries, undefined, `B6_PUSH_READ_BACK_NOT_ACCEPTED_${variant}`);
  assert.equal(h.exists(ACTIVATION), false, `B6_PUSH_FAILURE_REFUSED_${variant}`);
}

// EVERY MUTATION IS STILL ATTEMPTED EXACTLY ONCE. The read-only door is
// enumerated, so a failing systemctl verb that is not `show` - restart,
// daemon-reload, start, enable, stop, kill, disable - refuses on its first
// answer and is never repeated, however transient the failure looks.
// The three verbs below each appear exactly once on the arming path.
// `daemon-reload` and `stop` are deliberately not among them: the teardown
// re-runs a failed effect once on purpose - "independent safety effects must
// still be attempted" - so a run of two consecutive calls there is that
// reviewed behaviour and not a retry. That they are outside the retried set at
// all is proved by construction in readOnlyCommandClosureCheck, and the empty
// backoff record below is the direct proof for every verb.
export async function commandMutationNotRetriedCheck(create, h, verb = 'restart') {
  clean(h);
  const commands = interceptCommands(h, (exe, key, attempt, argv) =>
    exe === '/usr/bin/systemctl' && argv[0] === verb ? failed : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_COMMAND_FAILED', `B6_MUTATION_NOT_RETRIED_${verb} ${JSON.stringify(result)}`);
  assert.equal(commands.repeated(`/usr/bin/systemctl ${verb}`), 1, `B6_MUTATION_NOT_RETRIED_${verb}`);
  assert.deepEqual(commands.delays, [], `B6_MUTATION_NOT_RETRIED_${verb}`);
  assert.equal(result.command_failure?.exe, '/usr/bin/systemctl', `B6_MUTATION_FAILURE_NAMED_${verb}`);
  assert.ok(result.command_failure?.argv.includes(verb), `B6_MUTATION_FAILURE_NAMED_${verb}`);
}

// THE CREDENTIAL STORE WAS RE-OPENED ON EVERY CALL. credentials() re-read
// /srv/shu/coordinator.env - and /etc/passwd and /etc/group with it - on every
// API call and every remote git call, so one arming opened the credential store
// a dozen times and a rotation mid-run authenticated two halves of the same
// step with two different tokens. It is resolved at most once now.
export async function credentialResolvedOnceCheck(create, h) {
  clean(h);
  h.boundary.fs = { ...h.boundary.fs };
  const openInner = h.boundary.fs.openSync;
  let reads = 0;
  h.boundary.fs.openSync = (p, flags, mode) => { if (p === '/srv/shu/coordinator.env') reads++; return openInner(p, flags, mode); };
  await armed(create, h);
  // TWO readers of this file, each opening it exactly once: the credential
  // resolution, and the environment-contract guard that checks the two
  // independently owned sources against each other. Anything more is the
  // per-call re-read - one open per API call and per remote git call - that a
  // whole arming used to make, and with it the mid-run rotation hazard of
  // authenticating two halves of one step with two different tokens.
  assert.equal(reads, 2, 'B6_CREDENTIAL_RESOLVED_ONCE');
}

// It stays LAZY, and it still refuses. A coordinator.env whose GITHUB_TOKEN
// line is absent refuses under its own name - which the pre-fix halt reported
// as the generic ACT_PRODUCTION_FAILED - and names no value.
export async function credentialRefusalNamedCheck(create, h) {
  clean(h);
  h.write('/srv/shu/coordinator.env', coordinatorText().split('\n').filter(line => !line.startsWith('GITHUB_TOKEN=')).join('\n'), 0o600, 999);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'HALT', 'B6_ENV_REFUSAL_NAMED');
  assert.equal(result.code, 'SHU251_ENV_COORDINATOR', `B6_ENV_REFUSAL_NAMED ${JSON.stringify(result)}`);
  noSecret('B6_ENV_REFUSAL_CARRIES_NO_SECRET', result, h.journal());
}

// THE HOST-READ BOUND IS OVERALL, NOT PER CALL. Every read-only host command
// races twice and succeeds on its third attempt, so each costs the whole
// per-read backoff; once the per-invocation sleep budget is spent the next read
// that races has nothing left and refuses immediately rather than extending the
// window further. The total sleep this mechanism may add to one invocation is
// therefore bounded however many reads race.
export async function commandBudgetCheck(create, h) {
  clean(h);
  const commands = interceptCommands(h, (exe, key, attempt, argv) =>
    readOnlyCommand(exe, argv) && attempt <= 2 ? failed : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'HALT', `B6_COMMAND_RETRY_BUDGET_BOUNDED ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_COMMAND_FAILED', 'B6_COMMAND_RETRY_BUDGET_BOUNDED');
  const slept = commands.delays.reduce((a, b) => a + b, 0);
  assert.ok(slept <= COMMAND_RETRY.budgetMs, `B6_COMMAND_RETRY_BUDGET_BOUNDED ${slept}`);
  assert.ok(slept > COMMAND_RETRY.budgetMs - COMMAND_RETRY.delaysMs.at(-1), `B6_COMMAND_RETRY_BUDGET_SPENT ${slept}`);
  assert.equal(result.command_failure?.attempts, 2, `B6_COMMAND_RETRY_BUDGET_BOUNDED ${JSON.stringify(result.command_failure)}`);
  assert.equal(h.exists(ACTIVATION), false, 'B6_COMMAND_RETRY_BUDGET_BOUNDED');
}

// ONLY A MEASURED COMMAND OUTCOME IS RETRIED. A boundary that THROWS - a fork
// that never happened, a process replaced mid-run - is not a command that ran
// and answered badly, and it propagates exactly as it does today: unretried,
// undescribed, and reported as the generic refusal.
export async function boundaryThrowNotRetriedCheck(create, h) {
  clean(h);
  const inner = h.boundary.run;
  let thrown = 0;
  h.boundary.run = (exe, argv, options) => {
    if (readOnlyCommand(exe, argv) && argv.includes('ls-remote') && thrown === 0) { thrown++; throw new Error('SECRET_POISON'); }
    return inner(exe, argv, options);
  };
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(thrown, 1, 'B6_BOUNDARY_THROW_NOT_RETRIED');
  assert.equal(result.state, 'HALT', `B6_BOUNDARY_THROW_NOT_RETRIED ${JSON.stringify(result)}`);
  assert.equal(result.code, 'ACT_PRODUCTION_FAILED', `B6_BOUNDARY_THROW_NOT_RETRIED ${JSON.stringify(result)}`);
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(h.journal()), /SECRET_POISON/, 'B6_BOUNDARY_THROW_CARRIES_NO_TEXT');
}

// ------------------------------------------------ G3: a refusal names itself

// A 31-byte transport secret. The assertion that refuses it passed a BARE
// STRING as its message, so it threw an AssertionError whose code is
// ERR_ASSERTION and the name SHU251_ENV_SUPERVISOR existed only inside a
// message nothing records. Reported now - and the secret's value is not.
export async function supervisorSecretRefusalNamedCheck(create, h) {
  clean(h);
  h.write('/etc/shu/supervisor.env', environmentText({ SHU_SUPERVISOR_SECRET: 's'.repeat(31) }));
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'SHU251_ENV_SUPERVISOR', `B6_SUPERVISOR_SECRET_REFUSAL_NAMED ${JSON.stringify(result)}`);
  assert.ok(!JSON.stringify(result).includes('s'.repeat(31)), 'B6_SUPERVISOR_SECRET_VALUE_NEVER_REPORTED');
  noSecret('B6_SUPERVISOR_SECRET_CARRIES_NO_SECRET', result, h.journal());
}

// THE PRE-ARM REGION LEFT NO EVIDENCE AT ALL. The action vocabulary, the
// episode directories' custody, the operator's approval document and the
// journal open sat outside the covering try, so each of their refusals escaped
// the module and printed one fixed string with no episode, no path and no code.
// Pre-fix, execute() THREW here rather than returning a halt.
export async function preArmRefusalNamedCheck(create, h, variant = 'approval') {
  clean(h);
  const before = h.events.length;
  if (variant === 'approval') h.write(`/etc/shu/approvals/${h.id}.shu71.json`,
    JSON.stringify({ payload: h.spec, signature: Buffer.alloc(64).toString('base64') }));
  if (variant === 'custody') fs.chmodSync(path.join(h.root, `/srv/shu/state/shu71-evidence/${h.id}`), 0o755);
  const result = await create(h.id, h.boundary).execute(variant === 'action' ? 'demolish' : 'run')
    .catch(error => ({ state: 'THREW', code: error?.code ?? 'UNKNOWN' }));
  // Pre-fix, execute() THREW here rather than returning a halt at all, so the
  // refusal reached the CLI's outer catch and was printed as one fixed string.
  assert.notEqual(result.state, 'THREW', `B6_PRE_ARM_RETURNS_A_HALT_${variant} ${result.code}`);
  assert.equal(result.state, 'HALT', `B6_PRE_ARM_REFUSAL_NAMED_${variant}`);
  assert.equal(result.code, { approval: 'ACT_OWNER_APPROVAL', custody: 'ACT_FILE_CUSTODY', action: 'ACT_COMMAND_INVALID' }[variant],
    `B6_PRE_ARM_REFUSAL_NAMED_${variant} ${JSON.stringify(result)}`);
  // It ADDS THE NAME AND NOTHING ELSE: no effect is ordered and no teardown is
  // attempted for an episode this invocation never took custody of.
  assert.ok(!h.events.slice(before).some(e => e.startsWith('command:')), `B6_PRE_ARM_NO_EFFECT_${variant}`);
  assert.equal(result.teardown, undefined, `B6_PRE_ARM_NO_TEARDOWN_${variant}`);
  assert.equal(h.exists(ACTIVATION), false, `B6_PRE_ARM_NO_EFFECT_${variant}`);
}

// The CLI's own last door, measured in its own process. Everything that escapes
// shu71Cli printed the same fixed string, so the CLI's only evidence of a
// refusal said nothing about which refusal it was. No host path is reached:
// the argv guard refuses before the boundary is constructed.
export function cliNamesTheCodeCheck(modulePath = fileURLToPath(moduleUrl)) {
  const run = argv => spawnSync(process.execPath, [modulePath, ...argv],
    { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, SHU71_LOCKED: '1' } });
  const invalid = run(['run', 'x']);
  assert.equal(invalid.status, 1, `B6_CLI_NAMES_THE_CODE ${invalid.stdout}${invalid.stderr}`);
  assert.deepEqual(JSON.parse(invalid.stdout.trim()), { ok: false, code: 'ACT_COMMAND_INVALID' }, 'B6_CLI_NAMES_THE_CODE');
  const arity = run(['run']);
  assert.deepEqual(JSON.parse(arity.stdout.trim()), { ok: false, code: 'ACT_COMMAND_INVALID' }, 'B6_CLI_NAMES_THE_CODE');
}

// WHICH LEG DISAGREED. A three-leg and a four-leg conjunction refused under one
// code apiece with no way to tell a stale local ref from a moved remote from a
// GitHub answer that had not caught up - or a dirty worktree from a wrong tree.
export async function bindingLegNamedCheck(create, h, leg = 'readback') {
  clean(h);
  if (leg === 'readback') {
    const inner = h.boundary.fetch;
    h.boundary.fetch = async (url, options) => url.endsWith('SHU-140')
      ? replied({ object: { sha: 'f'.repeat(40) } }) : inner(url, options);
  }
  if (leg === 'local') interceptCommands(h, (exe, key, attempt, argv) =>
    key.includes(' rev-parse --verify refs/heads/coordinator/SHU-140') ? { status: 0, stdout: `${'b'.repeat(40)}\n` } : undefined);
  if (leg === 'clean') interceptCommands(h, (exe, key) =>
    key.includes(' status --porcelain') ? { status: 0, stdout: ' M some/file\n' } : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, leg === 'clean' ? 'ACT_REVISION_BINDING' : 'ACT_REF_BINDING', `B6_BINDING_LEG_NAMED_${leg} ${JSON.stringify(result)}`);
  assert.equal(result.binding_leg, leg, `B6_BINDING_LEG_NAMED_${leg} ${JSON.stringify(result)}`);
  assert.equal(h.journal().filter(e => e.event === 'HALTED').at(-1)?.binding_leg, leg, `B6_BINDING_LEG_IN_JOURNAL_${leg}`);
}

// WHICH FIXTURE - AND THEREFORE WHETHER THE SECOND ONE IS BOUND AT ALL.
// `heads()` walks every fixture the package pins, and fixture_2's head is a term
// of the sealed block (the window arms two slots). The controls above mutate
// fixture_1's legs only, and the committed baseline pinned just one leg of the
// second fixture - its readback, after the push, by a test that asserts HALT with
// no refusal code and no leg named. Its local and remote legs had no committed
// assertion at all: measured at the parent a51c8490, a mutant that neuters either
// one alone fires no ref-binding assertion anywhere in the parent's committed
// suite. The discriminator is that name diff against an unmutated baseline, not an
// exit code - an unrelated SHU251 row can redden a run in that configuration.
// The two mutant shapes that truncate the loop or skip its legs are a different
// matter, and are not claimed here as holes: five committed tests outside this
// file kill each of them at the parent, so they pin the loop's shape.
// Each leg of the second fixture now fails alone, under its own name, while the
// other two agree.
export async function secondFixtureRefBindingCheck(create, h, leg = 'readback') {
  clean(h);
  const foreign = `${'e'.repeat(40)}`;
  if (leg === 'readback') {
    const inner = h.boundary.fetch;
    h.boundary.fetch = async (url, options) => url.includes('SHU-254')
      ? replied({ object: { sha: foreign } }) : inner(url, options);
  }
  if (leg === 'remote') interceptCommands(h, (exe, key) =>
    key.includes(' ls-remote ') && key.endsWith('refs/heads/coordinator/SHU-254')
      ? { status: 0, stdout: `${foreign}\trefs/heads/coordinator/SHU-254\n` } : undefined);
  if (leg === 'local') interceptCommands(h, (exe, key) =>
    key.includes(' rev-parse --verify refs/heads/coordinator/SHU-254')
      ? { status: 0, stdout: `${foreign}\n` } : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_REF_BINDING', `B6_SECOND_FIXTURE_REF_BINDING ${leg} ${JSON.stringify(result)}`);
  assert.equal(result.binding_leg, leg, `B6_SECOND_FIXTURE_REF_BINDING_LEG ${leg}`);
  assert.equal(h.journal().filter(e => e.event === 'HALTED').at(-1)?.binding_leg, leg, `B6_SECOND_FIXTURE_REF_IN_JOURNAL ${leg}`);
}

// The legs SHORT-CIRCUIT exactly as the conjunction they replace did: a
// disagreeing HEAD still means `status --porcelain` is never run at all, so
// naming the leg added no command and no API call to any path.
export async function bindingLegShortCircuitCheck(create, h) {
  clean(h);
  const commands = interceptCommands(h, (exe, key) =>
    key.endsWith(' rev-parse HEAD') ? { status: 0, stdout: `${'b'.repeat(40)}\n` } : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_REVISION_BINDING', 'B6_BINDING_LEG_SHORT_CIRCUIT');
  assert.equal(result.binding_leg, 'head', `B6_BINDING_LEG_SHORT_CIRCUIT ${JSON.stringify(result)}`);
  assert.equal(commands.count(' status --porcelain'), 0, 'B6_BINDING_LEG_SHORT_CIRCUIT');
}

// THE PACKAGE VALIDATOR'S OWN NAME. It already reports which of its guards
// refused; that name was discarded and the halt said only "validation". The
// custody record is written before the journal, so a resume re-enters with the
// approved spec already in hand and reaches the validation with the anchor this
// control has changed under it.
export async function packageValidationNamedCheck(create, h) {
  clean(h);
  let dead = false;
  h.faults.after = name => dead || (dead = name.endsWith('/custody.json'));
  await create(h.id, h.boundary).execute('run').catch(() => {});
  h.faults.after = null;
  assert.ok(h.exists(`/srv/shu/state/shu71-evidence/${h.id}/custody.json`), 'B6_PACKAGE_VALIDATION_FIXTURE');
  h.context.anchor.state = 'provisional';
  const result = await create(h.id, h.boundary).execute('resume');
  assert.equal(result.code, 'ACT_PACKAGE_VALIDATION', `B6_PACKAGE_VALIDATION_NAMED ${JSON.stringify(result)}`);
  assert.equal(result.package_code, 'ACT_KEY_AUTHORITY_REQUIRED', `B6_PACKAGE_VALIDATION_NAMED ${JSON.stringify(result)}`);
  assert.equal(h.journal().filter(e => e.event === 'HALTED').at(-1)?.package_code, 'ACT_KEY_AUTHORITY_REQUIRED', 'B6_PACKAGE_VALIDATION_IN_JOURNAL');
}

// THE TEARDOWN RECORDED STEP CODES WITHOUT CAUSES. `failures` said WHICH
// reviewed effect refused and never WHY, so a unit that would not stop, a gate
// drop-in that failed custody and a read that never answered were
// indistinguishable at the module boundary.
export async function teardownCauseNamedCheck(create, h) {
  await armed(create, clean(h));
  // The stop command exits 0 and the unit stays up: the step's own
  // post-condition refuses, under its own name, ACT_SERVICE_CLEANUP.
  h.active.set('shu-coordinator.service', 'active');
  interceptCommands(h, (exe, key, attempt, argv) =>
    exe === '/usr/bin/systemctl' && argv[0] === 'stop' && argv[1] === 'shu-coordinator.service' ? { status: 0, stdout: '' } : undefined);
  const result = await create(h.id, h.boundary).execute('revoke');
  assert.equal(result.ok, false, 'B6_TEARDOWN_CAUSE_NAMED');
  assert.ok(result.failures.includes('ACT_TEARDOWN_STOP_SHU_COORDINATOR_SERVICE'), `B6_TEARDOWN_STEP_STILL_NAMED ${JSON.stringify(result.failures)}`);
  assert.ok(result.failures.includes('ACT_SERVICE_CLEANUP'), `B6_TEARDOWN_CAUSE_NAMED ${JSON.stringify(result.failures)}`);
  noSecret('B6_TEARDOWN_FAILURES_CARRY_NO_SECRET', result, h.journal());
}

// ------------------------------------------------------- direct closure proofs

// WHAT A FAILED HOST COMMAND IS ALLOWED TO SAY ABOUT ITSELF, proved on the
// exported sanitizer: the only way anything but an executable, an argv of bare
// command tokens, a numeric exit status, a signal name, a fault name and an
// attempt count can reach a halt record is through this function.
export function commandDetailClosureCheck(detail) {
  assert.deepEqual(detail({ exe: '/usr/bin/systemctl', argv: ['restart', 'shu-supervisor.service'], status: 1 }),
    { exe: '/usr/bin/systemctl', argv: ['restart', 'shu-supervisor.service'], status: 1 }, 'B6_COMMAND_DETAIL_ACCEPTS_REVIEWED_SHAPE');
  // A lease flag and a ref are command tokens and survive verbatim.
  assert.deepEqual(detail({ argv: ['--force-with-lease=refs/heads/coordinator/SHU-140:' + 'a'.repeat(40)] }).argv,
    ['--force-with-lease=refs/heads/coordinator/SHU-140:' + 'a'.repeat(40)], 'B6_COMMAND_DETAIL_ARGV_CLOSED');
  // Anything that is not one - the node probe source, an env assignment with a
  // token in it, a quoted header - is replaced IN ITS OWN POSITION, so the
  // argv's arity is preserved and nothing is echoed.
  assert.deepEqual(detail({ argv: ['-e', "import fs from 'node:fs'; fs.accessSync('/x');", 'tail'] }).argv,
    ['-e', 'unreportable', 'tail'], 'B6_COMMAND_DETAIL_ARGV_CLOSED');
  for (const hostile of ['AUTHORIZATION: basic ' + Buffer.from('x:y').toString('base64'), 'GIT_CONFIG_VALUE_0=AUTHORIZATION: basic z',
    'a'.repeat(121), 42, null, undefined, { toString: () => 'GITHUB_POISON' }])
    assert.deepEqual(detail({ argv: [hostile] }).argv, ['unreportable'], 'B6_COMMAND_DETAIL_ARGV_CLOSED');
  assert.equal(detail({ argv: Array.from({ length: 40 }, (_, i) => `a${i}`) }).argv.length, 16, 'B6_COMMAND_DETAIL_ARGV_CLOSED');
  // The executable is an absolute path of path characters and nothing else.
  for (const exe of ['systemctl', '/usr/bin/git --exec', 'https://x:GITHUB_POISON@h/', 42, null, undefined])
    assert.equal(detail({ exe }).exe, 'unknown', 'B6_COMMAND_DETAIL_EXECUTABLE_CLOSED');
  // The status is a process exit code, and a signal and a fault are names.
  for (const status of ['1', 256, -1, 1.5, 'GITHUB_POISON'])
    assert.equal(Object.hasOwn(detail({ status }), 'status'), false, 'B6_COMMAND_DETAIL_STATUS_CLOSED');
  assert.equal(detail({ status: 0 }).status, 0, 'B6_COMMAND_DETAIL_STATUS_CLOSED');
  assert.equal(detail({ signal: 'SIGKILL' }).signal, 'SIGKILL', 'B6_COMMAND_DETAIL_SIGNAL_CLOSED');
  assert.equal(Object.hasOwn(detail({ signal: 'killed by GITHUB_POISON' }), 'signal'), false, 'B6_COMMAND_DETAIL_SIGNAL_CLOSED');
  assert.equal(detail({ fault: 'ETIMEDOUT' }).fault, 'ETIMEDOUT', 'B6_COMMAND_DETAIL_FAULT_CLOSED');
  assert.equal(Object.hasOwn(detail({ fault: 'spawn failed: GITHUB_POISON' }), 'fault'), false, 'B6_COMMAND_DETAIL_FAULT_CLOSED');
  // Nothing unnamed survives, and re-sanitizing a sanitized detail is a no-op.
  const hostile = { exe: '/usr/bin/git', env: { GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic GITHUB_POISON' },
    stderr: 'GITHUB_POISON', input: 'file contents', attempts: -1 };
  assert.deepEqual(detail(hostile), { exe: '/usr/bin/git' }, 'B6_COMMAND_DETAIL_DROPS_EVERYTHING_ELSE');
  assert.deepEqual(detail(detail(hostile)), detail(hostile), 'B6_COMMAND_DETAIL_IDEMPOTENT');
}

// WHICH NAMES A HALT MAY REPORT, proved on the exported mapping. A reviewed
// refusal name is preserved; everything else is the generic code it is today,
// and the shape is narrow enough that no token, header or message text can be
// spelled as one.
export function haltCodeClosureCheck(map) {
  for (const code of ['ACT_OWNER_APPROVAL', 'ACT_TEARDOWN_MEASUREMENT', 'SHU251_ENV_COORDINATOR', 'SHU71_RESEED_DIGEST_MISMATCH',
    'ACT_GATE_NOT_LIVE', 'ACT_EXPIRY_NOT_INSTALLED', 'ACT_CREDENTIAL_UNAVAILABLE', 'ACT_JOURNAL_TORN'])
    assert.equal(map(code), code, 'B6_HALT_CODE_PRESERVES_REVIEWED_NAME');
  for (const code of [undefined, null, 42, '', 'ENOENT', 'ERR_ASSERTION', 'act_owner_approval', 'ACT', 'ACT_',
    'OTHER_THING', 'ACT_OWNER APPROVAL', 'ACT_OWNER-APPROVAL', 'Bearer ghp_GITHUBPOISON', 'GITHUB_POISON',
    `ACT_${'X'.repeat(45)}`, { code: 'ACT_OWNER_APPROVAL' }])
    assert.equal(map(code), 'ACT_PRODUCTION_FAILED', `B6_HALT_CODE_REJECTS_EVERYTHING_ELSE ${String(code)}`);
  assert.equal(map(map('ACT_OWNER_APPROVAL')), 'ACT_OWNER_APPROVAL', 'B6_HALT_CODE_IDEMPOTENT');
}

// WHICH HOST COMMANDS THE BOUNDED RETRY MAY REPEAT, proved on the exported
// classifier. The set is enumerated, so no mutation can fall inside it: every
// systemctl verb but `show`, every git verb but `ls-remote`, the node access
// probe and the push are all outside.
export function readOnlyCommandClosureCheck(classify) {
  const git = verb => ['--reuid=shu-coordinator', '--regid=shu-coordinator', '--init-groups', '/usr/bin/git',
    '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-C', '/reviewed/repo', verb, 'refs/heads/main'];
  assert.equal(classify('/usr/bin/systemctl', ['show', '--property=ActiveState', '--value', 'x.service']), true, 'B6_READ_ONLY_COMMAND_CLOSED');
  assert.equal(classify('/usr/bin/id', ['-u', 'shu-coordinator']), true, 'B6_READ_ONLY_COMMAND_CLOSED');
  assert.equal(classify('/usr/bin/setpriv', git('ls-remote')), true, 'B6_READ_ONLY_COMMAND_CLOSED');
  for (const verb of ['daemon-reload', 'start', 'restart', 'stop', 'kill', 'enable', 'disable'])
    assert.equal(classify('/usr/bin/systemctl', [verb, 'x.service']), false, `B6_READ_ONLY_COMMAND_CLOSED ${verb}`);
  for (const verb of ['push', 'update-ref', 'rev-parse', 'status', 'hash-object', 'merge-base', 'cat-file', 'ls-tree'])
    assert.equal(classify('/usr/bin/setpriv', git(verb)), false, `B6_READ_ONLY_COMMAND_CLOSED ${verb}`);
  // The node access probe runs under the same setpriv wrapper and is not a git
  // read; a `ls-remote` that is not in the reviewed argv position is not one.
  assert.equal(classify('/usr/bin/setpriv', ['--reuid=shu-coordinator', '/usr/bin/node', '-e', 'ls-remote']), false, 'B6_READ_ONLY_COMMAND_CLOSED');
  assert.equal(classify('/usr/bin/setpriv', ['/usr/bin/git', 'ls-remote']), false, 'B6_READ_ONLY_COMMAND_CLOSED');
  for (const exe of ['/usr/bin/git', '/usr/bin/gh', '/usr/bin/flock', '/usr/bin/node', undefined, null])
    assert.equal(classify(exe, ['show']), false, 'B6_READ_ONLY_COMMAND_CLOSED');
  for (const argv of [undefined, null, 'show', {}]) assert.equal(classify('/usr/bin/systemctl', argv), false, 'B6_READ_ONLY_COMMAND_CLOSED');
}

export const controls = [
  ['a failed measurement is not a state claim about the host', measurementIsNotAStateClaimCheck],
  ['a transient unit read is retried and the teardown completes', transientMeasurementRetriedCheck],
  ['a genuinely live expiry companion still refuses by its own name', liveCompanionStillRefusesCheck],
  ['a transient Linear fixture-card read is retried and the window arms', linearQueryRaceCheck],
  ['a persistently failing Linear read still refuses under the same name', linearQueryPersistentCheck],
  ['a genuinely drifted fixture card refuses instead of being retried', linearDriftNotRetriedCheck],
  ['a genuinely wrong fixture refuses instead of being retried', linearWrongFixtureNotRetriedCheck],
  ['a stale read-back of a landed card transition is re-read, not refused', cardReadbackStaleCheck],
  ['a transient ls-remote failure is retried and the window arms', lsRemoteRaceCheck],
  ['the host-read sleep budget is bounded across the whole invocation', commandBudgetCheck],
  ['a boundary that throws is never retried and echoes no text', boundaryThrowNotRetriedCheck],
  ['a persistently failing ls-remote names the command it ran', lsRemotePersistentCheck],
  ['a genuinely wrong remote sha refuses and names the leg', lsRemoteWrongShaCheck],
  ['a landed push that reported failure is re-read, not re-pushed', pushLandedThenFailedCheck],
  ['the credential store is opened at most once per invocation', credentialResolvedOnceCheck],
  ['an absent coordinator credential refuses under its own name', credentialRefusalNamedCheck],
  ['a short supervisor transport secret refuses under its own name', supervisorSecretRefusalNamedCheck],
  ['the failing binding leg is short-circuited and named', bindingLegShortCircuitCheck],
  ['the package validator own refusal is carried into the halt', packageValidationNamedCheck],
  ['a failed teardown step names its cause as well as its step', teardownCauseNamedCheck],
];

// Controls that take a variant, expanded one test per variant so each has its
// own name and its own outcome.
export const variantControls = [
  ['a supervisor that did not come up refuses instead of arming', gateLivenessRefusedCheck, ['inactive', 'substate', 'timer']],
  ['the expiry installation is measured, not assumed', expiryInstallationMeasuredCheck, ['inactive', 'disabled', 'unitfile']],
  ['a card read-back that never reaches the target still refuses', cardReadbackRefusesCheck, ['never', 'elsewhere']],
  ['a push that did not land still refuses', pushFailedRefusesCheck, ['old', 'third']],
  ['a systemctl mutation is attempted exactly once', commandMutationNotRetriedCheck, ['restart', 'start', 'enable']],
  ['a pre-arm refusal names itself and orders no effect', preArmRefusalNamedCheck, ['approval', 'custody', 'action']],
  ['the disagreeing binding leg is named', bindingLegNamedCheck, ['readback', 'local', 'clean']],
  ['the second fixture is bound too, leg by leg', secondFixtureRefBindingCheck, ['readback', 'remote', 'local']],
];

// One anchored substitution, loaded from a disposable path, across the three
// modules this round touches. A module-load or syntax error cannot count as a
// kill.
export async function loadMutant(t, before, after, target = 'production') {
  const sources = { production: source, journal: journalSource, units: unitsSource };
  assert.equal(sources[target].split(before).length, 2, `B6_MUTATION_ANCHOR_UNIQUE ${target}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-arming-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rewrite = (text, base) => text.replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, prefix, quote, relative) =>
    `${prefix}${quote}${['./shu71-journal.mjs', './units.mjs'].includes(relative)
      ? pathToFileURL(path.join(root, relative.slice(2))).href : new URL(relative, base).href}${quote}`);
  fs.writeFileSync(path.join(root, 'shu71-journal.mjs'), rewrite(target === 'journal' ? journalSource.replace(before, after) : journalSource, journalUrl));
  fs.writeFileSync(path.join(root, 'units.mjs'), rewrite(target === 'units' ? unitsSource.replace(before, after) : unitsSource, unitsUrl));
  const file = path.join(root, 'production.mjs');
  fs.writeFileSync(file, rewrite(target === 'production' ? source.replace(before, after) : source, moduleUrl));
  return { module: await import(pathToFileURL(file)), file };
}
// The killing assertion is reported, not merely counted.
export async function killedBy(t, run) {
  let killed = null;
  await assert.rejects(run, error => {
    killed = error; return error.code === 'ERR_ASSERTION' && /B6_/.test(error.message);
  }, 'B6_MUTATION_NAMED_ASSERTION');
  t.diagnostic(`killed by ${/B6_[A-Z_0-9]+/.exec(killed.message)?.[0]}`);
}

const MEASURED = 'export const measuredPredicate = predicate => { try { return predicate() === true; } catch (error) { throw measurementFailure(error); } };';
const GATE_LIVE = "        need(measuredPredicate(() => unitProperty('shu-supervisor.service', 'ActiveState') === 'active'\n"
  + "          && unitProperty('shu-supervisor.service', 'SubState') === 'running'), 'ACT_GATE_NOT_LIVE');";
const GATE_TIMER = "        need(measuredPredicate(() => unitProperty('shu-coordinator.timer', 'ActiveState') === 'active'), 'ACT_GATE_NOT_LIVE');";
const EXPIRY_READBACK = "    need(measuredPredicate(() => EXPIRY_UNITS.every(file => !unitFileAbsent(file) && expiryUnitCustody(file))\n"
  + "      && ['enabled', 'enabled-runtime'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))\n"
  + "      && unitProperty(expiryTimerUnit, 'ActiveState') === 'active'), 'ACT_EXPIRY_NOT_INSTALLED');";
const ISSUE_READ = "    const { issue: v } = await linearRead('query Shu71Fixture($id: String!) { issue(id: $id) { id identifier state { id } assignee { id } } }', { id: t.linear_id });";
const CARD_WRITE = "    const result = await linear('mutation Shu71Fixture($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',";
const CARD_READBACK = '    let observed = await issue(t), attempts = 1;';
const CARD_REREAD = '      await readWait(delay);\n      observed = await issue(t);\n      attempts++;';
const PUSH_RECOVERY = "            if (after !== `${next}\\t${ref}`) throw error;";
const COMMAND_DOOR = '    if (!readOnlyCommand(exe, args)) return runCommand(exe, args, options);';
const COMMAND_DETAIL = "      throw describeCommandFailure(error, { exe, argv: args, status: r.status,\n        signal: r.signal, fault: r.error?.code ?? r.error?.name });";

export const mutations = [
  // G1. The measurement distinction removed, and each measured post-condition
  // removed in turn.
  ['a failed measurement is reported as the state the caller named', MEASURED,
    'export const measuredPredicate = predicate => { try { return predicate() === true; } catch { return false; } };',
    measurementIsNotAStateClaimCheck],
  ['the host-command read retry is removed', COMMAND_DOOR, '    if (true) return runCommand(exe, args, options);', transientMeasurementRetriedCheck],
  ['the supervisor liveness read-back is removed', GATE_LIVE, '        /* mutation: claim ARMED on the exit status */',
    (create, h) => gateLivenessRefusedCheck(create, h, 'inactive')],
  ['the supervisor SubState term is dropped', GATE_LIVE,
    GATE_LIVE.replace("\n          && unitProperty('shu-supervisor.service', 'SubState') === 'running'", ''),
    (create, h) => gateLivenessRefusedCheck(create, h, 'substate')],
  ['the dispatch timer liveness read-back is removed', GATE_TIMER, '        /* mutation: the timer is assumed live */',
    (create, h) => gateLivenessRefusedCheck(create, h, 'timer')],
  ['the gate step stops repeating on a resume', "      }, /* re-establish and re-measure on resume */ true);", '      });', gateResumeRemeasuresCheck],
  ['the expiry installation read-back is removed', EXPIRY_READBACK, '    /* mutation: the exit status is proof */',
    (create, h) => expiryInstallationMeasuredCheck(create, h, 'inactive')],
  ['the expiry enablement term is dropped', EXPIRY_READBACK,
    EXPIRY_READBACK.replace("\n      && ['enabled', 'enabled-runtime'].includes(unitProperty(expiryTimerUnit, 'UnitFileState'))", ''),
    (create, h) => expiryInstallationMeasuredCheck(create, h, 'disabled')],
  ['the expiry durable-file term is dropped', EXPIRY_READBACK,
    EXPIRY_READBACK.replace('EXPIRY_UNITS.every(file => !unitFileAbsent(file) && expiryUnitCustody(file))', 'true'),
    (create, h) => expiryInstallationMeasuredCheck(create, h, 'unitfile')],
  // G2. Each retried read put back behind the unretried door, and each bound
  // of each new retry removed.
  ['the Linear fixture-card read goes back to the unretried door', ISSUE_READ, ISSUE_READ.replace('linearRead(', 'linear('), linearQueryRaceCheck],
  // The read door's guard is load-bearing, and this is the mutant that proves
  // it: route the ISSUE UPDATE through it. The guard refuses before any call is
  // made, so the mutation is never issued at all - which is exactly the
  // property the control measures.
  ['the Linear issueUpdate is routed through the retried read door', CARD_WRITE, CARD_WRITE.replace('await linear(', 'await linearRead('),
    linearMutationStillUnretriedCheck],
  ['the card read-back is never re-read', CARD_READBACK + '\n    while (!sameFixtureCard(observed, target) && attempts < READ_RETRY.attempts) {',
    CARD_READBACK + '\n    while (false) {', cardReadbackStaleCheck],
  ['the card read-back re-issues the write it is reading back', CARD_REREAD,
    CARD_REREAD.replace('      observed = await issue(t);',
      "      await linear('mutation Shu71Fixture($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',\n"
      + '        { id: t.linear_id, input: { stateId: target.state_id, assigneeId: target.assignee_id } });\n'
      + '      observed = await issue(t);'),
    (create, h) => cardReadbackRefusesCheck(create, h, 'never')],
  ['the card read-back accepts a card that is not the target', '    need(sameFixtureCard(observed, target), \'ACT_PARTIAL_ARMING\');',
    '    need(observed !== null, \'ACT_PARTIAL_ARMING\');', (create, h) => cardReadbackRefusesCheck(create, h, 'elsewhere')],
  ['the host-command read policy allows a single attempt', 'COMMAND_RETRY = Object.freeze({ attempts: 3,',
    'COMMAND_RETRY = Object.freeze({ attempts: 1,', lsRemoteRaceCheck],
  ['the host-command backoff schedule is emptied', 'delaysMs: Object.freeze([100, 200]), budgetMs: 2000',
    'delaysMs: Object.freeze([]), budgetMs: 2000', lsRemoteRaceCheck],
  ['the host-command sleep budget is not enforced', '|| delay > commandRetryBudgetMs', '|| false', commandBudgetCheck],
  ['the host-command retry repeats a boundary fault as well as a command failure',
    "        if (error?.code !== 'ACT_COMMAND_FAILED') throw error;", '', boundaryThrowNotRetriedCheck],
  ['the push recovery accepts any remote answer', PUSH_RECOVERY, '            if (after === undefined) throw error;',
    (create, h) => pushFailedRefusesCheck(create, h, 'old')],
  ['the push recovery accepts a third sha', PUSH_RECOVERY, '            if (!/^[a-f0-9]{40}\\t/.test(after)) throw error;',
    (create, h) => pushFailedRefusesCheck(create, h, 'third')],
  ['the credential is resolved on every call again', '  const credentials = () => (resolvedCredentials ??= readCredentials());',
    '  const credentials = () => readCredentials();', credentialResolvedOnceCheck],
  // G3. Each name dropped again, at its own door.
  ['the failing command is no longer described', COMMAND_DETAIL, '      throw error;', lsRemotePersistentCheck],
  ['the halt record drops the measured command detail', '...commandFailureRecord(error), ...bindingLegRecord(error),', '', lsRemotePersistentCheck],
  ['the halt code goes back to an allow-list', '  const code = haltCode(error?.code);',
    "  const code = ['ACT_OWNER_APPROVAL', 'ACT_FILE_CUSTODY', 'ACT_COMMAND_INVALID'].includes(error?.code) ? error.code : 'ACT_PRODUCTION_FAILED';",
    credentialRefusalNamedCheck],
  ['the pre-arm region loses its handler again', '      return { ok: false, state: \'HALT\', code: haltCode(error?.code),',
    '      throw error;\n      return { ok: false, state: \'HALT\', code: haltCode(error?.code),',
    (create, h) => preArmRefusalNamedCheck(create, h, 'approval')],
  ['the fixture loop covers only the first fixture',
    '    for (const fixture of spec.pkg.fixtures) {',
    '    for (const fixture of spec.pkg.fixtures.slice(0, 1)) {',
    (create, h) => secondFixtureRefBindingCheck(create, h, 'readback')],
  ['fixture_2 keeps every read but loses its LOCAL leg check',
    "['local', local === expected], ['remote', remote === `${expected}\\t${ref}`],",
    "['local', fixture.issue_id === 'SHU-140' ? local === expected : true], ['remote', remote === `${expected}\\t${ref}`],",
    (create, h) => secondFixtureRefBindingCheck(create, h, 'local')],
  ['fixture_2 keeps every read but loses its REMOTE leg check',
    "['remote', remote === `${expected}\\t${ref}`],",
    "['remote', fixture.issue_id === 'SHU-140' ? remote === `${expected}\\t${ref}` : true],",
    (create, h) => secondFixtureRefBindingCheck(create, h, 'remote')],
  ['fixture_2 keeps every read but loses its READBACK leg check',
    "['readback', readback.object?.sha === expected]], 'ACT_REF_BINDING');",
    "['readback', fixture.issue_id === 'SHU-140' ? readback.object?.sha === expected : true]], 'ACT_REF_BINDING');",
    (create, h) => secondFixtureRefBindingCheck(create, h, 'readback')],
  ['the second fixture skips its own binding legs',
    "      const expected = fixture.issue_id === 'SHU-140' && !seeded ? spec.pkg.reseed.expected_parent : fixture.seed_head;",
    "      const expected = fixture.issue_id === 'SHU-140' && !seeded ? spec.pkg.reseed.expected_parent : fixture.seed_head;\n      if (fixture.issue_id !== 'SHU-140') { result[fixture.branch] = expected; continue; }",
    (create, h) => secondFixtureRefBindingCheck(create, h, 'local')],
  ['the binding leg is no longer named', "    throw Object.assign(activationError(code), typeof leg === 'string' && BINDING_LEG_PATTERN.test(leg) ? { leg } : {});",
    '    throw activationError(code);', (create, h) => bindingLegNamedCheck(create, h, 'readback')],
  ['the binding legs are evaluated eagerly instead of in order',
    '  for (const [leg, term] of legs) {\n    if ((typeof term === \'function\' ? term() : term) === true) continue;',
    "  for (const [leg, term] of legs.map(([name, value]) => [name, typeof value === 'function' ? value() : value])) {\n    if (term === true) continue;",
    bindingLegShortCircuitCheck],
  ['the package validator code is dropped again',
    "      catch (error) { throw Object.assign(error, reviewedCode(checked.code) ? { package_code: checked.code } : {}); }",
    '      catch (error) { throw error; }', packageValidationNamedCheck],
];

// Mutants in the sibling modules this round also corrects.
export const siblingMutations = [
  ['the teardown records step codes without causes', 'journal',
    '      if (error?.code !== stepCode && reviewedCode(error?.code)) failures.push(error.code);',
    "      if (error?.code === 'ACT_TEARDOWN_EXPIRY_SERVICE') failures.push(error.code);", teardownCauseNamedCheck],
  ['the supervisor secret refusal goes back to a bare string', 'units',
    "    Object.assign(new Error('SHU251_ENV_SUPERVISOR: transport secret required'), { code: 'SHU251_ENV_SUPERVISOR' }));",
    "    'SHU251_ENV_SUPERVISOR: transport secret required');", supervisorSecretRefusalNamedCheck],
  ['the coordinator credential refusal goes back to a bare string', 'units',
    "    Object.assign(new Error('SHU251_ENV_COORDINATOR: GITHUB_TOKEN and LINEAR_API_TOKEN are required'), { code: 'SHU251_ENV_COORDINATOR' }));",
    "    'SHU251_ENV_COORDINATOR: GITHUB_TOKEN and LINEAR_API_TOKEN are required');", credentialRefusalNamedCheck],
];

// The reviewed refusal shape is what keeps the halt code's door closed, and it
// lives in the sibling journal module. Opened, an arbitrary string - an errno,
// an AssertionError, a credential-shaped value - would be reported as a halt
// code, so this mutant is killed by the closure proof directly.
export const PATTERN_MUTATION = Object.freeze(['the reviewed refusal shape admits arbitrary text', 'journal',
  'export const REFUSAL_CODE_PATTERN = /^(?:ACT|SHU251|SHU71)_[A-Z0-9_]{2,44}$/;',
  'export const REFUSAL_CODE_PATTERN = /.*/;']);

// The Linear MUTATION is still final on its first error - the guard on the read
// door is what proves it, so the mutant that opens that door is killed here.
export async function linearMutationStillUnretriedCheck(create, h) {
  clean(h);
  const linear = interceptLinear(h, kind => kind === 'mutation' ? apiFailure(503) : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_API_FAILED', 'B6_LINEAR_MUTATION_STILL_UNRETRIED');
  assert.equal(linear.count('mutation:'), 1, `B6_LINEAR_MUTATION_STILL_UNRETRIED ${JSON.stringify(linear.calls)}`);
  assert.equal(result.api_failure?.operation, 'linear:mutation:Shu71Fixture', 'B6_LINEAR_MUTATION_STILL_UNRETRIED');
  assert.equal(h.exists(ACTIVATION), false, 'B6_LINEAR_MUTATION_STILL_UNRETRIED');
}
