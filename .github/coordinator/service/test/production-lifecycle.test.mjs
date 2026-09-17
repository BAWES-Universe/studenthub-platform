import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { productionFixture } from './production-fixture.mjs';
import { createProductionLifecycle } from '../production-lifecycle.mjs';
import { FILES } from '../host-lifecycle.mjs';
import { main, defaultIO, hash, canonical } from '../phase-a-driver.mjs';
const named = code => e => e.code === code;
const absent = { kind: 'absent' };
const data = { kind: 'file', data: Buffer.from('bytes').toString('base64'), uid: 0, gid: 0, mode: 0o644 };

test('PROVIDER complete real provider recorded-boundary lifecycle', async t => {
  const f = productionFixture(t, { operations: ['pin', 'pin-retain', 'install', 'start', 'readiness', 'restart', 'host-rollback', 'pin-restore'] }), prior = f.provider.snapshot();
  assert.equal((await f.run('preflight')).evidence.after.writer_lock, undefined);
  await f.run('pin'); await f.run('pin-retain'); await f.run('install'); await f.run('start'); await f.run('readiness'); await f.run('restart');
  await f.run('host-rollback'); await f.run('pin-restore');
  assert.deepEqual(f.provider.snapshot(), prior);
  assert.ok(f.events.some(e => e[0] === 'fsync' && e[2] === 'file'));
  assert.ok(f.events.some(e => e[0] === 'fsync' && e[2] === 'directory'));
  assert.ok(f.commands.some(c => c.file === '/usr/bin/git' && c.args.includes('update-ref')));
});

// Inject completed timer ticks at every recorded syscall/command boundary, not
// elapsed-time sleeps. The fixture models flock conflict as Result=success/exit 2.
test('DETERMINISM readiness restart scheduled ticks never conflict with driver custody', async t => {
  let points = 0, ticks = 0;
  for (const step of ['readiness', 'restart']) for (const phase of ['before', 'after']) {
    const f = productionFixture(t, { operations: ['install', 'start', step] });
    await f.run('install'); await f.run('start');
    let journalSeen = false, journalReleased = false, commands = new Set(), conflicts = 0;
    f.faults.boundary = point => {
      if (point.phase !== phase) return;
      points++;
      const journal = f.lockHeld('journal.lock');
      if (journal) {
        assert.equal(journalReleased, false, 'DETERMINISTIC_JOURNAL_CUSTODY_REQUIRED');
        journalSeen = true;
      } else if (journalSeen) journalReleased = true;
      if (point.kind === 'command' && journal) commands.add(point.args[0]);
      const status = f.scheduledTick();
      if (status !== null) {
        ticks++;
        if (status !== '0') conflicts++;
      }
    };
    const [outcome] = await Promise.allSettled([f.run(step)]);
    f.faults.boundary = null;
    assert.equal(conflicts, 0, 'DETERMINISTIC_TIMER_CUSTODY_REQUIRED');
    assert.equal(outcome.status, 'fulfilled', outcome.reason?.stack);
    assert.equal(outcome.value.evidence.ok, true);
    assert.ok(journalSeen, 'DETERMINISTIC_JOURNAL_CUSTODY_REQUIRED');
    if (phase === 'after') assert.ok(journalReleased, 'DETERMINISTIC_JOURNAL_CUSTODY_REQUIRED');
    for (const command of ['/usr/bin/git', '/usr/bin/gh', '/usr/bin/ss']) assert.ok(commands.has(command));
    if (step === 'restart') assert.ok(commands.has('/usr/bin/node'));
    assert.equal(f.lockHeld('host-tick.lock'), false);
    assert.equal(f.lockHeld('journal.lock'), false);
  }
  assert.ok(ticks > 0);
  t.diagnostic(`Injected ${ticks} scheduled completions at ${points} before/after boundaries across readiness/restart`);
});

// G1: cover the entire A5 action, including network preflight and both
// executor readiness calls (the provider also checks readiness inside polling).
test('DETERMINISM gate-off every boundary has zero modeled conflicts', async t => {
  for (const phase of ['before', 'after']) {
    const f = productionFixture(t, { operations: ['install', 'start', 'running-gate-off'] });
    await f.run('install'); await f.run('start');
    let ticks = 0, conflicts = 0, journalSeen = false, journalReleased = false;
    const network = new Set();
    f.faults.boundary = point => {
      if (point.phase !== phase) return;
      const journal = f.lockHeld('journal.lock');
      if (journal) {
        assert.equal(journalReleased, false, 'GATE_OFF_JOURNAL_CUSTODY_REQUIRED');
        journalSeen = true;
      } else if (journalSeen) journalReleased = true;
      if (point.kind === 'command' && (point.args.includes('ls-remote') || point.args[0] === '/usr/bin/gh')) {
        network.add(point.args[0]);
      }
      const status = f.scheduledTick();
      if (status !== null) { ticks++; if (status === '2') conflicts++; }
    };
    const [outcome] = await Promise.allSettled([f.run('running-gate-off')]);
    f.faults.boundary = null;
    t.diagnostic(`gate-off ${phase}: ticks=${ticks} conflicts=${conflicts} outcome=${outcome.status} code=${outcome.reason?.code ?? 'none'}`);
    assert.equal(conflicts, 0, 'GATE_OFF_TIMER_CONFLICTS_REQUIRED');
    assert.equal(outcome.status, 'fulfilled', outcome.reason?.stack);
    assert.equal(outcome.value.evidence.ok, true);
    assert.ok(ticks > 0);
    assert.deepEqual([...network].sort(), ['/usr/bin/gh', '/usr/bin/git']);
    assert.ok(journalSeen);
    if (phase === 'after') assert.ok(journalReleased);
    assert.equal(f.lockHeld('journal.lock'), false);
    assert.equal(f.lockHeld('host-tick.lock'), false);
  }
});

