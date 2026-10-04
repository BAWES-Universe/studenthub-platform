import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisioner, parseCli, PATHS, BROKER } from '../provision-shu71-prerequisites.mjs';
import { revision } from './provision-prerequisites-fixture.mjs';
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
