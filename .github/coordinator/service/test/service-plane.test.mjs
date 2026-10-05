import test from 'node:test';
import assert from 'node:assert/strict';
import { servicePlane, main } from '../service-plane.mjs';
import { drive } from '../phase-a-driver.mjs';
import { productionFixture } from './production-fixture.mjs';
const options = f => ({ execute: true, approvedHostMutation: f.spec.window.approved_sha, env: { SHU251_HOST_MUTATION_APPROVED: 'true' } });
// Exercise the real driver, executor, signed approvals and production provider;
// only filesystem, subprocess and clock effects are the existing recorded model.
function ioFor(f) {
  return { read: () => JSON.stringify(f.spec.window), lifecycle: f.provider,
    render: async () => {
      const { fixture } = await import('./lifecycle-fixture.mjs');
      return fixture().io.render(f.spec);
    } };
}
test('CLOSURE_SERVICE_PLANE complete install start readiness rollback', async t => {
  const f = productionFixture(t, { operations: ['pin', 'install', 'start', 'readiness'] });
  const before = f.provider.snapshot(), io = ioFor(f);
  const fs = await import('node:fs');
  const input = `${f.root}/driver.json`, link = `${f.root}/driver-link.json`;
  fs.writeFileSync(input, JSON.stringify(f.spec)); fs.symlinkSync(input, link);
  await assert.rejects(() => main(['start', link]), { code: 'SHU251_INPUT_FILE' }, 'CLOSURE_DRIVER_INPUT_CUSTODY');
  const plan = await servicePlane('start', f.spec, {}, io);
  assert.equal(plan.acceptance, false, 'CLOSURE_DRY_RUN_NOT_ACCEPTANCE');
  const result = await servicePlane('start', f.spec, options(f), io);
  assert.equal(result.state, 'READY_GATE_OFF', JSON.stringify(result.failures));
  assert.deepEqual(result.receipts.map(r => r.step), ['pin', 'preflight', 'install', 'start', 'readiness'], 'CLOSURE_ALL_STEPS');
  assert.ok(f.commands.some(c => c.file === '/usr/bin/systemctl' && c.args.join(' ') === 'start shu-supervisor.service'), 'CLOSURE_START_REQUIRED');
  assert.equal(result.receipts.at(-1).evidence.after.readiness.supervisor, 'ready', 'CLOSURE_LISTENING_REQUIRED');
  const rollback = await servicePlane('rollback', f.spec, options(f), io);
  assert.equal(rollback.state, 'ROLLED_BACK', JSON.stringify(rollback.failures));
  assert.deepEqual(f.provider.snapshot(), before, 'CLOSURE_ROLLBACK_EXACT');
  t.diagnostic(JSON.stringify({ dry_run: plan, modeled_execution: { state: result.state, receipts: result.receipts.map(r => r.step), rollback: rollback.state } }));
});
for (const failedStep of ['pin', 'preflight', 'install', 'start', 'readiness']) test(`CLOSURE_SERVICE_PLANE failure ${failedStep} receipts rollback`, async t => {
  const f = productionFixture(t, { operations: ['pin', 'install', 'start', 'readiness'] });
  const io = ioFor(f), before = f.provider.snapshot();
  const initialize = io.lifecycle.initialize;
  let injected = false;
  io.lifecycle.initialize = step => {
    if (step === failedStep && !injected) { injected = true; throw Object.assign(Error('fault'), { code: 'SHU251_PROVIDER_COMMAND' }); }
    return initialize(step);
  };
  const result = await servicePlane('start', f.spec, options(f), io);
  assert.equal(result.ok, false, 'CLOSURE_FAILURE_NOT_SUCCESS');
  assert.deepEqual(result.failures[0], { step: failedStep, code: 'SHU251_PROVIDER_COMMAND' }, 'CLOSURE_NAMED_FAILURE');
  assert.ok(result.receipts.some(r => r.step === 'host-rollback'), 'CLOSURE_FAILURE_ROLLBACK');
  assert.deepEqual(f.provider.snapshot(), before, 'CLOSURE_FAILURE_RESTORES');
});

// Production-source mutations, not alternate fake plans.
for (const [label, from, to, assertion] of [
  ['start omitted', "['pin', 'preflight', 'install', 'start', 'readiness']", "['pin', 'preflight', 'install', 'readiness']", 'CLOSURE_START_CHAIN'],
  ['readiness omitted', "['pin', 'preflight', 'install', 'start', 'readiness']", "['pin', 'preflight', 'install', 'start']", 'CLOSURE_READINESS_CHAIN'],
  ['rollback omitted', "if (action === 'start' && lifecycleIO.lifecycle)", 'if (false)', 'CLOSURE_ROLLBACK_CHAIN'],
]) test(`CLOSURE_SERVICE_PLANE mutation ${label}`, async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { pathToFileURL } = await import('node:url'), { spawnSync } = await import('node:child_process');
  const url = new URL('../service-plane.mjs', import.meta.url);
  const source = fs.readFileSync(url, 'utf8').replace("from './phase-a-driver.mjs'", `from '${new URL('../phase-a-driver.mjs', import.meta.url).href}'`);
  assert.equal(source.split(from).length, 2, 'CLOSURE_MUTATION_UNIQUE');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-plane-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mutant.mjs'); fs.writeFileSync(file, source.replace(from, to));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  const control = async implementation => {
    const f = productionFixture(t, { operations: ['pin', 'install', 'start', 'readiness'] }), io = ioFor(f);
    if (label === 'rollback omitted') {
      const original = io.lifecycle.initialize;
      io.lifecycle.initialize = step => { if (step === 'readiness') throw Object.assign(Error(), { code: 'SHU251_PROVIDER_COMMAND' }); return original(step); };
    }
    const result = await implementation('start', f.spec, options(f), io);
    if (label === 'rollback omitted') assert.ok(result.receipts.some(r => r.step === 'host-rollback'), assertion);
    else assert.ok(result.ok && result.receipts.some(r => r.step === 'readiness'), assertion);
  };
  await control(servicePlane);
  const mutant = await import(pathToFileURL(file));
  await assert.rejects(() => control(mutant.servicePlane), e => e.code === 'ERR_ASSERTION' && e.message.includes(assertion), assertion);
});
test('CLOSURE_SERVICE_PLANE rollback failure is receipted and later cleanup attempted', async t => {
  const f = productionFixture(t, { operations: ['pin', 'install', 'start', 'readiness'] }), io = ioFor(f);
  assert.equal((await servicePlane('start', f.spec, options(f), io)).ok, true);
  const initialize = io.lifecycle.initialize, attempted = [];
  io.lifecycle.initialize = step => { attempted.push(step); if (step === 'host-rollback') throw Object.assign(Error(), { code: 'SHU251_LIFECYCLE_ROLLBACK' }); return initialize(step); };
  const result = await servicePlane('rollback', f.spec, options(f), io);
  assert.equal(result.state, 'HALT', 'CLOSURE_ROLLBACK_FAILURE_VISIBLE');
  assert.deepEqual(attempted, ['host-rollback', 'pin-restore'], 'CLOSURE_CLEANUP_CONTINUES');
  assert.equal(result.failures[0].code, 'SHU251_LIFECYCLE_ROLLBACK');
});
