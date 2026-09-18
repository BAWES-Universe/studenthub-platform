import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createShu71Production, renderEvidenceBroker } from '../shu71-production.mjs';
import { provisioner } from '../provision-shu71-prerequisites.mjs';
import { fixture, revision } from './provision-prerequisites-fixture.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { canonicalBytes } from '../../shu71-activation-package.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const committed = fs.readFileSync(new URL('../../shu71-activation-public-key.pem', import.meta.url));
const anchor = JSON.parse(fs.readFileSync(new URL('../../shu71-trust-anchor.json', import.meta.url)));
const keys = ephemeralPublicSource();
const keyPath = '/etc/shu/keys/shu71-activation-ed25519.pem';
const row = (p, name) => p.precondition().paths.find(r => r.path === name);
// Executable Unix DAC model: directory search and socket write are distinct
// operations. All identities come from the fixture's named account database.
function connect(h, unit, user) {
  const named = field => unit.match(new RegExp(`^${field}=(.+)$`, 'm'))[1];
  const broker = h.users().find(u => u.name === named('User'));
  const group = h.groups().find(g => g.name === named('Group'));
  const client = h.users().find(u => u.name === user);
  const membership = h.groups().filter(g => g.members.split(',').includes(user)).map(g => g.gid);
  const allowed = (mode, bit) => !!((mode >> (client.uid === broker?.uid ? 6 : group && (client.gid === group.gid || membership.includes(group.gid)) ? 3 : 0)) & bit);
  if (!allowed(0o750, 1) || !allowed(0o660, 2)) throw Object.assign(Error('EACCES'), { code: 'EACCES' });
  return 'CONNECTED';
}
test('D1 activation path signs both runtime payloads', async t => {
  const h = productionFixture(t, keys);
  const result = await createShu71Production(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'ARMED', 'D1_ACTIVATION_PATH: ' + JSON.stringify(result));
  const pkg = JSON.parse(h.read(`/srv/shu/state/shu71-evidence/${h.id}/signed-package.json`));
  for (const payload of [pkg, pkg.activation]) assert.ok(verify(null, canonicalBytes(payload), keys.publicKey, Buffer.from(payload.signature, 'base64')), 'D1_ACTIVATION_SIGNATURE_POSITIVE');
});
test('D1 committed activation SPKI remains pinned', () => {
  const fingerprint = createHash('sha256').update(createPublicKey(committed).export({ type: 'spki', format: 'der' })).digest('hex');
  assert.equal(fingerprint, '0cc5f24f46554bd25b713d78fca2f2bd48ab9b270d217a9dce613956d5786d5a', 'D1_COMMITTED_SPKI');
  assert.equal(fingerprint, anchor.spki_sha256, 'D1_TRUST_ANCHOR');
});
test('D1 precondition reports existing activation key custody', t => {
  const h = fixture(t), p = provisioner(revision, h.boundary); p.install();
  assert.equal(row(p, keyPath)?.ok, true, 'D1_KEY_ROW');
  assert.equal(p.precondition().paths.filter(r => r.path.startsWith('/etc/shu/keys/')).length, 1, 'D1_ONLY_ACTIVATION_KEY');
  h.write(keyPath, 'private fixture', 0o400, 0, 27);
  assert.equal(row(p, keyPath)?.ok, true, 'D1_PRIVATE_READ_CUSTODY');
});
test('D1 shared group permits coordinator and denies unrelated user', t => {
  const h = fixture(t); provisioner(revision, h.boundary).install();
  assert.equal(connect(h, renderEvidenceBroker(), 'shu-coordinator'), 'CONNECTED', 'D1_COORDINATOR_ALLOWED');
  assert.throws(() => connect(h, renderEvidenceBroker(), 'messagebus'), { code: 'EACCES' }, 'D1_UNRELATED_DENIED');
});
test('D1 precondition measures shared group membership and socket predicates', t => {
  const h = fixture(t), p = provisioner(revision, h.boundary); p.install();
  assert.equal(row(p, 'group:shu-workspace')?.ok, true, 'D1_SHARED_GROUP_MEASURED');
  for (const [name, label] of [['/run/shu71-evidence', 'D1_RUNTIME_DIRECTORY_MODE'], ['/run/shu71-evidence/fixture.sock', 'D1_SOCKET_MODE']]) {
    assert.equal(row(p, name)?.ok, true, label);
    fs.chmodSync(h.root + name, 0o777);
    assert.equal(row(p, name)?.ok, false, label);
  }
});
export { connect };

