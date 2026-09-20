import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { provisioner, PATHS } from '../provision-shu71-prerequisites.mjs';
import { createShu71Production } from '../shu71-production.mjs';
import { fixture, revision } from './provision-prerequisites-fixture.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
const root = '/srv/shu/state/shu71-evidence', activation = '/srv/shu/state/shu71-activation.json';
const base = new URL('../', import.meta.url);
const sources = Object.fromEntries(['shu71-production.mjs', 'provision-shu71-prerequisites.mjs'].map(n => [n, fs.readFileSync(new URL(n, base), 'utf8')]));
const historical = n => fs.readFileSync(new URL('./fixtures/shu71-history/f346e539b51ef35a6e4be9f7020bbb5ce6078694/' + n, import.meta.url), 'utf8');
async function load(t, n, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-contract-mutant-')); t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const file = path.join(dir, n);
  fs.writeFileSync(file, text.replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, p, q, r) => `${p}${q}${new URL(r, new URL(n, base))}${q}`));
  return { ...await import(pathToFileURL(file)), sourceUrl: pathToFileURL(file).href };
}
function prepared(t, impl = provisioner, options = {}) {
  const host = fixture(t), window = productionFixture(t, keys, undefined, host, options);
  host.remove('/usr/local/lib/shu71/coordinator');
  impl(revision, host.boundary).install();
  host.remove('/run/shu71-evidence');
  host.directory('/run', 0o755);
  for (const service of ['shu-coordinator', 'shu-supervisor']) host.remove(`/etc/systemd/system/${service}.service.d`);
  return { host, window, gate: () => impl(revision, host.boundary).precondition() };
}
const row = (r, p = root) => r.paths.find(r => r.path === p);
function allowed(h, p, uid, gids, bits) {
  // POSIX DAC, including traversal of each ancestor. Uses the same inode model
  // as both production readers and the pre-mint gate; no UID==GID shortcut.
  const access = (file, mask) => { const s = h.boundary.fs.lstatSync(file); const shift = s.uid === uid ? 6 : gids.includes(s.gid) ? 3 : 0; return ((s.mode >> shift) & mask) === mask; };
  for (let parent = path.dirname(p); parent !== '/'; parent = path.dirname(parent)) if (!access(parent, 1)) return false;
  return access(p, bits);
}
async function joint(t, gate = provisioner, production = createShu71Production) {
  const { host, window, gate: check } = prepared(t, gate), r = check();
  assert.equal(r.ok, true, 'JOINT_ALL_APPLICABLE_ROWS_GREEN: ' + JSON.stringify(r.paths.filter(r=>!r.ok)));
  assert.deepEqual(r.paths.filter(r=>r.runtime).map(r=>r.runtime), ['DEFERRED_UNTIL_SERVICE_START','DEFERRED_UNTIL_SERVICE_START'], 'JOINT_BROKER_PHASE_DEFERRAL');
  assert.deepEqual(r.paths.filter(r=>r.window).map(r=>r.path).sort(), [activation, ...['shu-coordinator','shu-supervisor'].flatMap(n=>[`/etc/systemd/system/${n}.service.d`,`/etc/systemd/system/${n}.service.d/90-shu71.conf`])].sort(), 'JOINT_ONLY_WINDOW_OUTPUTS_DEFERRED');
  assert.deepEqual([row(r).uid,row(r).gid,row(r).mode], [0,0,0o700], 'JOINT_EXACT_EVIDENCE_PREDICATE');
  assert.equal((await production(window.id, window.boundary).execute('run')).state, 'ARMED', 'JOINT_SAME_PATHS_PRODUCTION_ARMED');
  assert.equal(host.root, window.root, 'JOINT_ONE_FILESYSTEM'); assert.equal(host.owners, window.owners, 'JOINT_ONE_CUSTODY_DATABASE');
  for (const p of ['/srv/shu/state','/srv/shu/state/workspaces','/srv/shu/state/workspaces/supervisor']) {
    const s=window.boundary.fs.lstatSync(p); assert.deepEqual([s.uid,s.gid,s.mode&0o7777],[999,982,0o700], 'JOINT_SERVICE_PATH_'+p);
  }
  assert.equal(allowed(window, activation, 999, [982,980], 4), true, 'READER_ACTUAL_WRITTEN_FILE_READABLE');
  assert.deepEqual(window.owners.get(activation), [0,982], 'READER_PRIMARY_GID_NOT_UID');
  return {host,window};
}
test('CONTRACT_JOINT_PREPARED_HOST', t => joint(t));
test('CONTRACT_PRE_FIX_EVIDENCE_UNSATISFIABLE', async t => {
  const old = await load(t, 'provision-shu71-prerequisites.mjs', historical('provision-shu71-prerequisites.mjs'));
  const {host,window} = prepared(t, old.provisioner);
  assert.equal(row(old.provisioner(revision,host.boundary).precondition()).ok,false,'PRE_FIX_ROOT_ACCEPTED_BY_PRODUCTION_REFUSED_BY_GATE');
  host.owners.set(root,[999,982]);
  assert.equal(row(old.provisioner(revision,host.boundary).precondition()).ok,true,'PRE_FIX_SERVICE_ACCEPTED_BY_GATE');
  const prod = await load(t,'shu71-production.mjs',historical('shu71-production.mjs'));
  await assert.rejects(prod.createShu71Production(window.id,window.boundary).execute('run'),{code:'ACT_FILE_CUSTODY'},'PRE_FIX_SAME_INODE_REFUSED_BY_PRODUCTION');
});
for (const [name, mutate] of [
  ['SERVICE_OWNER', h=>h.owners.set(root,[999,982])], ['GID',h=>h.owners.set(root,[0,982])],
  ['MODE',h=>fs.chmodSync(h.root+root,0o750)],
  ['SYMLINK',h=>{h.remove(root);fs.symlinkSync('workspaces',h.root+root);}],
  ['ANCESTOR',h=>h.owners.set('/srv/shu',[999,982])],
]) test('CONTRACT_EVIDENCE_REFUSE_'+name,t=>{const h=prepared(t);mutate(h.host);assert.equal(row(h.gate()).ok,false,'EVIDENCE_REFUSE_'+name);});
async function reader(t, production) {
  const {window} = prepared(t);
  const result = await production(window.id,window.boundary).execute('run');
  assert.equal(result.state,'ARMED','READER_WINDOW_ARMED');
  assert.equal(allowed(window,activation,999,[982,980],4),true,'READER_READABLE');
  window.owners.set(activation,[0,999]);
  assert.equal(allowed(window,activation,999,[982,980],4),false,'READER_JOURNAL_GROUP_REFUSED');
}
test('CONTRACT_READER_UID_NE_GID',t=>reader(t,createShu71Production));
// PRE-FIX controls below execute a HISTORICAL revision, which compares the
// prior state by JSON.stringify and cannot consume a canonically sealed
// approval at all. Only those controls pin the construction order; every
// current-module control keeps the real target-host shape.
test('CONTRACT_PRE_FIX_ACTIVATION_UNREADABLE',async t=>{
  const {host,window}=prepared(t,provisioner,{approvalBytes:'construction'}); host.owners.set('/srv/shu/state',[0,0]); fs.chmodSync(host.root+'/srv/shu/state',0o755);
  const old=await load(t,'shu71-production.mjs',historical('shu71-production.mjs'));
  assert.equal((await old.createShu71Production(window.id,window.boundary).execute('run')).state,'ARMED','PRE_FIX_WRITES_ACTIVATION');
  assert.deepEqual(window.owners.get(activation),[0,999],'PRE_FIX_BINDS_SYSTEMD_JOURNAL');
  assert.equal(allowed(window,activation,999,[982,980],4),false,'PRE_FIX_READER_CANNOT_READ');
  assert.ok(window.events.some(e=>e.includes('--reuid=999 --regid=999 --clear-groups')),'PRE_FIX_GIT_DROPS_SHARED_GROUP');
});
async function gitControl(t, production) {
  const {host,window}=prepared(t); const run=window.boundary.run; let operations=0;
  host.directory('/srv/shu/worktrees/shared',0o2770,995,980);
  // Execute real Git only after the identity interpreter authorizes the path.
  const repo=host.root+'/srv/shu/worktrees/shared';
  assert.equal(spawnSync('/usr/bin/git',['init','--bare',repo]).status,0,'GIT_FIXTURE_INIT');
  window.boundary.run=(exe,args,opts)=>{
    if(exe==='/usr/bin/setpriv'&&args.includes('/usr/bin/git')) {
      const uid=args[0]==='--reuid=shu-coordinator'?999:Number(args[0].split('=')[1]);
      const gid=args[1]==='--regid=shu-coordinator'?982:Number(args[1].split('=')[1]);
      const gids=args.includes('--init-groups')?[gid,980]:[gid];
      if(!allowed(window,'/srv/shu/worktrees/shared',uid,gids,7)) return {status:1,stdout:''};
      assert.equal(spawnSync('/usr/bin/git',['--git-dir='+repo,'hash-object','-w','--stdin'],{input:'shared operation'}).status,0,'GIT_REAL_SHARED_OPERATION'); operations++;
    }
    return run(exe,args,opts);
  };
  assert.equal((await production(window.id,window.boundary).execute('run')).state,'ARMED','GIT_SHARED_GROUP_ARMED');
  assert.ok(operations>0,'GIT_SHARED_OPERATION_REACHED');
  assert.equal(allowed(window,'/srv/shu/worktrees/shared',999,[999],7),false,'GIT_OLD_GROUPS_REFUSED');
}
test('CONTRACT_GIT_SHARED_GROUP_OPERATION',t=>gitControl(t,createShu71Production));
const mutations = [
  ['EVIDENCE_SERVICE_OWNER','provision-shu71-prerequisites.mjs', s=>s.replace("state && current !== '/srv/shu/state/shu71-evidence'",'state').replace("p === '/srv/shu/state/shu71-evidence' ? { uid: 0, gid: 0 } : serviceIdentity()",'serviceIdentity()'),(t,m)=>joint(t,m.provisioner)],
  ['ACTIVATION_UID_AS_GID','shu71-production.mjs',s=>s.replaceAll('coordinatorIdentity().gid, 0o640','999, 0o640'),(t,m)=>reader(t,m.createShu71Production)],
  ['GIT_OLD_IDENTITY','shu71-production.mjs',s=>s.replace("'--reuid=shu-coordinator', '--regid=shu-coordinator', '--init-groups', '/usr/bin/git'","'--reuid=999', '--regid=999', '--clear-groups', '/usr/bin/git'"),(t,m)=>gitControl(t,m.createShu71Production)],
  ['GIT_CLEAR_GROUPS','shu71-production.mjs',s=>s.replace("'--init-groups', '/usr/bin/git'","'--clear-groups', '/usr/bin/git'"),(t,m)=>gitControl(t,m.createShu71Production)],
  ['STATE_ROOT_ONLY','shu71-production.mjs',s=>s.replace("parent === '/srv/shu/state' ? coordinatorIdentity() : { uid: 0, gid: 0 }",'{ uid: 0, gid: 0 }'),(t,m)=>joint(t,provisioner,m.createShu71Production)],
];
for(const [name,n,mutate,control] of mutations) test('CONTRACT_KILL_'+name,async t=>{
  const text=mutate(sources[n]);assert.notEqual(text,sources[n],'CONTRACT_MUTATION_APPLIED_'+name);
  const mutant=await load(t,n,text);
  await assert.rejects(control(t,mutant),e=>e.code==='ERR_ASSERTION','CONTRACT_NAMED_KILL_'+name);
});
test('CONTRACT_DISTINCT_ACCOUNT_DATABASE',t=>{
  const h=fixture(t);assert.equal(h.users().find(u=>u.name==='shu-coordinator').uid,999,'UID_999');
  assert.equal(h.users().find(u=>u.name==='shu-coordinator').gid,982,'PRIMARY_GID_982');
  assert.equal(h.groups().find(g=>g.gid===999).name,'systemd-journal','GID_999_OTHER_NAMED_GROUP');
});

