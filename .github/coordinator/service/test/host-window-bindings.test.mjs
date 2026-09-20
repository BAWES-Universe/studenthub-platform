import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { measureBranchHead, fetchBranchHead } from '../../reconcile.mjs';
import {
  BINDING_CODES, HostBindingHalt, capturePriorState, cleanupFixture, deliverStatusCredential,
  observeDriverQuiescence, observeFixtureLaunch, observeRemoteInventory, observeTransport,
  observeWorker, replayAndRelease, rollbackPriorState, validateWindowSpec,
  readRemoteWork, measureBranchHeadBounded, INVENTORY_READ,
  INVENTORY_MEASUREMENT, inventoryMeasurement, inventoryReadRetryable,
} from '../host-window-bindings.mjs';

const SHA = 'a'.repeat(40), ATTEMPT = '11111111-2222-4333-8444-555555555555';
const named = binding => error => error instanceof HostBindingHalt && error.code === BINDING_CODES[binding]
  && error.message.startsWith(`${BINDING_CODES[binding]}:`);

const PROCESS_TOKEN = '123456';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'shu251-bindings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), workspace = path.join(root, 'workspace'), state = path.join(root, 'state');
  const evidence = path.join(root, 'evidence'), units = path.join(root, 'units'), staged = path.join(root, 'staged');
  for (const dir of [repo, workspace, state, evidence, units, staged, path.join(state, 'launches')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const order = { version: '1.0.0', issue_id: 'SHU-140', attempt_id: ATTEMPT, target_sha: SHA,
    role: 'build', runtime: 'codex-cli', repo: 'BAWES-Universe/studenthub-platform', branch: 'fixture', authorization_ref: 'fixture', task_context: 'fixture' };
  const orderFile = path.join(evidence, 'order.json'), envFile = path.join(evidence, 'status.env');
  fs.writeFileSync(orderFile, JSON.stringify(order), { mode: 0o600 });
  fs.writeFileSync(envFile, `SHU_SUPERVISOR_SECRET=${'s'.repeat(40)}\n`, { mode: 0o600 });
  const spec = { version: 'shu251-host-window-v2', approved_sha: SHA, repo_dir: repo,
    remote_url: 'https://github.com/BAWES-Universe/studenthub-platform.git', remote_ref: 'refs/heads/main',
    workspace_state_dir: workspace, supervisor_state_dir: state, supervisor_socket: path.join(root, 'supervisor.sock'),
    status_environment_file: envFile, service_uid: process.getuid() === 0 ? 999 : process.getuid(), unit_directory: units, staged_unit_directory: staged,
    prior_state_file: path.join(evidence, 'prior.json'), fixture: { issue_id: 'SHU-140', attempt_id: ATTEMPT,
      target_sha: SHA, order_json: orderFile, release_file: path.join(evidence, 'release'),
      journal_file: path.join(evidence, 'worker.log'), pid: 4242, start_token: PROCESS_TOKEN } };
  fs.writeFileSync(path.join(state, 'launches', `${ATTEMPT}.json`), JSON.stringify({ issue_id: 'SHU-140', attempt_id: ATTEMPT,
    target_sha: SHA, phase: 'launched', pid: 4242, completion_token_hash: 'b'.repeat(64) }), { mode: 0o600 });
  for (const name of ['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer']) fs.writeFileSync(path.join(staged, name), `staged ${name}`, { mode: 0o644 });
  return { root, spec, order };
}

test('SHU251 operational bindings closed typed spec rejects free-form commands', t => {
  const { spec } = fixture(t);
  assert.equal(validateWindowSpec(spec), spec);
  assert.throws(() => validateWindowSpec({ ...spec, command: 'sh -c anything' }), named('remote_inventory'));
  const wrapper = path.resolve('.github/coordinator/service/shu251-operational-bindings.sh');
  const source = fs.readFileSync(wrapper, 'utf8');
  assert.doesNotMatch(source, /\beval\b|\bsh\s+-c\b|exec\s+"\$[A-Za-z_]/, 'SHU251_TYPED_ACTION: wrapper must not execute operator text');
  const rejected = spawnSync(wrapper, ['sh -c anything', '/tmp/spec.json'], { encoding: 'utf8' });
  assert.equal(rejected.status, 64, 'SHU251_TYPED_ACTION: unknown action must be rejected');
  assert.match(rejected.stderr, /SHU251_WINDOW_ACTION/, 'SHU251_TYPED_ACTION: unknown action must have typed output');
});

test('SHU251_REMOTE_INVENTORY positive control and mutation', async t => {
  const { spec } = fixture(t);
  const run = (_file, args) => args[0] === 'status' ? '' : args[0] === 'ls-remote' ? `${SHA}\trefs/heads/main` : SHA;
  const good = { run, readRemote: async () => ({ branch_head: SHA, comment_count: 3, comments_digest: 'd'.repeat(64) }) };
  assert.equal((await observeRemoteInventory(spec, good)).ok, true);
  const mutant = { run, readRemote: async () => ({ branch_head: 'c'.repeat(40), comment_count: 3, comments_digest: 'd'.repeat(64) }) };
  await assert.rejects(() => observeRemoteInventory(spec, mutant), named('remote_inventory'));
});

// A-11. `fetchBranchHead` answered null for a 429, a 5xx, a body that would not
// parse and a branch that genuinely does not exist alike, and the caller
// reported every one of them as "remote fixture inventory is incomplete or
// moved" - a claim about the remote that a read which never answered cannot
// support. The read is measured now, a transient answer is retried under a
// small fixed bound, and 404 stays terminal because an answer is not a race.
test('SHU251_REMOTE_INVENTORY distinguishes a failed read from a moved inventory', async t => {
  const { spec, order } = fixture(t);
  const env = { LINEAR_API_TOKEN: 'LINEAR_POISON', GITHUB_TOKEN: 'GITHUB_POISON' };
  const io = answers => {
    const seen = [], waits = [];
    const measure = async () => { const next = answers[Math.min(seen.length, answers.length - 1)]; seen.push(next); return next; };
    return { seen, waits, io: { measure, wait: async ms => { waits.push(ms); }, comments: async () => [] } };
  };
  const answered = sha => ({ ok: true, status: 200, sha });
  const run = (_file, args) => args[0] === 'status' ? '' : args[0] === 'ls-remote' ? `${SHA}\trefs/heads/main` : SHA;
  const inventory = async plan => {
    const { seen, waits, io: seams } = io(plan);
    const outcome = await observeRemoteInventory(spec, { run, readRemote: s => readRemoteWork(s, env, seams) })
      .catch(error => ({ halt: error }));
    return { outcome, seen, waits };
  };
  // One transient answer and the inventory still reads.
  const raced = await inventory([{ ok: false, status: 503, sha: null }, answered(spec.fixture.target_sha)]);
  assert.equal(raced.outcome.ok, true, `SHU251_INVENTORY_TRANSIENT_RETRIED ${raced.outcome.halt?.message}`);
  assert.equal(raced.seen.length, 2, 'SHU251_INVENTORY_TRANSIENT_RETRIED');
  assert.deepEqual(raced.waits, [INVENTORY_READ.delaysMs[0]], 'SHU251_INVENTORY_TRANSIENT_RETRIED');
  // A read that never answers halts under its OWN reason, naming the status,
  // and never claims the inventory moved.
  const failed = await inventory([{ ok: false, status: 503, sha: null }]);
  assert.ok(named('remote_inventory')(failed.outcome.halt), 'SHU251_INVENTORY_READ_FAILURE_NAMED');
  assert.match(failed.outcome.halt.message, /could not be read/, 'SHU251_INVENTORY_READ_FAILURE_NAMED');
  assert.doesNotMatch(failed.outcome.halt.message, /moved/, 'SHU251_INVENTORY_READ_FAILURE_NAMED');
  assert.equal(failed.outcome.halt.details.status, 503, 'SHU251_INVENTORY_READ_FAILURE_NAMED');
  assert.equal(failed.seen.length, INVENTORY_READ.attempts, 'SHU251_INVENTORY_READ_BOUNDED');
  // A 404 is an ANSWER, not a race: terminal on the first read.
  const absent = await inventory([{ ok: false, status: 404, sha: null }]);
  assert.ok(named('remote_inventory')(absent.outcome.halt), 'SHU251_INVENTORY_DEFINITIVE_TERMINAL');
  assert.equal(absent.seen.length, 1, 'SHU251_INVENTORY_DEFINITIVE_TERMINAL');
  assert.deepEqual(absent.waits, [], 'SHU251_INVENTORY_DEFINITIVE_TERMINAL');
  // A read that DID answer, with a head that is not the approved one, still
  // refuses as a moved inventory on that first answer and is never retried.
  const moved = await inventory([answered('c'.repeat(40))]);
  assert.ok(named('remote_inventory')(moved.outcome.halt), 'SHU251_INVENTORY_MOVED_STILL_REFUSES');
  assert.match(moved.outcome.halt.message, /incomplete or moved/, 'SHU251_INVENTORY_MOVED_STILL_REFUSES');
  assert.equal(moved.seen.length, 1, 'SHU251_INVENTORY_MOVED_STILL_REFUSES');
  // No token reaches any of it.
  for (const secret of ['GITHUB_POISON', 'LINEAR_POISON'])
    for (const { outcome } of [raced, failed, absent, moved])
      assert.ok(!JSON.stringify(outcome.halt?.message ?? outcome).includes(secret), `SHU251_INVENTORY_CARRIES_NO_SECRET ${secret}`);
  // fetchBranchHead itself is unchanged: the same null contract every existing
  // caller was written against, for every one of those answers.
  for (const plan of [[{ ok: false, status: 503, sha: null }], [{ ok: false, status: 404, sha: null }], [answered(null)]])
    assert.equal((await measureBranchHeadBounded({ repo: order.repo, branch: order.branch, token: 'x' },
      { measure: async () => plan[0], wait: async () => {} })).sha, null, 'SHU251_INVENTORY_SHA_CONTRACT');
});

// A-11, the condition the status class alone could not see. `ok` is the
// server's verdict on the REQUEST; a 2xx whose body will not yield the measured
// field is a FAILED MEASUREMENT, not the remote stating that its inventory
// moved, and it was reported as the latter after a single read. All four
// enumerated conditions are asserted here together, so the dispatch cannot be
// right for one and wrong for another: a transient non-2xx, a 2xx carrying no
// value, an answer that genuinely disagrees, and a definitive refusal.
test('SHU251_REMOTE_INVENTORY refuses a 2xx that carried no branch head as a failed measurement', async t => {
  const { spec } = fixture(t);
  const env = { LINEAR_API_TOKEN: 'LINEAR_POISON', GITHUB_TOKEN: 'GITHUB_POISON' };
  const run = (_file, args) => args[0] === 'status' ? '' : args[0] === 'ls-remote' ? `${SHA}\trefs/heads/main` : SHA;
  const inventory = async plan => {
    const seen = [], waits = [];
    const seams = { measure: async () => { const next = plan[Math.min(seen.length, plan.length - 1)]; seen.push(next); return next; },
      wait: async ms => { waits.push(ms); }, comments: async () => [] };
    const outcome = await observeRemoteInventory(spec, { run, readRemote: s => readRemoteWork(s, env, seams) })
      .catch(error => ({ halt: error }));
    return { outcome, seen, waits };
  };
  // Absent, null and unparseable are the same failure: the read answered and
  // carried no branch head. Each is retried under the READ policy and then
  // named as the measurement failure it is - never as a state of the remote.
  const valueless = [['null', { ok: true, status: 200, sha: null }], ['absent', { ok: true, status: 200 }],
    ['unparseable', { ok: true, status: 200, sha: 'not-a-sha' }], ['wrong shape', { ok: true, status: 200, sha: { commit: SHA } }]];
  for (const [label, answer] of valueless) {
    const { outcome, seen, waits } = await inventory([answer]);
    assert.ok(named('remote_inventory')(outcome.halt), `SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM ${label}`);
    assert.match(outcome.halt.message, /could not be read/, `SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM ${label}`);
    assert.doesNotMatch(outcome.halt.message, /moved/, `SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM ${label}`);
    assert.equal(outcome.halt.details.measurement, 'without_value', `SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM ${label}`);
    assert.equal(outcome.halt.details.status, 200, `SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM ${label}`);
    assert.equal(seen.length, INVENTORY_READ.attempts, `SHU251_INVENTORY_VALUELESS_RETRIED ${label}`);
    assert.deepEqual(waits, [...INVENTORY_READ.delaysMs], `SHU251_INVENTORY_VALUELESS_RETRIED ${label}`);
    // The refusal reports a closed measurement token and nothing a remote body
    // could have put there.
    assert.ok(Object.values(INVENTORY_MEASUREMENT).includes(outcome.halt.details.measurement), `SHU251_INVENTORY_MEASUREMENT_CLOSED ${label}`);
  }
  // One valueless answer and the inventory still reads, exactly as one 503 does.
  const raced = await inventory([{ ok: true, status: 200, sha: null }, { ok: true, status: 200, sha: spec.fixture.target_sha }]);
  assert.equal(raced.outcome.ok, true, `SHU251_INVENTORY_VALUELESS_RETRIED raced ${raced.outcome.halt?.message}`);
  assert.equal(raced.seen.length, 2, 'SHU251_INVENTORY_VALUELESS_RETRIED raced');
  assert.deepEqual(raced.waits, [INVENTORY_READ.delaysMs[0]], 'SHU251_INVENTORY_VALUELESS_RETRIED raced');
  // The transient non-2xx, at the DISPATCH and not only at the predicate: read
  // to the bound on the enumerated waits, then named as the failed measurement
  // it is, carrying the same closed token as every other failure to measure.
  for (const status of [503, 429]) {
    const { outcome, seen, waits } = await inventory([{ ok: false, status, sha: null }]);
    assert.ok(named('remote_inventory')(outcome.halt), `SHU251_INVENTORY_READ_FAILURE_NAMED ${status}`);
    assert.match(outcome.halt.message, /could not be read/, `SHU251_INVENTORY_READ_FAILURE_NAMED ${status}`);
    assert.doesNotMatch(outcome.halt.message, /moved/, `SHU251_INVENTORY_READ_FAILURE_NAMED ${status}`);
    assert.equal(outcome.halt.details.measurement, 'unanswered', `SHU251_INVENTORY_READ_FAILURE_NAMED ${status}`);
    assert.equal(outcome.halt.details.status, status, `SHU251_INVENTORY_READ_FAILURE_NAMED ${status}`);
    assert.equal(seen.length, INVENTORY_READ.attempts, `SHU251_INVENTORY_TRANSIENT_RETRIED ${status}`);
    assert.deepEqual(waits, [...INVENTORY_READ.delaysMs], `SHU251_INVENTORY_TRANSIENT_RETRIED ${status}`);
  }
  // A HELD measurement still speaks for the remote, however bad its answer is.
  // A head that disagrees and a head that is a well-formed nonsense sha are both
  // answers: one read, no retry, and the inventory's own refusal by its own name.
  for (const [label, sha] of [['moved', 'c'.repeat(40)], ['terrible but parseable', '0'.repeat(40)]]) {
    const { outcome, seen, waits } = await inventory([{ ok: true, status: 200, sha }]);
    assert.ok(named('remote_inventory')(outcome.halt), `SHU251_INVENTORY_HELD_STILL_NAMES_THE_INVENTORY ${label}`);
    assert.match(outcome.halt.message, /incomplete or moved/, `SHU251_INVENTORY_HELD_STILL_NAMES_THE_INVENTORY ${label}`);
    assert.doesNotMatch(outcome.halt.message, /could not be read/, `SHU251_INVENTORY_HELD_STILL_NAMES_THE_INVENTORY ${label}`);
    assert.equal(seen.length, 1, `SHU251_INVENTORY_HELD_STILL_NAMES_THE_INVENTORY ${label}`);
    assert.deepEqual(waits, [], `SHU251_INVENTORY_HELD_STILL_NAMES_THE_INVENTORY ${label}`);
  }
  // A definitive refusal is an answer about the request and is never re-read.
  for (const status of [400, 401, 403, 410, 422]) {
    const { outcome, seen, waits } = await inventory([{ ok: false, status, sha: null }]);
    assert.ok(named('remote_inventory')(outcome.halt), `SHU251_INVENTORY_DEFINITIVE_TERMINAL ${status}`);
    assert.match(outcome.halt.message, /could not be read/, `SHU251_INVENTORY_DEFINITIVE_TERMINAL ${status}`);
    assert.equal(outcome.halt.details.measurement, 'unanswered', `SHU251_INVENTORY_DEFINITIVE_TERMINAL ${status}`);
    assert.equal(seen.length, 1, `SHU251_INVENTORY_DEFINITIVE_TERMINAL ${status}`);
    assert.deepEqual(waits, [], `SHU251_INVENTORY_DEFINITIVE_TERMINAL ${status}`);
  }
  // The predicate itself, on every answer shape above: held is the only one that
  // may describe the world, and only held stops the read.
  for (const [read, measurement, retryable] of [
    [{ ok: true, status: 200, sha: SHA }, 'held', false],
    [{ ok: true, status: 200, sha: null }, 'without_value', true],
    [{ ok: true, status: 200 }, 'without_value', true],
    [{ ok: true, status: 200, sha: 'not-a-sha' }, 'without_value', true],
    [{ ok: false, status: 503, sha: null }, 'unanswered', true],
    [{ ok: false, status: 404, sha: null }, 'unanswered', false],
    [{ ok: false, status: 403, sha: null }, 'unanswered', false],
    [undefined, 'unanswered', false],
  ]) {
    assert.equal(inventoryMeasurement(read), measurement, `SHU251_INVENTORY_MEASUREMENT_CLOSED ${JSON.stringify(read)}`);
    assert.equal(inventoryReadRetryable(read), retryable, `SHU251_INVENTORY_MEASUREMENT_CLOSED ${JSON.stringify(read)}`);
  }
  // No token reaches any of it.
  for (const secret of ['GITHUB_POISON', 'LINEAR_POISON'])
    for (const plan of [[{ ok: true, status: 200, sha: null }], [{ ok: false, status: 403, sha: null }]]) {
      const { outcome } = await inventory(plan);
      assert.ok(!JSON.stringify(outcome.halt?.toJSON() ?? outcome).includes(secret), `SHU251_INVENTORY_CARRIES_NO_SECRET ${secret}`);
    }
});

// The measured read itself, at the transport, and the exact null contract
// `fetchBranchHead` keeps for every caller that was written against it.
test('SHU251_REMOTE_INVENTORY measures the branch read without changing fetchBranchHead', async () => {
  const request = { repo: 'o/r', branch: 'b', token: 'GITHUB_POISON' };
  const reply = (ok, status, body) => ({ ok, status, json: async () => body });
  for (const [label, fetchImpl, measured, sha] of [
    ['answered', async () => reply(true, 200, { commit: { sha: SHA } }), { ok: true, status: 200, sha: SHA }, SHA],
    ['rate limited', async () => reply(false, 429), { ok: false, status: 429, sha: null }, null],
    ['absent', async () => reply(false, 404), { ok: false, status: 404, sha: null }, null],
    ['unparsable', async () => ({ ok: true, status: 200, json: async () => { throw new Error('body'); } }), { ok: true, status: 200, sha: null }, null],
  ]) {
    assert.deepEqual(await measureBranchHead({ ...request, fetchImpl }), measured, `SHU251_BRANCH_READ_MEASURED ${label}`);
    assert.equal(await fetchBranchHead({ ...request, fetchImpl }), sha, `SHU251_BRANCH_READ_SHA_CONTRACT ${label}`);
  }
  // An incomplete request still answers without a call, and a transport fault
  // still THROWS out of both, exactly as it did before.
  let calls = 0;
  const counting = async () => { calls++; return reply(true, 200, { commit: { sha: SHA } }); };
  assert.deepEqual(await measureBranchHead({ repo: 'o/r', branch: 'b', token: '', fetchImpl: counting }), { ok: false, status: null, sha: null }, 'SHU251_BRANCH_READ_MEASURED incomplete');
  assert.equal(await fetchBranchHead({ repo: 'o/r', branch: 'b', token: '', fetchImpl: counting }), null, 'SHU251_BRANCH_READ_SHA_CONTRACT incomplete');
  assert.equal(calls, 0, 'SHU251_BRANCH_READ_MEASURED incomplete');
  const faulting = async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); };
  for (const read of [measureBranchHead, fetchBranchHead])
    await assert.rejects(() => read({ ...request, fetchImpl: faulting }), e => e.code === 'ECONNRESET', 'SHU251_BRANCH_READ_TRANSPORT_THROWS');
});

