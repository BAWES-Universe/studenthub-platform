import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as api from '../units.mjs';
import { secretText, coordinatorText, environmentText, supervisorEnvironment } from './shu71-supervisor-environment-fixture.mjs';
function controls(module = api) {
  assert.deepEqual(module.assertSupervisorLaunchEnvironment(secretText(), coordinatorText()), supervisorEnvironment, 'CLOSURE_SPLIT_PASSES');
  assert.throws(() => module.assertSupervisorLaunchEnvironment(environmentText(), coordinatorText()), /SHU251_ENV_CROSSED/, 'CLOSURE_COMBINED_REFUSED');
  assert.throws(() => module.assertSupervisorLaunchEnvironment(secretText(), coordinatorText() + secretText()), /SHU251_ENV_CROSSED/, 'CLOSURE_CROSSED_REFUSED');
  const child = module.adapterLaunchEnvironment(coordinatorText());
  for (const key of module.supervisorAdapterKeys) assert.equal(child[key], supervisorEnvironment[key], 'CLOSURE_CHILD_BINDINGS');
  for (const key of ['SHU_SUPERVISOR_SECRET', 'GITHUB_TOKEN', 'LINEAR_API_TOKEN']) assert.equal(child[key], undefined, 'CLOSURE_CHILD_NO_AUTHORITY');
}
test('CLOSURE_ENV split passes combined and crossed refuse', () => controls());
test('CLOSURE_ENV child reads fixed coordinator source with custody', () => {
  const calls = [];
  const io = { constants: fs.constants,
    openSync(p, flags) { calls.push(p); assert.ok(flags & fs.constants.O_NOFOLLOW); return 9; },
    fstatSync: () => ({ isFile: () => true, nlink: 1, uid: 999, gid: 999, mode: 0o100600, size: 100 }),
    readFileSync: () => coordinatorText(), closeSync: fd => calls.push(fd) };
  assert.deepEqual(api.readAdapterLaunchEnvironment(io, 999, 999), api.adapterLaunchEnvironment(coordinatorText()), 'CLOSURE_CHILD_SOURCE');
  assert.deepEqual(calls, ['/srv/shu/coordinator.env', 9]);
  assert.throws(() => api.readAdapterLaunchEnvironment(io, 998, 999), /SHU251_ENV_CUSTODY/);
});
for (const [label, from, to, assertion] of [
  ['combined accepted', "supervisor.size === 1 && supervisor.has('SHU_SUPERVISOR_SECRET')", 'true', 'CLOSURE_COMBINED_REFUSED'],
  ['crossed accepted', "!coordinator.has('SHU_SUPERVISOR_SECRET')", 'true', 'CLOSURE_CROSSED_REFUSED'],
  ['child adapter delivery omitted', 'supervisorAdapterKeys.includes(key)\n    ||', 'false\n    ||', 'CLOSURE_CHILD_BINDINGS'],
]) test(`CLOSURE_ENV mutation ${label}`, async t => {
  controls();
  const sourceURL = new URL('../units.mjs', import.meta.url);
  const source = fs.readFileSync(sourceURL, 'utf8').replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from '${new URL(p, sourceURL).href}'`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-env-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mutant.mjs');
  // The first matching coordinator guard is the arming guard; staging retains its own.
  assert.ok(source.includes(from)); fs.writeFileSync(file, source.replace(from, to));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  const mutant = await import(pathToFileURL(file));
  assert.throws(() => controls(mutant), e => e.code === 'ERR_ASSERTION' && e.message.includes(assertion), assertion);
});

import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
import { fork } from 'node:child_process';
import { createSupervisorSpawner } from '../../supervisor-worker.mjs';
import { REQUIRED_CAPABILITIES } from '../host-lifecycle.mjs';
const keys = ephemeralPublicSource();
async function sourceCopy(t, relative, from, to) {
  const url = new URL(relative, import.meta.url);
  let source = fs.readFileSync(url, 'utf8');
  if (from) {
    assert.equal(source.split(from).length, 2, 'CLOSURE_UNIQUE_MUTATION_ANCHOR');
    source = source.replace(from, to);
  }
  source = source.replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from '${new URL(p, url).href}'`)
    .replace(/new URL\(('([^']+)'|"([^"]+)"), import.meta.url\)/g, (_, q, a, b) => `new URL(${JSON.stringify(new URL(a ?? b, url).href)})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-findings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'subject.mjs'); fs.writeFileSync(file, source);
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0, 'CLOSURE_MUTANT_SYNTAX');
  return { file, dir };
}
async function armingControl(t, create = createShu71Production) {
  for (const [label, gid, mode] of [['PAIR_PASSES', 982, 0o600], ['GID_REFUSED', 981, 0o600], ['MODE_REFUSED', 982, 0o400]]) {
    const p = productionFixture(t, keys); p.identity.gid = 982;
    p.write('/srv/shu/coordinator.env', coordinatorText(), mode, 999, gid);
    fs.chmodSync(`${p.root}/srv/shu/coordinator.env`, mode);
    assert.deepEqual([p.boundary.fs.lstatSync('/srv/shu/coordinator.env').uid, p.boundary.fs.lstatSync('/srv/shu/coordinator.env').gid], [999, gid]);
    const result = await create(p.id, p.boundary).execute('run');
    if (label === 'PAIR_PASSES') assert.equal(result.ok, true, 'CLOSURE_ARM_PAIR_PASSES');
    else {
      assert.equal(result.code, 'ACT_FILE_CUSTODY', `CLOSURE_ARM_${label}`);
      assert.equal(p.signatures(), 0, `CLOSURE_ARM_${label}_BEFORE_SIGN`);
    }
  }
  for (const [label, change] of [
    ['IDENTITY_NAME_REFUSED', p => { p.identity.user = 'bad/name'; }],
    ['IDENTITY_GROUP_REFUSED', p => { p.identity.gid = 0; p.write('/srv/shu/coordinator.env', coordinatorText(), 0o600, 999, 0); }],
  ]) {
    const p = productionFixture(t, keys); change(p);
    const result = await create(p.id, p.boundary).execute('run');
    assert.equal(result.code, 'ACT_FILE_CUSTODY', `CLOSURE_ARM_${label}`);
    assert.equal(p.signatures(), 0, `CLOSURE_ARM_${label}_BEFORE_SIGN`);
  }
}
function childCustodyControl(module = api) {
  for (const [label, gid, mode] of [['PAIR_PASSES', 982, 0o600], ['GID_REFUSED', 981, 0o600], ['MODE_REFUSED', 982, 0o400]]) {
    const io = { constants: fs.constants, openSync: () => 9, closeSync() {}, readFileSync: () => coordinatorText(),
      fstatSync: () => ({ isFile: () => true, nlink: 1, uid: 999, gid, mode, size: 100 }) };
    if (label === 'PAIR_PASSES') assert.doesNotThrow(() => module.readAdapterLaunchEnvironment(io, 999, 982), 'CLOSURE_CHILD_PAIR_PASSES');
    else assert.throws(() => module.readAdapterLaunchEnvironment(io, 999, 982), /SHU251_ENV_CUSTODY/, `CLOSURE_CHILD_${label}`);
  }
}
test('CLOSURE_CUSTODY configured unequal uid gid passes and drift refuses', async t => { await armingControl(t); childCustodyControl(); });
for (const [label, file, from, to, assertion] of [
  ['arming invalid identity name accepted', '../shu71-production.mjs', '/^[a-z_][a-z0-9_-]*$/.test(user) && /^[a-z_][a-z0-9_-]*$/.test(group)', 'true', 'CLOSURE_ARM_IDENTITY_NAME_REFUSED'],
  ['arming invalid identity gid accepted', '../shu71-production.mjs', 'Number.isSafeInteger(gid) && gid > 0', 'true', 'CLOSURE_ARM_IDENTITY_GROUP_REFUSED'],
  ['arming conflates gid with uid', '../shu71-production.mjs', 's.gid === gid', 's.gid === uid', 'CLOSURE_ARM_PAIR_PASSES'],
  ['arming wrong gid accepted', '../shu71-production.mjs', 's.gid === gid', 'true', 'CLOSURE_ARM_GID_REFUSED'],
  ['arming non0600 accepted', '../shu71-production.mjs', '(s.mode & 0o777) === exactMode', 'true', 'CLOSURE_ARM_MODE_REFUSED'],
  ['arming configured identity ignored', '../shu71-production.mjs', 'uid, 0o600, gid)', '999, 0o600, 999)', 'CLOSURE_ARM_PAIR_PASSES'],
  ['child conflates gid with uid', '../units.mjs', 'stat.gid === gid', 'stat.gid === uid', 'CLOSURE_CHILD_PAIR_PASSES'],
  ['child wrong gid accepted', '../units.mjs', 'stat.gid === gid', 'true', 'CLOSURE_CHILD_GID_REFUSED'],
  ['child non0600 accepted', '../units.mjs', '(stat.mode & 0o777) === 0o600', 'true', 'CLOSURE_CHILD_MODE_REFUSED'],
]) test(`CLOSURE_CUSTODY mutation ${label}`, async t => {
  const copy = await sourceCopy(t, file, from, to), module = await import(pathToFileURL(copy.file));
  await assert.rejects(async () => file.includes('production') ? armingControl(t, module.createShu71Production) : childCustodyControl(module),
    e => e.code === 'ERR_ASSERTION' && e.message.includes(assertion), assertion);
});

