import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { provisioner, PATHS } from '../provision-shu71-prerequisites.mjs';
import { fixture, revision } from './provision-prerequisites-fixture.mjs';

const dir = '/run/shu71-evidence', socket = dir + '/fixture.sock';
const runtime = report => report.paths.filter(r => [dir, socket].includes(r.path));
async function mutant(from, to) {
  const url = new URL('../provision-shu71-prerequisites.mjs', import.meta.url);
  let source = fs.readFileSync(url, 'utf8');
  assert.equal(source.split(from).length, 2, 'H_MUTANT_UNIQUE_SOURCE');
  source = source.replace(from, to).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, rel) => `${prefix}${quote}${new URL(rel, url)}${quote}`);
  source = source.replaceAll('import.meta.url', JSON.stringify(url.href));
  return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).provisioner;
}
async function kills(t, label, check, from, to) {
  check(provisioner);
  const changed = await mutant(from, to);
  assert.throws(() => check(changed), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
}
function installed(t, running = true) {
  const h = fixture(t);
  if (!running) h.remove('/run');
  assert.equal(provisioner(revision, h.boundary).install().state, 'VERIFIED', 'H_INSTALL_CONTROL');
  assert.equal(provisioner(revision, h.boundary).precondition().ok, true, 'H_STATIC_AND_RUNTIME_CONTROL');
  return h;
}
for (const [label, from, to] of [
  ['H1_NOT_STARTED', "return { runtime: 'DEFERRED_UNTIL_SERVICE_START' };", "need(false, 'ACT_BROKER_SOCKET_CUSTODY');"],
  ['H1_EXPLICIT_RUNTIME_MARKER', "return { runtime: 'DEFERRED_UNTIL_SERVICE_START' };", 'return {};'],
]) test(`${label} passing control and named mutant kill`, async t => {
  await kills(t, label, impl => {
    const h = installed(t, false), before = h.snapshot(), events = [...h.events];
    const report = impl(revision, h.boundary).precondition();
    assert.equal(report.ok, true, label);
    assert.deepEqual(runtime(report), [dir, socket].map(path => ({ path, ok: true, runtime: 'DEFERRED_UNTIL_SERVICE_START' })), label);
    assert.deepEqual(h.snapshot(), before, 'H1_READ_ONLY');
    assert.deepEqual(h.events.slice(events.length), ['parser:-', 'parser:/etc/sudoers.d/shu-reviewer'], 'H1_READ_ONLY_PARSER_EVENTS');
  }, from, to);
});
test('H1_RUNNING_MEASURED passing control and named mutant kill', async t => {
  const label = 'H1_RUNNING_MEASURED';
  await kills(t, label, impl => {
    const h = installed(t), report = impl(revision, h.boundary).precondition();
    assert.equal(report.ok, true, label);
    assert.deepEqual(runtime(report), [dir, socket].map((path, i) => ({ path, ok: true, runtime: 'MEASURED', uid: 100, gid: 980, mode: i ? 0o660 : 0o750 })), label);
  }, "runtime: 'MEASURED'", "runtime: 'DEFERRED_UNTIL_SERVICE_START'");
});
for (const [kind, target, mode, code] of [
  ['DIRECTORY', dir, 0o750, 'ACT_BROKER_DIRECTORY_MODE'],
  ['SOCKET', socket, 0o660, 'ACT_BROKER_SOCKET_MODE'],
]) {
  for (const [field, owner] of [['UID', [4242, 980]], ['GID', [100, 4243]]]) {
    const label = `H2_${kind}_${field}_CUSTODY`;
    test(`${label} passing control and named mutant kill`, async t => {
      await kills(t, label, impl => {
        const h = installed(t); h.owners.set(target, owner);
        assert.equal(h.f.lstatSync(target)[field.toLowerCase()], owner[field === 'UID' ? 0 : 1], label + '_FIXTURE_STATE');
        const report = impl(revision, h.boundary).precondition();
        assert.equal(report.paths.find(r => r.path === target)?.code, 'ACT_BROKER_SOCKET_CUSTODY', label);
        assert.equal(report.ok, false, label);
      }, 's.uid === broker.uid && s.gid === shared.gid', 'true');
    });
  }
  const label = `H1_${kind}_WIDENED_MODE`;
  test(`${label} passing control and named mutant kill`, async t => {
    await kills(t, label, impl => {
      const h = installed(t); fs.chmodSync(h.root + target, 0o777);
      const report = impl(revision, h.boundary).precondition();
      assert.equal(report.paths.find(r => r.path === target)?.code, code, label);
      assert.equal(report.ok, false, label);
    }, `(s.mode & 0o7777) === 0o${mode.toString(8)}`, 'true');
  });
}
test('H1_PARTIAL_RUNTIME passing control and named mutant kill', async t => {
  const label = 'H1_PARTIAL_RUNTIME';
  await kills(t, label, impl => {
    const h = installed(t); h.remove(socket);
    const report = impl(revision, h.boundary).precondition();
    assert.equal(report.ok, false, label);
    assert.equal(report.paths.find(r => r.path === dir)?.code, 'ACT_BROKER_SOCKET_CUSTODY', label);
    assert.equal(report.paths.find(r => r.path === socket)?.code, 'ACT_BROKER_SOCKET_CUSTODY', label);
  }, "need(peer, 'ACT_BROKER_SOCKET_CUSTODY');", '');
});
const absentGuard = "need(report.ok, report.paths.find(r => !r.ok)?.code ?? 'ACT_PREREQUISITE_MISSING');";
for (const [name, damage, code] of [
  ['UNIT', h => h.write(PATHS.unit, 'drift'), 'ACT_TREE_CONTENT'],
  ['IDENTITY', h => { h.users().find(u => u.name === 'shu71-evidence').shell = '/bin/sh'; }, 'ACT_BROKER_IDENTITY'],
  ['GROUP', h => { h.groups().find(g => g.name === 'shu-workspace').name = 'renamed'; }, 'ACT_BROKER_SHARED_GROUP'],
  ['MEMBERSHIP', h => { h.groups().find(g => g.name === 'shu-workspace').members = ''; }, 'ACT_BROKER_COORDINATOR_ACCESS'],
  ['KEY', h => h.owners.set('/etc/shu/keys/shu71-activation-ed25519.pem', [42, 0]), 'ACT_FILE_CUSTODY'],
  ['RECEIPT', h => h.owners.set(PATHS.receipt, [42, 0]), 'ACT_PREREQUISITE_RECEIPT'],
  ['TREE', h => h.write(PATHS.tree + '/service/shu71-production.mjs', 'drift'), 'ACT_TREE_CONTENT'],
  ['CHECKOUT', h => h.owners.set(PATHS.checkout, [42, 0]), 'ACT_PREREQUISITE_CHECKOUT'],
  ['REFS', h => { const run = h.boundary.run; h.boundary.run = (exe, args, opts) => args.includes('--verify') ? { status: 0, stdout: 'bad' } : run(exe, args, opts); }, 'ACT_REF_BINDING'],
]) {
  const label = `H1_ABSENT_STATIC_${name}`;
  test(`${label} passing control and named mutant kill`, async t => {
    await kills(t, label, impl => {
      const h = installed(t, false); damage(h);
      const report = impl(revision, h.boundary).precondition();
      assert.equal(report.ok, false, label);
      assert.ok(report.paths.some(r => ![dir, socket].includes(r.path) && r.code === code), label);
      assert.deepEqual(runtime(report), [dir, socket].map(path => ({ path, ok: false, code })), label);
    }, ...(['IDENTITY', 'GROUP', 'MEMBERSHIP'].includes(name)
      ? ['const broker = identity(), shared = sharedAccess(), s = stat(p);', "if (!stat(p) && !stat(p === EVIDENCE_SOCKET ? '/run/shu71-evidence' : EVIDENCE_SOCKET)) return { runtime: 'DEFERRED_UNTIL_SERVICE_START' }; const broker = identity(), shared = sharedAccess(), s = stat(p);"]
      : [absentGuard, '']));
  });
}
test('H1_ABSENT_RENDER passing control and named mutant kill', async t => {
  const label = 'H1_ABSENT_RENDER';
  const injection = "import { renderEvidenceBroker } from './shu71-production.mjs';";
  const render = "import { renderEvidenceBroker as reviewed } from './shu71-production.mjs'; const renderEvidenceBroker = () => reviewed().replace('Group=shu-workspace', 'Group=messagebus');";
  const check = impl => {
    const h = installed(t, false);
    const report = impl(revision, h.boundary).precondition();
    assert.equal(report.ok, false, label);
    assert.equal(report.paths.find(r => r.path === 'identity:shu71-evidence')?.code, 'ACT_BROKER_UNIT_BINDING', label);
    for (const r of runtime(report)) assert.equal(r.code, 'ACT_BROKER_UNIT_BINDING', label);
  };
  check(await mutant(injection, render));
  // The named render binding is exercised with an invalid Group, independently
  // of the unit byte comparison and without relying on a source-anchor kill.
  const guard = "need(renderEvidenceBroker().includes(`\\nUser=${BROKER}\\nGroup=${SHARED_GROUP}\\n`) && !/\\n(?:User|Group)=\\d+\\n/.test(renderEvidenceBroker()), 'ACT_BROKER_UNIT_BINDING');";
  // Compose two edits through a local source seam; keep the generic mutant's
  // source uniqueness assertion for both anchors.
  const url = new URL('../provision-shu71-prerequisites.mjs', import.meta.url);
  let source = fs.readFileSync(url, 'utf8');
  assert.equal(source.split(guard).length, 2, 'H_RENDER_GUARD_SOURCE');
  source = source.replace(guard, guard.replace('Group=${SHARED_GROUP}\\n', '')).replace(injection, render)
    .replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, p, q, rel) => `${p}${q}${new URL(rel, url)}${q}`)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  const weak = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).provisioner;
  assert.throws(() => check(weak), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});