// One anchored substitution per mutant, loaded from a disposable path.
async function bindingMutant(t, target, before, after) {
  const urls = { bindings: new URL('../host-window-bindings.mjs', import.meta.url), reconcile: new URL('../../reconcile.mjs', import.meta.url) };
  const source = Object.fromEntries(Object.entries(urls).map(([key, url]) => [key, fs.readFileSync(url, 'utf8')]));
  assert.equal(source[target].split(before).length, 2, `SHU251_MUTATION_ANCHOR_UNIQUE ${target}`);
  const root = fs.mkdtempSync(path.join(tmpdir(), 'shu251-bindings-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rewrite = (text, url) => text.replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, prefix, quote, relative) =>
    `${prefix}${quote}${relative.endsWith('/reconcile.mjs') ? pathToFileURL(path.join(root, 'reconcile.mjs')).href : new URL(relative, url).href}${quote}`);
  fs.writeFileSync(path.join(root, 'reconcile.mjs'),
    rewrite(target === 'reconcile' ? source.reconcile.replace(before, after) : source.reconcile, urls.reconcile));
  const file = path.join(root, 'bindings.mjs');
  fs.writeFileSync(file, rewrite(target === 'bindings' ? source.bindings.replace(before, after) : source.bindings, urls.bindings));
  const bindings = await import(pathToFileURL(file));
  const reconcile = await import(pathToFileURL(path.join(root, 'reconcile.mjs')));
  return { ...bindings, measureBranchHead: reconcile.measureBranchHead, fetchBranchHead: reconcile.fetchBranchHead };
}
const READ_FAILURE_HALT = `  if (work?.branch_head_read) {
    const measurement = inventoryMeasurement(work.branch_head_read);
    if (measurement !== INVENTORY_MEASUREMENT.held)
      halt(binding, 'remote fixture inventory could not be read', { status: work.branch_head_read.status, measurement });
  }`;
const BOUNDED_READ_BREAK = '    if (inventoryMeasurement(measured) === INVENTORY_MEASUREMENT.held || !inventoryReadRetryable(measured) || attempt === INVENTORY_READ.attempts) break;';
for (const [name, target, before, after, assertion] of [
  ['a failed read is reported as a moved inventory again', 'bindings', READ_FAILURE_HALT, '', 'SHU251_INVENTORY_READ_FAILURE_NAMED'],
  ['the transient read is never retried', 'bindings', BOUNDED_READ_BREAK, '    break;', 'SHU251_INVENTORY_TRANSIENT_RETRIED'],
  ['a definitive absence is treated as a race', 'bindings',
    'statuses: Object.freeze([408, 425, 429, 500, 502, 503, 504])', 'statuses: Object.freeze([404, 408, 425, 429, 500, 502, 503, 504])',
    'SHU251_INVENTORY_DEFINITIVE_TERMINAL'],
  // A-11: the three ways back to dispatching on the STATUS CLASS instead of on
  // whether a measurement was obtained. Each reverts one clause to what this
  // correction replaced, and each dies on the 2xx-without-a-value answer.
  ['a 2xx that carried no branch head is reported as a moved inventory', 'bindings',
    '    if (measurement !== INVENTORY_MEASUREMENT.held)', '    if (work.branch_head_read.ok !== true)',
    'SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM'],
  ['a 2xx that carried no branch head is never re-read', 'bindings',
    'inventoryMeasurement(measured) === INVENTORY_MEASUREMENT.held || !inventoryReadRetryable(measured)', 'measured.ok',
    'SHU251_INVENTORY_VALUELESS_RETRIED'],
  ['any 2xx is treated as a held measurement', 'bindings',
    "  : SHA.test(read.sha ?? '') ? INVENTORY_MEASUREMENT.held : INVENTORY_MEASUREMENT.without_value;",
    '  : INVENTORY_MEASUREMENT.held;', 'SHU251_INVENTORY_MEASUREMENT_CLOSED'],
  ['a non-2xx answer is measured as though it answered', 'reconcile',
    '  if (!res.ok) return { ok: false, status: res.status, sha: null };', '  if (false) return { ok: false, status: res.status, sha: null };',
    'SHU251_BRANCH_READ_MEASURED'],
]) test(`SHU251_REMOTE_INVENTORY mutation: ${name}`, async t => {
  const mutant = await bindingMutant(t, target, before, after);
  const pattern = new RegExp(assertion);
  const run = async module => {
    if (assertion === 'SHU251_BRANCH_READ_MEASURED') {
      const reply = { ok: false, status: 429, json: async () => ({ commit: { sha: SHA } }) };
      assert.deepEqual(await module.measureBranchHead({ repo: 'o/r', branch: 'b', token: 't', fetchImpl: async () => reply }),
        { ok: false, status: 429, sha: null }, 'SHU251_BRANCH_READ_MEASURED rate limited');
      return;
    }
    const valueless = [{ ok: true, status: 200, sha: null }];
    const answers = { SHU251_INVENTORY_READ_FAILURE_NAMED: [{ ok: false, status: 503, sha: null }],
      SHU251_INVENTORY_TRANSIENT_RETRIED: [{ ok: false, status: 503, sha: null }, { ok: true, status: 200, sha: SHA }],
      SHU251_INVENTORY_DEFINITIVE_TERMINAL: [{ ok: false, status: 404, sha: null }],
      SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM: valueless,
      SHU251_INVENTORY_VALUELESS_RETRIED: valueless,
      SHU251_INVENTORY_MEASUREMENT_CLOSED: valueless }[assertion];
    const { spec } = fixture(t);
    const seen = [], waits = [];
    const seams = { measure: async () => { const next = answers[Math.min(seen.length, answers.length - 1)]; seen.push(next); return next; },
      wait: async ms => { waits.push(ms); }, comments: async () => [] };
    const run2 = (_file, args) => args[0] === 'status' ? '' : args[0] === 'ls-remote' ? `${SHA}\trefs/heads/main` : SHA;
    const outcome = await module.observeRemoteInventory(spec, { run: run2, readRemote: s => module.readRemoteWork(s, { LINEAR_API_TOKEN: 'l', GITHUB_TOKEN: 'g' }, seams) })
      .catch(error => ({ halt: error }));
    if (assertion === 'SHU251_INVENTORY_TRANSIENT_RETRIED') {
      assert.equal(outcome.ok, true, 'SHU251_INVENTORY_TRANSIENT_RETRIED');
      assert.equal(seen.length, 2, 'SHU251_INVENTORY_TRANSIENT_RETRIED');
    }
    if (assertion === 'SHU251_INVENTORY_READ_FAILURE_NAMED')
      assert.match(outcome.halt.message, /could not be read/, 'SHU251_INVENTORY_READ_FAILURE_NAMED');
    if (assertion === 'SHU251_INVENTORY_DEFINITIVE_TERMINAL') assert.equal(seen.length, 1, 'SHU251_INVENTORY_DEFINITIVE_TERMINAL');
    // The 2xx that carried no value: named as the failed measurement it is, and
    // re-read under the same policy as any other failed read.
    if (assertion === 'SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM') {
      assert.match(outcome.halt.message, /could not be read/, 'SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM');
      assert.equal(outcome.halt.details.measurement, 'without_value', 'SHU251_INVENTORY_VALUELESS_NOT_A_STATE_CLAIM');
    }
    if (assertion === 'SHU251_INVENTORY_VALUELESS_RETRIED')
      assert.equal(seen.length, INVENTORY_READ.attempts, 'SHU251_INVENTORY_VALUELESS_RETRIED');
    if (assertion === 'SHU251_INVENTORY_MEASUREMENT_CLOSED') {
      assert.match(outcome.halt?.message ?? 'armed', /could not be read/, 'SHU251_INVENTORY_MEASUREMENT_CLOSED');
      assert.equal(seen.length, INVENTORY_READ.attempts, 'SHU251_INVENTORY_MEASUREMENT_CLOSED');
    }
  };
  await run(await import('../host-window-bindings.mjs').then(async m => ({ ...m, measureBranchHead: (await import('../../reconcile.mjs')).measureBranchHead })));
  let killed = null;
  await assert.rejects(() => run(mutant), error => { killed = error; return error.code === 'ERR_ASSERTION' && pattern.test(error.message); },
    'SHU251_MUTATION_NAMED_ASSERTION');
  t.diagnostic(`killed by ${/SHU251_[A-Z_0-9]+/.exec(killed.message)?.[0]}`);
});

test('SHU251_STATUS_CREDENTIAL positive control and mutation', t => {
  const { spec } = fixture(t);
  const delivered = deliverStatusCredential(spec);
  assert.deepEqual(delivered.evidence.key_names, ['SHU_SUPERVISOR_SECRET']);
  assert.equal(Object.hasOwn(delivered.evidence, 'secret'), false);
  fs.chmodSync(spec.status_environment_file, 0o644);
  assert.throws(() => deliverStatusCredential(spec), named('status_credential_delivery'));
});

test('SHU251_DRIVER_QUIESCENCE positive control and mutation', t => {
  const { spec } = fixture(t);
  const good = { serviceState: () => 'inactive', run: () => '' };
  assert.equal(observeDriverQuiescence(spec, good).writer_lock, 'free');
  assert.throws(() => observeDriverQuiescence(spec, { ...good, serviceState: (_kind, unit) => unit.endsWith('.timer') ? 'active' : 'inactive' }), named('driver_quiescence'));
});

test('SHU251_FIXTURE_LAUNCH positive control and mutation', t => {
  const { spec } = fixture(t), file = path.join(spec.supervisor_state_dir, 'launches', `${ATTEMPT}.json`);
  assert.equal(observeFixtureLaunch(spec, { readStartToken: () => PROCESS_TOKEN }).pid, 4242);
  const receipt = JSON.parse(fs.readFileSync(file)); receipt.target_sha = 'c'.repeat(40); fs.writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => observeFixtureLaunch(spec, { readStartToken: () => PROCESS_TOKEN }), named('fixture_launch_observation'));
});

