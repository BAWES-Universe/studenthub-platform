// Historical objects and disposable boundaries only: no production host access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { productionFixture } from './shu71-production-fixture.mjs';
export const gates = ['shu-coordinator', 'shu-supervisor'].map(n => `/etc/systemd/system/${n}.service.d/90-shu71.conf`);
const activation = '/srv/shu/state/shu71-activation.json', lease = '/srv/shu/state/shu71-evidence/active.json';
const disarmed = '[Service]\nEnvironment=ENABLE_DISPATCH=false\n';
export async function historicalProduction(t, revision) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-r5-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const url = new URL('../shu71-production.mjs', import.meta.url);
  const read = name => execFileSync('git', ['show', `${revision}:.github/coordinator/service/${name}`], {cwd: new URL('../../../../', import.meta.url), encoding: 'utf8'});
  fs.writeFileSync(path.join(root, 'journal.mjs'), read('shu71-journal.mjs'));
  fs.writeFileSync(path.join(root, 'production.mjs'), read('shu71-production.mjs').replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, p, q, r) => `${p}${q}${r === './shu71-journal.mjs' ? pathToFileURL(path.join(root, 'journal.mjs')).href : new URL(r, url).href}${q}`));
  return (await import(pathToFileURL(path.join(root, 'production.mjs')))).createShu71Production;
}
export async function r5Differential(t, keys, candidate, scenario) {
  for (const [label, revision] of [['parent', '5e25c651254a72adbb46fa8f950df95248b640e9'], ['blocked', '0eeadd5f05abc8cd82968a855b2bff8cc137c65a'], ['candidate', null]]) {
    const production = revision ? await historicalProduction(t, revision) : candidate;
    const h = productionFixture(t, keys), create = () => production(h.id, h.boundary);
    assert.equal((await create().execute('run')).state, 'ARMED'); h.expire();
    const budget = `/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`;
    if (['settlement-plant', 'settlement-interrupt'].includes(scenario)) {
      const rename = h.boundary.fs.renameSync;
      h.boundary.fs.renameSync = (a, b) => { rename(a, b); if (b === gates[0]) h.write(b, disarmed.replace('false', 'true'), 0o644); };
      for (let n = 0; n < 32; n++) assert.equal((await create().execute('expire')).code, 'ACT_CLEANUP_FAILED');
      h.boundary.fs.renameSync = rename;
      h.write(gates[0], disarmed, 0o644);
      if (scenario === 'settlement-plant') h.write(budget, '{"attempts":32,"settlement_started":true}');
      else {
        const run = h.boundary.run;
        h.boundary.run = (exe, argv, opts) => { if (argv[0] === 'disable') throw new Error('retirement interrupted'); return run(exe, argv, opts); };
      }
    } else h.write(budget, scenario === 'counter-fault' ? '{"attempts":0}' : '{"attempts":32}', scenario === 'counter-fault' ? 0o644 : 0o600);
    const start = h.events.length, results = [];
    for (let n = 0; n < 5; n++) results.push(await create().execute('expire'));
    const complete = h.journal().some(e => e.event === 'TEARDOWN_COMPLETE');
    const snapshot = {scenario, label, results: results.map(r => [r.state, r.code ?? null]),
      gates: Object.fromEntries(gates.map(g => [g, h.read(g).includes('true') ? 'ARMED' : 'DIS'])),
      activation: h.exists(activation), lease: h.exists(lease), complete,
      services: Object.fromEntries(h.active), timerRetired: h.events.some(e => e.includes('disable --now shu71-expiry-')),
      writes: h.events.slice(start).filter(e => /^(write:|rename:|unlink:|remove:)/.test(e)).length,
      commands: h.events.slice(start).filter(e => e.startsWith('command:')).length};
    const armed = scenario === 'counter-plant' && label === 'blocked';
    for (const gate of gates) assert.equal(snapshot.gates[gate], armed ? 'ARMED' : 'DIS', `B4_R5_BOTH_GATES_${label}`);
    if (scenario === 'settlement-interrupt') {
      assert.equal(results[0].code, 'ACT_CLEANUP_FAILED');
      assert.equal(snapshot.lease, true, 'B4_SETTLEMENT_FAILED_OWNERSHIP_RETAINED');
      assert.equal(snapshot.timerRetired, false, 'B4_SETTLEMENT_FAILED_TIMER_RETAINED');
      assert.equal(complete, false, 'B4_SETTLEMENT_FAILED_NO_COMPLETION');
    } else {
      const settled = label === 'parent' || scenario === 'settlement-plant' && label === 'candidate';
      assert.equal(complete, settled, 'B4_R5_COMPLETION');
      assert.equal(snapshot.lease, !settled, 'B4_R5_OWNERSHIP');
      assert.equal(snapshot.activation, label === 'blocked' && scenario !== 'settlement-plant', 'B4_R5_CREDENTIAL_REVOKED');
      if (label === 'candidate' && scenario === 'counter-plant') assert.equal(results[0].code, 'ACT_RETRY_BUDGET_UNAVAILABLE', 'B4_COUNTER_EVIDENCE_REQUIRED');
    }
    t.diagnostic(JSON.stringify(snapshot));
  }
}
export async function plantedCounterCheck(createProduction, h) {
  await createProduction(h.id, h.boundary).execute('run'); h.expire();
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`, '{"attempts":32}');
  const r = await createProduction(h.id, h.boundary).execute('expire');
  assert.equal(r.code, 'ACT_RETRY_BUDGET_UNAVAILABLE', 'B4_COUNTER_EVIDENCE_REQUIRED');
  assert.equal(r.budget_error, 'ACT_RETRY_BUDGET_INVALID');
  for (const gate of gates) assert.equal(h.read(gate), disarmed, 'B4_PLANTED_COUNTER_DISARMS');
  assert.equal(h.exists(activation), false, 'B4_PLANTED_COUNTER_CREDENTIAL_REVOKED');
}
export async function safeExhausted(createProduction, h) {
  const create = () => createProduction(h.id, h.boundary);
  await create().execute('run'); h.expire();
  const rename = h.boundary.fs.renameSync;
  h.boundary.fs.renameSync = (a, b) => { rename(a, b); if (b === gates[0]) h.write(b, disarmed.replace('false', 'true'), 0o644); };
  for (let n = 0; n < 32; n++) assert.equal((await create().execute('expire')).code, 'ACT_CLEANUP_FAILED');
  h.boundary.fs.renameSync = rename;
  h.write(gates[0], disarmed, 0o644);
}
export async function plantedSettlementCheck(createProduction, h) {
  await safeExhausted(createProduction, h);
  h.write(`/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`, '{"attempts":32,"settlement_started":true}');
  assert.equal((await createProduction(h.id, h.boundary).execute('expire')).state, 'REVOKED', 'B4_SETTLEMENT_BOOLEAN_NOT_AUTHORITY');
}
