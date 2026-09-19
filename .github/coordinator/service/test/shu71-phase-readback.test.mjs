import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
const moduleUrl = new URL('../shu71-production.mjs', import.meta.url);
const source = fs.readFileSync(moduleUrl, 'utf8');
const historical = fs.readFileSync(new URL('./fixtures/shu71-history/6e91a6c135311ffdaf129c10cd8c1d2a9455272f/shu71-production.mjs', import.meta.url), 'utf8');
const activation = '/srv/shu/state/shu71-activation.json';
const gates = ['shu-coordinator', 'shu-supervisor'].map(n => `/etc/systemd/system/${n}.service.d/90-shu71.conf`);
const activationStep = "      await step('activation-readback', () => installedReadback(ACTIVATION_FILE, JSON.stringify(pkg.activation), coordinatorIdentity().gid, 0o640, 'ACTIVATION'), true);\n";
const dropinStep = "      await step('dropin-readback', () => {\n        for (const file of GATES) installedReadback(file, '[Service]\\nEnvironment=ENABLE_DISPATCH=true\\n', 0, 0o644, 'DROPIN');\n      }, /* remeasure on resume */ true);\n";
function replace(s, before, after) {
  assert.equal(s.split(before).length, 2, 'PHASE_MUTATION_UNIQUE');
  return s.replace(before, after);
}
async function load(t, s) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-phase-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'production.mjs');
  fs.writeFileSync(file, s.replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, p, q, r) => `${p}${q}${new URL(r, moduleUrl).href}${q}`));
  return (await import(pathToFileURL(file))).createShu71Production;
}
const damage = {
  MISSING: (h, file) => fs.unlinkSync(h.root + file),
  BYTES: (h, file) => fs.writeFileSync(h.root + file, h.read(file).replace(/./, '!')),
  UID: (h, file) => h.owners.set(file, [123, file === activation ? 982 : 0]),
  GID: (h, file) => h.owners.set(file, [0, 123]),
  WIDE_MODE: (h, file) => fs.chmodSync(h.root + file, 0o666),
  NARROW_MODE: (h, file) => fs.chmodSync(h.root + file, 0o600),
  SPECIAL_MODE: (h, file) => fs.chmodSync(h.root + file, 0o2644),
  SYMLINK: (h, file) => { fs.renameSync(h.root + file, h.root + file + '.target'); fs.symlinkSync(file.split('/').at(-1) + '.target', h.root + file); },
  DIRECTORY_UID: (h, file) => h.owners.set(path.dirname(file), [123, 0]),
  DIRECTORY_GID: (h, file) => h.owners.set(path.dirname(file), [0, 123]),
  DIRECTORY_WIDE: (h, file) => fs.chmodSync(h.root + path.dirname(file), 0o777),
  DIRECTORY_NARROW: (h, file) => fs.chmodSync(h.root + path.dirname(file), 0o700),
  SIGNATURE: (h, file) => { const doc = JSON.parse(h.read(file)); doc.signature = 'A'.repeat(doc.signature.length); fs.writeFileSync(h.root + file, JSON.stringify(doc)); },
};
const reason = name => name.startsWith('DIRECTORY') ? 'DIRECTORY' : name.includes('MODE') ? 'MODE' : ['UID', 'GID', 'SYMLINK'].includes(name) ? 'CUSTODY' : name === 'SIGNATURE' ? 'BYTES' : name;
function scenario(t, file, failure) {
  const h = productionFixture(t, keys);
  let damaged = false;
  h.faults.after = event => {
    // One-shot post-rename corruption: teardown gets the unmodified boundary.
    if (!damaged && event === `rename:${file}`) { damaged = true; damage[failure](h, file); }
    return false;
  };
  return h;
}
async function check(create, h, file, failure) {
  const kind = file === activation ? 'ACTIVATION' : 'DROPIN';
  const name = `PHASE_${kind}_${failure}`;
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'HALT', `${name}_HALT`);
  assert.equal(result.code, `ACT_${kind}_READBACK_${reason(failure)}`, `${name}_CODE`);
  assert.ok(!h.events.some(e => e.includes(':restart shu-supervisor.service') || e.includes(':start shu-coordinator.timer')), `${name}_BEFORE_RESTART`);
  assert.ok(!h.journal().some(e => e.event === 'ARMED'), `${name}_BEFORE_ARMED`);
  if (kind === 'ACTIVATION') assert.ok(!h.journal().some(e => e.step === 'gate-install'), `${name}_BEFORE_DISPATCH_GATE`);
  else {
    const written = h.events.findIndex(e => e === `rename:${file}`);
    const halt = h.journal().find(e => e.event === 'HALTED');
    assert.ok(written >= 0 && halt, `${name}_AFTER_INSTALL`);
  }
  assert.equal(h.exists(activation), false, `${name}_TEARDOWN_ACTIVATION`);
  assert.ok(h.events.some(e => e.includes(':kill --kill-whom=all')), `${name}_TEARDOWN_WORKERS`);
  for (const service of ['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer'])
    assert.equal(h.active.get(service), 'inactive', `${name}_TEARDOWN_STOP`);
  for (const v of h.spec.pkg.issue_transitions) assert.deepEqual(h.states.get(v.issue_id), v.restore, `${name}_TEARDOWN_RESTORE`);
  assert.ok(result.teardown, `${name}_TEARDOWN_RESULT`);
  if (!failure.startsWith('DIRECTORY') || failure === 'DIRECTORY_GID' || failure === 'DIRECTORY_NARROW') {
    for (const gate of gates) assert.equal(h.read(gate), '[Service]\nEnvironment=ENABLE_DISPATCH=false\n', `${name}_TEARDOWN_GATES`);
    assert.equal(result.teardown.state, 'REVOKED', `${name}_TEARDOWN_COMPLETE`);
  } else assert.equal(result.teardown.ok, false, `${name}_TEARDOWN_DAMAGE_REPORTED`);
}
const cases = [];
for (const file of [...gates, activation]) for (const failure of Object.keys(damage)) {
  if (file === activation && failure.startsWith('DIRECTORY') || file !== activation && failure === 'SIGNATURE') continue;
  cases.push({ file, failure, label: `${file === activation ? 'ACTIVATION' : file.includes('supervisor') ? 'DROPIN_SUPERVISOR' : 'DROPIN_COORDINATOR'}_${failure}` });
}
for (const { file, failure, label } of cases) {
  test(`PHASE_REQUIRE_${label}`, t => check(createShu71Production, scenario(t, file, failure), file, failure));
  test(`PHASE_KILL_${label}`, async t => {
    let mutant;
    const r = reason(failure);
    if (r === 'MISSING') mutant = replace(source, file === activation ? activationStep : dropinStep, '');
    else if (r === 'DIRECTORY') mutant = replace(source, "if (kind === 'DROPIN') {", 'if (false) {');
    else if (r === 'BYTES') mutant = replace(source, "need(stat.size === expected.length && f.readFileSync(fd).equals(expected), code('BYTES'));", "/* mutant: accept different bytes */");
    else if (r === 'MODE') mutant = replace(source, "need((stat.mode & 0o7777) === mode, code('MODE'));", '/* mutant: accept different mode */');
    else if (failure === 'SYMLINK') {
      mutant = replace(source, "need(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1, code('CUSTODY'));", '');
      mutant = replace(mutant, '      fd = f.openSync(file, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);', '      fd = f.openSync(file, C.O_RDONLY | C.O_NONBLOCK);');
    } else mutant = replace(source, "need(stat.isFile() && stat.nlink === 1 && stat.uid === 0 && stat.gid === gid, code('CUSTODY'));", '/* mutant: accept foreign custody */');
    const create = await load(t, mutant);
    await assert.rejects(check(create, scenario(t, file, failure), file, failure),
      e => e.code === 'ERR_ASSERTION' && e.message.includes(`PHASE_${file === activation ? 'ACTIVATION' : 'DROPIN'}_${failure}_`), `PHASE_NAMED_KILL_${label}`);
  });
}
for (const file of [...gates, activation]) for (const failure of ['MISSING', 'BYTES']) test(`PHASE_PRE_FIX_${file === activation ? 'ACTIVATION' : file.includes('supervisor') ? 'DROPIN_SUPERVISOR' : 'DROPIN_COORDINATOR'}_${failure}_ACCEPTED`, async t => {
  const create = await load(t, historical), h = scenario(t, file, failure);
  h.owners.set('/srv/shu/state', [0, 0]);
  assert.equal((await create(h.id, h.boundary).execute('run')).state, 'ARMED', 'PHASE_PRE_FIX_ACCEPTS_DAMAGED_ARTIFACT');
  assert.ok(h.events.some(e => e.includes(':restart shu-supervisor.service')), 'PHASE_PRE_FIX_RESTARTS');
  if (failure === 'MISSING') assert.equal(h.exists(file), false, 'PHASE_PRE_FIX_MISSING');
  else assert.ok(h.read(file).startsWith('!'), 'PHASE_PRE_FIX_MISMATCHED');
});