for (const [name, before, after, code] of [
  ['USER', 'User=shu71-evidence', 'User=other', 'ACT_BROKER_UNIT_USER'],
  ['GROUP', 'Group=shu-workspace', 'Group=other', 'ACT_BROKER_UNIT_GROUP'],
  ['RUNTIME_DIRECTORY', 'RuntimeDirectory=shu71-evidence', 'RuntimeDirectory=other', 'ACT_BROKER_UNIT_RUNTIME_DIRECTORY'],
  ['DIRECTORY_MODE', 'RuntimeDirectoryMode=0750', 'RuntimeDirectoryMode=0770', 'ACT_BROKER_UNIT_DIRECTORY_MODE'],
  ['UMASK', 'UMask=0007', 'UMask=0000', 'ACT_BROKER_UNIT_UMASK'],
  ['NUMERIC_IDENTITY', 'NoNewPrivileges=true', 'SupplementaryGroups=980', 'ACT_BROKER_UNIT_NUMERIC_IDENTITY'],
]) test(`OWNER_STATIC_${name} passing control and named mutant kill`, async t => {
  installed(t, false);
  const label = `OWNER_STATIC_${name}`;
  const injection = "import { renderEvidenceBroker } from './shu71-production.mjs';";
  const render = `import { renderEvidenceBroker as reviewed } from './shu71-production.mjs'; const renderEvidenceBroker = () => reviewed().replace('${before}', '${after}');`;
  const check = impl => {
    const h = installed(t, false), report = impl(revision, h.boundary).precondition();
    assert.equal(report.ok, false, label);
    assert.ok(report.paths.some(r => r.code === code), label);
    assert.ok(runtime(report).every(r => r.ok === false && !Object.hasOwn(r, 'runtime')), label);
  };
  const disk = installed(t, false);
  disk.write(PATHS.unit, fs.readFileSync(disk.root + PATHS.unit, 'utf8').replace(before, after));
  const diskReport = provisioner(revision, disk.boundary).precondition();
  assert.ok(diskReport.paths.some(r => r.code === code), label + '_INSTALLED_UNIT');
  assert.ok(runtime(diskReport).every(r => !Object.hasOwn(r, 'runtime')), label + '_INSTALLED_UNIT');
  check(await mutant(injection, render));
  const url = new URL('../provision-shu71-prerequisites.mjs', import.meta.url);
  let source = fs.readFileSync(url, 'utf8').replace(injection, render);
  source = source.replace("if (!v) throw", `if (!v && code !== '${code}') throw`)
    .replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, p, q, rel) => `${p}${q}${new URL(rel, url)}${q}`)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  const weak = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).provisioner;
  assert.throws(() => check(weak), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});
test('OWNER_STATIC_SOCKET_CONTRACT passing control and named mutant kill', async t => {
  const label = 'OWNER_STATIC_SOCKET_CONTRACT';
  await kills(t, label, impl => {
    const h = installed(t, false);
    h.write(PATHS.tree + '/service/fixture-evidence-broker.mjs', 'fs.chmodSync(EVIDENCE_SOCKET, 0o666)');
    const report = impl(revision, h.boundary).precondition();
    assert.equal(report.ok, false, label);
    assert.ok(report.paths.some(r => r.code === 'ACT_BROKER_SOCKET_CONTRACT'), label);
    assert.ok(runtime(report).every(r => !Object.hasOwn(r, 'runtime')), label);
  }, "need(source.includes('fs.chmodSync(EVIDENCE_SOCKET, 0o660)'), 'ACT_BROKER_SOCKET_CONTRACT');", '');
});