test('DETERMINISM gate-off single tick at network and bracketing readiness', async t => {
  for (const target of ['gh', 'git', 'readiness-before', 'readiness-after']) {
    const f = productionFixture(t, { operations: ['install', 'start', 'running-gate-off'] });
    await f.run('install'); await f.run('start');
    let ticks = 0, conflicts = 0, readinessCalls = 0;
    const inject = () => {
      ticks++;
      if (f.scheduledTick() === '2') conflicts++;
    };
    f.faults.boundary = point => {
      if (point.phase === 'before' && point.kind === 'command' && ticks === 0 &&
          (target === 'gh' && point.args[0] === '/usr/bin/gh' || target === 'git' && point.args.includes('ls-remote'))) inject();
    };
    const original = f.provider.serviceReadiness;
    f.provider.serviceReadiness = () => {
      readinessCalls++;
      if (target === 'readiness-before' && readinessCalls === 1 || target === 'readiness-after' && readinessCalls === 3) inject();
      return original();
    };
    const [outcome] = await Promise.allSettled([f.run('running-gate-off')]);
    f.faults.boundary = null;
    t.diagnostic(`gate-off ${target}: ticks=${ticks} conflicts=${conflicts} outcome=${outcome.status} code=${outcome.reason?.code ?? 'none'}`);
    assert.equal(ticks, 1, 'GATE_OFF_INJECTION_REQUIRED');
    assert.equal(conflicts, 0, 'GATE_OFF_SINGLE_TICK_CONFLICTS_REQUIRED');
    assert.equal(outcome.status, 'fulfilled', outcome.reason?.stack);
    assert.equal(outcome.value.evidence.ok, true);
    assert.equal(readinessCalls, 3);
    assert.equal(f.lockHeld('journal.lock'), false);
    assert.equal(f.lockHeld('host-tick.lock'), false);
  }
});

// J1: execute real scratch create/write/remove effects at each generated probe
// boundary, entirely inside the translated fixture filesystem.
test('J1 prerequisite scratch permits a clean gate-off receipt', async t => {
  const f = productionFixture(t, { operations: ['install', 'start', 'running-gate-off'] });
  f.faults.capabilityScratch = [];
  await f.run('install'); await f.run('start');
  assert.equal(f.faults.capabilityScratch.length, 10);
  f.faults.capabilityScratch.length = 0;
  const [outcome] = await Promise.allSettled([f.run('running-gate-off')]);
  t.diagnostic(`J1 scratchDirs=${f.faults.capabilityScratch.length} outcome=${outcome.status} code=${outcome.reason?.code ?? 'none'}`);
  assert.equal(f.faults.capabilityScratch.length, 5);
  assert.equal(outcome.status, 'fulfilled', 'J1_PREREQUISITE_RECEIPT_REQUIRED');
  assert.equal(outcome.value.evidence.ok, true);
  const proof = outcome.value.evidence.after.proof;
  assert.equal(proof.writes, 0);
  assert.equal(proof.ticks, 3);
  assert.deepEqual(proof.before, proof.after);
  assert.deepEqual(f.faults.capabilityScratch, Array(5).fill('/tmp'));
});

test('J1 prerequisite scratch preserves all 18 H1 interleavings', async t => {
  for (const target of ['pre-action', 'pre-action-transient', 'git', 'gh', 'readiness', 'watch', 'baseline', 'poll', 'final-readiness']) {
    for (const rootKey of ['workspace_state_dir', 'supervisor_state_dir']) {
      const f = productionFixture(t, { operations: ['install', 'start', 'running-gate-off'] });
      f.faults.capabilityScratch = [];
      await f.run('install'); await f.run('start');
      assert.equal(f.faults.capabilityScratch.length, 10);
      f.faults.capabilityScratch.length = 0;
      let writes = 0, conflicts = 0, readiness = 0;
      const filename = `${f.spec.window[rootKey]}/j1-tick`;
      const inject = () => {
        if (writes || conflicts) return;
        if (f.scheduledTick() === '2') { conflicts++; return; }
        f.write(filename, 'scheduled tick landed');
        assert.equal(fs.readFileSync(f.resolve(filename), 'utf8'), 'scheduled tick landed');
        writes++;
        if (target === 'pre-action-transient') fs.unlinkSync(f.resolve(filename));
      };
      if (target.startsWith('pre-action')) inject();
      f.faults.boundary = point => {
        if (point.phase !== 'before') return;
        if (target === 'watch' && point.kind === 'watch') inject();
        if (target === 'baseline' && point.kind === 'readdirSync' && point.args[0] === f.spec.window.workspace_state_dir) inject();
        if (point.kind === 'command' && (target === 'git' && point.args.includes('ls-remote') || target === 'gh' && point.args[0] === '/usr/bin/gh')) inject();
      };
      const original = f.provider.serviceReadiness;
      f.provider.serviceReadiness = (...args) => {
        readiness++;
        if (target === 'readiness' && readiness === 1 || target === 'final-readiness' && readiness === 3) inject();
        return original(...args);
      };
      if (target === 'poll') f.faults.wait = inject;
      const [outcome] = await Promise.allSettled([f.run('running-gate-off')]);
      f.faults.boundary = null;
      t.diagnostic(`J1 H1 ${target} ${rootKey}: scratchDirs=${f.faults.capabilityScratch.length} actualWrites=${writes} conflicts=${conflicts} code=${outcome.reason?.code ?? 'none'}`);
      assert.equal(writes, 1);
      assert.equal(conflicts, 0);
      assert.equal(outcome.reason?.code, 'SHU251_PROVIDER_GATE_OFF');
      // Preflight is not reached when the recorded baseline already differs.
      assert.equal(f.faults.capabilityScratch.length, ['pre-action', 'pre-action-transient', 'watch', 'baseline'].includes(target) ? 0 : 5);
      assert.equal(f.lockHeld('journal.lock'), false);
      assert.equal(f.lockHeld('host-tick.lock'), false);
    }
  }
});