test('PHASE_GREEN_ORDER_AND_EXACT_BYTES', async t => {
  const h = productionFixture(t, keys), trace = [];
  const after = h.faults.after;
  h.faults.after = name => {
    if (name.startsWith('rename:') || name.startsWith('command:/usr/bin/systemctl:')) trace.push({ name, rows: h.exists(`/srv/shu/state/shu71-evidence/${h.id}/journal.jsonl`) ? h.journal() : [] });
    return after?.(name);
  };
  assert.equal((await createShu71Production(h.id, h.boundary).execute('run')).state, 'ARMED', 'PHASE_GREEN_ARMED');
  const rows = h.journal(), done = step => rows.findIndex(e => e.event === 'DONE' && e.step === step);
  const order = ['activation', 'activation-readback', 'gate-install', 'dropin-readback', 'gate'].map(done);
  assert.ok(order.every((v, i) => v >= 0 && (!i || v > order[i - 1])), 'PHASE_ORDER_ALL_STEPS');
  assert.ok(done('gate') < rows.findIndex(e => e.event === 'ARMED'), 'PHASE_ORDER_ARMED');
  const gateWrite = trace.findIndex(e => e.name === `rename:${gates[0]}`);
  for (const event of trace.slice(gateWrite).filter(e => e.name.startsWith('command:'))) {
    assert.ok(event.rows.some(e => e.step === 'dropin-readback' && e.event === 'DONE'), 'PHASE_ORDER_BEFORE_RELOAD_RESTART_TIMER');
  }
  for (const file of gates) {
    const event = trace.find(e => e.name === `rename:${file}`);
    assert.ok(event.rows.some(e => e.step === 'activation-readback' && e.event === 'DONE'), 'PHASE_ORDER_BEFORE_GATE_WRITE');
    assert.equal(h.read(file), '[Service]\nEnvironment=ENABLE_DISPATCH=true\n', 'PHASE_GREEN_DROPIN_BYTES');
  }
  const signed = JSON.parse(h.read(`/srv/shu/state/shu71-evidence/${h.id}/signed-package.json`));
  assert.equal(h.read(activation), JSON.stringify(signed.activation), 'PHASE_GREEN_SIGNED_BYTES');
});
for (const kind of ['ACTIVATION', 'DROPIN']) test(`PHASE_KILL_${kind}_LATE_ORDER`, async t => {
  const step = kind === 'ACTIVATION' ? activationStep : dropinStep;
  let mutant = replace(source, step, '');
  const anchor = "      journal.append({ event: 'ARMED', authorization_expires_at: pkg.expires_at, teardown_complete: false });";
  mutant = replace(mutant, anchor, step + anchor);
  const create = await load(t, mutant), file = kind === 'ACTIVATION' ? activation : gates[0];
  await assert.rejects(check(create, scenario(t, file, 'BYTES'), file, 'BYTES'),
    e => e.code === 'ERR_ASSERTION' && e.message.includes(`PHASE_${kind}_BYTES_BEFORE_RESTART`), `PHASE_NAMED_KILL_${kind}_LATE_ORDER`);
});

