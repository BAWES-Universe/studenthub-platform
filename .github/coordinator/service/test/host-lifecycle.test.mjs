import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { drive, hash, canonical, UNIT_NAMES, LIFECYCLE_ACTIONS, validateReceipt } from '../phase-a-driver.mjs';
import { FILES, TARGETS, DROP_IN_DIRECTORIES, expectedManifest, REQUIRED_CAPABILITIES, executeLifecycle } from '../host-lifecycle.mjs';

const SHA = 'a'.repeat(40), OLD = 'b'.repeat(40);
const approved = { execute: true, approvedHostMutation: SHA, env: { SHU251_HOST_MUTATION_APPROVED: 'true' } };
const clone = v => structuredClone(v);
const named = code => e => e.code === code;
import { fixture } from './lifecycle-fixture.mjs';
async function installed(f) { await f.run('install'); }
async function started(f) { await installed(f); await f.run('start'); }

test('LIFECYCLE complete fake-only typed action control', async () => {
  const f = fixture(), prior = clone(f.state);
  const pre = await f.run('preflight'); validateReceipt(pre, 'preflight', f.spec);
  await f.run('pin'); await f.run('pin-retain'); await started(f); await f.run('readiness');
  const restart = await f.run('restart');
  assert.equal(restart.evidence.after.readiness.invocation_id, 'e'.repeat(32));
  assert.equal(f.journal.restart.record.receipt.evidence.invocation_id, 'd'.repeat(32));
  await f.run('host-rollback'); await f.run('pin-restore');
  assert.deepEqual(f.state, prior);
  assert.deepEqual(new Set([pre.step, ...f.journal.receipts.map(r => r.step)]), new Set(Object.keys(LIFECYCLE_ACTIONS)));
  for (const r of f.journal.receipts) validateReceipt(r, r.step, f.spec);
  assert.equal(f.calls.filter(c => c.verb === 'restart').length, 1);
});
test('LIFECYCLE dry run and all mutation approvals have zero effects', async () => {
  for (const step of Object.keys(LIFECYCLE_ACTIONS)) {
    const f = fixture();
    assert.equal((await f.run(step, { ...approved, execute: false })).dry_run, true);
    if (step !== 'preflight') await assert.rejects(() => f.run(step, { execute: true }), named('SHU251_HOST_MUTATION_APPROVAL'));
    assert.deepEqual(f.calls, []); assert.equal(f.journal, null);
  }
});

