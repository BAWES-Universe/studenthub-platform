import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
const dir = '/run/shu71-evidence', socket = dir + '/fixture.sock';
const sourceURL = new URL('../shu71-production.mjs', import.meta.url);
async function mutant(from, to) {
  let source = fs.readFileSync(sourceURL, 'utf8');
  assert.equal(source.split(from).length, 2, 'WINDOW_UNIQUE_MUTANT');
  source = source.replace(from, to).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, p, q, rel) => `${p}${q}${new URL(rel, sourceURL)}${q}`).replaceAll('import.meta.url', JSON.stringify(sourceURL.href));
  return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createShu71Production;
}
async function passing(t, impl = createShu71Production, mask = process.umask()) {
  const previous = process.umask(mask);
  let h;
  try { h = productionFixture(t, keys); }
  finally { process.umask(previous); }
  // execute() can cross await boundaries; scope the umask to the synchronous
  // service-start double, where runtime paths are actually created.
  const run = h.boundary.run;
  h.boundary.run = (...args) => {
    const before = process.umask(mask);
    try { return run(...args); }
    finally { process.umask(before); }
  };
  assert.equal((await impl(h.id, h.boundary).execute('run')).state, 'ARMED', 'WINDOW_PASSING_CONTROL');
  return h;
}
for (const [name, damage, code] of [
  ['MISSING_DIRECTORY', h => fs.rmSync(h.root + dir, { recursive: true }), 'ACT_RUNTIME_DIRECTORY_MISSING'],
  ['MISSING_SOCKET', h => fs.unlinkSync(h.root + socket), 'ACT_RUNTIME_SOCKET_MISSING'],
  ['WRONG_OWNER', h => h.owners.set(socket, [101, 980]), 'ACT_RUNTIME_OWNER'],
  ['WRONG_GROUP', h => h.owners.set(socket, [100, 981]), 'ACT_RUNTIME_GROUP'],
  ['WIDENED_DIRECTORY', h => fs.chmodSync(h.root + dir, 0o770), 'ACT_RUNTIME_DIRECTORY_MODE'],
  ['WIDENED_SOCKET', h => fs.chmodSync(h.root + socket, 0o666), 'ACT_RUNTIME_SOCKET_MODE'],
  ['COORDINATOR_INACCESSIBLE', h => fs.chmodSync(h.root + '/run', 0o700), 'ACT_RUNTIME_COORDINATOR_ACCESS'],
]) test(`WINDOW_${name} passing control and named mutant kill`, async t => {
  const label = 'WINDOW_' + name;
  await passing(t);
  const check = async impl => {
    const h = productionFixture(t, keys); h.faults.runtime = () => damage(h);
    const result = await impl(h.id, h.boundary).execute('run');
    assert.equal(result.code, code, label);
    assert.equal(result.state, 'HALT', label);
    assert.equal(result.teardown.state, 'REVOKED', label);
    assert.ok(h.journal().some(r => r.event === 'HALTED' && r.code === code), label);
    assert.ok(h.journal().some(r => r.event === 'TEARDOWN_COMPLETE'), label);
    assert.ok(!h.journal().some(r => r.step?.startsWith('ready-') || r.event === 'ARMED'), label);
    assert.ok(!h.events.some(e => e.includes('start shu-coordinator.timer')), label);
  };
  await check(createShu71Production);
  // Each named mutant suppresses only its named refusal, over the same passing control.
  const changed = await mutant('const runtime = measureBrokerRuntime(b, env);',
    `const runtime = (() => { try { return measureBrokerRuntime(b, env); } catch(e) { if(e.code !== '${code}') throw e; return { rows: [] }; } })();`);
  await passing(t, changed);
  await assert.rejects(() => check(changed), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});
test('WINDOW_MEASURED_RECEIPT passing control and named mutant kill', async t => {
  const label = 'WINDOW_MEASURED_RECEIPT';
  const check = async impl => {
    for (const mask of [0o002, 0o022, 0o077]) {
      const h = await passing(t, impl, mask), rows = h.journal();
      const receipt = rows.find(r => r.event === 'BROKER_RUNTIME_MEASURED');
      assert.deepEqual(receipt?.rows, [dir, socket].map((path, i) => ({ path, ok: true, runtime: 'MEASURED', uid: 100, gid: 980, mode: i ? 0o660 : 0o750 })), label);
      assert.ok(rows.indexOf(receipt) < rows.findIndex(r => r.step === 'ready-SHU-140'), label);
      assert.equal(receipt.coordinator_access, 'MEASURED_TRAVERSE_READ_WRITE', label);
      assert.equal((await impl(h.id, h.boundary).execute('revoke')).state, 'REVOKED', label);
      const archive = JSON.parse(h.read(`/srv/shu/state/shu71-evidence/${h.id}/activation.json`));
      assert.deepEqual(archive.broker_runtime.rows, receipt.rows, label);
    }
  };
  await check(createShu71Production);
  const changed = await mutant("journal.append({ event: 'BROKER_RUNTIME_MEASURED', ...runtime });", '');
  await assert.rejects(() => check(changed), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});
