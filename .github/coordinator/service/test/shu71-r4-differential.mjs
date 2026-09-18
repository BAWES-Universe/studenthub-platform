// Read custody-checked historical fixtures; every execution uses the disposable
// production boundary. No checkout, host command, API or real key is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { historicalSource } from './shu71-history.mjs';
import { pathToFileURL } from 'node:url';
import { productionFixture } from './shu71-production-fixture.mjs';
export async function counterDifferential(t, keys, candidate) {
  const url = new URL('../shu71-production.mjs', import.meta.url);
  for (const [label, revision] of [['parent', '5e25c651254a72adbb46fa8f950df95248b640e9'], ['blocked', 'e9a68c156a0b8631b314d8d14c626ba31014a882'], ['candidate', null]]) {
    let create = candidate, historicalSigningPath;
    if (revision) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-r4-differential-'));
      t.after(() => fs.rmSync(root, {recursive: true, force: true}));
      const read = name => historicalSource(revision, name);
      fs.writeFileSync(path.join(root, 'journal.mjs'), read('shu71-journal.mjs'));
      historicalSigningPath = read('shu71-production.mjs').match(/privateRead\('([^']+\/keys\/[^']+)'\)/)[1];
      const source = read('shu71-production.mjs').replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
        (_, p, q, r) => `${p}${q}${r === './shu71-journal.mjs' ? pathToFileURL(path.join(root, 'journal.mjs')).href : new URL(r, url).href}${q}`);
      fs.writeFileSync(path.join(root, 'production.mjs'), source);
      create = (await import(pathToFileURL(path.join(root, 'production.mjs')))).createShu71Production;
    }
    const h = productionFixture(t, keys, historicalSigningPath);
    assert.equal((await create(h.id,h.boundary).execute('run')).state, 'ARMED'); h.expire();
    h.write(`/srv/shu/state/shu71-evidence/${h.id}/automatic-teardown.json`, '{"attempts":0}', 0o644);
    for (let n=0;n<4;n++) {
      const start=h.events.length, result=await create(h.id,h.boundary).execute('expire');
      const gate=h.read('/etc/systemd/system/shu-coordinator.service.d/90-shu71.conf');
      assert.equal(gate.includes('ENABLE_DISPATCH=true'), label === 'blocked', `B4_Q1_DIFFERENTIAL_${label}`);
      assert.equal(h.read('/etc/systemd/system/shu-supervisor.service.d/90-shu71.conf').includes('ENABLE_DISPATCH=true'), label === 'blocked', `B4_Q1_SECOND_GATE_${label}`);
      assert.equal(result.state, label === 'parent' ? 'REVOKED' : 'HALT');
      assert.equal(h.journal().some(e => e.event === 'TEARDOWN_COMPLETE'), label === 'parent', `B4_Q1_COMPLETION_${label}`);
      if (label !== 'parent') assert.equal(result.code, 'ACT_RETRY_BUDGET_UNAVAILABLE');
      if (label === 'blocked') assert.equal(h.events.slice(start).filter(e=>/^(command:|api:|write:|rename:)/.test(e)).length,0);
    }
    t.diagnostic(`Q1 ${label}: four identical poisoned-counter wakes; gate ${label === 'blocked' ? 'ARMED' : 'DISARMED'}`);
  }
}
