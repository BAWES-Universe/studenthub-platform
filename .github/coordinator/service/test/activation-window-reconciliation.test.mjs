import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, assertPolicy, serviceParameters, names } from '../units.mjs';
import { fixtureParameters } from '../verify.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'shu-reconciliation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fixtureParameters(root);
}
function refuses(params, code) {
  for (const operation of [render, p => assertPolicy({}, p)]) {
    assert.throws(() => operation(params), error => error.name === 'AssertionError' && error.message.startsWith(`${code}:`), `${code}: named refusal required`);
  }
}

test('RECON_ENV_POSITIVE: distinct credential roles render and pass policy', t => {
  const params = fixture(t);
  const units = render(params);
  assertPolicy(units, params);
  for (const [name, field] of [[names[0], 'supervisorEnvironmentFile'], [names[1], 'coordinatorEnvironmentFile']]) {
    assert.deepEqual(units[name].split('\n').filter(line => line.startsWith('EnvironmentFile=')), [`EnvironmentFile=${params[field]}`], 'RECON_ENV_POSITIVE: exactly the unit-specific required file');
  }
  const defaults = serviceParameters({ workdir: params.workdir });
  assert.equal(defaults.supervisorEnvironmentFile, '/etc/shu/supervisor.env', 'RECON_ENV_DEFAULTS: supervisor owner binding');
  assert.deepEqual([defaults.coordinatorEnvironmentFile, defaults.supervisorEnvironmentFile], ['/srv/shu/coordinator.env', '/etc/shu/supervisor.env'], 'RECON_ENV_DEFAULTS: evidence-backed pair and coordinator owner binding');
});

test('RECON_ENV_MUTATION: crossed file paths', t => {
  const params = fixture(t);
  refuses({ ...params, supervisorEnvironmentFile: params.coordinatorEnvironmentFile, coordinatorEnvironmentFile: params.supervisorEnvironmentFile }, 'SHU251_ENV_CROSSED');
  // Canonical reversal is refused before any host file can be inspected.
  refuses({ ...params, supervisorEnvironmentFile: '/srv/shu/service.env', coordinatorEnvironmentFile: '/etc/shu/supervisor.env' }, 'SHU251_ENV_CROSSED');
});
test('RECON_ENV_MUTATION: identical file paths and hardlinked contents', t => {
  const params = fixture(t);
  refuses({ ...params, coordinatorEnvironmentFile: params.supervisorEnvironmentFile }, 'SHU251_ENV_IDENTICAL');
  fs.unlinkSync(params.coordinatorEnvironmentFile);
  fs.linkSync(params.supervisorEnvironmentFile, params.coordinatorEnvironmentFile);
  refuses(params, 'SHU251_ENV_IDENTICAL');
});
for (const field of ['supervisorEnvironmentFile', 'coordinatorEnvironmentFile']) {
  test(`RECON_ENV_MUTATION: ${field} missing`, t => {
    const params = fixture(t);
    fs.unlinkSync(params[field]);
    refuses(params, 'SHU251_ENV_MISSING');
  });
  test(`RECON_ENV_MUTATION: ${field} pointed at other contents`, t => {
    const params = fixture(t);
    const other = field === 'supervisorEnvironmentFile' ? 'coordinatorEnvironmentFile' : 'supervisorEnvironmentFile';
    fs.copyFileSync(params[other], params[field]);
    refuses(params, 'SHU251_ENV_CROSSED');
  });
  test(`RECON_ENV_MUTATION: ${field} unsafe absolute path`, t => {
    const params = fixture(t);
    for (const value of ['relative', '/etc/./file', '/etc/../file', '/etc//file', '/etc/file name', '/etc/file\n']) {
      refuses({ ...params, [field]: value }, 'SHU251_SECRET_FILE');
    }
  });
}
for (const key of ['GITHUB_TOKEN', 'LINEAR_API_TOKEN']) test(`RECON_ENV_MUTATION: coordinator ${key} missing or empty`, t => {
  const params = fixture(t), original = fs.readFileSync(params.coordinatorEnvironmentFile, 'utf8');
  fs.writeFileSync(params.coordinatorEnvironmentFile, original.split('\n').filter(line => !line.startsWith(`${key}=`)).join('\n'));
  refuses(params, 'SHU251_ENV_COORDINATOR');
  fs.appendFileSync(params.coordinatorEnvironmentFile, `${key}=""\n`);
  refuses(params, 'SHU251_ENV_CONTENT');
});

