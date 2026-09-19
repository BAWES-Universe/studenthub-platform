import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, revision } from './provision-prerequisites-fixture.mjs';
import { provisioner, PATHS, BROKER } from '../provision-shu71-prerequisites.mjs';
const moduleURL = new URL('../provision-shu71-prerequisites.mjs', import.meta.url);
const source = fs.readFileSync(moduleURL, 'utf8');
const tree = PATHS.tree + '/service/shu71-production.mjs';
const cases = [
  ['missing tree file', "need(stat(e.path), code('PATH'));", "if (!stat(e.path)) return { path: e.path };", h => h.remove(tree), 'ACT_TREE_PATH'],
  ['stale tree file', "need(actual.bytes === e.bytes && hash(Buffer.from(actual.bytes, 'base64')) === (e.blob ?? hash(Buffer.from(e.bytes, 'base64'))), code('CONTENT'));", '', h => h.write(tree, 'stale'), 'ACT_TREE_CONTENT'],
  ['wrong tree ownership', "need(actual.uid === e.uid && actual.gid === e.gid, code('OWNER'));", '', h => h.owners.set(tree, [1, 0]), 'ACT_TREE_OWNER'],
  ['wrong tree mode', "need(actual.mode === e.mode, code('MODE'));", '', h => h.write(tree, 'reviewed production', 0o600), 'ACT_TREE_MODE'],
  ['wrong sudoers path', "need(stat(e.path), code('PATH'));", "if (e.kind === 'sudoers' && !stat(e.path)) return { path: e.path }; need(stat(e.path), code('PATH'));", h => h.remove(PATHS.sudoers), 'SHU251_SUDOERS_PATH'],
  ['wrong sudoers mode', "need(actual.mode === e.mode, code('MODE'));", "if(e.kind !== 'sudoers') need(actual.mode === e.mode, code('MODE'));", h => h.write(PATHS.sudoers, h.f.readFileSync(PATHS.sudoers), 0o644), 'SHU251_SUDOERS_MODE'],
  ['wrong sudoers content', "need(actual.bytes === e.bytes && hash(Buffer.from(actual.bytes, 'base64')) === (e.blob ?? hash(Buffer.from(e.bytes, 'base64'))), code('CONTENT'));", "if(e.kind !== 'sudoers') need(actual.bytes === e.bytes, code('CONTENT'));", h => h.write(PATHS.sudoers, 'wrong', 0o440), 'SHU251_SUDOERS_CONTENT'],
  ['parser failure', "catch { need(false, 'SHU251_SUDOERS_PARSER'); }", "catch { return { identity: '/usr/bin/cvtsudoers.ws' }; }", h => { h.faults.parser = true; }, 'SHU251_SUDOERS_PARSER'],
  ['wrapper drift', 'function verifyFile(e) {', "function verifyFile(e) { if(e.kind === 'wrapper') return {};", h => h.write(PATHS.wrapper, 'wrong', 0o755), 'ACT_WRAPPER_DRIFT'],
  ['UID collision', "need(!u || !users.some(p => p.name !== BROKER && p.uid === u.uid), 'ACT_BROKER_UID_COLLISION');", '', h => h.users().push({ ...h.users().find(u => u.name === BROKER), name: 'unrelated', gid: 321 }), 'ACT_BROKER_UID_COLLISION'],
  ['GID collision', "need(!g || !groups.some(p => p.name !== BROKER && p.gid === g.gid), 'ACT_BROKER_GID_COLLISION');", '', h => h.groups().push({ ...h.groups().find(g => g.name === BROKER), name: 'unrelated' }), 'ACT_BROKER_GID_COLLISION'],
  ['messagebus substitution', "need(!u || u.uid !== 996 && u.name !== 'messagebus', 'ACT_BROKER_MESSAGEBUS');", '', h => { h.users().find(u => u.name === BROKER).uid = 996; }, 'ACT_BROKER_MESSAGEBUS'],
];
async function mutated(from, to) {
  assert.ok(source.includes(from), 'MUTATION_SOURCE_PRESENT');
  const text = source.replace(from, to).replaceAll("from './host-suite-contract.mjs'", `from '${new URL('../host-suite-contract.mjs', import.meta.url)}'`)
    .replaceAll("from './shu71-runtime-schema.mjs'", `from '${new URL('../shu71-runtime-schema.mjs', import.meta.url)}'`)
    .replaceAll("from './shu71-production.mjs'", `from '${new URL('../shu71-production.mjs', import.meta.url)}'`);
  return import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
}
for (const [name, from, to, fault, code] of cases) test(`SHU71 named mutation killed: ${name}`, async t => {
  const label = 'SHU71_KILL_' + name.toUpperCase().replaceAll(' ', '_');
  const check = implementation => {
    const h = fixture(t); provisioner(revision, h.boundary).install(); fault(h);
    assert.throws(() => implementation(revision, h.boundary).verify(), { code }, label);
  };
  check(provisioner);
  const mutant = await mutated(from, to);
  assert.throws(() => check(mutant.provisioner), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + ': mutant must die by named assertion');
});
test('SHU71 named mutation killed: hard-coded numeric identity in render', async t => {
  const from = "import { renderEvidenceBroker } from './shu71-production.mjs';";
  const to = "import { renderEvidenceBroker as originalRender } from './shu71-production.mjs'; const renderEvidenceBroker = () => originalRender().replace('User=shu71-evidence', 'User=996').replace('Group=shu-workspace', 'Group=999');";
  const check = implementation => { const h = fixture(t); provisioner(revision, h.boundary).install();
    assert.doesNotThrow(() => implementation(revision, h.boundary).identity(), 'SHU71_KILL_NUMERIC_RENDER');
    assert.deepEqual(implementation(revision, h.boundary).identity(), { name: BROKER, uid: 100, gid: 100 }, 'SHU71_KILL_NUMERIC_RENDER'); };
  check(provisioner); const m = await mutated(from, to);
  assert.throws(() => check(m.provisioner), e => e.code === 'ERR_ASSERTION' && e.message.includes('SHU71_KILL_NUMERIC_RENDER'), 'SHU71_KILL_NUMERIC_RENDER');
});
for (const name of ['partial installation', 'rollback residue']) test(`SHU71 named mutation killed: ${name}`, async t => {
  const label = name === 'partial installation' ? 'SHU71_KILL_PARTIAL_INSTALLATION' : 'SHU71_KILL_ROLLBACK_RESIDUE';
  const check = implementation => {
    const h = fixture(t), before = h.snapshot(), p = implementation(revision, h.boundary);
    if (name === 'partial installation') {
      let thrown = false; h.faults.after = event => { if (!thrown && event === 'rename:' + PATHS.wrapper) { thrown = true; return true; } return false; };
      assert.throws(() => p.install()); h.faults.after = null;
    } else { p.install(); p.rollback(); }
    assert.deepEqual(h.snapshot(), before, label);
  };
  check(provisioner);
  const m = name === 'partial installation'
    ? await mutated("try { rollback(j); } catch (recovery)", "try { /* rollback omitted */ } catch (recovery)")
    : await mutated("remove(PATHS.receipt); need(!stat(PATHS.receipt), 'ACT_ROLLBACK_RESIDUE');", '');
  assert.throws(() => check(m.provisioner), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label);
});