// H1: the write really reaches disposable storage only after a successful
// modeled scheduled tick. Count bytes written, not a requested injection.
for (const target of ['initialize', 'git', 'gh', 'readiness', 'poll', 'final-readiness', 'finalize', 'baseline', 'before-watch', 'before-watch-transient', 'capability']) {
  test(`OBSERVATION gate-off actual writes ${target}`, async t => {
    for (const rootKey of ['workspace_state_dir', 'supervisor_state_dir']) {
      const f = productionFixture(t, { operations: ['install', 'start', 'running-gate-off'] });
      await f.run('install'); await f.run('start');
      let actualWrites = 0, conflicts = 0, readinessCalls = 0;
      const filename = `${f.spec.window[rootKey]}/h1-write`;
      const inject = () => {
        if (actualWrites || conflicts) return;
        if (f.scheduledTick() === '2') { conflicts++; return; }
        f.write(filename, 'actual modeled coordinator write');
        assert.equal(fs.readFileSync(f.resolve(filename), 'utf8'), 'actual modeled coordinator write');
        actualWrites++;
        if (target === 'before-watch-transient' || target === 'capability') fs.unlinkSync(f.resolve(filename));
      };
      f.faults.boundary = point => {
        if (point.phase !== 'before') return;
        if (target.startsWith('before-watch') && point.kind === 'watch') inject();
        if (target === 'baseline' && point.kind === 'readdirSync' && point.args[0] === f.spec.window.workspace_state_dir) inject();
        if (target === 'capability' && point.kind === 'command' && point.args[0] === '/usr/bin/setpriv' && point.args.some(arg => arg.includes('fs.mkdtempSync'))) inject();
        if (point.kind === 'command' && (target === 'gh' && point.args[0] === '/usr/bin/gh' || target === 'git' && point.args.includes('ls-remote'))) inject();
      };
      for (const method of ['initialize', 'serviceReadiness', 'finalize']) {
        const original = f.provider[method];
        f.provider[method] = (...args) => {
          if (method === 'serviceReadiness') readinessCalls++;
          if (target === method || method === 'serviceReadiness' &&
              (target === 'readiness' && readinessCalls === 1 || target === 'final-readiness' && readinessCalls === 3)) inject();
          return original(...args);
        };
      }
      if (target === 'poll') f.faults.wait = inject;
      const [outcome] = await Promise.allSettled([f.run('running-gate-off')]);
      f.faults.boundary = null;
      t.diagnostic(`H1 ${target} ${rootKey}: actualWrites=${actualWrites} conflicts=${conflicts} outcome=${outcome.status} code=${outcome.reason?.code ?? 'none'}`);
      assert.equal(actualWrites, 1, 'H1_ACTUAL_WRITE_REQUIRED');
      assert.equal(conflicts, 0, 'H1_NO_WRITER_CONTENTION_REQUIRED');
      assert.equal(outcome.reason?.code, 'SHU251_PROVIDER_GATE_OFF', 'H1_WRITE_OBSERVATION_REQUIRED');
      assert.equal(f.lockHeld('journal.lock'), false);
      assert.equal(f.lockHeld('host-tick.lock'), false);
    }
  });
}

test('OBSERVATION disjoint roots share registration and release on failure', async t => {
  for (const fault of ['none', 'workspace_state_dir', 'supervisor_state_dir', 'watch-error', 'initialize-error']) {
    const f = productionFixture(t, { operations: ['install', 'start', 'running-gate-off'] });
    f.spec.window.supervisor_state_dir = '/srv/shu/state/supervisor';
    f.spec.render.supervisorStateDir = f.spec.window.supervisor_state_dir;
    f.spec.lifecycle.directories[1].path = f.spec.window.supervisor_state_dir;
    f.mkdir(f.spec.window.supervisor_state_dir, 0o700); f.approveFixture();
    await f.run('install'); await f.run('start'); f.reopen();
    const watch = f.boundary.fs.watch;
    let registrations = 0, closes = 0, watcher, actualWrites = 0;
    f.boundary.fs.watch = (...args) => {
      registrations++; assert.equal(args[0], '/srv/shu/state');
      watcher = watch(...args);
      const close = watcher.close.bind(watcher);
      watcher.close = () => { closes++; close(); };
      return watcher;
    };
    const initialize = f.provider.initialize;
    f.provider.initialize = (...args) => {
      if (fault.endsWith('_state_dir')) {
        assert.equal(f.scheduledTick(), '0');
        f.write(`${f.spec.window[fault]}/actual-write`, 'write'); actualWrites++;
      }
      if (fault === 'watch-error') watcher.emit('error', Error('watch failed'));
      if (fault === 'initialize-error') throw Object.assign(Error('initialize failed'), { code: 'SHU251_APPROVAL_TIME' });
      return initialize(...args);
    };
    const [outcome] = await Promise.allSettled([f.run('running-gate-off')]);
    assert.equal(registrations, 1); assert.equal(closes, 1);
    assert.equal(actualWrites, fault.endsWith('_state_dir') ? 1 : 0);
    if (fault === 'none') assert.equal(outcome.value?.evidence.ok, true);
    else assert.equal(outcome.reason?.code, fault === 'initialize-error' ? 'SHU251_APPROVAL_TIME' : 'SHU251_PROVIDER_GATE_OFF');
    assert.equal(f.lockHeld('journal.lock'), false); assert.equal(f.lockHeld('host-tick.lock'), false);
  }
});

test('OBSERVATION baseline requires writer custody and legacy start refuses', async t => {
  const f = productionFixture(t, { operations: ['install', 'start', 'running-gate-off'] });
  await f.run('install'); await f.run('start');
  await f.provider.withLock(() => assert.throws(() => f.provider.gateOffBaseline(), named('SHU251_PROVIDER_CUSTODY')), 'readiness');
  const journalPath = `${f.spec.lifecycle.evidence_dir}/journal.json`;
  const journal = JSON.parse(fs.readFileSync(f.resolve(journalPath), 'utf8'));
  const baseline = journal.receipts.at(-1).evidence.after.gate_off_baseline;
  for (const key of ['workspace_state_dir', 'supervisor_state_dir']) assert.equal(baseline[f.spec.window[key]].directory, true);
  delete journal.receipts.at(-1).evidence.after.gate_off_baseline;
  journal.receipts.at(-1).evidence_sha256 = hash(canonical(journal.receipts.at(-1).evidence));
  f.write(journalPath, JSON.stringify(journal)); f.reopen();
  await assert.rejects(() => f.run('running-gate-off'), named('SHU251_PROVIDER_GATE_OFF'));
});