// Every row runs a permitted control, then changes one input/observation/effect.
// The separate mutation harness removes only the named invariant family.
const guards = [
  ['SHU251_LIFECYCLE_SPEC', 'preflight', f => { f.spec.window.unit_directory = '/unreviewed'; }],
  ['SHU251_LIFECYCLE_PATHS', 'preflight', f => { f.spec.lifecycle.evidence_dir = f.spec.lifecycle.evidence_root; }],
  ['SHU251_LIFECYCLE_INPUT', 'preflight', f => {}, null, { ...approved, command: 'systemctl anything' }],
  ['SHU251_LIFECYCLE_IO', 'preflight', f => { delete f.host.save; }],
  ['SHU251_LIFECYCLE_CHECKOUT', 'preflight', f => { f.overrides.probe = p => ({ ...p, checkout: { ...p.checkout, clean: false } }); }],
  ['SHU251_LIFECYCLE_IDENTITY', 'preflight', f => { f.overrides.probe = p => ({ ...p, identity: { ...p.identity, uid: 0 } }); }],
  ['SHU251_LIFECYCLE_ENVIRONMENT', 'preflight', f => { f.overrides.probe = p => ({ ...p, environment: { ...p.environment, value: 'must-not-leak' } }); }],
  ['SHU251_LIFECYCLE_DIRECTORIES', 'preflight', f => { f.overrides.probe = p => ({ ...p, directories: [] }); }],
  ['SHU251_LIFECYCLE_CAPABILITIES', 'preflight', f => { f.overrides.probe = p => ({ ...p, capabilities: [] }); }],
  ['SHU251_LIFECYCLE_EVIDENCE', 'preflight', f => { f.overrides.probe = p => ({ ...p, evidence: { ...p.evidence, path: f.spec.lifecycle.evidence_root } }); }],
  ['SHU251_WRITER_LOCK', 'preflight', f => { f.overrides.probe = p => ({ ...p, writer_lock: 'busy' }); }],
  ['SHU251_DESTINATION', 'preflight', f => { f.overrides.probe = p => ({ ...p, destination: { ...p.destination, canonical: '/substituted' } }); }],
  ['SHU251_LIFECYCLE_SNAPSHOT', 'pin', f => { f.state.files[FILES[0]] = { kind: 'socket' }; }],
  ['SHU251_LIFECYCLE_ROLLBACK_REENABLE', 'install', f => { f.state.enabled[UNIT_NAMES[0]] = 'enabled'; }],
  ['SHU251_LIFECYCLE_JOURNAL', 'pin-retain', f => { f.overrides.load = j => ({ ...j, binding: { ...j.binding, activation_id: 'forged-run' } }); }, f => f.run('pin')],
  ['SHU251_LIFECYCLE_INTENT', 'pin-retain', f => {
    f.overrides.load = j => { j.entries[0].after = 'f'.repeat(40); return j; };
  }, f => f.run('pin')],
  ['SHU251_LIFECYCLE_DURABILITY', 'pin', f => { f.faults.save = () => true; }],
  ['SHU251_LIFECYCLE_RENDER', 'install', f => { f.units[UNIT_NAMES[0]] += '# substituted\n'; }],
  ['SHU251_LIFECYCLE_STAGE', 'install', f => { f.overrides.stage = s => ({ ...s, units: { ...s.units, [FILES[0]]: s.units[FILES[0]] + '\n' } }); }],
  ['SHU251_OWNER', 'install', f => { f.overrides.stage = s => ({ ...s, uid: 0 }); }],
  ['SHU251_PRIVATE', 'install', f => { f.overrides.stage = s => ({ ...s, mode: 0o777 }); }],
  ['SHU251_LIFECYCLE_PLACE', 'install', f => { f.faults.before = (v, n) => v === 'place' && n === FILES[1]; }],
  ['SHU251_LIFECYCLE_RELOAD', 'install', f => { f.faults.before = v => v === 'daemon-reload'; }],
  ['SHU251_LIFECYCLE_ENABLE', 'start', f => { f.faults.before = v => v === 'enable'; }, installed],
  ['SHU251_LIFECYCLE_START', 'start', f => { f.faults.before = v => v === 'start'; }, installed],
  ['SHU251_LIFECYCLE_PIN', 'pin', f => { f.faults.before = v => v === 'pin'; }],
  ['SHU251_LIFECYCLE_SUBSTITUTION', 'install', f => {
    f.state.files[FILES[0]] = { kind: 'symlink', target: '/dev/null', uid: 0, gid: 0 };
  }, async f => {
    f.faults.before = (v, n) => v === 'place' && n === FILES[0]; await assert.rejects(() => installed(f), named('SHU251_LIFECYCLE_PLACE')); f.faults.before = null;
  }],
  ['SHU251_LIFECYCLE_EFFECT', 'pin', f => { f.host.pin = async () => true; }],
  ['SHU251_LIFECYCLE_ORDER', 'install', f => {}, started],
  ['SHU251_LIFECYCLE_INSTALLED', 'start', f => { f.state.files[FILES[0]].data = Buffer.from('changed bytes').toString('base64'); }, installed],
  ['SHU251_LIFECYCLE_READINESS', 'readiness', f => { f.overrides.readiness = r => ({ ...r, runtime_dispatch: true }); }, started],
  ['SHU251_LIFECYCLE_RESTART', 'restart', f => { f.faults.before = v => v === 'restart'; }, started],
  ['SHU251_LIFECYCLE_ROLLBACK', 'host-rollback', f => { f.faults.before = v => v === 'stop'; }, started],
  ['SHU251_LIFECYCLE_ROLLBACK_EQUALITY', 'host-rollback', f => {
    const call = f.host.systemd; f.host.systemd = (v, n) => v === 'stop' ? true : call(v, n);
  }, started],
  ['SHU251_LIFECYCLE_PIN_RESTORE', 'pin-restore', f => {}, f => f.run('pin')],
  ['SHU251_LIFECYCLE_PIN_RETAIN', 'pin-retain', f => { f.state.pin.sha = OLD; }, f => f.run('pin')],
];
const positive = {
  SHU251_LIFECYCLE_ORDER: async f => { await installed(f); },
  SHU251_LIFECYCLE_PIN_RESTORE: async f => { await f.run('pin'); await f.run('host-rollback'); },
};
for (const [code, step, alter, prepare, opts] of guards) test(`LIFECYCLE guard ${code}`, async () => {
  const control = fixture();
  if (positive[code]) await positive[code](control); else if (prepare) await prepare(control);
  const good = await control.run(step); validateReceipt(good, step, control.spec);
  const f = fixture(); if (prepare) await prepare(f); alter(f);
  await assert.rejects(() => f.run(step, opts ?? approved), named(code), `${code}_REQUIRED`);
});