async function moduleFrom(relative, edits) {
  const url = new URL(relative, import.meta.url);
  let source = fs.readFileSync(url, 'utf8');
  for (const [from, to] of edits) { assert.ok(source.includes(from), 'D1_MUTATION_SOURCE_PRESENT'); source = source.replace(from, to); }
  source = source.replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, prefix, quote, rel) => `${prefix}${quote}${new URL(rel, url)}${quote}`);
  source = source.replaceAll('import.meta.url', JSON.stringify(url.href));
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const production = '../shu71-production.mjs', provisioning = '../provision-shu71-prerequisites.mjs';
for (const role of ['C1 owner', 'lifecycle owner']) for (const payload of ['package', 'activation']) test(`D1 ${role} ${payload} substitution rejected and mutant killed`, async t => {
  const owner = generateKeyPairSync('ed25519');
  const label = `D1_REJECT_${role.replaceAll(' ', '_').toUpperCase()}_${payload.toUpperCase()}`;
  const check = async implementation => {
    const h = productionFixture(t, keys);
    h.write(role === 'C1 owner' ? '/etc/shu/approvals/shu71-owner.pub' : '/etc/shu/approvals/owner.pub', owner.publicKey.export({ type: 'spki', format: 'pem' }));
    if (role === 'C1 owner') h.write(`/etc/shu/approvals/${h.id}.shu71.json`, JSON.stringify({ payload: h.spec, signature: sign(null, canonicalBytes(h.spec, false), owner.privateKey).toString('base64') }));
    let count = 0;
    h.boundary.sign = (bytes, key) => sign(null, bytes, ++count === (payload === 'activation' ? 1 : 2) ? owner.privateKey : key);
    const result = await implementation(h.id, h.boundary).execute('run');
    assert.equal(result.code, 'ACT_PACKAGE_VALIDATION', label);
    assert.equal(h.exists('/srv/shu/state/shu71-activation.json'), false, label);
    // Real committed public key, captured before the ephemeral test-key seam.
    const doc = Buffer.from('owner role separation control');
    assert.equal(verify(null, doc, committed, sign(null, doc, owner.privateKey)), false, label + '_COMMITTED_KEY');
  };
  await check(createShu71Production);
  const mutant = await moduleFrom(production, [["need(checked.ok, 'ACT_PACKAGE_VALIDATION');", '']]);
  await assert.rejects(() => check(mutant.createShu71Production), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});
test('D1 activation path source mutant killed', async t => {
  const label = 'D1_ACTIVATION_PATH';
  const check = async implementation => {
    const h = productionFixture(t, keys);
    assert.equal((await implementation(h.id, h.boundary).execute('run')).state, 'ARMED', label);
  };
  await check(createShu71Production);
  const mutant = await moduleFrom(production, [[keyPath, '/etc/shu/keys/' + 'shu71-signing' + '.pem']]);
  await assert.rejects(() => check(mutant.createShu71Production), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});
for (const [name, from, to, user, expected] of [
  ['coordinator allowed', 'Group=shu-workspace', 'Group=shu71-evidence', 'shu-coordinator', true],
  ['unrelated denied', 'Group=shu-workspace', 'Group=messagebus', 'messagebus', false],
]) test(`D1 ${name} render mutation killed behaviourally`, async t => {
  const label = name === 'coordinator allowed' ? 'D1_COORDINATOR_ALLOWED' : 'D1_UNRELATED_DENIED';
  const check = render => {
    const h = fixture(t); provisioner(revision, h.boundary).install();
    if (expected) assert.doesNotThrow(() => assert.equal(connect(h, render(), user), 'CONNECTED'), label);
    else assert.throws(() => connect(h, render(), user), { code: 'EACCES' }, label);
  };
  check(renderEvidenceBroker);
  const mutant = await moduleFrom(production, [[from, to]]);
  assert.throws(() => check(mutant.renderEvidenceBroker), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});
for (const [name, value] of [['messagebus', 'messagebus'], ['numeric', '12345']]) test(`D1 ${name} unit identity refused and guard mutation killed`, async t => {
  const label = `D1_${name.toUpperCase()}_IDENTITY_REFUSED`;
  const injected = [["import { renderEvidenceBroker } from './shu71-production.mjs';", `import { renderEvidenceBroker as reviewed } from './shu71-production.mjs'; const renderEvidenceBroker = () => reviewed().replace('User=shu71-evidence', 'User=${value}');`]];
  const guard = "need(renderEvidenceBroker().includes(`\\nUser=${BROKER}\\nGroup=${SHARED_GROUP}\\n`) && !/\\n(?:User|Group)=\\d+\\n/.test(renderEvidenceBroker()), 'ACT_BROKER_UNIT_BINDING');";
  const check = implementation => {
    const h = fixture(t); provisioner(revision, h.boundary).install();
    assert.throws(() => implementation(revision, h.boundary).identity(), { code: 'ACT_BROKER_UNIT_BINDING' }, label);
  };
  check((await moduleFrom(provisioning, injected)).provisioner);
  const mutant = await moduleFrom(provisioning, [...injected, [guard, '']]);
  assert.throws(() => check(mutant.provisioner), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});
for (const [name, target, from, to, code] of [
  ['socket mode', '/run/shu71-evidence/fixture.sock', '(s.mode & 0o7777) === 0o660', 'true', 'ACT_BROKER_SOCKET_MODE'],
  ['runtime directory mode', '/run/shu71-evidence', '(s.mode & 0o7777) === 0o750', 'true', 'ACT_BROKER_DIRECTORY_MODE'],
  ['shared group membership', 'group:shu-workspace', "need(memberships.includes(SHARED_GROUP), 'ACT_BROKER_COORDINATOR_ACCESS');", '', 'ACT_BROKER_COORDINATOR_ACCESS'],
  ['shared group exists by name', 'group:shu-workspace', 'g.name === SHARED_GROUP', "g.name === 'renamed'", 'ACT_BROKER_SHARED_GROUP'],
]) test(`D1 ${name} refusal and source mutation killed`, async t => {
  const label = 'D1_' + name.replaceAll(' ', '_').toUpperCase();
  const check = implementation => {
    const h = fixture(t); provisioner(revision, h.boundary).install();
    if (name === 'shared group membership') h.groups().find(g => g.name === 'shu-workspace').members = '';
    else if (name === 'shared group exists by name') h.groups().find(g => g.name === 'shu-workspace').name = 'renamed';
    else fs.chmodSync(h.root + target, 0o777);
    assert.equal(row(implementation(revision, h.boundary), target)?.code, code, label);
  };
  check(provisioner);
  const mutant = await moduleFrom(provisioning, [[from, to]]);
  // For the group-name mutant, supply membership in the reviewed group while
  // its database entry has been renamed; this separates the existence guard.
  if (name === 'shared group exists by name') {
    const h = fixture(t); provisioner(revision, h.boundary).install(); h.groups().find(g => g.name === 'shu-workspace').name = 'renamed';
    const run = h.boundary.run; h.boundary.run = (exe, args, opts) => exe === '/usr/bin/id' ? { status: 0, stdout: 'shu-coordinator shu-workspace' } : run(exe, args, opts);
    const assertion = impl => assert.equal(row(impl(revision, h.boundary), target)?.code, code, label);
    assertion(provisioner);
    assert.throws(() => assertion(mutant.provisioner), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
  } else assert.throws(() => check(mutant.provisioner), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});
for (const [name, mutate, from, to] of [
  ['owner', h => h.owners.set(keyPath, [7, 0]), 'r.uid === 0 && !(r.mode & 0o077)', '!(r.mode & 0o077)'],
  ['group other bits', h => h.write(keyPath, 'private fixture', 0o640), '!(r.mode & 0o077)', 'true'],
  ['nonempty', h => h.write(keyPath, '', 0o600), 'r.bytes.length > 0 && Buffer.from', 'Buffer.from'],
  ['single link', h => fs.linkSync(h.root + keyPath, h.root + keyPath + '.extra'), 's.isFile() && s.nlink === 1', 's.isFile()'],
  ['no symlink', h => { fs.renameSync(h.root + keyPath, h.root + keyPath + '.target'); fs.symlinkSync(h.root + keyPath + '.target', h.root + keyPath); }, 'C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK', 'C.O_RDONLY | C.O_NONBLOCK'],
]) test(`D1 activation key ${name} custody refusal and mutation killed`, async t => {
  const label = 'D1_KEY_' + name.replaceAll(' ', '_').toUpperCase();
  const check = implementation => {
    const h = fixture(t); provisioner(revision, h.boundary).install(); mutate(h);
    assert.equal(row(implementation(revision, h.boundary), keyPath)?.ok, false, label);
  };
  check(provisioner);
  const mutant = await moduleFrom(provisioning, [[from, to]]);
  assert.throws(() => check(mutant.provisioner), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});
test('D1 precondition key path mutation killed', async t => {
  const label = 'D1_KEY_ROW';
  const check = implementation => { const h = fixture(t); provisioner(revision, h.boundary).install(); assert.equal(row(implementation(revision, h.boundary), keyPath)?.ok, true, label); };
  check(provisioner);
  const mutant = await moduleFrom(provisioning, [[`check('${keyPath}'`, "check('/etc/shu/keys/wrong.pem'"]]);
  assert.throws(() => check(mutant.provisioner), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});
test('D1 precondition exact rendered unit mutation killed', async t => {
  const label = 'D1_EXACT_UNIT';
  const check = implementation => { const h = fixture(t); provisioner(revision, h.boundary).install(); h.write('/etc/systemd/system/shu71-evidence.service', renderEvidenceBroker() + 'SupplementaryGroups=unrelated\n');
    assert.equal(row(implementation(revision, h.boundary), '/etc/systemd/system/shu71-evidence.service')?.code, 'ACT_TREE_CONTENT', label); };
  check(provisioner);
  const mutant = await moduleFrom(provisioning, [["need(actual.bytes === e.bytes && hash(Buffer.from(actual.bytes, 'base64')) === (e.blob ?? hash(Buffer.from(e.bytes, 'base64'))), code('CONTENT'));", "if(e.kind !== 'unit') need(actual.bytes === e.bytes && hash(Buffer.from(actual.bytes, 'base64')) === (e.blob ?? hash(Buffer.from(e.bytes, 'base64'))), code('CONTENT'));"]]);
  assert.throws(() => check(mutant.provisioner), e => e.code === 'ERR_ASSERTION' && e.message.includes(label), label + '_KILL');
});
test('D1 broker creates socket at 0660 and widened source mutant killed', async t => {
  const seams = [["import net from 'node:net';", "const net = { createServer: () => ({ listen: (p, ready) => ready() }) };"],
    ["import fs from 'node:fs';", 'export const measured = []; const fs = { chmodSync: (p, mode) => measured.push({ path: p, mode }) };']];
  const check = async edits => {
    const module = await moduleFrom('../fixture-evidence-broker.mjs', [...seams, ...edits]);
    module.measured.length = 0; module.startEvidenceBroker({});
    assert.deepEqual(module.measured, [{ path: '/run/shu71-evidence/fixture.sock', mode: 0o660 }], 'D1_SOCKET_CREATED_0660');
  };
  await check([]);
  await assert.rejects(() => check([['fs.chmodSync(EVIDENCE_SOCKET, 0o660)', 'fs.chmodSync(EVIDENCE_SOCKET, 0o666)']]), e => e.code === 'ERR_ASSERTION' && e.message.includes('D1_SOCKET_CREATED_0660'));
});
test('D1 rendered runtime directory widening refused and mutant killed', async t => {
  const check = render => {
    const h = fixture(t), p = provisioner(revision, h.boundary); p.install();
    fs.chmodSync(h.root + '/run/shu71-evidence', parseInt(render().match(/RuntimeDirectoryMode=(\d+)/)[1], 8));
    assert.equal(row(p, '/run/shu71-evidence').ok, true, 'D1_RENDERED_DIRECTORY_MODE');
  };
  check(renderEvidenceBroker);
  const mutant = await moduleFrom(production, [['RuntimeDirectoryMode=0750', 'RuntimeDirectoryMode=0755']]);
  assert.throws(() => check(mutant.renderEvidenceBroker), e => e.code === 'ERR_ASSERTION' && e.message.includes('D1_RENDERED_DIRECTORY_MODE'));
});