test('DETERMINISM scheduled tick conflict model retains exit-2 refusal', async t => {
  const f = productionFixture(t, { operations: ['install', 'start'] });
  await f.run('install'); await f.run('start');
  await f.provider.withLock(() => {
    assert.equal(f.scheduledTick(), '2');
    assert.throws(() => f.provider.serviceReadiness(), named('SHU251_PROVIDER_READINESS'));
  });
  assert.equal(f.scheduledTick(), '0');
  assert.equal(f.provider.serviceReadiness().coordinator, 'ready');
});

test('DETERMINISM observation custody refuses writer effects and releases on failure', async t => {
  for (const step of ['readiness', 'restart', 'running-gate-off']) {
    const f = productionFixture(t);
    await assert.rejects(() => f.provider.withLock(() => {
      assert.equal(f.lockHeld('journal.lock'), true);
      assert.equal(f.lockHeld('host-tick.lock'), false);
      for (const action of [() => f.provider.place(FILES[0], absent, data),
        () => f.provider.stage({}), () => f.provider.checkout(f.checkout, f.checkout),
        () => f.provider.pin('bad', null, null), () => f.provider.systemd('stop', 'shu-supervisor.service')]) {
        assert.throws(action, named('SHU251_PROVIDER_CUSTODY'));
      }
      throw Error('observation failure');
    }, step), /observation failure/);
    assert.equal(f.lockHeld('journal.lock'), false);
    assert.equal(f.lockHeld('host-tick.lock'), false);
    await f.provider.withLock(() => assert.equal(f.lockHeld('host-tick.lock'), true));
  }
});

const approved = f => ({ sha: f.spec.window.approved_sha, head_ref: 'refs/heads/main', main: f.spec.window.approved_sha,
  origin_main: f.spec.window.approved_sha, tree: f.spec.lifecycle.approved_tree, clean: true });
function stale(f, detached = false) {
  Object.assign(f.checkout, { sha: 'b'.repeat(40), head_ref: detached ? null : 'refs/heads/main', main: 'b'.repeat(40), origin_main: 'd'.repeat(40), tree: 'e'.repeat(40), clean: true });
  f.spec.lifecycle.checkout_before = structuredClone(f.checkout); f.approveFixture();
}
const cases = [
  ['SHU251_PROVIDER_TICK', f => { f.faults.command = (file,args) => args.includes('--property=ExecMainStatus') ? { status: 0, stdout: '2' } : null; return () => f.provider.withLock(() => f.provider.systemd('start', 'shu-coordinator.service')); }],
  ['SHU251_PROVIDER_CHECKOUT', f => () => f.provider.withLock(() => f.provider.checkout(f.checkout, { ...f.checkout, origin_main: 'f'.repeat(40) }))],
  ['SHU251_CHECKOUT_CAS', f => { const before = structuredClone(f.checkout); f.checkout.origin_main = 'f'.repeat(40); return () => f.provider.withLock(() => f.provider.checkout(before, before)); }],
  ['SHU251_CHECKOUT_TREE', f => {
    stale(f); f.faults.command = (file,args) => args.includes(`${f.spec.window.approved_sha}^{tree}`) ? { status: 0, stdout: 'f'.repeat(40) } : null;
    return () => f.provider.withLock(() => f.provider.checkout(f.spec.lifecycle.checkout_before, approved(f)));
  }],
  ['SHU251_CHECKOUT_REMOTE', f => {
    stale(f); f.faults.command = (file,args) => args.includes('ls-remote') ? { status: 0, stdout: `${f.spec.window.approved_sha}\trefs/heads/main\n${f.spec.window.approved_sha}\trefs/heads/main` } : null;
    return () => f.provider.withLock(() => f.provider.checkout(f.spec.lifecycle.checkout_before, approved(f)));
  }],
  ['SHU251_APPROVAL_CUSTODY', f => { f.faults.stat = (p,s) => String(p).endsWith(`${f.spec.lifecycle.activation_id}.json`) ? new Proxy(s, { get(t,k) { return k === 'uid' ? 1001 : Reflect.get(t,k); } }) : s; return () => f.provider.authorize('preflight', null); }],
  ['SHU251_APPROVAL_DIGEST', f => { f.spec.lifecycle.approval_sha256 = '0'.repeat(64); return () => f.provider.authorize('preflight', null); }],
  ['SHU251_APPROVAL_SIGNATURE', f => {
    const file = `/etc/shu/approvals/${f.spec.lifecycle.activation_id}.json`, v = JSON.parse(fs.readFileSync(f.resolve(file), 'utf8'));
    v.signature = Buffer.alloc(64).toString('base64'); const bytes = JSON.stringify(v); f.write(file, bytes); f.spec.lifecycle.approval_sha256 = hash(bytes);
    return () => f.provider.authorize('preflight', null);
  }],
  ['SHU251_APPROVAL_BINDING', f => { f.spec.render.workdir = '/other'; return () => f.provider.authorize('preflight', null); }],
  ['SHU251_APPROVAL_TIME', f => { f.boundary.now = () => 10000; return () => f.provider.authorize('preflight', null); }],
  ['SHU251_APPROVAL_ORDER', f => () => f.provider.authorize('start', null)],
  ['SHU251_APPROVAL_TEARDOWN', f => () => f.provider.authorize('pin-retain', { rolled_back: true })],
  ['SHU251_PROVIDER_GATE_OFF', f => { f.faults.wait = () => {}; return async () => {
    await f.run('install'); await f.run('start'); return f.provider.withLock(() => f.provider.runningGateOff());
  }; }],
  ['SHU251_PREFLIGHT_PRIVILEGE', f => () => createProductionLifecycle(f.spec, { ...f.boundary, uid: () => 1001 })],
  ['SHU251_PROVIDER_SCOPE', f => { const s = structuredClone(f.spec); s.lifecycle.evidence_dir += '/elsewhere'; return () => createProductionLifecycle(s, f.boundary); }],
  ['SHU251_PROVIDER_PATH', f => { fs.chmodSync(f.resolve('/etc/systemd/system'), 0o777); return () => f.provider.snapshot(); }],
  ['SHU251_PROVIDER_SUBSTITUTION', f => { const original = f.boundary.fs.fstatSync; f.boundary.fs.fstatSync = fd => ({ ...original(fd), ino: -1 }); return () => f.provider.snapshot(); }],
  ['SHU251_PROVIDER_SYMLINK', f => { fs.symlinkSync('/unreviewed', f.resolve(`/etc/systemd/system/${FILES[0]}`)); return () => f.provider.snapshot(); }],
  ['SHU251_PROVIDER_FILE', f => { f.write(`/etc/systemd/system/${FILES[0]}`, 'bytes'); fs.linkSync(f.resolve(`/etc/systemd/system/${FILES[0]}`), f.resolve('/etc/systemd/system/alias')); return () => f.provider.snapshot(); }],
  ['SHU251_PROVIDER_STORAGE', f => () => f.provider.withLock(() => f.provider.save({ binding: { activation_id: 'other' } }))],
  ['SHU251_PROVIDER_CUSTODY', f => () => f.provider.save({ binding: { activation_id: f.spec.lifecycle.activation_id } })],
  ['SHU251_PROVIDER_ALLOWLIST', f => () => f.provider.withLock(() => f.provider.place('other.service', absent, data))],
  ['SHU251_PROVIDER_COMPARE', f => () => f.provider.withLock(() => f.provider.place(FILES[0], data, data))],
  ['SHU251_PROVIDER_ARGV', f => () => f.provider.withLock(() => f.provider.systemd('start', 'other.service'))],
  ['SHU251_PROVIDER_PIN', f => () => f.provider.withLock(() => f.provider.pin('refs/heads/main', 'b'.repeat(40), 'a'.repeat(40)))],
  ['SHU251_PROVIDER_COMMAND', f => { f.faults.command = (file,args) => file === '/usr/bin/systemctl' && args[0] === 'daemon-reload' ? { status: 1, stdout: '' } : null; return () => f.provider.withLock(() => f.provider.systemd('daemon-reload', null)); }],
  ['SHU251_PROVIDER_READINESS', f => { f.faults.command = file => file === '/usr/bin/ss' ? { status: 0, stdout: '' } : null; return () => f.provider.readiness(); }],
];
for (const [code, change] of cases) test(`PROVIDER guard ${code}`, async t => {
  if (['SHU251_PROVIDER_CHECKOUT', 'SHU251_CHECKOUT_CAS', 'SHU251_CHECKOUT_TREE', 'SHU251_CHECKOUT_REMOTE'].includes(code)) {
    const positive = productionFixture(t); stale(positive);
    await positive.provider.withLock(() => positive.provider.checkout(positive.spec.lifecycle.checkout_before, approved(positive)));
    assert.deepEqual(positive.checkout, approved(positive));
  }
  const control = productionFixture(t);
  await control.run('install'); await control.run('start');
  if (code === 'SHU251_PROVIDER_GATE_OFF') await control.provider.withLock(() => control.provider.runningGateOff());
  await control.run('pin'); await control.run('host-rollback'); await control.run('pin-restore');
  const f = productionFixture(t);
  if (code === 'SHU251_PROVIDER_READINESS') { await f.run('install'); await f.run('start'); }
  const action = change(f);
  await assert.rejects(async () => action(), named(code), `${code}_REQUIRED`);
});