async function predicate(t, gate = provisioner, production = createShu71Production) {
  for (const [uid,gid,mode,accept] of [[0,0,0o700,true],[999,982,0o700,false],[0,982,0o700,false],[0,0,0o750,false],[0,0,0o1700,false]]) {
    const h=prepared(t,gate); h.host.directory(root,mode,uid,gid);
    assert.equal(row(h.gate()).ok,accept,'EXACT_GATE_PREDICATE_'+[uid,gid,mode]);
    let result; try { result=await production(h.window.id,h.window.boundary).execute('run'); } catch(e) { result={state:'HALT',code:e.code}; }
    assert.equal(result.state==='ARMED',accept,'EXACT_PRODUCTION_PREDICATE_'+[uid,gid,mode]);
  }
}
test('CONTRACT_EXACT_GATE_AND_PRODUCTION_PREDICATE',t=>predicate(t));
for(const [name,n,mutate] of [
  ['GATE_GID','provision-shu71-prerequisites.mjs',s=>s.replaceAll('s.gid === owner.gid','true').replaceAll('s.gid === gid','true')],
  ['GATE_MODE','provision-shu71-prerequisites.mjs',s=>s.replaceAll('(s.mode & 0o7777) === 0o700','true')],
  ['PRODUCTION_GID','shu71-production.mjs',s=>s.replace('s.uid === 0 && s.gid === 0 && (s.mode & 0o7777) === 0o700','s.uid === 0 && (s.mode & 0o7777) === 0o700')],
  ['PRODUCTION_MODE','shu71-production.mjs',s=>s.replace('s.uid === 0 && s.gid === 0 && (s.mode & 0o7777) === 0o700','s.uid === 0 && s.gid === 0')],
]) test('CONTRACT_KILL_EXACT_'+name,async t=>{
  const text=mutate(sources[n]);assert.notEqual(text,sources[n]); const m=await load(t,n,text);
  await assert.rejects(predicate(t,m.provisioner??provisioner,m.createShu71Production??createShu71Production),e=>e.code==='ERR_ASSERTION'&&e.message.includes('EXACT_'),'EXACT_NAMED_KILL_'+name);
});
async function readback(t,production) {
  const h=prepared(t); h.window.faults.after=event=>{if(event==='rename:'+activation) h.host.owners.set(activation,[0,999]);};
  const r=await production(h.window.id,h.window.boundary).execute('run');
  assert.equal(r.code,'ACT_ACTIVATION_READBACK_CUSTODY','READER_WRONG_GID_PHASE_READBACK');
  assert.ok(!h.window.events.some(e=>e.includes('restart shu-supervisor.service')),'READER_REFUSAL_BEFORE_RESTART');
}
test('CONTRACT_READBACK_REFUSES_SYSTEMD_JOURNAL',t=>readback(t,createShu71Production));
test('CONTRACT_KILL_READBACK_UID_AS_GID',async t=>{
  const s=sources['shu71-production.mjs'].replace("JSON.stringify(pkg.activation), coordinatorIdentity().gid, 0o640, 'ACTIVATION'","JSON.stringify(pkg.activation), 999, 0o640, 'ACTIVATION'");
  const m=await load(t,'shu71-production.mjs',s);
  await assert.rejects(readback(t,m.createShu71Production),e=>e.code==='ERR_ASSERTION'&&e.message.includes('READER_WRONG_GID_PHASE_READBACK'),'READBACK_NAMED_KILL');
});
async function serviceRootRefusal(t, gate) {
  const h=prepared(t,gate); h.host.owners.set(root,[999,982]);
  assert.equal(row(h.gate()).ok,false,'EVIDENCE_SERVICE_OWNER_REFUSED');
}
test('CONTRACT_KILL_SERVICE_ROOT_ACCEPTANCE',async t=>{
  await serviceRootRefusal(t,provisioner);
  const s=sources['provision-shu71-prerequisites.mjs'].replace("state && current !== '/srv/shu/state/shu71-evidence'",'state').replace("p === '/srv/shu/state/shu71-evidence' ? { uid: 0, gid: 0 } : serviceIdentity()",'serviceIdentity()');
  const m=await load(t,'provision-shu71-prerequisites.mjs',s);
  await assert.rejects(serviceRootRefusal(t,m.provisioner),e=>e.code==='ERR_ASSERTION'&&e.message.includes('EVIDENCE_SERVICE_OWNER_REFUSED'),'EVIDENCE_NAMED_SERVICE_ROOT_KILL');
});
async function readerProbe(t, production) {
  const h=prepared(t),run=h.window.boundary.run;
  h.window.boundary.run=(exe,args,opts)=>exe==='/usr/bin/setpriv'&&args.includes('/usr/bin/node')&&args.at(-1).includes(activation)?{status:1,stdout:''}:run(exe,args,opts);
  const r=await production(h.window.id,h.window.boundary).execute('run');
  assert.equal(r.code,'ACT_ACTIVATION_READBACK_READ','READER_IDENTITY_ACCESS_REQUIRED');
  assert.ok(!h.window.journal().some(e=>e.step==='gate-install'),'READER_PROBE_BEFORE_DISPATCH');
}
test('CONTRACT_READER_PROBE_REFUSAL',t=>readerProbe(t,createShu71Production));
test('CONTRACT_KILL_READER_PROBE_OMISSION',async t=>{
  const s=sources['shu71-production.mjs'].replace(/      if \(kind === 'ACTIVATION'\) command\('\/usr\/bin\/setpriv',[\s\S]*?fs.constants.R_OK\);`\]\);\n/,'');
  assert.notEqual(s,sources['shu71-production.mjs'],'READER_PROBE_MUTATION_APPLIED');
  const m=await load(t,'shu71-production.mjs',s);
  await assert.rejects(readerProbe(t,m.createShu71Production),e=>e.code==='ERR_ASSERTION'&&e.message.includes('READER_IDENTITY_ACCESS_REQUIRED'),'READER_PROBE_NAMED_KILL');
});
test('CONTRACT_HISTORICAL_BYTES_PINNED',()=>{
  for (const [file,hash] of [['shu71-production.mjs','51af5a2ada47786fd0762b21533ebf50873e4bf5fa24382c364673048a1fd4f3'],['provision-shu71-prerequisites.mjs','111f640fad6818d089eb922676bdc6135cf4ad4e1a1beeaa00ee663838da5518']])
    assert.equal(createHash('sha256').update(historical(file)).digest('hex'),hash,'CONTRACT_PRE_FIX_IMMUTABLE_'+file);
});
async function checkoutGroups(t, gate) {
  const h=prepared(t,gate);
  h.host.directory(PATHS.checkout + '/group-only',0o750,995,980);
  assert.equal(h.gate().ok,true,'GATE_CHECKOUT_SUPPLEMENTARY_GROUP');
}
test('CONTRACT_GATE_CHECKOUT_GROUPS',t=>checkoutGroups(t,provisioner));
test('CONTRACT_KILL_GATE_CLEAR_GROUPS',async t=>{
  const s=sources['provision-shu71-prerequisites.mjs'].replace("'--init-groups', '/usr/bin/node'","'--clear-groups', '/usr/bin/node'");
  const m=await load(t,'provision-shu71-prerequisites.mjs',s);
  await assert.rejects(checkoutGroups(t,m.provisioner),e=>e.code==='ERR_ASSERTION'&&e.message.includes('GATE_CHECKOUT_SUPPLEMENTARY_GROUP'),'GATE_GROUPS_NAMED_KILL');
});

test('CONTRACT_KILL_JOURNAL_ROOT_ONLY_ANCESTRY',async t=>{
  const source=fs.readFileSync(new URL('shu71-journal.mjs',base),'utf8');
  const m=await load(t,'shu71-journal.mjs',source.replace("current === '/srv/shu/state' && coordinator",'false'));
  const production=await load(t,'shu71-production.mjs',sources['shu71-production.mjs'].replace("'./shu71-journal.mjs'",JSON.stringify(m.sourceUrl)));
  await assert.rejects(joint(t,provisioner,production.createShu71Production),e=>e.code==='ERR_ASSERTION'&&e.message.includes('JOINT_SAME_PATHS_PRODUCTION_ARMED'),'JOURNAL_ANCESTRY_NAMED_KILL');
});
