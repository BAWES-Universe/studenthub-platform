// Repository-only proof capture. Every host command is a fixture boundary double.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { provisioner, PATHS } from '../../../provision-shu71-prerequisites.mjs';
import { fixture, revision } from '../../provision-prerequisites-fixture.mjs';
import { productionFixture } from '../../shu71-production-fixture.mjs';
import { createShu71Production } from '../../../shu71-production.mjs';
import { ephemeralPublicSource } from '../../../../test/fixture/ephemeral-public-source.mjs';
const cleanup = [], t = { after: fn => cleanup.push(fn) }, keys = ephemeralPublicSource();
const dir = '/run/shu71-evidence', socket = dir + '/fixture.sock';
const result = { pre_mint: {}, window: {} };
try {
  for (const state of ['inactive_green', 'inactive_static_failure', 'active_correct', 'active_wrong']) {
    const h = fixture(t);
    if (state.startsWith('inactive')) h.remove('/run/shu71-evidence');
    const p = provisioner(revision, h.boundary); p.install();
    if (state === 'inactive_static_failure') h.write(PATHS.unit, fs.readFileSync(h.root + PATHS.unit, 'utf8').replace('UMask=0007', 'UMask=0000'));
    if (state === 'active_wrong') fs.chmodSync(h.root + socket, 0o666);
    const r = p.precondition();
    result.pre_mint[state] = { ok: r.ok, refusals: r.paths.filter(row => !row.ok), runtime_rows: r.paths.filter(row => [dir, socket].includes(row.path)) };
    assert.equal(r.ok, ['inactive_green', 'active_correct'].includes(state));
  }
  for (const [name, damage, code] of [
    ['passing', () => {}, null],
    ['missing_directory', h => fs.rmSync(h.root + dir, { recursive: true }), 'ACT_RUNTIME_DIRECTORY_MISSING'],
    ['missing_socket', h => fs.unlinkSync(h.root + socket), 'ACT_RUNTIME_SOCKET_MISSING'],
    ['wrong_owner', h => h.owners.set(socket, [101, 980]), 'ACT_RUNTIME_OWNER'],
    ['wrong_group', h => h.owners.set(socket, [100, 981]), 'ACT_RUNTIME_GROUP'],
    ['widened_directory', h => fs.chmodSync(h.root + dir, 0o770), 'ACT_RUNTIME_DIRECTORY_MODE'],
    ['widened_socket', h => fs.chmodSync(h.root + socket, 0o666), 'ACT_RUNTIME_SOCKET_MODE'],
    ['coordinator_inaccessible', h => fs.chmodSync(h.root + '/run', 0o700), 'ACT_RUNTIME_COORDINATOR_ACCESS'],
  ]) {
    const h = productionFixture(t, keys); h.faults.runtime = () => damage(h);
    const r = await createShu71Production(h.id, h.boundary).execute('run');
    if (code) { assert.equal(r.code, code); assert.equal(r.teardown.state, 'REVOKED'); }
    else { assert.equal(r.state, 'ARMED'); await createShu71Production(h.id, h.boundary).execute('revoke'); }
    const receipt = h.journal().find(row => row.event === 'BROKER_RUNTIME_MEASURED');
    result.window[name] = { result: r, runtime_receipt: receipt ? { rows: receipt.rows, coordinator_access: receipt.coordinator_access, kernel_connect: receipt.kernel_connect } : null,
      archive_runtime: JSON.parse(h.read(`/srv/shu/state/shu71-evidence/${h.id}/activation.json`)).broker_runtime,
      halted: h.journal().filter(row => row.event === 'HALTED').map(({event, code}) => ({event, code})),
      teardown_complete: h.journal().at(-1).event === 'TEARDOWN_COMPLETE' };
  }
  fs.writeFileSync(new URL('./proof.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
} finally { for (const fn of cleanup.reverse()) fn(); }