test('SHU251_WORKER_OBSERVATION positive control and mutation', t => {
  const { spec } = fixture(t);
  assert.equal(observeWorker(spec, { readStartToken: () => PROCESS_TOKEN }).start_token, PROCESS_TOKEN);
  assert.throws(() => observeWorker(spec, { readStartToken: () => '654321' }), named('worker_observation'));
});

test('SHU251_TRANSPORT_OBSERVATION positive control and mutation', async t => {
  const { spec } = fixture(t);
  const credential = () => ({ secret: 's'.repeat(40), evidence: { key_names: ['SHU_SUPERVISOR_SECRET'] } });
  const status = async () => ({ ok: true, stage: 'RUNNING', attempt_id: ATTEMPT, target_sha: SHA });
  const socketStat = () => ({ isSocket: () => true, isSymbolicLink: () => false });
  assert.equal((await observeTransport(spec, { credential, status, socketStat })).stage, 'RUNNING');
  await assert.rejects(() => observeTransport(spec, { credential, socketStat, status: async () => { throw new Error('mutant transport'); } }), named('transport_observation'));
});

test('SHU251_REPLAY_RELEASE positive control and mutation', async t => {
  const { spec } = fixture(t);
  const credential = () => ({ secret: 's'.repeat(40), evidence: {} });
  const observeLaunch = () => ({ pid: 4242, start_token: PROCESS_TOKEN }), observeLiveWorker = () => ({ pid: 4242, start_token: PROCESS_TOKEN });
  assert.equal((await replayAndRelease(spec, { credential, submit: async () => ({ ok: true, duplicate: true, status: 'RUNNING' }), observeLaunch, observeLiveWorker })).released, true);
  fs.rmSync(spec.fixture.release_file);
  await assert.rejects(() => replayAndRelease(spec, { credential, submit: async () => ({ ok: false, stage: 'HOLD' }), observeLaunch, observeLiveWorker }), named('replay_release'));
});

