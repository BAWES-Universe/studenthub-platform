import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture, revision } from './provision-prerequisites-fixture.mjs';
import { provisioner, runCli, PATHS } from '../provision-shu71-prerequisites.mjs';
const url = new URL('../provision-shu71-prerequisites.mjs', import.meta.url);
const source = fs.readFileSync(url, 'utf8');
const load = text => import('data:text/javascript;base64,' + Buffer.from(text.replace(/from '\.\/(.*?)'/g, (_, p) => `from '${new URL('../' + p, import.meta.url)}'`)).toString('base64'));
const defs = 'UID_MIN 1000\nUID_MAX 60000\nGID_MIN 1000\nGID_MAX 60000\n';
const state = ['/srv/shu/state', '/srv/shu/state/workspaces', '/srv/shu/state/workspaces/supervisor', '/srv/shu/state/shu71-evidence'];
const gates = ['shu-supervisor.service', 'shu-coordinator.service'].flatMap(n => ['/etc/systemd/system/' + n + '.d', '/etc/systemd/system/' + n + '.d/90-shu71.conf']);
// Measured prepared-deployment shape: the checkout is the live npm workspace
// and holds exactly 19 in-tree symlinks, every one resolving inside the
// checkout root and readable by the service identity (zero escapes measured).
const PACKAGE_LINKS = [['@studenthub/gateway', 'apps/gateway'], ['@studenthub/worker', 'apps/worker'],
  ['@studenthub/contracts', 'packages/contracts'], ['@studenthub/search-bakeoff', 'tools/search-bakeoff'],
  ['@studenthub/fixtures', 'packages/fixtures'], ['@studenthub/reconciliation', 'packages/reconciliation'],
  ['@studenthub/search', 'packages/search'], ['@studenthub/db', 'packages/db'],
  ['@studenthub/legacy-import', 'tools/legacy-import'], ['@bawes/actor-assertion', 'packages/actor-assertion']];
const BIN_LINKS = [['tsc', 'typescript/bin/tsc'], ['tsserver', 'typescript/bin/tsserver'],
  ['vite', 'vite/bin/vite.js'], ['vite-node', 'vite-node/vite-node.mjs'], ['vitest', 'vitest/vitest.mjs'],
  ['esbuild', 'esbuild/bin/esbuild'], ['rollup', 'rollup/dist/bin/rollup'], ['nanoid', 'nanoid/bin/nanoid.cjs'],
  ['why-is-node-running', 'why-is-node-running/cli.js']];