test('PROVIDER durability order and failures never acknowledge success', async t => {
  const f = productionFixture(t);
  await f.provider.withLock(() => {
    f.events.length = 0;
    f.provider.save({ binding: { activation_id: f.spec.lifecycle.activation_id } });
    const events = f.events.filter(e => ['write', 'fsync', 'rename'].includes(e[0]));
    assert.deepEqual(events.map(e => e[0]), ['write', 'fsync', 'rename', 'fsync'], 'PROVIDER_DURABILITY_REQUIRED');
    assert.equal(events[1][2], 'file'); assert.equal(events[3][2], 'directory');
    f.faults.fsync = true;
    assert.throws(() => f.provider.save({ binding: { activation_id: f.spec.lifecycle.activation_id } }));
  });
});
test('PROVIDER lock contention outside custody and release after exceptions', async t => {
  const f = productionFixture(t);
  f.faults.command = file => file === '/usr/bin/flock' ? { status: 1 } : null;
  await assert.rejects(() => f.provider.withLock(() => assert.fail('must not enter')), named('SHU251_WRITER_LOCK'), 'PROVIDER_LOCK_REQUIRED');
  f.faults.command = null;
  await assert.rejects(() => f.provider.withLock(async () => { await assert.rejects(() => f.provider.withLock(() => {}), named('SHU251_WRITER_LOCK')); throw Error('body'); }));
  await f.provider.withLock(() => f.provider.save({ binding: { activation_id: f.spec.lifecycle.activation_id } }));
});
test('PROVIDER default entrypoint wiring and no implementation option', async t => {
  const f = productionFixture(t), specFile = path.join(f.root, 'driver.json'); fs.writeFileSync(specFile, JSON.stringify(f.spec));
  const oldRead = defaultIO.read, oldFactory = defaultIO.lifecycleProvider;
  // Substitute only at the in-process default boundary; CLI has no IO argument.
  defaultIO.read = () => Buffer.from(JSON.stringify(f.spec.window));
  let called = 0; defaultIO.lifecycleProvider = async spec => { called++; assert.deepEqual(spec, f.spec); return f.provider; };
  try {
    const [outcome] = await Promise.allSettled([main(['preflight', specFile, '--execute'])]);
    assert.equal(outcome.status, 'fulfilled', 'PROVIDER_ENTRYPOINT_REQUIRED');
    const result = outcome.value;
    assert.equal(result.step, 'preflight'); assert.equal(called, 1, 'PROVIDER_ENTRYPOINT_REQUIRED');
    await assert.rejects(() => main(['preflight', specFile, '--provider', '/attacker.mjs']), named('SHU251_DRIVER_USAGE'), 'PROVIDER_NO_OVERRIDE_REQUIRED');
  } finally { defaultIO.read = oldRead; defaultIO.lifecycleProvider = oldFactory; }
  const oldPin = defaultIO.pin; let checked = 0;
  defaultIO.pin = async s => { assert.deepEqual(s, f.spec); checked++; };
  try {
    const provider = await oldFactory(f.spec, f.boundary);
    assert.equal(checked, 1, 'PROVIDER_CHECKOUT_REQUIRED');
    assert.equal(typeof provider?.probe, 'function', 'PROVIDER_FACTORY_REQUIRED');
    assert.equal((await provider.probe()).checkout.sha, f.spec.window.approved_sha, 'PROVIDER_FACTORY_REQUIRED');
  } finally { defaultIO.pin = oldPin; }
});