test('SHU251_FIXTURE_CLEANUP positive control and mutation', t => {
  const { spec } = fixture(t), signals = [];
  fs.writeFileSync(spec.fixture.release_file, 'release'); fs.writeFileSync(spec.fixture.journal_file, 'journal');
  const observeLaunch = () => ({ pid: 4242, start_token: PROCESS_TOKEN });
  assert.equal(cleanupFixture(spec, { signal: (...args) => signals.push(args), observeLaunch, waitForExit: () => true }).signaled_pid, 4242);
  assert.deepEqual(signals, [[4242, 'SIGTERM']]);
  const outside = path.join(spec.repo_dir, 'outside.log'); fs.writeFileSync(outside, 'x');
  const mutant = { ...spec, fixture: { ...spec.fixture, journal_file: outside } };
  fs.writeFileSync(spec.fixture.release_file, 'release');
  assert.throws(() => cleanupFixture(mutant, { signal: () => {}, observeLaunch, waitForExit: () => true }), named('fixture_cleanup'));
});

test('SHU251_PRIOR_STATE_ROLLBACK positive control and mutation', t => {
  const { spec } = fixture(t), unit = path.join(spec.unit_directory, 'shu-supervisor.service');
  fs.writeFileSync(unit, 'prior', { mode: 0o640 });
  const states = { serviceState: kind => kind === 'is-active' ? 'inactive' : 'disabled', run: () => '' };
  assert.equal(capturePriorState(spec, states).ok, true);
  fs.writeFileSync(unit, 'staged shu-supervisor.service');
  assert.equal(rollbackPriorState(spec, { run: () => '' }).ok, true);
  assert.equal(fs.readFileSync(unit, 'utf8'), 'prior');
  const prior = JSON.parse(fs.readFileSync(spec.prior_state_file)); prior.approved_sha = 'c'.repeat(40); fs.writeFileSync(spec.prior_state_file, JSON.stringify(prior));
  assert.throws(() => rollbackPriorState(spec, { run: () => '' }), named('prior_state_rollback'));
});