async function workerControl(t, from, to, badCustody = false) {
  const { file, dir } = await sourceCopy(t, '../../supervisor-worker.mjs', from, to);
  const preload = path.join(dir, 'preload.mjs'), authorizationModule = path.join(dir, 'authorize.mjs');
  fs.writeFileSync(authorizationModule, 'export const authorizeWorkOrder = () => true;');
  fs.writeFileSync(preload, `import fs from 'node:fs';
process.getuid = () => 999; process.getgid = () => 982;
const open=fs.openSync, stat=fs.fstatSync, read=fs.readFileSync, close=fs.closeSync;
fs.openSync=(p,...args)=>p==='/srv/shu/coordinator.env' ? 987654 : open(p,...args);
fs.fstatSync=(fd)=>fd===987654 ? {isFile:()=>true,nlink:1,uid:999,gid:${badCustody ? 981 : 982},mode:0o100600,size:100} : stat(fd);
fs.readFileSync=(fd,...args)=>fd===987654 ? ${JSON.stringify(coordinatorText())} : read(fd,...args);
fs.closeSync=(fd)=>fd===987654 ? undefined : close(fd);
`);
  fs.mkdirSync(path.join(dir, 'adapters'));
  fs.writeFileSync(path.join(dir, 'adapters/codex-cli.mjs'), `export async function launchBuilder(options) {
await new Promise(() => process.send({adapterEnvironment: options.env}, () => process.exit(0)));
}`);
  const messages = []; let stderr = '';
  const spawn = createSupervisorSpawner({ stateDir: dir, authorizationModule,
    env: { SHU71_EVIDENCE_BROKER: 'true', SHU_SUPERVISOR_SECRET: 'SECRET_POISON', GITHUB_TOKEN: 'GITHUB_POISON', LINEAR_API_TOKEN: 'LINEAR_POISON' },
    forkImpl: (_file, args, options) => fork(file, args, { ...options, execArgv: ['--import', preload] }) });
  const child = spawn({ runtime: 'codex-cli' }, {});
  child.on('message', value => messages.push(value)); child.stderr.on('data', value => { stderr += value; });
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLOSURE_CHILD_TIMEOUT')); }, 10000);
    child.once('error', reject); child.once('close', code => { clearTimeout(timeout); resolve(code); });
  });
  if (badCustody) {
    assert.equal(exit, 1, 'CLOSURE_WIRING_CUSTODY_EXIT');
    assert.equal(messages.some(v => v.adapterEnvironment), false, 'CLOSURE_WIRING_NO_LAUNCH');
    assert.equal(stderr, 'SHU251_ENV_CUSTODY\n', 'CLOSURE_WIRING_NAMED_REFUSAL');
  } else {
    assert.equal(exit, 0, `CLOSURE_WIRING_EXIT: ${stderr}`);
    const env = messages.find(v => v.adapterEnvironment)?.adapterEnvironment;
    for (const key of api.supervisorAdapterKeys) assert.equal(env?.[key], supervisorEnvironment[key], 'CLOSURE_WIRING_NINE_KEYS');
    for (const key of ['SHU_SUPERVISOR_SECRET', 'GITHUB_TOKEN', 'LINEAR_API_TOKEN']) assert.equal(env?.[key], undefined, 'CLOSURE_WIRING_NO_AUTHORITY');
  }
  assert.doesNotMatch(stderr, /POISON/, 'CLOSURE_WIRING_REDACTED');
}
test('CLOSURE_WIRING forked adapter receives nine keys and custody refusal is named', async t => {
  await workerControl(t); await workerControl(t, undefined, undefined, true);
});
for (const [label, from, to, bad, assertion] of [
  ['worker child delivery omitted', 'Object.assign(process.env, readAdapterLaunchEnvironment());', '', false, 'CLOSURE_WIRING_NINE_KEYS'],
  ['worker process gid ignored', 'readAdapterLaunchEnvironment()', 'readAdapterLaunchEnvironment(undefined, process.getuid(), process.getuid())', false, 'CLOSURE_WIRING_EXIT'],
  ['worker custody diagnostic swallowed', 'process.stderr.write(`${code}\\n`);', '', true, 'CLOSURE_WIRING_NAMED_REFUSAL'],
]) test(`CLOSURE_WIRING mutation ${label}`, async t => {
  await assert.rejects(() => workerControl(t, from, to, bad), e => e.code === 'ERR_ASSERTION' && e.message.includes(assertion), assertion);
});
test('CLOSURE_LIFECYCLE independently pinned capability vocabulary', () => {
  assert.deepEqual(REQUIRED_CAPABILITIES, ['privilege', 'worker_uid', 'temp', 'cvtsudoers', 'checkout', 'systemd', 'systemd_analyze', 'flock', 'systemd_notify', 'git', 'bash', 'shell_toolchain', 'linux_proc', 'loopback_socket', 'unix_socket', 'node', 'atomic-rename', 'directory-fsync'], 'CLOSURE_LIFECYCLE_CAPABILITIES');
});