const SYMLINK_CENSUS = PACKAGE_LINKS.length + BIN_LINKS.length;
// cargo's multicall coreutils set: one inode, measured nlink 115 on the target
// host, reached through the root-owned /usr/bin/env symlink.
const MULTICALL = '/usr/lib/cargo/bin/coreutils/env', MULTICALL_LINKS = 115;
function link(h, from, to) {
  fs.mkdirSync(path.dirname(h.root + PATHS.checkout + '/' + from), { recursive: true });
  fs.symlinkSync(to, h.root + PATHS.checkout + '/' + from);
}
function deployment(h) {
  for (const [name, target] of PACKAGE_LINKS) {
    h.write(`${PATHS.checkout}/${target}/package.json`, '{"name":"' + name + '"}');
    link(h, 'node_modules/' + name, '../../' + target);
  }
  for (const [name, target] of BIN_LINKS) {
    h.write(`${PATHS.checkout}/node_modules/${target}`, '#!/usr/bin/env node\n');
    link(h, 'node_modules/.bin/' + name, '../' + target);
  }
}
function multicall(h) {
  h.write(MULTICALL, 'trusted executable', 0o755);
  for (let n = 1; n < MULTICALL_LINKS; n++) fs.linkSync(h.root + MULTICALL, h.root + '/usr/lib/cargo/bin/coreutils/applet-' + n);
  fs.symlinkSync('../lib/cargo/bin/coreutils/env', h.root + '/usr/bin/env');
}
function prepare(t) {
  const h = fixture(t);
  h.write('/etc/login.defs', defs);
  for (const p of state) h.directory(p, 0o700, p.endsWith('shu71-evidence') ? 0 : 999, p.endsWith('shu71-evidence') ? 0 : 982);
  h.remove('/usr/bin/env'); multicall(h); deployment(h);
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
  ['ENV_SYMLINK', 'const r = read(target, true);', 'const r = read(p, true);', controls.GREEN],
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

// Real deployment checkout and pre-existing multicall executable corrections.
const evidence = ['/run/shu71-evidence', '/run/shu71-evidence/fixture.sock'];
const rowOf = (h, impl, p) => impl(revision, h.boundary).precondition().paths.find(r => r.path === p);
const linkRefusal = (label, build, code) => impl => t => {
  const h = prepare(t); build(h);
  const row = rowOf(h, impl, PATHS.checkout);
  assert.equal(row.ok, false, label); assert.equal(row.code, code, label);
};
const deployed = {
  CHECKOUT_CENSUS: impl => t => {
    const h = prepare(t); impl(revision, h.boundary).install();
    const report = impl(revision, h.boundary).precondition();
    const row = report.paths.find(r => r.path === PATHS.checkout);
    assert.equal(row.ok, true, 'HOST_CHECKOUT_CENSUS');
    assert.equal(row.symlinks, SYMLINK_CENSUS, 'HOST_CHECKOUT_CENSUS');
    assert.equal(report.ok, true, 'HOST_CHECKOUT_CENSUS');
  },
  CHECKOUT_ESCAPE: linkRefusal('HOST_CHECKOUT_ESCAPE',
    h => link(h, 'node_modules/.escape', '/srv/shu/absent-target'), 'ACT_PREREQUISITE_CHECKOUT_SYMLINK_ESCAPE'),
  CHECKOUT_ESCAPE_EXISTING: linkRefusal('HOST_CHECKOUT_ESCAPE_EXISTING',
    h => link(h, 'node_modules/.escape', '/etc/passwd'), 'ACT_PREREQUISITE_CHECKOUT_SYMLINK_ESCAPE'),
  CHECKOUT_ESCAPE_REALPATH: impl => t => {
    // Link text stays in-tree; only the resolved real path leaves the checkout.
    const h = prepare(t); link(h, 'node_modules/.resolved', '../apps/gateway/package.json');
    const real = h.f.realpathSync;
    h.f.realpathSync = p => p === PATHS.checkout + '/apps/gateway/package.json' ? '/etc/passwd' : real(p);
    const row = rowOf(h, impl, PATHS.checkout);
    assert.equal(row.ok, false, 'HOST_CHECKOUT_ESCAPE_REALPATH');
    assert.equal(row.code, 'ACT_PREREQUISITE_CHECKOUT_SYMLINK_ESCAPE', 'HOST_CHECKOUT_ESCAPE_REALPATH');
  },
  CHECKOUT_DANGLING: linkRefusal('HOST_CHECKOUT_DANGLING',
    h => link(h, 'node_modules/.dangling', './absent-sibling'), 'ACT_PREREQUISITE_CHECKOUT_SYMLINK_UNRESOLVED'),
  CHECKOUT_LOOP: linkRefusal('HOST_CHECKOUT_LOOP', h => {
    link(h, 'node_modules/.loop-a', './.loop-b'); link(h, 'node_modules/.loop-b', './.loop-a');
  }, 'ACT_PREREQUISITE_CHECKOUT_SYMLINK_UNRESOLVED'),
  CHECKOUT_WRITABLE_TARGET: linkRefusal('HOST_CHECKOUT_WRITABLE_TARGET', h => {
    h.write(PATHS.checkout + '/tools/shared.json', '{}', 0o666, 999, 982);
    link(h, 'node_modules/.shared', '../tools/shared.json');
  }, 'ACT_PREREQUISITE_CHECKOUT_SYMLINK_WRITABLE'),
  CHECKOUT_UNREADABLE_TARGET: linkRefusal('HOST_CHECKOUT_UNREADABLE_TARGET', h => {
    h.write(PATHS.checkout + '/tools/private.key', 'secret', 0o600, 0, 0);
    link(h, 'node_modules/.private', '../tools/private.key');
  }, 'ACT_PREREQUISITE_CHECKOUT_ACCESS'),
  CHECKOUT_ANCESTOR: impl => t => {
    const h = prepare(t); const original = h.f.lstatSync;
    h.f.lstatSync = p => { const s = original(p); return p !== '/srv/shu' ? s : new Proxy(s, { get: (s, k) => k === 'isSymbolicLink' ? () => true : Reflect.get(s, k) }); };
    const row = rowOf(h, impl, PATHS.checkout);
    assert.equal(row.ok, false, 'HOST_CHECKOUT_ANCESTOR');
    assert.equal(row.code, 'ACT_PREREQUISITE_CHECKOUT_ANCESTOR', 'HOST_CHECKOUT_ANCESTOR');
  },
  ENV_MULTILINK: impl => t => {
    const h = prepare(t); impl(revision, h.boundary).install();
    assert.equal(h.f.lstatSync(MULTICALL).nlink, MULTICALL_LINKS, 'HOST_ENV_MULTILINK');
    const report = impl(revision, h.boundary).precondition();
    assert.equal(report.paths.find(r => r.path === '/usr/bin/env').ok, true, 'HOST_ENV_MULTILINK');
    assert.equal(report.ok, true, 'HOST_ENV_MULTILINK');
  },
  INSTALLED_SINGLE_LINK: impl => t => {
    const h = prepare(t); impl(revision, h.boundary).install();
    fs.linkSync(h.root + PATHS.wrapper, h.root + '/usr/local/libexec/shu-reviewer-sandbox.extra-link');
    assert.equal(h.f.lstatSync(PATHS.wrapper).nlink, 2, 'HOST_INSTALLED_SINGLE_LINK');
    const row = rowOf(h, impl, PATHS.wrapper);
    assert.equal(row.ok, false, 'HOST_INSTALLED_SINGLE_LINK');
    assert.equal(row.code, 'ACT_PREREQUISITE_CUSTODY', 'HOST_INSTALLED_SINGLE_LINK');
  },
  MULTILINK_WRITABLE_TARGET: impl => t => {
    const h = prepare(t); h.write(MULTICALL, 'unsafe', 0o777);
    assert.equal(h.f.lstatSync(MULTICALL).nlink, MULTICALL_LINKS, 'HOST_MULTILINK_WRITABLE_TARGET');
    const row = rowOf(h, impl, '/usr/bin/env');
    assert.equal(row.ok, false, 'HOST_MULTILINK_WRITABLE_TARGET');
    assert.equal(row.code, 'ACT_PRODUCTION_EXECUTABLE', 'HOST_MULTILINK_WRITABLE_TARGET');
  },
  MULTILINK_FOREIGN_OWNER: impl => t => {
    const h = prepare(t); h.owners.set(MULTICALL, [999, 0]);
    assert.equal(h.f.lstatSync(MULTICALL).nlink, MULTICALL_LINKS, 'HOST_MULTILINK_FOREIGN_OWNER');
    const row = rowOf(h, impl, '/usr/bin/env');
    assert.equal(row.ok, false, 'HOST_MULTILINK_FOREIGN_OWNER');
    assert.equal(row.code, 'ACT_PRODUCTION_EXECUTABLE', 'HOST_MULTILINK_FOREIGN_OWNER');
  },
  MIRRORED_REFUSAL: impl => t => {
    const mirrored = prepare(t); impl(revision, mirrored.boundary).install();
    mirrored.write(PATHS.unit, 'drift');
    const rows = impl(revision, mirrored.boundary).precondition().paths.filter(r => evidence.includes(r.path));
    assert.deepEqual(rows, evidence.map(path => ({ path, ok: false, code: 'ACT_TREE_CONTENT',
      mirrored_code: 'ACT_TREE_CONTENT', mirrored_from: PATHS.unit })), 'HOST_MIRRORED_REFUSAL');
    const direct = prepare(t); impl(revision, direct.boundary).install();
    direct.groups().find(g => g.name === 'shu-workspace').name = 'renamed';
    assert.deepEqual(impl(revision, direct.boundary).precondition().paths.filter(r => evidence.includes(r.path)),
      evidence.map(path => ({ path, ok: false, code: 'ACT_BROKER_SHARED_GROUP' })), 'HOST_MIRRORED_REFUSAL');
  },
};
for (const [name, control] of Object.entries(deployed)) test('HOST_' + name, t => control(provisioner)(t));
// Stricter harness than the matrices above: the mutant must die by the exact
// named assertion, never by an import, syntax or unrelated runtime failure.
const both = (a, b) => s => s.replace(a[0], a[1]).replace(b[0], b[1]);
const one = (from, to) => s => s.replace(from, to);
for (const [name, label, anchors, mutate] of [
  ['CHECKOUT_SYMLINK_BAN', 'HOST_CHECKOUT_CENSUS', [' if (s.isSymbolicLink()) { symlinks++; const t = target(p);'],
    one(' if (s.isSymbolicLink()) { symlinks++; const t = target(p);', ' if (s.isSymbolicLink()) { refuse(CODE.escape); const t = target(p);')],
  ['CHECKOUT_CENSUS', 'HOST_CHECKOUT_CENSUS', ['revision, symlinks: measured.symlinks };'],
    one('revision, symlinks: measured.symlinks };', 'revision };')],
  ['CHECKOUT_ESCAPE', 'HOST_CHECKOUT_ESCAPE', [' if (!inside(current)) refuse(CODE.escape); } }'],
    one(' if (!inside(current)) refuse(CODE.escape); } }', ' } }')],
  ['CHECKOUT_ESCAPE_RESOLVED', 'HOST_CHECKOUT_ESCAPE_EXISTING', [' if (!inside(current)) refuse(CODE.escape); } }', ' if (!inside(real)) refuse(CODE.escape);'],
    both([' if (!inside(current)) refuse(CODE.escape); } }', ' } }'], [' if (!inside(real)) refuse(CODE.escape);', ''])],
  ['CHECKOUT_ESCAPE_REALPATH', 'HOST_CHECKOUT_ESCAPE_REALPATH', [' if (!inside(real)) refuse(CODE.escape);'],
    one(' if (!inside(real)) refuse(CODE.escape);', '')],
  ['CHECKOUT_DANGLING', 'HOST_CHECKOUT_DANGLING', ['fs.lstatSync(current); } catch { refuse(CODE.unresolved); }'],
    one('fs.lstatSync(current); } catch { refuse(CODE.unresolved); }', 'fs.lstatSync(current); } catch { return { path: current, stat: { isDirectory: () => false, mode: 0o644 } }; }')],
  // A bounded hop counter still terminates, so the mutant is observable: it
  // loses only the named cycle refusal.
  ['CHECKOUT_LOOP', 'HOST_CHECKOUT_LOOP', [' if (seen.has(current)) refuse(CODE.unresolved); seen.add(current);', 'const seen = new Set(); let current = link;'],
    both([' if (seen.has(current)) refuse(CODE.unresolved); seen.add(current);', ' if (hops++ > 64) refuse(CODE.access); seen.add(current);'],
      ['const seen = new Set(); let current = link;', 'const seen = new Set(); let hops = 0; let current = link;'])],
  ['CHECKOUT_WRITABLE_TARGET', 'HOST_CHECKOUT_WRITABLE_TARGET', [' if (t.stat.mode & 0o022) refuse(CODE.writable);'],
    one(' if (t.stat.mode & 0o022) refuse(CODE.writable);', '')],
  ['CHECKOUT_READ_PROOF', 'HOST_CHECKOUT_UNREADABLE_TARGET', [' permitted(t.path, t.stat); return; }', ' permitted(p, s); if (s.isDirectory())'],
    both([' permitted(t.path, t.stat); return; }', ' return; }'], [' permitted(p, s); if (s.isDirectory())', ' if (s.isDirectory())'])],
  ['CHECKOUT_ANCESTOR', 'HOST_CHECKOUT_ANCESTOR', ["      need(a?.isDirectory() && !a.isSymbolicLink() && a.uid === 0 && !(a.mode & 0o022), 'ACT_PREREQUISITE_CHECKOUT_ANCESTOR');\n"],
    one("      need(a?.isDirectory() && !a.isSymbolicLink() && a.uid === 0 && !(a.mode & 0o022), 'ACT_PREREQUISITE_CHECKOUT_ANCESTOR');\n", '')],
  ['ENV_MULTILINK', 'HOST_ENV_MULTILINK', ['const r = read(target, true);'], one('const r = read(target, true);', 'const r = read(target);')],
  ['INSTALLED_SINGLE_LINK', 'HOST_INSTALLED_SINGLE_LINK', ['(shared || s.nlink === 1)'], one('(shared || s.nlink === 1)', 'true')],
  ['MULTILINK_WRITABLE_TARGET', 'HOST_MULTILINK_WRITABLE_TARGET', ['r.mode === 0o755'], one('r.mode === 0o755', 'true')],
  ['MULTILINK_FOREIGN_OWNER', 'HOST_MULTILINK_FOREIGN_OWNER', ['r.uid === 0 && r.gid === 0 && r.mode === 0o755'],
    one('r.uid === 0 && r.gid === 0 && r.mode === 0o755', 'r.gid === 0 && r.mode === 0o755')],
  ['MIRRORED_REFUSAL', 'HOST_MIRRORED_REFUSAL', ['...(e.mirrored ? { mirrored_code: code, mirrored_from: e.mirrored } : {})'],
    one('...(e.mirrored ? { mirrored_code: code, mirrored_from: e.mirrored } : {})', '')],
  ['MIRRORED_INDISCRIMINATE', 'HOST_MIRRORED_REFUSAL', ['...(e.mirrored ? { mirrored_code: code, mirrored_from: e.mirrored } : {})'],
    one('...(e.mirrored ? { mirrored_code: code, mirrored_from: e.mirrored } : {})', '...{ mirrored_code: code, mirrored_from: p }')],
]) test('HOST_KILL_' + name, async t => {
  deployed[label.slice('HOST_'.length)](provisioner)(t);
  for (const anchor of anchors) assert.equal(source.split(anchor).length, 2, 'HOST_MUTATION_SOURCE_' + name);
  const changed = mutate(source);
  assert.notEqual(changed, source, 'HOST_MUTATION_APPLIED_' + name);
  const m = await load(changed);
  assert.throws(() => deployed[label.slice('HOST_'.length)](m.provisioner)(t),
    e => e.code === 'ERR_ASSERTION' && e.message.includes(label), 'HOST_KILL_' + name);
});
