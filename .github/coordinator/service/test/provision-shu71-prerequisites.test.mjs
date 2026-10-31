import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisioner, parseCli, prerequisiteFailure, installExclusion, runCli, PATHS, BROKER, FIND_TIMEOUT_MS } from '../provision-shu71-prerequisites.mjs';
import { revision, holdInstallLocks } from './provision-prerequisites-fixture.mjs';
import { targetFixture as fixture } from './provision-target-host-fixture.mjs';

const treeFile = PATHS.tree + '/service/shu71-production.mjs';
export const refusals = [
  ['missing tree file', 'ACT_TREE_PATH', h => h.remove(treeFile)],
  ['stale tree file', 'ACT_TREE_CONTENT', h => h.write(treeFile, 'stale')],
  ['wrong tree ownership', 'ACT_TREE_OWNER', h => h.owners.set(treeFile, [1, 0])],
  ['wrong tree mode', 'ACT_TREE_MODE', h => h.write(treeFile, 'reviewed production', 0o600)],
  ['wrong sudoers path', 'SHU251_SUDOERS_PATH', h => h.remove(PATHS.sudoers)],
  ['wrong sudoers mode', 'SHU251_SUDOERS_MODE', h => h.write(PATHS.sudoers, h.f.readFileSync(PATHS.sudoers), 0o644)],
  ['wrong sudoers content', 'SHU251_SUDOERS_CONTENT', h => h.write(PATHS.sudoers, 'wrong', 0o440)],
  ['parser failure', 'SHU251_SUDOERS_PARSER', h => { h.faults.parser = true; }],
  ['wrapper drift', 'ACT_WRAPPER_DRIFT', h => h.write(PATHS.wrapper, 'wrong', 0o755)],
  ['UID collision', 'ACT_BROKER_UID_COLLISION', h => h.users().push({ ...h.users().find(u => u.name === BROKER), name: 'unrelated' })],
  ['GID collision', 'ACT_BROKER_GID_COLLISION', h => h.groups().push({ ...h.groups().find(g => g.name === BROKER), name: 'unrelated' })],
  ['messagebus substitution', 'ACT_BROKER_MESSAGEBUS', h => { h.users().find(u => u.name === BROKER).uid = 996; }],
];
for (const [name, code, mutate] of refusals) test(`SHU71 provisioning refuses ${name}`, t => {
  const h = fixture(t), p = provisioner(revision, h.boundary); p.install(); p.verify(); mutate(h);
  assert.throws(() => p.verify(), { code }, `SHU71_${name.toUpperCase().replaceAll(' ', '_')}: invalid prerequisite must be refused`);
});
test('SHU71 provisioning exact install adoption and rollback', t => {
  const h = fixture(t), before = h.snapshot(), p = provisioner(revision, h.boundary);
  const result = p.install(); assert.equal(result.state, 'VERIFIED');
  assert.equal(result.parser, '/usr/bin/cvtsudoers.ws'); assert.notEqual(result.broker.uid, 996);
  const installed = h.snapshot(), start = h.events.length;
  assert.equal(p.install().state, 'ADOPTED'); assert.deepEqual(h.snapshot(), installed);
  assert.ok(h.events.slice(start).every(e => e.startsWith('parser:')), 'SHU71_ADOPTION_NO_WRITES');
  assert.equal(p.rollback().state, 'ROLLED_BACK'); assert.deepEqual(h.snapshot(), before, 'SHU71_EXACT_ROLLBACK: bytes modes owners and unrelated files restored');
});
test('SHU71 precondition measures all paths without effects or private bytes', t => {
  const h = fixture(t), p = provisioner(revision, h.boundary); p.install(); const before = h.snapshot();
  const result = p.precondition(); assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.snapshot(), before, 'SHU71_PRECONDITION_READ_ONLY');
  assert.ok(result.paths.some(p => p.path === 'refs/heads/coordinator/SHU-254'));
  assert.doesNotMatch(JSON.stringify(result), /private fixture|cHJpdmF0ZSBmaXh0dXJl/);
  h.remove('/etc/shu/approvals/owner.pub');
  assert.equal(p.precondition().ok, false, 'SHU71_PRECONDITION_MISSING_PATH');
});
test('SHU71 provisioning closed CLI', () => {
  assert.deepEqual(parseCli(['install', revision]), { action: 'install', revision });
  for (const args of [[], ['install', revision, '--exec'], ['install', '../'], ['run', revision]]) assert.throws(() => parseCli(args), { code: 'ACT_COMMAND_INVALID' });
});
test('SHU71 provisioning refuses extras symlinks hardlinks and parent writes', t => {
  for (const fault of ['extra', 'symlink', 'hardlink', 'parent']) {
    const h = fixture(t), p = provisioner(revision, h.boundary); p.install();
    if (fault === 'extra') h.write(PATHS.tree + '/extra', 'extra');
    if (fault === 'parent') h.directory(PATHS.tree, 0o777);
    if (fault === 'symlink' || fault === 'hardlink') {
      const original = h.f.lstatSync; h.f.lstatSync = p => { const s = original(p); return p !== treeFile ? s : new Proxy(s, { get(t, k) {
        if (k === 'isSymbolicLink') return () => fault === 'symlink'; return Reflect.get(t, k);
      } }); };
      const originalF = h.f.fstatSync; h.f.fstatSync = fd => new Proxy(originalF(fd), { get(t, k) { return k === 'nlink' ? 2 : Reflect.get(t, k); } });
    }
    assert.throws(() => p.verify(), undefined, `SHU71_CUSTODY_${fault}`);
  }
});
test('SHU71 provisioning partial installation and rollback residue crash matrix', t => {
  const baseline = fixture(t); provisioner(revision, baseline.boundary).install();
  const points = baseline.events.map((name, index) => ({ name, index })).filter(p => !p.name.startsWith('parser:'));
  for (const phase of ['before', 'after']) for (const point of points) {
    const h = fixture(t), before = h.snapshot(); let dead = false;
    h.faults[phase] = () => dead || (dead = h.events.length === point.index + 1);
    if (phase === 'after') h.faults.before = () => dead;
    try { provisioner(revision, h.boundary).install(); } catch {}
    h.faults.before = null; h.faults.after = null;
    provisioner(revision, h.boundary).rollback();
    assert.deepEqual(h.snapshot(), before, `SHU71_PARTIAL_INSTALLATION: exact restoration after ${phase} ${point.name}`);
    assert.ok(!Object.keys(h.snapshot().files).some(p => p.includes('.shu71-pending') || p === PATHS.receipt), 'SHU71_ROLLBACK_RESIDUE: no stage or unreplayed journal');
  }
  t.diagnostic(`${points.length * 2} forward process-death injections`);
});
test('SHU71 provisioning rollback process replacement at every effect', t => {
  const baseline = fixture(t), p = provisioner(revision, baseline.boundary); p.install(); const start = baseline.events.length; p.rollback();
  const points = baseline.events.slice(start).map((name, index) => ({ name, index }));
  for (const phase of ['before', 'after']) for (const point of points) {
    const h = fixture(t), before = h.snapshot(), p = provisioner(revision, h.boundary); p.install(); const start = h.events.length;
    let dead = false; h.faults[phase] = () => dead || (dead = h.events.length === start + point.index + 1);
    if (phase === 'after') h.faults.before = () => dead;
    try { p.rollback(); } catch {}
    h.faults.before = null; h.faults.after = null;
    provisioner(revision, h.boundary).rollback();
    assert.deepEqual(h.snapshot(), before, `SHU71_ROLLBACK_RESTART: ${phase} ${point.name}`);
  }
  t.diagnostic(`${points.length * 2} rollback process-death injections`);
});
test('SHU71 provisioning refuses to remove an identity still in use', t => {
  const h = fixture(t), p = provisioner(revision, h.boundary); p.install(); h.faults.inUse = true;
  assert.throws(() => p.rollback(), { code: 'ACT_ROLLBACK_IDENTITY_IN_USE' }, 'SHU71_UNUSED_IDENTITY_REQUIRED');
  assert.ok(h.users().some(u => u.name === BROKER)); h.faults.inUse = false; p.rollback();
});
test('SHU71 rollback walks the filesystem with its own timeout, and a failed command names itself', t => {
  // 2026-10-26 and 27: three rollbacks in a row failed ACT_PREREQUISITE_COMMAND
  // once and passed a retry; the walk outgrew the 30-second default.
  const h = fixture(t), run = h.boundary.run, finds = [];
  let timeout = false;
  h.boundary.run = (exe, args, opts) => {
    if (exe === '/usr/bin/find') {
      finds.push(opts.timeout);
      if (timeout) return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error('spawnSync /usr/bin/find ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
    }
    return run(exe, args, opts);
  };
  const p = provisioner(revision, h.boundary); p.install(); timeout = true;
  let failure = null;
  try { p.rollback(); } catch (e) { failure = prerequisiteFailure(e); }
  assert.deepEqual(failure, { ok: false, code: 'ACT_PREREQUISITE_COMMAND', failed: { command: '/usr/bin/find', status: null, signal: 'SIGTERM', error: 'ETIMEDOUT' } });
  assert.ok(h.users().some(u => u.name === BROKER), 'nothing was removed');
  timeout = false; p.rollback();
  assert.ok(!h.users().some(u => u.name === BROKER));
  assert.ok(FIND_TIMEOUT_MS >= 10 * 60 * 1000);
  assert.deepEqual(finds, [FIND_TIMEOUT_MS, FIND_TIMEOUT_MS]);
});

// M15: card worker 2's directories, units and resident drop-ins, as card-run's
// timer-install renders and makes them.
async function workerTwoUnits() {
  const { render, serviceParameters } = await import('../units.mjs');
  const files = { '/etc/shu/supervisor.env': `SHU_SUPERVISOR_SECRET=${'s'.repeat(40)}\n`, '/srv/shu/coordinator.env': 'GITHUB_TOKEN=x\nLINEAR_API_TOKEN=y\n' };
  const fsio = { lstatSync: p => (p in files ? { dev: 1, ino: p.length, isFile: () => true, isSymbolicLink: () => false } : undefined),
    readFileSync: p => { if (p in files) return files[p]; throw Object.assign(Error('ENOENT'), { code: 'ENOENT' }); }, existsSync: p => p in files };
  return render(serviceParameters({ workdir: PATHS.checkout, serviceUser: 'shu-coordinator', serviceGroup: 'shu-coordinator', node: '/usr/bin/node', worker: 2 }), fsio);
}
const W2 = Object.freeze({ dirs: ['/srv/shu/state/w2', '/srv/shu/state/workspaces/w2', '/srv/shu/state/workspaces/w2/supervisor'],
  units: ['shu-supervisor-w2.service', 'shu-coordinator-w2.service'].map(name => '/etc/systemd/system/' + name),
  activation: '/srv/shu/state/w2/shu71-activation.json' });
async function stageWorkerTwo(h) {
  const units = await workerTwoUnits();
  for (const dir of W2.dirs) h.directory(dir, 0o700, 999, 982);
  for (const p of W2.units) {
    h.write(p, units[p.split('/').at(-1)]);
    h.directory(p + '.d'); h.write(p + '.d/90-shu71.conf', '[Service]\nEnvironment=ENABLE_DISPATCH=false\n');
  }
}
const rowsOf = (result, needle) => result.paths.filter(row => row.path.includes(needle));
test('M15 SHU71 precondition measures card worker 2 as timer-install makes it, and rollback leaves it to timer-remove', async t => {
  // One worker, nothing of another on the host: not one row more.
  const one = fixture(t), p1 = provisioner(revision, one.boundary); p1.install();
  const alone = p1.precondition();
  assert.equal(alone.ok, true, JSON.stringify(alone));
  assert.deepEqual(rowsOf(alone, 'w2'), []);
  // The installed config turns worker 2 on before its timer-install ran: every
  // row is measured and deferred to timer-install.
  const h = fixture(t); h.sources.set('config.json', Buffer.from(JSON.stringify({ workers: { max: 2 } })));
  const p = provisioner(revision, h.boundary); p.install();
  const deferred = p.precondition();
  assert.equal(deferred.ok, true, JSON.stringify(deferred));
  const rows = rowsOf(deferred, 'w2');
  for (const path of [...W2.dirs, ...W2.units, ...W2.units.map(u => u + '.d'), ...W2.units.map(u => u + '.d/90-shu71.conf')]) {
    assert.equal(rows.find(row => row.path === path)?.window, 'DEFERRED_UNTIL_TIMER_INSTALL', path);
  }
  assert.equal(rows.find(row => row.path === W2.activation)?.window, 'DEFERRED_UNTIL_ARM');
  // Made by timer-install: measured exactly, and read-only.
  await stageWorkerTwo(h);
  const before = h.snapshot();
  const made = p.precondition();
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.deepEqual(h.snapshot(), before, 'SHU71_PRECONDITION_READ_ONLY');
  assert.ok(rowsOf(made, 'w2').filter(row => row.path !== W2.activation).every(row => row.window === undefined && row.ok), JSON.stringify(rowsOf(made, 'w2')));
  // Rollback takes off only what the install made: worker 2's units,
  // directories and drop-ins are timer-install's, and stay for timer-remove
  // and a later timer-install to judge.
  const w2Bytes = snapshot => Object.fromEntries(Object.entries(snapshot.files).filter(([path]) => /w2/.test(path)));
  assert.equal(p.rollback().state, 'ROLLED_BACK');
  assert.deepEqual(w2Bytes(h.snapshot()), w2Bytes(before));
  assert.ok(Object.keys(w2Bytes(before)).length >= 9);
  // Even with worker 2 turned off again, what is on the host is still measured.
  const off = fixture(t), po = provisioner(revision, off.boundary); po.install(); await stageWorkerTwo(off);
  assert.equal(rowsOf(po.precondition(), 'w2').length, rows.length);
});
test('M15 SHU71 precondition refuses a card worker 2 that is not as timer-install makes it', async t => {
  const units = await workerTwoUnits();
  const [supervisor, coordinator] = W2.units;
  const cases = [
    ['an armed worker 2', 'ACT_PRODUCTION_ACTIVATION_PRESENT', h => h.write(W2.activation, '{}', 0o640, 0, 982)],
    ['a coordinator unit armed from another record', 'ACT_PRODUCTION_UNIT_BINDING',
      h => h.write(coordinator, units['shu-coordinator-w2.service'].replace('/srv/shu/state/w2/shu71-activation.json', '/srv/shu/state/shu71-activation.json'))],
    ['a coordinator unit under worker 1\'s writer lock', 'ACT_PRODUCTION_UNIT_BINDING',
      h => h.write(coordinator, units['shu-coordinator-w2.service'].replace('/srv/shu/state/workspaces/w2/host-tick.lock', '/srv/shu/state/workspaces/host-tick.lock'))],
    ['a supervisor unit on worker 1\'s workspace', 'ACT_PRODUCTION_UNIT_BINDING',
      h => h.write(supervisor, units['shu-supervisor-w2.service'].replace('SHU_WORKSPACE_STATE_DIR=/srv/shu/state/workspaces/w2', 'SHU_WORKSPACE_STATE_DIR=/srv/shu/state/workspaces'))],
    ['a writable unit', 'ACT_PRODUCTION_UNIT_CUSTODY', h => h.write(supervisor, units['shu-supervisor-w2.service'], 0o664)],
    ['a dispatching resident drop-in', 'ACT_PRODUCTION_GATE', h => h.write(supervisor + '.d/90-shu71.conf', '[Service]\nEnvironment=ENABLE_DISPATCH=true\n')],
    ['an open workspace directory', 'ACT_PREREQUISITE_CUSTODY', h => h.directory('/srv/shu/state/workspaces/w2', 0o755, 999, 982)],
    ['a root-owned state directory', 'ACT_PREREQUISITE_CUSTODY', h => h.directory('/srv/shu/state/w2', 0o700, 0, 0)],
  ];
  for (const [name, code, mutate] of cases) {
    const h = fixture(t), p = provisioner(revision, h.boundary); p.install(); await stageWorkerTwo(h);
    assert.equal(p.precondition().ok, true, name);
    mutate(h);
    const result = p.precondition();
    assert.equal(result.ok, false, name);
    assert.ok(result.paths.some(row => !row.ok && row.code === code), `${name}: ${JSON.stringify(result.paths.filter(row => !row.ok))}`);
  }
});

test('M15 SHU71 an install or rollback excludes every card worker, by hand as by the box', t => {
  const code = fn => { try { fn(); return 'OK'; } catch (e) { return e.code; } };
  const h = fixture(t), fsys = h.boundary.fs;
  // Nothing held: refused.
  assert.equal(code(() => installExclusion(fsys)), 'ACT_INSTALL_LOCK_NOT_HELD');
  // The install lock alone, with no card-run lock: refused.
  h.write('/run/lock/shu-card-install.lock', 'hand-366', 0o600);
  assert.equal(code(() => installExclusion(fsys)), 'ACT_INSTALL_LOCK_NOT_HELD');
  // Both, one holder: allowed.
  h.write('/run/lock/shu-card-run.lock', 'hand-366', 0o600);
  assert.deepEqual(installExclusion(fsys), { holder: 'hand-366', run_locks: 1 });
  // A second worker's run under way (its own run lock and activation record): refused.
  h.write('/run/lock/shu-card-run-w2.lock', '4242', 0o600);
  assert.equal(code(() => installExclusion(fsys)), 'ACT_INSTALL_WORKER_BUSY');
  h.remove('/run/lock/shu-card-run-w2.lock');
  h.write('/srv/shu/state/w2/shu71-activation.json', '{}', 0o640);
  assert.equal(code(() => installExclusion(fsys)), 'ACT_INSTALL_WORKER_ARMED');
  h.remove('/srv/shu/state/w2/shu71-activation.json');
  // The box's self-install holds worker 2's run lock and the install lock with its pid.
  h.remove('/run/lock/shu-card-run.lock');
  h.write('/run/lock/shu-card-install.lock', '777', 0o600);
  h.write('/run/lock/shu-card-run-w2.lock', '777', 0o600);
  assert.deepEqual(installExclusion(fsys), { holder: '777', run_locks: 1 });
  // A kept lock from a failed install never lets a new install through.
  h.write('/run/lock/shu-card-install.lock', 'kept: a failed install whose pause could not be written', 0o600);
  assert.equal(code(() => installExclusion(fsys)), 'ACT_INSTALL_WORKER_BUSY');

  // The CLI refuses before it takes the /etc/shu lock or runs anything.
  for (const action of ['install', 'rollback']) {
    const g = fixture(t); holdInstallLocks(g);
    g.write('/run/lock/shu-card-run-w2.lock', '4242', 0o600);
    g.write('/srv/shu/state/w2/shu71-activation.json', '{}', 0o640);
    const output = [], runs = [];
    const rc = runCli([action, revision], { uid: () => 0, fs: g.boundary.fs, run: (...args) => { runs.push(args); return { status: 0 }; } }, r => output.push(r));
    assert.equal(rc, 2, action);
    assert.equal(runs.length, 0, `${action}: nothing ran`);
    assert.equal(output[0].code, 'ACT_INSTALL_WORKER_BUSY', action);
  }
});