function assertDocumentation(host, validation, readme) {
  assert.ok(host.includes('## Decided credential environment files') && !host.includes('One credential-owner decision remains') && !host.includes('credential owner must name'), 'RECON_DOC_OWNER: owner decision must be closed');
  for (const text of [host, validation, readme]) {
    assert.ok(text.includes('/etc/shu/supervisor.env') && text.includes('/srv/shu/service.env') && text.includes('root:root') && text.includes('0600'), 'RECON_DOC_PAIR: document both decided files and supervisor ownership');
    assert.ok(!text.includes('same external `EnvironmentFile=`') && !text.includes('Both units require `EnvironmentFile=/etc/shu/supervisor.env`'), 'RECON_DOC_SEPARATE: no shared-file claim');
  }
  for (const phrase of ['stderr', 'process.exitCode = 2', 'HostBindingHalt', 'nine typed codes', 'SHU251_UNEXPECTED', 'no binding name']) {
    assert.ok(host.includes(phrase), 'RECON_DOC_ERRORS: typed binding halts and unexpected failures must be distinguished');
  }
}
function documents() {
  return ['SHU-251-HOST-BINDINGS.md', 'SHU-251-VALIDATION.md', 'README.md'].map(name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}
test('RECON_DOC_POSITIVE: closed owner decision and actual error contract', () => {
  assertDocumentation(...documents());
});
for (const [label, index, before, after, code] of [
  ['owner decision reopened', 0, '## Decided credential environment files', '## One credential-owner decision remains', 'RECON_DOC_OWNER'],
  ['unexpected failure class omitted', 0, 'SHU251_UNEXPECTED', 'unclassified', 'RECON_DOC_ERRORS'],
  ['shared EnvironmentFile claim restored', 1, 'The templates require separate external', 'Both templates now require the same external `EnvironmentFile=`; the templates require', 'RECON_DOC_SEPARATE'],
]) test(`RECON_DOC_MUTATION: ${label}`, () => {
  const docs = documents();
  assert.ok(docs[index].includes(before), 'RECON_DOC_MUTATION_TARGET: mutation must apply');
  docs[index] = docs[index].replace(before, after);
  assert.throws(() => assertDocumentation(...docs), error => error.name === 'AssertionError' && error.message.startsWith(`${code}:`), `${code}: mutation must die by name`);
});
// The committed scope is now the ONE-fixture scope, deliberately: Orchestrator
// v1 rests on the owner-approved dispatch_scope ["SHU-140"] and max_dispatch 1.
// This pin follows those values; the dispatch gate stays off as before.
function assertDispatch(config) {
  assert.equal(config.enable_dispatch, false, 'RECON_CONFIG_GATE: committed dispatch must remain off');
  assert.equal(config.max_dispatch, 1, 'RECON_CONFIG_CAPACITY: committed capacity must remain one');
  assert.deepEqual(config.dispatch_scope.issue_ids, ['SHU-140'], 'RECON_CONFIG_SCOPE: committed single lane must remain unchanged');
}
test('RECON_CONFIG_POSITIVE: committed gates and scope remain fixed', () => {
  assertDispatch(JSON.parse(fs.readFileSync(new URL('../../config.json', import.meta.url))));
});
test('RECON_CONFIG_MUTATION: committed dispatch gate flipped true', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../../config.json', import.meta.url)));
  config.enable_dispatch = true;
  assert.throws(() => assertDispatch(config), error => error.name === 'AssertionError' && error.message.startsWith('RECON_CONFIG_GATE:'), 'RECON_CONFIG_GATE: enabled config must die by name');
});

test('RECON_ENV_ONLY_SECRET: exactly SHU_SUPERVISOR_SECRET proceeds through render and policy', t => {
  const params = fixture(t);
  fs.writeFileSync(params.supervisorEnvironmentFile, `SHU_SUPERVISOR_SECRET=${'s'.repeat(40)}\n`);
  const units = render(params);
  assert.deepEqual(Object.keys(units), names, 'RECON_ENV_ONLY_SECRET: all units rendered');
  assert.doesNotThrow(() => assertPolicy(units, params), 'RECON_ENV_ONLY_SECRET: policy accepts ruled configuration');
});

for (const [label, extra] of [
  ['EXTRA_CREDENTIAL', 'AWS_SECRET_ACCESS_KEY=fixture-only'],
  ['EXTRA_SETTING', 'LOG_LEVEL=debug'],
]) test(`RECON_ENV_${label}: supervisor extra assignment refuses`, t => {
  const params = fixture(t);
  fs.appendFileSync(params.supervisorEnvironmentFile, `${extra}\n`);
  refuses(params, 'SHU251_ENV_SUPERVISOR');
});

for (const field of ['supervisorEnvironmentFile', 'coordinatorEnvironmentFile']) {
  test(`RECON_ENV_FILE: ${field} symlink refuses`, t => {
    const params = fixture(t), target = `${params[field]}.target`;
    fs.renameSync(params[field], target);
    fs.symlinkSync(target, params[field]);
    refuses(params, 'SHU251_ENV_FILE');
  });
  test(`RECON_ENV_UNREADABLE: ${field} present but unreadable refuses`, t => {
    const params = fixture(t), file = params[field];
    fs.chmodSync(file, 0o000);
    assert.ok(fs.lstatSync(file).isFile(), 'RECON_ENV_UNREADABLE: file is present and regular');
    // Root bypasses mode bits; inject the same EACCES only for this fixture there.
    if (process.getuid?.() === 0) {
      const read = fs.readFileSync;
      t.mock.method(fs, 'readFileSync', function (target, ...args) {
        if (target === file) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
        return read.call(this, target, ...args);
      });
    }
    refuses(params, 'SHU251_ENV_UNREADABLE');
  });
}
