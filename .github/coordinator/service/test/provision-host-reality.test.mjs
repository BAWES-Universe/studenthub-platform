import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fixture, revision } from './provision-prerequisites-fixture.mjs';
import { provisioner, runCli } from '../provision-shu71-prerequisites.mjs';
const url = new URL('../provision-shu71-prerequisites.mjs', import.meta.url);
const source = fs.readFileSync(url, 'utf8');
const load = text => import('data:text/javascript;base64,' + Buffer.from(text.replace(/from '\.\/(.*?)'/g, (_, p) => `from '${new URL('../' + p, import.meta.url)}'`)).toString('base64'));
const defs = 'UID_MIN 1000\nUID_MAX 60000\nGID_MIN 1000\nGID_MAX 60000\n';
const state = ['/srv/shu/state', '/srv/shu/state/workspaces', '/srv/shu/state/workspaces/supervisor', '/srv/shu/state/shu71-evidence'];
const gates = ['shu-supervisor.service', 'shu-coordinator.service'].flatMap(n => ['/etc/systemd/system/' + n + '.d', '/etc/systemd/system/' + n + '.d/90-shu71.conf']);
function prepare(t) {
  const h = fixture(t);
  h.write('/etc/login.defs', defs);
  for (const p of state) h.directory(p, 0o700, p.endsWith('shu71-evidence') ? 0 : 999, p.endsWith('shu71-evidence') ? 0 : 982);
  h.remove('/usr/bin/env'); h.write('/usr/lib/cargo/bin/coreutils/env', 'trusted executable', 0o755);
  fs.symlinkSync('../lib/cargo/bin/coreutils/env', h.root + '/usr/bin/env');
  h.f.readlinkSync = p => fs.readlinkSync(h.root + p);
  for (const p of gates) h.remove(p);
  h.remove('/run/shu71-evidence');
  return h;
}
test('HOST_REALITY_PRE_FIX: all five failures reproduced from merged source', async t => {
  const old = await load(fs.readFileSync(new URL('./fixtures/shu71-history/3761fc4ed83429d56a43592b125fa52564b94cc0/provision-shu71-prerequisites.mjs', import.meta.url), 'utf8'));
  const h = prepare(t);
  assert.throws(() => old.provisioner(revision, h.boundary).install(), { code: 'ACT_IDENTITY_SYSTEM_RANGE' }, 'HOST_RANGE_PRE_FIX');
  h.write('/etc/login.defs', 'SYS_UID_MIN 100\nSYS_UID_MAX 999\nSYS_GID_MIN 100\nSYS_GID_MAX 999\n');
  old.provisioner(revision, h.boundary).install();
  const r = old.provisioner(revision, h.boundary).precondition();
  for (const p of ['/usr/bin/env', ...state.slice(1), ...gates, '/srv/shu/state/shu71-activation.json']) assert.equal(r.paths.find(row => row.path === p)?.ok, false, 'HOST_PRE_FIX_' + p);
  assert.equal(r.ok, false, 'HOST_GREEN_PRE_FIX');
});
const controls = {
  RANGE_DEFAULT: impl => t => { const h = prepare(t); assert.deepEqual(impl(revision, h.boundary).install().broker, { name: 'shu71-evidence', uid: 100, gid: 100 }, 'HOST_RANGE_DEFAULT'); },
  GREEN: impl => t => {
    const h = prepare(t); impl(revision, h.boundary).install(); const before = h.snapshot();
    const r = impl(revision, h.boundary).precondition(); assert.equal(r.ok, true, 'HOST_GREEN');
    assert.deepEqual(h.snapshot(), before, 'HOST_READ_ONLY');
    assert.deepEqual(r.paths.filter(r => r.window).map(r => [r.path, r.window]), [...gates, '/srv/shu/state/shu71-activation.json'].map(p => [p, 'DEFERRED_UNTIL_ARM']), 'HOST_WINDOW_DEFERRED');
    assert.deepEqual(r.paths.filter(r => r.runtime).map(r => r.runtime), ['DEFERRED_UNTIL_SERVICE_START', 'DEFERRED_UNTIL_SERVICE_START'], 'HOST_RUNTIME_DEFERRED');
  },
};
for (const [name, control] of Object.entries(controls)) test('HOST_' + name, t => control(provisioner)(t));
test('HOST_CLI_GREEN', t => { const h = prepare(t);
  // Exercise every production blob and exact Git mode in the reviewed tree,
  // not only the small crash-matrix fixture's representative source map.
  const run = h.boundary.run;
  h.boundary.run = (exe, args, opts) => {
    if (exe === '/usr/bin/setpriv' && args.includes('/usr/bin/git')) {
      const a = args.slice(args.indexOf('-C') + 2);
      if (a[0] === 'ls-tree') return { status: 0, stdout: execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', '.github/coordinator']) };
      if (a[0] === 'cat-file') return { status: 0, stdout: execFileSync('git', a) };
    }
    return run(exe, args, opts);
  };
  provisioner(revision, h.boundary).install(); assert.equal(runCli(['precondition', revision], h.boundary, () => {}), 0, 'HOST_CLI_GREEN'); });
const refusal = (name, change, path, code) => impl => t => {
  const h = prepare(t); impl(revision, h.boundary).install(); change(h);
  const row = impl(revision, h.boundary).precondition().paths.find(r => r.path === path);
  assert.equal(row.ok, false, name); assert.equal(row.code, code, name);
};
const checks = [
  ['ENV_FOREIGN_TARGET', h => { h.remove('/usr/bin/env'); h.write('/usr/lib/foreign/env', 'foreign', 0o755); fs.symlinkSync('../lib/foreign/env', h.root + '/usr/bin/env'); }, '/usr/bin/env', 'ACT_PRODUCTION_EXECUTABLE'],
  ['ENV_FOREIGN_OWNER', h => h.owners.set('/usr/lib/cargo/bin/coreutils/env', [999, 0]), '/usr/bin/env', 'ACT_PRODUCTION_EXECUTABLE'],
  ['ENV_LINK_OWNER', h => h.owners.set('/usr/bin/env', [999, 0]), '/usr/bin/env', 'ACT_PRODUCTION_EXECUTABLE'],
  ['ENV_WRITABLE', h => h.write('/usr/lib/cargo/bin/coreutils/env', 'unsafe', 0o777), '/usr/bin/env', 'ACT_PRODUCTION_EXECUTABLE'],
  ['ENV_PARENT_WRITABLE', h => h.directory('/usr/lib/cargo', 0o777), '/usr/bin/env', 'ACT_PREREQUISITE_CUSTODY'],
  ...state.flatMap(p => [
    ['STATE_OWNER_' + p, h => h.owners.set(p, p.endsWith('shu71-evidence') ? [999, 982] : [0, 0]), p, 'ACT_PREREQUISITE_CUSTODY'],
    ['STATE_WRITE_' + p, h => h.directory(p, 0o722, 999, 982), p, 'ACT_PREREQUISITE_CUSTODY'],
    ['STATE_LINK_' + p, h => { h.remove(p); fs.symlinkSync('/tmp', h.root + p); }, p, 'ACT_PREREQUISITE_CUSTODY'],
  ]),
  ['ROOT_ANCESTOR', h => h.owners.set('/srv/shu', [999, 982]), '/srv/shu/state', 'ACT_PREREQUISITE_CUSTODY'],
  ['ACTIVATION_PRESENT', h => h.write('/srv/shu/state/shu71-activation.json', '{}'), '/srv/shu/state/shu71-activation.json', 'ACT_PRODUCTION_ACTIVATION_PRESENT'],
  ...['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer'].map(n => ['HARD_UNIT_' + n, h => h.remove('/etc/systemd/system/' + n), '/etc/systemd/system/' + n, 'ACT_PREREQUISITE_PATH_MISSING']),
];
for (const [name, ...args] of checks) test('HOST_' + name, t => refusal('HOST_' + name, ...args)(provisioner)(t));
for (const [name, extra] of [
  ['DUPLICATE', 'SYS_UID_MIN 100\nSYS_UID_MIN 101\n'], ['MALFORMED', 'SYS_UID_MIN nope\n'],
  ['REVERSED', 'SYS_UID_MIN 500\nSYS_UID_MAX 200\n'], ['OVERLAP', 'SYS_GID_MAX 1000\n'],
  ['ZERO', 'SYS_UID_MIN 0\n'], ['OVERFLOW', 'SYS_GID_MAX 9007199254740993\n'],
  ['REGULAR_MALFORMED', 'UID_MIN nope\n'],
]) test('HOST_RANGE_' + name, t => {
  const h = prepare(t); h.write('/etc/login.defs', defs + extra);
  assert.throws(() => provisioner(revision, h.boundary).install(), { code: 'ACT_IDENTITY_SYSTEM_RANGE' }, 'HOST_RANGE_' + name);
});
test('HOST_RANGE_BOUNDARIES_OCCUPANCY', t => {
  const h = prepare(t); h.write('/etc/login.defs', 'UID_MIN 999\nGID_MIN 999\nSYS_UID_MIN 995\nSYS_GID_MIN 995\n');
  h.users().push({ name: 'occupied', uid: 995, gid: 995, home: '/', shell: '/bin/false' });
  assert.deepEqual(provisioner(revision, h.boundary).install().broker, { name: 'shu71-evidence', uid: 997, gid: 997 }, 'HOST_RANGE_BOUNDARIES_OCCUPANCY');
});
const mutants = [
  ['RANGE_DEFAULT', "if (!rows.length) return fallback;", "if (!rows.length) need(false, 'ACT_IDENTITY_SYSTEM_RANGE');", controls.RANGE_DEFAULT],
  ['ENV_SYMLINK', 'const r = read(target);', 'const r = read(p);', controls.GREEN],
  ['STATE_ROOT_ONLY', 's.uid === owner.uid', 's.uid === 0', controls.GREEN],
  ['WINDOW_HARD_REQUIREMENT', "return { window: 'DEFERRED_UNTIL_ARM' };", "need(false, 'ACT_PRODUCTION_GATE_DIRECTORY');", controls.GREEN],
  ['ACTIVATION_HARD_REQUIREMENT', "need(!stat('/srv/shu/state/shu71-activation.json'),", "need(stat('/srv/shu/state/shu71-activation.json'),", controls.GREEN],
  ['GREEN_ALWAYS_REFUSE', 'return report;', 'report.ok = false; return report;', controls.GREEN],
  ['ENV_FOREIGN_TARGET', "target === '/usr/lib/cargo/bin/coreutils/env'", 'true', refusal('HOST_ENV_FOREIGN_TARGET', ...checks[0].slice(1))],
  ['ENV_FOREIGN_OWNER', 'r.uid === 0 && r.gid === 0 && r.mode === 0o755', 'r.gid === 0 && r.mode === 0o755', refusal('HOST_ENV_FOREIGN_OWNER', ...checks[1].slice(1))],
  ['ENV_WRITABLE', 'r.mode === 0o755', 'true', refusal('HOST_ENV_WRITABLE', ...checks[3].slice(1))],
  ['STATE_SYMLINK', 's?.isDirectory() && !s.isSymbolicLink() && s.uid === owner.uid', 's && s.uid === owner.uid', impl => t => {
    const h = prepare(t); impl(revision, h.boundary).install();
    const original = h.f.lstatSync; h.f.lstatSync = p => { const s = original(p); return p !== '/srv/shu/state' ? s : new Proxy(s, { get: (s,k) => k === 'isSymbolicLink' ? () => true : Reflect.get(s,k) }); };
    assert.equal(impl(revision, h.boundary).precondition().paths.find(r => r.path === '/srv/shu/state/workspaces').ok, false, 'HOST_STATE_SYMLINK');
  }],
];
for (const [name, from, to, control] of mutants) test('HOST_KILL_' + name, async t => {
  control(provisioner)(t); assert.ok(source.includes(from), 'HOST_MUTATION_SOURCE_' + name);
  const m = await load((name === 'ENV_FOREIGN_TARGET' ? source.replace("['../lib/cargo/bin/coreutils/env', '/usr/lib/cargo/bin/coreutils/env'].includes(destination)", 'true') : source).replace(from, to));
  assert.throws(() => { try { control(m.provisioner)(t); } catch (e) { assert.fail('HOST_KILL_' + name + ': ' + e.message); } }, e => e.code === 'ERR_ASSERTION' && e.message.includes('HOST_KILL_' + name), 'HOST_KILL_' + name);
});
const rangeControl = (label, defsText, expected, setup = () => {}) => impl => t => {
  const h = prepare(t); h.write('/etc/login.defs', defsText); setup(h);
  if (expected === null) assert.throws(() => impl(revision, h.boundary).install(), { code: 'ACT_IDENTITY_SYSTEM_RANGE' }, label);
  else assert.deepEqual(impl(revision, h.boundary).install().broker, { name: 'shu71-evidence', ...expected }, label);
};
for (const [name, from, to, control] of [
  ['DUPLICATE', "need(rows.length <= 1, 'ACT_IDENTITY_SYSTEM_RANGE');", '', rangeControl('HOST_DUPLICATE', defs + 'SYS_UID_MIN 100\nSYS_UID_MIN 101\n', null)],
  ['MALFORMED', "need(match && Number.isSafeInteger(Number(match[1])), 'ACT_IDENTITY_SYSTEM_RANGE');", 'if (!match) return fallback;', rangeControl('HOST_MALFORMED', defs + 'SYS_UID_MIN bad\n', null)],
  ['MAX_DEFAULT', "regularMin - 1", '999', rangeControl('HOST_MAX_DEFAULT', 'UID_MIN 500\nGID_MIN 500\n', { uid:100, gid:100 })],
  ['OCCUPIED_UID', '!used.has(n)', 'true', rangeControl('HOST_OCCUPIED_UID', defs, {uid:101,gid:100}, h => h.users().push({name:'occupied',uid:100,gid:200,home:'/',shell:'/bin/false'}))],
  ['NO_WORLD_WRITE', "&& !(s.mode & 0o022)", '', impl => t => {
    const h = prepare(t); impl(revision,h.boundary).install(); h.directory('/srv/shu',0o777);
    assert.equal(impl(revision,h.boundary).precondition().paths.find(r=>r.path==='/srv/shu/state').ok,false,'HOST_NO_WORLD_WRITE');
  }],
]) test('HOST_KILL_' + name, async t => {
  control(provisioner)(t); assert.ok(source.includes(from)); const m = await load(source.replace(from,to));
  assert.throws(() => { try { control(m.provisioner)(t); } catch(e) { assert.fail('HOST_KILL_' + name + ': ' + e.message); } }, e => e.code === 'ERR_ASSERTION' && e.message.includes('HOST_KILL_' + name), 'HOST_KILL_' + name);
});