test('PHASE_HISTORICAL_BYTES_PINNED', () => {
  assert.equal(createHash('sha256').update(historical).digest('hex'), '1c5150e36a089fd89dbeb577971f214f066b97fc5f313a2b96da1549b7ca69fb', 'PHASE_PRE_FIX_IMMUTABLE');
});

test('PHASE_KILL_ACTIVATION_PAST_DISPATCH_GATE', async t => {
  let mutant = replace(source, activationStep, '');
  mutant = replace(mutant, dropinStep, activationStep + dropinStep);
  const create = await load(t, mutant);
  await assert.rejects(check(create, scenario(t, activation, 'BYTES'), activation, 'BYTES'),
    e => e.code === 'ERR_ASSERTION' && e.message.includes('PHASE_ACTIVATION_BYTES_BEFORE_DISPATCH_GATE'), 'PHASE_NAMED_KILL_ACTIVATION_PAST_DISPATCH_GATE');
});
for (const kind of ['ACTIVATION', 'DROPIN']) {
  async function resumeCheck(t, create) {
    const h = productionFixture(t, keys), step = kind === 'ACTIVATION' ? 'activation-readback' : 'dropin-readback';
    let dead = false;
    h.faults.after = event => {
      if (event.startsWith('write:') && event.endsWith('/journal.jsonl') && h.journal().at(-1)?.event === 'DONE' && h.journal().at(-1)?.step === step) dead = true;
      return dead;
    };
    h.faults.before = () => dead;
    await create(h.id, h.boundary).execute('run').catch(() => {});
    assert.ok(dead, `PHASE_${kind}_RESUME_CRASH_REACHED`);
    h.faults.before = null; h.faults.after = null;
    damage.BYTES(h, kind === 'ACTIVATION' ? activation : gates[0]);
    const result = await create(h.id, h.boundary).execute('resume');
    assert.equal(result.code, `ACT_${kind}_READBACK_BYTES`, `PHASE_${kind}_RESUME_REMEASURES`);
    assert.equal(result.state, 'HALT', `PHASE_${kind}_RESUME_HALT`);
    assert.equal(result.teardown.state, 'REVOKED', `PHASE_${kind}_RESUME_TEARDOWN`);
  }
  test(`PHASE_REQUIRE_${kind}_RESUME_REMEASURES`, t => resumeCheck(t, createShu71Production));
  test(`PHASE_KILL_${kind}_RESUME_SKIP`, async t => {
    const step = kind === 'ACTIVATION' ? activationStep : dropinStep;
    const create = await load(t, replace(source, step, step.replace('true);\n', 'false);\n')));
    await assert.rejects(resumeCheck(t, create),
      e => e.code === 'ERR_ASSERTION' && e.message.includes(`PHASE_${kind}_RESUME_REMEASURES`), `PHASE_NAMED_KILL_${kind}_RESUME_SKIP`);
  });
}