test('LIFECYCLE guard SHU251_LIFECYCLE_RECEIPT', async () => {
  const f = fixture(), r = await f.run('preflight'); validateReceipt(r, r.step, f.spec);
  r.evidence.activation_id = 'forged-activation'; r.evidence_sha256 = hash(canonical(r.evidence));
  assert.throws(() => validateReceipt(r, r.step, f.spec), named('SHU251_LIFECYCLE_RECEIPT'), 'SHU251_LIFECYCLE_RECEIPT_REQUIRED');
});

for (const [step, prepare] of [['install', null], ['start', installed], ['host-rollback', started], ['pin', null],
  ['pin-restore', async f => { await f.run('pin'); await f.run('host-rollback'); }]]) {
  for (const side of ['before', 'after']) test(`LIFECYCLE recovery ${step} every ${side} effect boundary`, async () => {
    const control = fixture(); if (prepare) await prepare(control);
    const offset = control.calls.length; await control.run(step);
    const boundaries = control.calls.length - offset;
    assert.ok(boundaries > 0);
    for (let i = 1; i <= boundaries; i++) {
      const f = fixture(); if (prepare) await prepare(f);
      const start = f.calls.length;
      f.faults[side] = (v, n, index) => index === start + i;
      await assert.rejects(() => f.run(step), e => /^SHU251_LIFECYCLE_/.test(e.code), `boundary ${i} refuses partial success`);
      assert.ok(f.journal, 'the intent is durable');
      f.faults[side] = null;
      await f.run(step);
      assert.deepEqual(f.state, control.state, `boundary ${i} resumes to the same exact state`);
      if (!['host-rollback', 'pin-restore'].includes(step)) await f.run('host-rollback');
      await f.run('pin-restore');
      assert.deepEqual(f.state, f.journal.prior, `boundary ${i} restores complete prior state`);
    }
  });
  test(`LIFECYCLE recovery ${step} every journal durability boundary`, async () => {
    const control = fixture(); if (prepare) await prepare(control);
    let boundaries = 0; control.faults.save = () => { boundaries++; return false; }; await control.run(step);
    for (const side of ['save', 'saveAfter']) for (let i = 1; i <= boundaries; i++) {
      const f = fixture(); if (prepare) await prepare(f);
      let writes = 0; f.faults[side] = () => ++writes === i;
      await assert.rejects(() => f.run(step), named('SHU251_LIFECYCLE_DURABILITY'), `journal boundary ${i}`);
      f.faults[side] = null;
      await f.run(step);
      assert.deepEqual(f.state, control.state, `journal boundary ${i} resumes`);
    }
  });
}