const mutations = cases.map(([code]) => ({ name: code, pattern: `PROVIDER guard ${code}`, from: 'if (!condition) refuse(code);', to: `if (!condition && code !== '${code}') refuse(code);`, assertion: `${code}_REQUIRED` }));
mutations.push(
  { name: 'J1 scratch restored to watched root', pattern: 'J1 prerequisite scratch permits', from: "temp_dir: '/tmp'", to: 'temp_dir: w.workspace_state_dir', assertion: 'J1_PREREQUISITE_RECEIPT_REQUIRED' },
  { name: 'H1 preflight observation omitted', module: 'host-lifecycle', pattern: 'OBSERVATION gate-off actual writes gh$', from: 'await io.lifecycle.observeGateOff(() => execute(step, spec, options, io))', to: 'await execute(step, spec, options, io)', extra: { module: 'host-lifecycle', from: 'await host.gateOffBaseline(baseline);', to: 'void baseline;' }, assertion: 'H1_WRITE_OBSERVATION_REQUIRED' },
  { name: 'H1 first readiness observation omitted', module: 'host-lifecycle', pattern: 'OBSERVATION gate-off actual writes readiness$', from: 'await io.lifecycle.observeGateOff(() => execute(step, spec, options, io))', to: 'await execute(step, spec, options, io)', extra: { module: 'host-lifecycle', from: 'await host.gateOffBaseline(baseline);', to: 'void baseline;' }, assertion: 'H1_WRITE_OBSERVATION_REQUIRED' },
  { name: 'H1 persisted baseline omitted', pattern: 'OBSERVATION gate-off actual writes before-watch$', from: 'gateObservation !== null && equal(before, gateObservation.before)', to: 'gateObservation !== null', assertion: 'H1_WRITE_OBSERVATION_REQUIRED' },
  { name: 'H1 final observation omitted', pattern: 'OBSERVATION gate-off actual writes finalize$', from: 'observation.check();', to: 'void observation;', assertion: 'H1_WRITE_OBSERVATION_REQUIRED' },
  { name: 'gate-off whole-step writer contention', pattern: 'DETERMINISM gate-off every boundary', from: "if (!['readiness', 'restart', 'running-gate-off'].includes(step)) locks.push", to: "if (!['readiness', 'restart'].includes(step)) locks.push", assertion: 'GATE_OFF_TIMER_CONFLICTS_REQUIRED' },
  { name: 'gate-off executor observation scope', module: 'host-lifecycle', pattern: 'DETERMINISM gate-off every boundary', from: '}, step);', to: '});', assertion: 'GATE_OFF_TIMER_CONFLICTS_REQUIRED' },
  { name: 'gate-off post-poll writer reacquisition', pattern: 'DETERMINISM gate-off every boundary', from: 'if (writer) custody.unshift', to: 'if (true) custody.unshift', assertion: 'GATE_OFF_TIMER_CONFLICTS_REQUIRED' },
  { name: 'gate-off single network tick contention', pattern: 'DETERMINISM gate-off single tick', from: "if (!['readiness', 'restart', 'running-gate-off'].includes(step)) locks.push", to: "if (!['readiness', 'restart'].includes(step)) locks.push", assertion: 'GATE_OFF_SINGLE_TICK_CONFLICTS_REQUIRED' },
  { name: 'readiness alone writer contention', pattern: 'DETERMINISM readiness restart scheduled', from: "if (!['readiness', 'restart', 'running-gate-off'].includes(step)) locks.push", to: "if (step !== 'restart') locks.push", assertion: 'DETERMINISTIC_TIMER_CUSTODY_REQUIRED' },
  { name: 'restart alone writer contention', pattern: 'DETERMINISM readiness restart scheduled', from: "if (!['readiness', 'restart', 'running-gate-off'].includes(step)) locks.push", to: "if (step !== 'readiness') locks.push", assertion: 'DETERMINISTIC_TIMER_CUSTODY_REQUIRED' },
  { name: 'readiness restart writer contention', pattern: 'DETERMINISM readiness restart scheduled', from: "if (!['readiness', 'restart', 'running-gate-off'].includes(step)) locks.push", to: 'if (true) locks.push', assertion: 'DETERMINISTIC_TIMER_CUSTODY_REQUIRED' },
  { name: 'executor observation scope', module: 'host-lifecycle', pattern: 'DETERMINISM readiness restart scheduled', from: '}, step);', to: '});', assertion: 'DETERMINISTIC_TIMER_CUSTODY_REQUIRED' },
  { name: 'default entrypoint', module: 'phase-a-driver', pattern: 'PROVIDER default entrypoint', from: 'const lifecycleIO = io === defaultIO ?', to: 'const lifecycleIO = false ?', assertion: 'PROVIDER_ENTRYPOINT_REQUIRED' },
  { name: 'production factory', module: 'phase-a-driver', pattern: 'PROVIDER default entrypoint', from: 'return createProductionLifecycle(spec, boundary);', to: 'return {};', assertion: 'PROVIDER_FACTORY_REQUIRED' },
  { name: 'reviewed checkout', module: 'phase-a-driver', pattern: 'PROVIDER default entrypoint', from: 'await defaultIO.pin(spec);', to: 'void spec;', assertion: 'PROVIDER_CHECKOUT_REQUIRED' },
  { name: 'file fsync', pattern: 'PROVIDER durability order', from: 'f.fsyncSync(handle);', to: 'void handle;', assertion: 'PROVIDER_DURABILITY_REQUIRED' },
  { name: 'directory fsync', pattern: 'PROVIDER durability order', from: 'f.renameSync(temp, `${root}/${name}`); f.fsyncSync(fd);', to: 'f.renameSync(temp, `${root}/${name}`);', assertion: 'PROVIDER_DURABILITY_REQUIRED' },
  { name: 'kernel lock', pattern: 'PROVIDER lock contention', from: "guard('SHU251_WRITER_LOCK', !r.error && r.status === 0);", to: 'void r;', assertion: 'PROVIDER_LOCK_REQUIRED' },
);
for (const mutation of mutations) test(`PROVIDER named mutation ${mutation.name}`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-mutation-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'test'));
  for (const n of ['phase-a-driver', 'host-lifecycle', 'host-suite-contract', 'production-lifecycle']) fs.copyFileSync(new URL(`../${n}.mjs`, import.meta.url), path.join(root, `${n}.mjs`));
  for (const n of ['production-lifecycle.test', 'production-fixture', 'lifecycle-fixture']) fs.copyFileSync(new URL(`./${n}.mjs`, import.meta.url), path.join(root, `test/${n}.mjs`));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ['--test', `--test-name-pattern=^${mutation.pattern}`, path.join(root, 'test/production-lifecycle.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
  const control = run(); assert.equal(control.status, 0, control.stdout + control.stderr); assert.match(control.stdout, /^# pass 1$/m);
  const file = path.join(root, `${mutation.module ?? 'production-lifecycle'}.mjs`), source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(mutation.from).length, 2); fs.writeFileSync(file, source.replace(mutation.from, mutation.to));
  if (mutation.extra) {
    const extraFile = path.join(root, `${mutation.extra.module}.mjs`), extraSource = fs.readFileSync(extraFile, 'utf8');
    assert.equal(extraSource.split(mutation.extra.from).length, 2);
    fs.writeFileSync(extraFile, extraSource.replace(mutation.extra.from, mutation.extra.to));
    assert.equal(spawnSync(process.execPath, ['--check', extraFile]).status, 0);
  }
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  const result = run(), output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output); assert.match(output, /^# fail 1$/m);
  assert.match(output, /code: 'ERR_ASSERTION'/); assert.ok(output.includes(mutation.assertion), output);
  assert.doesNotMatch(output, /TypeError|SyntaxError|ERR_MODULE_NOT_FOUND/);
  if (mutation.name.startsWith('J1 ')) {
    assert.match(output, /J1 scratchDirs=5 outcome=rejected code=SHU251_PROVIDER_GATE_OFF/);
    t.diagnostic('J1 reversal: scratchDirs=5; SHU251_PROVIDER_GATE_OFF kills clean receipt');
  }
  if (mutation.name.startsWith('gate-off ')) t.diagnostic(`${mutation.name}: ${output.match(/# gate-off [^\n]+/)?.[0]}`);
  if (mutation.name.startsWith('H1 ')) {
    assert.match(output, /actualWrites=1 conflicts=0 outcome=fulfilled/);
    t.diagnostic(`${mutation.name}: actualWrites=1 conflicts=0; false receipt killed by H1_WRITE_OBSERVATION_REQUIRED`);
  }
});


