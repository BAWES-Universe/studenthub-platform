import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { provisioner, PATHS } from '../provision-shu71-prerequisites.mjs';
import { measureBrokerRuntime } from '../shu71-runtime.mjs';
import { runtimeRowSchema, validateRuntimeRow } from '../shu71-runtime-schema.mjs';
import { createShu71Production } from '../shu71-production.mjs';
import { fixture, revision } from './provision-prerequisites-fixture.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
const dir = '/run/shu71-evidence', sock = dir + '/fixture.sock';
async function mutant(file, edits) {
  const url = new URL('../' + file, import.meta.url);
  let source = fs.readFileSync(url, 'utf8');
  for (const [from, to] of edits) {
    assert.equal(source.split(from).length, 2, 'V_MUTANT_UNIQUE_SOURCE'); source = source.replace(from, to);
  }
  source = source.replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, p, q, rel) => `${p}${q}${new URL(rel, url)}${q}`).replaceAll('import.meta.url', JSON.stringify(url.href));
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const dies = async (check, impl, label) => assert.rejects(() => check(impl), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
function installed(t) { const h = fixture(t); provisioner(revision, h.boundary).install(); return h; }
const measured = (path = dir) => ({ path, ok: true, runtime: 'MEASURED', uid: 100, gid: 980, mode: path === dir ? 0o750 : 0o660 });
const deferred = { path: dir, ok: true, runtime: 'DEFERRED_UNTIL_SERVICE_START' };

test('V1_EMITTED_ROWS_VALIDATE', async t => {
  const h = installed(t);
  for (const state of ['active', 'refusal', 'inactive']) {
    if (state === 'refusal') fs.chmodSync(h.root + sock, 0o664);
    if (state === 'inactive') h.remove(dir);
    const rows = provisioner(revision, h.boundary).precondition().paths.filter(r => [dir, sock].includes(r.path));
    for (const row of rows) assert.doesNotThrow(() => validateRuntimeRow(row), 'V1_EMITTED_ROWS_VALIDATE');
  }
  const p = productionFixture(t, keys);
  await createShu71Production(p.id, p.boundary).execute('run');
  for (const row of measureBrokerRuntime(p.boundary, {}).rows) assert.doesNotThrow(() => validateRuntimeRow(row), 'V1_EMITTED_ROWS_VALIDATE');
});
for (const [name, damage, forgery] of [
  ['AMBIGUOUS_DEFERRED', s => { s.oneOf[0].properties.runtime = { enum: ['DEFERRED_UNTIL_SERVICE_START', 'MEASURED', 'PASS'] }; delete s.oneOf[0].additionalProperties; }, { ...deferred, runtime: 'PASS' }],
  ['FABRICATED_MEASUREMENT', s => { delete s.oneOf[0].additionalProperties; }, { ...deferred, uid: 100, gid: 980, mode: 0o750 }],
  ['MODE_WEAKENED', s => { delete s.oneOf[1].allOf; s.oneOf[1].properties.mode.enum.push(0o664); }, { ...measured(sock), mode: 0o664 }],
  ['REFUSAL_WEAKENED', s => { delete s.oneOf[2].properties.code.pattern; }, { path: dir, ok: false, code: 'PASS' }],
]) test('V1_SCHEMA_' + name, async () => {
  const label = 'V1_SCHEMA_' + name;
  const check = async schema => {
    assert.doesNotThrow(() => validateRuntimeRow(deferred, schema), label);
    assert.throws(() => validateRuntimeRow(forgery, schema), { code: 'ACT_RUNTIME_ROW_SCHEMA' }, label);
  };
  await check(runtimeRowSchema()); const changed = runtimeRowSchema(); damage(changed); await dies(check, changed, label);
});
for (const [file, symbol] of [['provision-shu71-prerequisites.mjs', 'provisioner'], ['shu71-runtime.mjs', 'measureBrokerRuntime']]) test('V1_SCHEMA_LOAD_BEARING_' + symbol, async t => {
  const label = 'V1_SCHEMA_LOAD_BEARING_' + symbol;
  const changed = await mutant(file, [["import { validateRuntimeRow } from './shu71-runtime-schema.mjs';", "const validateRuntimeRow = () => { throw Object.assign(new Error('schema rejects'), { code: 'ACT_RUNTIME_ROW_SCHEMA' }); };"]]);
  if (symbol === 'provisioner') {
    const h = installed(t);
    assert.throws(() => changed.provisioner(revision, h.boundary).precondition(), { code: 'ACT_RUNTIME_ROW_SCHEMA' }, label);
  } else {
    const h = productionFixture(t, keys); await createShu71Production(h.id, h.boundary).execute('run');
    assert.throws(() => changed.measureBrokerRuntime(h.boundary, {}), { code: 'ACT_RUNTIME_ROW_SCHEMA' }, label);
  }
});
for (const [kind, target, exact, modes, code] of [
  ['DIRECTORY', dir, '0o750', [0o754, 0o751], 'DIRECTORY_MODE'],
  ['SOCKET', sock, '0o660', [0o664, 0o661], 'SOCKET_MODE'],
]) for (const mode of modes) for (const lane of ['PREMINT', 'WINDOW']) test(`V3_${lane}_${kind}_${mode.toString(8)}`, async t => {
  const label = `V3_${lane}_${kind}_${mode.toString(8)}`;
  const file = lane === 'PREMINT' ? 'provision-shu71-prerequisites.mjs' : 'shu71-runtime.mjs';
  const check = async impl => {
    if (lane === 'PREMINT') {
      const h = installed(t); fs.chmodSync(h.root + target, mode);
      assert.equal(impl(revision, h.boundary).precondition().paths.find(r => r.path === target).code, 'ACT_BROKER_' + code, label);
    } else {
      const h = productionFixture(t, keys); await createShu71Production(h.id, h.boundary).execute('run'); fs.chmodSync(h.root + target, mode);
      assert.throws(() => impl(h.boundary, {}), { code: 'ACT_RUNTIME_' + code }, label);
    }
  };
  await check(lane === 'PREMINT' ? provisioner : measureBrokerRuntime);
  const changed = await mutant(file, [[`(s.mode & 0o7777) === ${exact}`, `((s.mode & 0o7777) === ${exact} || (s.mode & 0o7777) === ${mode})`]]);
  await dies(check, changed[lane === 'PREMINT' ? 'provisioner' : 'measureBrokerRuntime'], label);
});
for (const [kind, target] of [['DIRECTORY', dir], ['SOCKET', sock]]) for (const error of ['ENOENT', 'EACCES', 'ELOOP', 'ENOTDIR']) test(`V6_${kind}_${error}`, async t => {
  const label = `V6_${kind}_${error}`;
  const check = async impl => {
    const h = productionFixture(t, keys); await createShu71Production(h.id, h.boundary).execute('run');
    const original = h.boundary.fs.lstatSync;
    h.boundary.fs.lstatSync = p => { if (p === target) throw Object.assign(new Error(error), { code: error }); return original(p); };
    assert.throws(() => impl(h.boundary, {}), { code: `ACT_RUNTIME_${kind}_${error === 'ENOENT' ? 'MISSING' : 'MEASUREMENT'}` }, label);
  };
  await check(measureBrokerRuntime);
  const changed = await mutant('shu71-runtime.mjs', [["e.code === 'ENOENT' ? missing : i ? 'ACT_RUNTIME_SOCKET_MEASUREMENT' : 'ACT_RUNTIME_DIRECTORY_MEASUREMENT'", error === 'ENOENT' ? "'ACT_RUNTIME_DIRECTORY_MEASUREMENT'" : 'missing']]);
  await dies(check, changed.measureBrokerRuntime, label);
});
test('V7_NUMERIC_RENDER_CLAUSE', async t => {
  const label = 'V7_NUMERIC_RENDER_CLAUSE';
  const inject = ["import { renderEvidenceBroker } from './shu71-production.mjs';", "import { renderEvidenceBroker as reviewed } from './shu71-production.mjs'; const renderEvidenceBroker = () => reviewed() + '\\nUser=123\\n';"];
  const check = async impl => { const h = installed(t); assert.throws(() => impl(revision, h.boundary).identity(), { code: 'ACT_BROKER_UNIT_BINDING' }, label); };
  await check((await mutant('provision-shu71-prerequisites.mjs', [inject])).provisioner);
  await dies(check, (await mutant('provision-shu71-prerequisites.mjs', [inject, [' && !/\\n(?:User|Group)=\\d+\\n/.test(renderEvidenceBroker())', '']])).provisioner, label);
});
test('V5_PRIVATE_READ_SEMANTICS', async t => {
  const key = '/etc/shu/keys/shu71-activation-ed25519.pem';
  const h = installed(t); h.write(key, 'private', 0o700, 0, 4242);
  assert.equal(provisioner(revision, h.boundary).precondition().paths.find(r => r.path === key).ok, true, 'V5_PRIVATE_READ_SEMANTICS');
  const p = productionFixture(t, keys); fs.chmodSync(p.root + key, 0o700); p.owners.set(key, [0, 4242]);
  assert.equal((await createShu71Production(p.id, p.boundary).execute('run')).state, 'ARMED', 'V5_PRIVATE_READ_SEMANTICS');
});
test('V4_STALE_ARCHIVE_REFUSAL', async t => {
  const label = 'V4_STALE_ARCHIVE_REFUSAL';
  const check = async impl => {
    const h = productionFixture(t, keys);
    h.write(`/srv/shu/state/shu71-evidence/${h.id}/broker-runtime.json`, JSON.stringify({ rows: [measured(), measured(sock)] }));
    h.faults.runtime = () => fs.chmodSync(h.root + sock, 0o664);
    const result = await impl(h.id, h.boundary).execute('run');
    assert.equal(result.code, 'ACT_RUNTIME_SOCKET_MODE', label);
    assert.equal(result.teardown.state, 'REVOKED', label);
    assert.equal(h.journal().filter(e => e.event === 'BROKER_RUNTIME_MEASURED').length, 0, label);
    assert.equal(JSON.parse(h.read(`/srv/shu/state/shu71-evidence/${h.id}/activation.json`)).broker_runtime, null, label);
  };
  await check(createShu71Production);
  const source = fs.readFileSync(new URL('../shu71-production.mjs', import.meta.url), 'utf8');
  const expression = source.match(/broker_runtime: (\(\(\) => .*?\}\)\(\))/)[1];
  await dies(check, (await mutant('shu71-production.mjs', [[expression, 'JSON.parse(privateRead(`${dir}/broker-runtime.json`))']])).createShu71Production, label);
});
test('V10_JOURNALLED_ORDER', async t => {
  const label = 'V10_JOURNALLED_ORDER';
  const check = async impl => {
    const h = productionFixture(t, keys); assert.equal((await impl(h.id, h.boundary).execute('run')).state, 'ARMED', label);
    const rows = h.journal(), index = (event, step) => rows.findIndex(r => r.event === event && (!step || r.step === step));
    const positions = [index('DONE', 'evidence-broker'), index('INTENT', 'broker-runtime'), index('BROKER_RUNTIME_CHECK_STARTED'), index('BROKER_RUNTIME_MEASURED'), index('DONE', 'broker-runtime'), index('INTENT', 'ready-SHU-140'), index('INTENT', 'activation'), index('INTENT', 'gate'), index('ARMED')];
    assert.ok(positions.every((v, i) => v >= 0 && (!i || v > positions[i - 1])), label);
  };
  await check(createShu71Production);
  await dies(check, (await mutant('shu71-production.mjs', [["await step('broker-runtime', async () => {", 'await (async () => {'], ['      }, true);', '      })();']])).createShu71Production, label);
  const source = fs.readFileSync(new URL('../shu71-production.mjs', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf("      await step('broker-runtime'"), source.indexOf('      for (const t of pkg.issue_transitions)'));
  await dies(check, (await mutant('shu71-production.mjs', [[block, ''], ["      await step('activation',", block + "      await step('activation',"]])).createShu71Production, label);
});
const executables = ['/usr/bin/node', '/usr/bin/systemctl', '/usr/bin/flock', '/usr/bin/env', '/usr/sbin/useradd', '/usr/sbin/groupadd', '/usr/sbin/userdel', '/usr/sbin/groupdel', '/usr/sbin/nologin', '/usr/bin/find'];
const units = ['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer'].map(n => '/etc/systemd/system/' + n);
const gates = units.slice(0, 2).flatMap(p => [p + '.d', p + '.d/90-shu71.conf']);
for (const target of [...executables, ...units, ...gates, '/run/lock/shu71-production.lock', '/srv/shu/state/shu71-activation.json', '/etc/shu/approvals/example.shu71.json']) test('V9_TRAVERSE_' + target, async t => {
  const label = 'V9_TRAVERSE_' + target;
  const check = async impl => {
    const h = installed(t);
    h.write('/etc/shu/approvals/example.shu71.json', '{}', 0o600);
    const before = h.snapshot();
    assert.equal(impl(revision, h.boundary).precondition().paths.find(r => r.path === target)?.ok, true, label);
    assert.deepEqual(h.snapshot(), before, label);
    if (target.endsWith('.d')) h.directory(target, 0o777);
    else if (target.endsWith('production.lock')) h.write(target, '', 0o666);
    else if (target.endsWith('shu71-activation.json')) h.write(target, '{}', 0o640);
    else fs.chmodSync(h.root + target, 0o666);
    const report = impl(revision, h.boundary).precondition();
    assert.equal(report.paths.find(r => r.path === target)?.ok, false, label);
    assert.match(report.paths.find(r => r.path === target)?.code, /^ACT_/, label);
  };
  await check(provisioner);
  const changed = await mutant('provision-shu71-prerequisites.mjs', [['const check = (p, fn) => {', `const check = (p, fn) => { if (p === ${JSON.stringify(target)}) return;`]]);
  await dies(check, changed.provisioner, label);
});
for (const [name, target, before, after] of [
  ['SUPERVISOR_IDENTITY', units[0], 'User=shu-coordinator', 'User=999'],
  ['COORDINATOR_GROUP', units[1], 'Group=shu-coordinator', 'Group=999'],
  ['CREDENTIAL_SOURCE', units[1], 'LoadCredential=supervisor-transport:/etc/shu/supervisor.env', 'LoadCredential=supervisor-transport:/srv/shu/coordinator.env'],
  ['TIMER_TARGET', units[2], 'Unit=shu-coordinator.service', 'Unit=other.service'],
  ['GATE_OFF', gates[1], 'ENABLE_DISPATCH=false', 'ENABLE_DISPATCH=true'],
]) test('V9_BINDING_' + name, async t => {
  const label = 'V9_BINDING_' + name;
  const check = async impl => {
    const h = installed(t); h.write(target, h.f.readFileSync(target, 'utf8').replace(before, after));
    assert.equal(impl(revision, h.boundary).precondition().paths.find(r => r.path === target)?.code, name === 'GATE_OFF' ? 'ACT_PRODUCTION_GATE' : 'ACT_PRODUCTION_UNIT_BINDING', label);
  };
  await check(provisioner);
  const from = name === 'GATE_OFF' ? "need(r.uid === 0 && r.gid === 0 && r.mode === 0o644 && Buffer.from(r.bytes, 'base64').toString() === '[Service]\\nEnvironment=ENABLE_DISPATCH=false\\n', 'ACT_PRODUCTION_GATE');" : "need(lines.length === 1 && lines[0] === key + '=' + value, 'ACT_PRODUCTION_UNIT_BINDING');";
  await dies(check, (await mutant('provision-shu71-prerequisites.mjs', [[from, '']])).provisioner, label);
});
for (const expiry of [false, true]) test(expiry ? 'V10_WAIT_EXPIRY' : 'V10_WAIT_FOR_SOCKET', async t => {
  const label = expiry ? 'V10_WAIT_EXPIRY' : 'V10_WAIT_FOR_SOCKET';
  const check = async impl => {
    const h = productionFixture(t, keys); let waits = 0;
    h.faults.runtime = () => fs.unlinkSync(h.root + sock);
    h.boundary.runtimeWait = async () => { waits++; h.write(sock, '', 0o660, 100, 980); if (expiry) h.expire(); };
    const result = await impl(h.id, h.boundary).execute('run');
    assert.equal(waits, 1, label);
    if (expiry) {
      assert.equal(result.code, 'ACT_ID_OR_EXPIRY_INVALID', label);
      assert.ok(!h.journal().some(r => r.event === 'BROKER_RUNTIME_MEASURED' || r.step?.startsWith('ready-')), label);
    } else assert.equal(result.state, 'ARMED', label);
  };
  await check(createShu71Production);
  const from = expiry ? "          need(b.now() < Date.parse(spec.pkg.expires_at), 'ACT_ID_OR_EXPIRY_INVALID');" : 'attempt >= 19';
  await dies(check, (await mutant('shu71-production.mjs', [[from, expiry ? '' : 'attempt >= 0']])).createShu71Production, label);
});
test('V4_RESUME_DISCARDS_PRIOR_MEASUREMENT', async t => {
  const label = 'V4_RESUME_DISCARDS_PRIOR_MEASUREMENT';
  const check = async impl => {
    const h = productionFixture(t, keys);
    // Model termination after measurement, before readiness: retain only the
    // authentic hash-chain prefix and restart with the same durable files.
    await impl(h.id, h.boundary).execute('run');
    const rows = h.journal(), stop = rows.findIndex(r => r.event === 'DONE' && r.step === 'broker-runtime');
    h.write(`/srv/shu/state/shu71-evidence/${h.id}/journal.jsonl`, rows.slice(0, stop + 1).map(JSON.stringify).join('\n') + '\n');
    fs.chmodSync(h.root + sock, 0o664);
    const result = await impl(h.id, h.boundary).execute('resume');
    assert.equal(result.code, 'ACT_RUNTIME_SOCKET_MODE', label);
    assert.equal(JSON.parse(h.read(`/srv/shu/state/shu71-evidence/${h.id}/activation.json`)).broker_runtime, null, label);
  };
  await check(createShu71Production);
  await dies(check, (await mutant('shu71-production.mjs', [['      }, true);', '      });']])).createShu71Production, label);
});
test('V1_SCHEMA_FORGERY_MATRIX', () => {
  for (const row of [
    { ...deferred, ok: false }, { ...deferred, runtime: 'DEFERRED' }, { path: dir, ok: true },
    { ...measured(), mode: 0o755 }, { ...measured(), mode: 0o660 }, { ...measured(sock), mode: 0o750 },
    { ...measured(), uid: -1 }, { ...measured(), gid: 1.5 }, { ...measured(), path: '/unknown' },
    { path: dir, ok: false, code: 'ACT_REFUSAL', runtime: 'MEASURED' },
    (({ mode, ...r }) => r)(measured()),
  ]) assert.throws(() => validateRuntimeRow(row), { code: 'ACT_RUNTIME_ROW_SCHEMA' }, 'V1_SCHEMA_FORGERY_MATRIX');
});
test('V5_REVIEWED_PRIVATE_READ_KILL', async t => {
  const label = 'V5_REVIEWED_PRIVATE_READ_KILL', key = '/etc/shu/keys/shu71-activation-ed25519.pem';
  const check = async impl => {
    const h = installed(t); h.write(key, 'private', 0o700, 0, 4242);
    assert.equal(impl(revision, h.boundary).precondition().paths.find(r => r.path === key).ok, true, label);
    h.write(key, 'private', 0o640, 0, 4242);
    assert.equal(impl(revision, h.boundary).precondition().paths.find(r => r.path === key).code, 'ACT_FILE_CUSTODY', label);
  };
  await check(provisioner);
  await dies(check, (await mutant('provision-shu71-prerequisites.mjs', [["r.uid === 0 && !(r.mode & 0o077) && r.bytes.length > 0 && Buffer.from", "r.uid === 0 && r.gid === 0 && r.mode === 0o600 && r.bytes.length > 0 && Buffer.from"]])).provisioner, label);
});
test('V8_DOCUMENTATION_LINK_TARGETS', async () => {
  const label = 'V8_DOCUMENTATION_LINK_TARGETS';
  const docs = ['SHU71-PREREQUISITES.md', 'ACTIVATION-WINDOW-RECONCILIATION.md', 'SHU71-L3-CLOSURE.md'];
  const check = async drift => {
    for (const name of docs) {
      const source = fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
      for (const [, file, number] of source.matchAll(/\((shu71-production\.mjs|provision-shu71-prerequisites\.mjs)#L(\d+)\)/g)) {
        const lines = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').split('\n');
        assert.match(lines[Number(number) - 1 + drift], /renderEvidenceBroker|const key = privateRead|step\('evidence-broker'|\['evidence-broker'|check\('\/etc\/shu\/keys|function identity\(|function sharedAccess\(/, label);
      }
    }
  };
  await check(0); await dies(check, 1, label);
});