test('SHU251_UNEXPECTED: non-directory unit_directory reaches ENOTDIR', t => {
  const { root, spec } = fixture(t);
  fs.rmdirSync(spec.unit_directory);
  fs.writeFileSync(spec.unit_directory, 'fixture regular file');
  assert.throws(() => capturePriorState(spec, {
    serviceState: () => assert.fail('SHU251_UNEXPECTED: must fail before service access'),
  }), { code: 'ENOTDIR' }, 'SHU251_UNEXPECTED: non-directory example is reachable');
  const specFile = path.join(root, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const run = spawnSync(process.execPath, [new URL('../host-window-bindings.mjs', import.meta.url).pathname,
    'capture-prior', specFile], { encoding: 'utf8' });
  assert.equal(run.status, 2, 'SHU251_UNEXPECTED: CLI failure exit');
  const error = JSON.parse(run.stderr);
  assert.equal(error.ok, false, 'SHU251_UNEXPECTED: CLI failure contract');
  assert.equal(error.code, 'SHU251_UNEXPECTED', 'SHU251_UNEXPECTED: CLI classifies ENOTDIR');
  assert.match(error.reason, /ENOTDIR/, 'SHU251_UNEXPECTED: CLI preserves reason');
  assert.equal(Object.hasOwn(error, 'binding'), false, 'SHU251_UNEXPECTED: no binding name');
});

test('SHU251 operational wrapper routes every reviewed lifecycle action without host effects', t => {
  const { root } = fixture(t);
  const wrapper = path.resolve('.github/coordinator/service/shu251-operational-bindings.sh');
  const window = { approved_sha: SHA, repo_dir: root };
  const windowFile = path.join(root, 'window.json'), driverFile = path.join(root, 'driver.json');
  fs.writeFileSync(windowFile, JSON.stringify(window));
  fs.writeFileSync(driverFile, JSON.stringify({ window, window_spec_path: windowFile, render: { workdir: root } }));
  const actions = ['preflight', 'install', 'start', 'readiness', 'running-gate-off', 'restart', 'host-rollback', 'pin', 'pin-restore', 'pin-retain'];
  for (const action of actions) {
    const result = spawnSync(wrapper, [action, driverFile, '--approved-host-mutation', SHA], {
      encoding: 'utf8', env: { ...process.env, SHU251_HOST_MUTATION_APPROVED: 'true' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).step, action);
    assert.equal(JSON.parse(result.stdout).dry_run, true);
    if (action !== 'preflight') {
      const denied = spawnSync(wrapper, [action, driverFile, '--execute'], {
        encoding: 'utf8', env: { ...process.env, SHU251_HOST_MUTATION_APPROVED: '' },
      });
      assert.equal(denied.status, 2);
      assert.equal(JSON.parse(denied.stderr).code, 'SHU251_HOST_MUTATION_APPROVAL');
    }
  }
  const unknown = spawnSync(wrapper, ['untested-new-action', driverFile], { encoding: 'utf8' });
  assert.equal(unknown.status, 64);
  assert.equal(JSON.parse(unknown.stderr).code, 'SHU251_WINDOW_ACTION');
  const override = spawnSync(wrapper, ['install', driverFile, '--provider', '/attacker.mjs'], { encoding: 'utf8' });
  assert.equal(override.status, 2);
  assert.equal(JSON.parse(override.stderr).code, 'SHU251_DRIVER_USAGE');
});