test('LIFECYCLE partial install can roll back directly without finishing installation', async () => {
  for (let i = 1; i <= TARGETS.length + 1; i++) {
    const f = fixture(), prior = clone(f.state);
    f.faults.after = (v, n, index) => index === i;
    await assert.rejects(() => installed(f));
    f.faults.after = null;
    await f.run('host-rollback');
    assert.deepEqual(f.state, prior);
  }
});
test('LIFECYCLE rollback restores exact bytes modes absence and masked symlink in reverse order', async () => {
  const f = fixture();
  f.state.files[FILES[0]] = { kind: 'file', data: Buffer.from('[Service]\nEnvironment=ENABLE_DISPATCH=false\n# prior revision\n').toString('base64'), mode: 0o640, uid: 0, gid: 0 };
  f.state.files[FILES[1]] = { kind: 'symlink', target: '/dev/null', uid: 0, gid: 0 };
  f.state.files[DROP_IN_DIRECTORIES[0]] = { kind: 'directory', uid: 0, gid: 0, mode: 0o700 };
  const before = clone(f.state);
  await started(f);
  f.calls.length = 0;
  await f.run('host-rollback');
  assert.deepEqual(f.state, before);
  assert.deepEqual(f.calls.filter(c => c.verb === 'place').map(c => c.target), [...TARGETS].reverse());
  assert.deepEqual(f.calls.filter(c => c.verb === 'stop').map(c => c.target), [...UNIT_NAMES].reverse().filter(n => n !== 'shu-coordinator.service'));
  const count = f.calls.length;
  await f.run('host-rollback');
  assert.equal(f.calls.length - count, 1, 'completed rollback only reloads and verifies');
});
test('LIFECYCLE restart consumption rejects replay and survives ambiguous process failure', async () => {
  for (const side of ['before', 'after']) {
    const f = fixture(); await started(f);
    f.faults[side] = v => v === 'restart';
    await assert.rejects(() => f.run('restart'), named('SHU251_LIFECYCLE_RESTART'));
    f.faults[side] = null;
    await assert.rejects(() => f.run('restart'), named('SHU251_RESTART_REPLAYED'));
    assert.equal(f.calls.filter(c => c.verb === 'restart').length, 1);
    await f.run('host-rollback'); assert.deepEqual(f.state, f.journal.prior);
  }
});
test('LIFECYCLE restart retains existing custody forgery cross-run and position guards', async () => {
  for (const [code, corrupt] of [
    ['SHU251_RESTART_FORGED', j => { j.restart.record.receipt.evidence.invocation_id = 'f'.repeat(32); }],
    ['SHU251_RESTART_CROSS_RUN', j => { j.restart.custody.identity.approved_sha = OLD; }],
    ['SHU251_RESTART_SUBSTITUTED', j => { j.restart.record.position = 'restart-after'; }],
  ]) {
    const f = fixture(); await started(f); await f.run('restart');
    f.overrides.load = j => { corrupt(j); return j; };
    await assert.rejects(() => f.run('readiness'), named(code));
  }
  const f = fixture(); await started(f);
  await assert.rejects(() => f.run('restart', { ...approved, before: {} }), named('SHU251_RESTART_CALLER_BEFORE'));
  f.overrides.readiness = r => ({ ...r, invocation_id: 'd'.repeat(32) });
  await assert.rejects(() => f.run('restart'), named('SHU251_RESTART_ACCEPTANCE'));
});
test('LIFECYCLE mutually exclusive writers cannot issue duplicate service operations', async () => {
  const f = fixture(); await installed(f);
  const results = await Promise.allSettled([f.run('start'), f.run('start')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'SHU251_WRITER_LOCK');
  assert.equal(f.calls.filter(c => c.verb === 'start').length, 3);
});

const codes = [...guards.map(g => g[0]), 'SHU251_LIFECYCLE_RECEIPT'];
for (const code of codes) test(`LIFECYCLE named mutation ${code}`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'test'));
  for (const module of ['phase-a-driver', 'host-lifecycle', 'host-suite-contract']) fs.copyFileSync(new URL(`../${module}.mjs`, import.meta.url), path.join(root, `${module}.mjs`));
  fs.copyFileSync(new URL('./lifecycle-fixture.mjs', import.meta.url), path.join(root, 'test/lifecycle-fixture.mjs'));
  fs.copyFileSync(new URL('./host-lifecycle.test.mjs', import.meta.url), path.join(root, 'test/host-lifecycle.test.mjs'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ['--test', `--test-name-pattern=^LIFECYCLE guard ${code}$`, path.join(root, 'test/host-lifecycle.test.mjs')],
    { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  const control = run();
  assert.equal(control.status, 0, control.stdout + control.stderr);
  assert.match(control.stdout, /^# pass 1$/m); assert.match(control.stdout, /^# fail 0$/m);
  const file = path.join(root, code === 'SHU251_LIFECYCLE_RECEIPT' ? 'phase-a-driver.mjs' : 'host-lifecycle.mjs');
  const source = fs.readFileSync(file, 'utf8');
  const from = code === 'SHU251_LIFECYCLE_RECEIPT' ? 'if (Object.hasOwn(LIFECYCLE_ACTIONS, step) && !(value.evidence.binding' : 'if (!condition) refuse(code);';
  const to = code === 'SHU251_LIFECYCLE_RECEIPT' ? 'if (false && Object.hasOwn(LIFECYCLE_ACTIONS, step) && !(value.evidence.binding' : `if (!condition && code !== '${code}') refuse(code);`;
  assert.equal(source.split(from).length, 2, 'one unique syntactic guard mutation');
  fs.writeFileSync(file, source.replace(from, to));
  assert.equal(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status, 0, 'syntax-clean mutation');
  const mutant = run(), output = mutant.stdout + mutant.stderr;
  assert.equal(mutant.status, 1, output);
  assert.match(output, /^# fail 1$/m);
  assert.match(output, /name: 'AssertionError'/); assert.match(output, /code: 'ERR_ASSERTION'/);
  assert.match(output, /failureType: 'testCodeFailure'/);
  assert.ok(output.includes(`${code}_REQUIRED`), `named assertion kills ${code}: ${output}`);
  assert.doesNotMatch(output, /SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/, 'crashes are not mutation kills');
});

test('LIFECYCLE byte-exact rollback preserves non-UTF8 prior bytes and every safe enablement state', async () => {
  for (const enabled of ['disabled', 'masked', 'static', 'indirect', 'not-found']) {
    const f = fixture();
    f.state.files[FILES[0]] = { kind: 'file', mode: 0o600, uid: 0, gid: 0,
      data: Buffer.concat([Buffer.from('[Service]\nEnvironment=ENABLE_DISPATCH=false\n# old '), Buffer.from([0xff, 0xfe])]).toString('base64') };
    f.state.enabled[UNIT_NAMES[0]] = enabled;
    const prior = clone(f.state); await started(f); await f.run('host-rollback');
    assert.deepEqual(f.state, prior, enabled);
  }
});
test('LIFECYCLE preflight mismatches are refused without rendering or exposing environment values', async () => {
  const changes = [
    ['SHU251_LIFECYCLE_CHECKOUT', p => { p.checkout.sha = OLD; }],
    ['SHU251_LIFECYCLE_CHECKOUT', p => { p.checkout.tree = OLD; }],
    ['SHU251_LIFECYCLE_IDENTITY', p => { p.identity.groups.push(1003); }],
    ['SHU251_LIFECYCLE_ENVIRONMENT', p => { p.environment.supervisor.mode = 0o644; }],
    ['SHU251_LIFECYCLE_ENVIRONMENT', p => { p.environment.coordinator.uid = 0; }],
    ['SHU251_LIFECYCLE_ENVIRONMENT', p => { p.environment.supervisor.kind = 'symlink'; }],
    ['SHU251_LIFECYCLE_ENVIRONMENT', p => { p.environment.coordinator.path = '/etc/shu/supervisor.env'; }],
    ['SHU251_LIFECYCLE_CAPABILITIES', p => { p.systemd_version--; }],
    ['SHU251_LIFECYCLE_EVIDENCE', p => { p.evidence.manifest.approval_sha256 = hash('other'); }],
  ];
  for (const [code, change] of changes) {
    const f = fixture(); f.io.render = () => assert.fail('metadata preflight never renders or reads environment contents');
    f.overrides.probe = p => { change(p); return p; };
    await assert.rejects(() => f.run('preflight'), named(code));
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(); f.host.probe = () => { throw new Error('secret-value-from-broken-provider'); };
  await assert.rejects(() => f.run('preflight'), e => e.code === 'SHU251_LIFECYCLE_IO' && !e.message.includes('secret-value'));
});
test('LIFECYCLE readiness proves all observations and refuses dispatch or identity drift', async () => {
  const changes = [r => { r.identity.uid = 0; }, r => { r.listeners = []; }, r => { r.supervisor = 'starting'; },
    r => { r.coordinator = 'failed'; }, r => { r.committed_dispatch = true; }, r => { r.runtime_dispatch = true; }];
  for (const change of changes) {
    const f = fixture(); await started(f); f.overrides.readiness = r => { change(r); return r; };
    await assert.rejects(() => f.run('readiness'), named('SHU251_LIFECYCLE_READINESS'));
  }
});
test('LIFECYCLE restart journal failure never allows a second consumed restart', async () => {
  const control = fixture(); await started(control);
  let boundaries = 0; control.faults.save = () => { boundaries++; return false; }; await control.run('restart');
  for (const side of ['save', 'saveAfter']) for (let i = 1; i <= boundaries; i++) {
    const f = fixture(); await started(f); let calls = 0;
    f.faults[side] = () => ++calls === i;
    await assert.rejects(() => f.run('restart'), named('SHU251_LIFECYCLE_DURABILITY'));
    f.faults[side] = null;
    if (f.journal.restart) await assert.rejects(() => f.run('restart'), named('SHU251_RESTART_REPLAYED'));
    else await f.run('restart');
    assert.ok(f.calls.filter(c => c.verb === 'restart').length <= 1, 'an ambiguous custody commit never reissues restart');
    await f.run('host-rollback'); assert.deepEqual(f.state, f.journal.prior);
  }
});


test('LIFECYCLE internal executor also enforces approval and execute intent', async () => {
  const f = fixture();
  await assert.rejects(() => executeLifecycle('install', f.spec, {}, f.io), named('SHU251_HOST_MUTATION_APPROVAL'));
  await assert.rejects(() => executeLifecycle('install', f.spec, { ...approved, execute: false }, f.io), named('SHU251_LIFECYCLE_INPUT'));
  assert.deepEqual(f.calls, []); assert.equal(f.journal, null);
});