test('PROVIDER placements restore exact bytes mode absence and masking links', async t => {
  const f = productionFixture(t), name = FILES[0];
  const binary = { ...data, mode: 0o640, data: Buffer.from([0xff, 0xfe, 0, 1]).toString('base64') };
  const mask = { kind: 'symlink', target: '/dev/null', uid: 0, gid: 0 };
  await f.provider.withLock(() => {
    for (const [before, after] of [[absent, binary], [binary, data], [data, mask], [mask, data], [data, absent]]) {
      assert.equal(f.provider.place(name, before, after), true);
      assert.deepEqual(f.provider.snapshot().files[name], after);
    }
  });
});
test('PROVIDER substituted destination and symlink ancestor cannot redirect placement', async t => {
  for (const fault of ['ancestor', 'destination']) {
    const f = productionFixture(t), name = FILES[0];
    if (fault === 'ancestor') {
      fs.renameSync(f.resolve('/etc/systemd/system'), f.resolve('/etc/systemd/original'));
      fs.symlinkSync('original', f.resolve('/etc/systemd/system'));
      await assert.rejects(() => f.provider.withLock(() => f.provider.place(name, absent, data)), named('SHU251_PROVIDER_PATH'));
      assert.equal(fs.existsSync(f.resolve(`/etc/systemd/original/${name}`)), false);
    } else {
      const write = f.boundary.fs.writeFileSync;
      f.boundary.fs.writeFileSync = (...args) => { write(...args); f.write(`/etc/systemd/system/${name}`, 'substituted'); };
      await assert.rejects(() => f.provider.withLock(() => f.provider.place(name, absent, data)), named('SHU251_PROVIDER_SUBSTITUTION'));
      assert.equal(fs.readFileSync(f.resolve(`/etc/systemd/system/${name}`), 'utf8'), 'substituted');
    }
  }
});
test('PROVIDER observations reject listener identity runtime gate and oneshot drift', async t => {
  for (const fault of ['uid', 'gate', 'oneshot', 'invocation']) {
    const f = productionFixture(t, { operations: ['install', 'start', 'readiness'] }); await f.run('install'); await f.run('start');
    if (fault === 'uid') f.write('/proc/123/status', 'Uid: 0 0 0 0\nGid: 1001 1001 1001 1001\nGroups: 1001 1002\n');
    if (fault === 'gate') f.write('/proc/123/environ', 'ENABLE_DISPATCH=true\0');
    if (fault === 'oneshot' || fault === 'invocation') f.faults.command = (file,args) => args.includes(fault === 'oneshot' ? '--property=ExecMainExitTimestampMonotonic' : '--property=InvocationID') ? { status: 0, stdout: '0' } : null;
    await assert.rejects(() => f.run('readiness'), named(fault === 'invocation' ? 'SHU251_LIFECYCLE_READINESS' : 'SHU251_PROVIDER_READINESS'));
  }
});

test('CLOSURE split ownership and fresh service readiness require no acceptance worker', async t => {
  const f = productionFixture(t, { operations: ['install', 'start', 'readiness', 'running-gate-off'] });
  delete f.spec.window.fixture; f.approveFixture();
  await f.run('install'); await f.run('start'); await f.run('readiness');
  const proof = await f.run('running-gate-off');
  assert.equal(proof.evidence.after.proof.ticks, 3);
  assert.equal(proof.evidence.after.proof.launches, 0);
  assert.equal(proof.evidence.after.proof.writes, 0);
  assert.ok(!f.commands.some(c => c.file === '/usr/bin/node' && ['worker', 'transport'].includes(c.args[1])));
  assert.ok(!f.events.some(e => e[0] === 'read' && Object.values(f.spec.lifecycle.environment).some(v => v.path === e[1])));
  const probes = f.commands.filter(c => c.file === '/usr/bin/setpriv').flatMap(c => c.args).filter(a => a.includes('fs.mkdtempSync'));
  assert.ok(probes.length === 20 && probes.every(p => p.includes(JSON.stringify('/tmp')) && !p.includes(JSON.stringify(f.spec.window.workspace_state_dir)) && !p.includes(JSON.stringify(f.spec.lifecycle.evidence_dir))), 'service probes use writable scratch storage, never watched state or root-only evidence');
  assert.equal(f.spec.lifecycle.environment.supervisor.uid, 0);
  assert.equal(f.spec.lifecycle.environment.coordinator.uid, 1001);
});

test('CLOSURE stale local main stale origin main detached HEAD restore and retain', async t => {
  for (const detached of [false, true]) for (const teardown of ['restore', 'retain']) {
    const f = productionFixture(t, { operations: ['pin'], teardown }); stale(f, detached);
    const before = structuredClone(f.checkout);
    await f.run('pin'); assert.deepEqual(f.checkout, approved(f));
    const journal = JSON.parse(fs.readFileSync(f.resolve(`${f.spec.lifecycle.evidence_dir}/journal.json`), 'utf8'));
    assert.deepEqual(journal.prior.checkout, before);
    assert.ok(journal.entries.some(e => e.verb === 'checkout' && e.status === 'done'));
    await f.run('host-rollback'); await f.run(`pin-${teardown}`);
    assert.deepEqual(f.checkout, teardown === 'restore' ? before : approved(f));
    const archive = JSON.parse(fs.readFileSync(f.resolve(`${f.spec.lifecycle.evidence_dir}/archive.json`), 'utf8'));
    assert.equal(archive.receipts.at(-1).step, `pin-${teardown}`);
    assert.equal(archive.rolled_back, true);
  }
});

test('CLOSURE pin and restore recover every Git command boundary with a new provider', async t => {
  const predicates = [
    a => a.includes('fetch'), a => a.includes('--detach'), a => a.includes('--stdin'), a => a.at(-1) === 'main' && a.includes('checkout'),
  ];
  for (const step of ['pin', 'pin-restore']) for (const side of ['command', 'afterCommand']) for (const match of predicates.slice(step === 'pin' ? 0 : 1)) {
    const f = productionFixture(t, { operations: ['pin'] }); stale(f);
    if (step === 'pin-restore') { await f.run('pin'); await f.run('host-rollback'); }
    let injected = false;
    f.faults[side] = (file,args) => {
      if (!injected && file === '/usr/bin/git' && match(args)) { injected = true; return { status: 1, stdout: '' }; }
    };
    await assert.rejects(() => f.run(step), named('SHU251_CHECKOUT_EFFECT'));
    assert.equal(injected, true);
    f.faults[side] = null; f.reopen();
    await f.run(step);
    assert.deepEqual(f.checkout, step === 'pin' ? approved(f) : f.spec.lifecycle.checkout_before);
  }
});

test('CLOSURE dirty checkout independent drift wrong tree and ambiguous fetch refuse', async t => {
  for (const fault of ['dirty', 'main', 'origin', 'tree', 'fetch']) {
    const f = productionFixture(t, { operations: ['pin'] }); stale(f);
    if (fault === 'dirty') f.checkout.clean = false;
    if (fault === 'main') { f.checkout.head_ref = null; f.checkout.main = 'f'.repeat(40); }
    if (fault === 'origin') f.checkout.origin_main = 'f'.repeat(40);
    if (fault === 'tree') f.checkout.tree = 'f'.repeat(40);
    if (fault === 'fetch') f.faults.command = (file,args) => args.includes('fetch') ? { status: 1, stdout: '' } : null;
    await assert.rejects(() => f.run('pin'));
    assert.ok(!f.commands.some(c => c.args.includes('checkout')));
  }
  const f = productionFixture(t, { operations: ['pin'] }); stale(f); await f.run('pin'); await f.run('host-rollback');
  f.checkout.origin_main = 'f'.repeat(40);
  await assert.rejects(() => f.run('pin-restore'), named('SHU251_CHECKOUT_RESTORE'));
  assert.equal(f.checkout.origin_main, 'f'.repeat(40));
});

test('CLOSURE gate proof rejects stopped silence missing timer wake writes and children', async t => {
  for (const fault of ['stopped', 'timer', 'oneshot', 'writes', 'children']) {
    const f = productionFixture(t, { operations: ['install', 'start', 'running-gate-off'] });
    await f.run('install'); await f.run('start');
    if (fault === 'stopped') f.faults.command = (file,args) => args.includes('--property=ActiveState') ? { status: 0, stdout: 'inactive' } : null;
    if (fault === 'timer') f.faults.wait = () => {};
    if (fault === 'oneshot') f.faults.command = (file,args) => args.includes('--property=ExecMainStatus') ? { status: 0, stdout: '2' } : null;
    if (fault === 'writes') f.faults.wait = () => f.write(`${f.spec.window.workspace_state_dir}/unexpected`, 'write');
    if (fault === 'children') f.write('/proc/123/task/123/children', '4321');
    await assert.rejects(() => f.run('running-gate-off'));
  }
});

test('CLOSURE evidence creation authenticated approval expiry cleanup and archive resume', async t => {
  const f = productionFixture(t, { operations: ['pin'] });
  fs.rmSync(f.resolve(f.spec.lifecycle.evidence_dir), { recursive: true });
  await f.run('pin');
  const receipt = JSON.parse(fs.readFileSync(f.resolve(`${f.spec.lifecycle.evidence_dir}/journal.json`), 'utf8')).receipts.at(-1);
  fs.unlinkSync(f.resolve(`${f.spec.lifecycle.evidence_dir}/archive.json`));
  f.reopen(); assert.deepEqual(await f.run('pin'), receipt);
  assert.ok(fs.existsSync(f.resolve(`${f.spec.lifecycle.evidence_dir}/archive.json`)));
  f.boundary.now = () => 10000;
  await assert.rejects(() => f.run('install'), named('SHU251_APPROVAL_TIME'));
  await f.run('host-rollback'); await f.run('pin-restore');
});
