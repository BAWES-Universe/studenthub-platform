import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import * as implementation from '../provision-shu71-prerequisites.mjs';
import { installedModule } from '../shu71-production.mjs';
import { fixture, revision } from './provision-prerequisites-fixture.mjs';
const { provisioner, PATHS, BROKER } = implementation;
const row = (p, name) => p.precondition().paths.find(r => r.path === name);
const sourceURL = new URL('../provision-shu71-prerequisites.mjs', import.meta.url);
const source = fs.readFileSync(sourceURL, 'utf8');
const docURL = new URL('../SHU71-PREREQUISITES.md', import.meta.url);

test('SHU71 review worktrees production shape', t => {
  const h = fixture(t); h.directory('/srv/shu/worktrees', 0o3770, 999, 980);
  const p = provisioner(revision, h.boundary);
  assert.equal(row(p, '/srv/shu/worktrees').ok, true, 'SHU71_WORKTREES_REAL_SHAPE');
  h.directory('/srv/shu/worktrees', 0o770, 999, 980);
  assert.equal(row(p, '/srv/shu/worktrees').ok, false, 'SHU71_WORKTREES_MODE');
});
test('SHU71 review checkout capability', t => {
  const h = fixture(t); h.directory(PATHS.checkout, 0o755, 999, 980);
  const p = provisioner(revision, h.boundary);
  assert.equal(row(p, PATHS.checkout).ok, true, 'SHU71_CHECKOUT_GROUP_INDEPENDENT');
  h.write(PATHS.checkout + '/unreadable', 'secret', 0o600, 0, 0);
  assert.equal(row(p, PATHS.checkout).ok, false, 'SHU71_CHECKOUT_READABILITY');
});
test('SHU71 review named absent row codes', t => {
  const h = fixture(t), p = provisioner(revision, h.boundary);
  h.remove('/etc/shu/keys/shu71-activation-ed25519.pem'); h.remove('/srv/shu/worktrees');
  for (const [name, code] of [['/etc/shu/keys/shu71-activation-ed25519.pem', 'ACT_PREREQUISITE_PATH_MISSING'], ['/srv/shu/worktrees', 'ACT_PREREQUISITE_CUSTODY'], ['identity:' + BROKER, 'ACT_BROKER_IDENTITY_MISSING']]) {
    assert.equal(row(p, name).code, code, 'SHU71_ABSENT_ROW_CODE');
  }
  assert.ok(p.precondition().paths.filter(r => !r.ok).every(r => /^(ACT_|SHU251_)/.test(r.code)), 'SHU71_ALL_ROWS_NAMED');
});
function unfinished(h) { h.write(PATHS.receipt, JSON.stringify({version:1, revision, state:'INSTALLING', effects:[]}), 0o600); }
test('SHU71 review rollback only install result', t => {
  const h = fixture(t); unfinished(h);
  const r = provisioner(revision, h.boundary).install();
  assert.equal(r.ok, false, 'SHU71_INSTALL_RECOVERY_NOT_SUCCESS');
  assert.equal(r.state, 'ROLLED_BACK', 'SHU71_INSTALL_RECOVERY_STATE');
  assert.equal(r.code, 'ACT_PREREQUISITE_INSTALL_RECOVERED', 'SHU71_INSTALL_RECOVERY_CODE');
  assert.equal(provisioner(revision, h.boundary).install().state, 'VERIFIED', 'SHU71_INSTALL_RECOVERY_RERUN');
});
test('SHU71 review literal effect paths', () => {
  assert.equal(PATHS.sudoers, '/etc/sudoers.d/shu-reviewer', 'SHU71_LITERAL_SUDOERS');
  assert.equal(PATHS.wrapper, '/usr/local/libexec/shu-reviewer-sandbox', 'SHU71_LITERAL_WRAPPER');
  assert.equal(PATHS.tree, '/usr/local/lib/shu71/coordinator', 'SHU71_LITERAL_TREE');
  assert.equal(PATHS.tree + '/service/shu71-production.mjs', installedModule, 'SHU71_INSTALLED_MODULE');
});
test('SHU71 review non test effect selection', t => {
  const h = fixture(t), p = provisioner(revision, h.boundary); p.install();
  assert.equal(fs.existsSync(h.root + PATHS.tree + '/test/excluded.test.mjs'), false, 'SHU71_EXCLUDE_TEST_FILES');
  h.write(PATHS.tree + '/test/excluded.test.mjs', 'not production');
  assert.throws(() => p.verify(), {code:'ACT_TREE_EXTRA'}, 'SHU71_EXCLUDED_FILE_IS_EXTRA');
});
test('SHU71 review path neutral commands', () => {
  assert.doesNotMatch(fs.readFileSync(docURL, 'utf8'), /\/home\/bawes\/work\/prov\//, 'SHU71_PATH_NEUTRAL_COMMANDS');
});

function allocation(t, mod, variant, label) {
  const h = fixture(t);
  if (variant === 'occupied') {
    h.users().push({name:'occupied', uid:100, gid:101, home:'/', shell:'/bin/false'}, {name:'occupied2', uid:101, gid:101, home:'/', shell:'/bin/false'});
    h.groups().push({name:'occupied', gid:100, members:''});
  } else h.write('/etc/login.defs', 'SYS_UID_MIN 996\nSYS_UID_MAX 999\nSYS_GID_MIN 996\nSYS_GID_MAX 999\n');
  if (variant === 'free996') h.users().find(u => u.name === 'messagebus').uid = 995;
  let r;
  assert.doesNotThrow(() => { r = mod.provisioner(revision, h.boundary).install(); }, label);
  const expected = variant === 'occupied' ? 102 : 997;
  assert.deepEqual(r.broker, {name:BROKER, uid:expected, gid:expected}, label);
  const receipt = JSON.parse(h.f.readFileSync(PATHS.receipt, 'utf8'));
  assert.deepEqual(receipt.broker, r.broker, label);
  const unit = h.f.readFileSync(PATHS.unit, 'utf8');
  assert.ok(unit.includes(`\nUser=${receipt.broker.name}\nGroup=shu-workspace\n`), label);
  assert.deepEqual(mod.provisioner(revision, h.boundary).identity(), receipt.broker, label);
}
function recoveryCli(t, mod, label) {
  const h = fixture(t); unfinished(h); const output = [];
  const b = {...h.boundary, run(exe, args) {
    assert.equal(exe, '/usr/bin/flock', label);
    const processDouble = {exitCode:0};
    vm.runInNewContext(args.at(-1).replace(/^import .*?; /, ''), {
      provisioner: rev => mod.provisioner(rev, h.boundary), console:{log:s => output.push(JSON.parse(s))}, process:processDouble,
    });
    return {status:processDouble.exitCode};
  }};
  assert.equal(mod.runCli(['install', revision], b, r => output.push(r)), 2, label);
  assert.equal(output.length, 1, label); assert.equal(output[0].ok, false, label);
  assert.equal(mod.runCli(['install', revision], b, r => output.push(r)), 0, label);
  assert.equal(output.at(-1).state, 'VERIFIED', label);
}
test('SHU71 review recovery CLI status', t => recoveryCli(t, implementation, 'SHU71_INSTALL_RECOVERY_EXIT'));
test('SHU71 review measured service identity', t => {
  const h = fixture(t);
  h.users().find(u => u.name === 'shu-coordinator').uid = 1201;
  h.users().find(u => u.name === 'shu-coordinator').gid = 1202;
  h.groups().find(g => g.name === 'shu-coordinator').gid = 1202;
  for (const p of [PATHS.checkout, '/srv/shu/coordinator.env', '/srv/shu/state/workspaces', '/srv/shu/state/workspaces/supervisor']) h.owners.set(p, [1201,1202]);
  const run = h.boundary.run;
  h.boundary.run = (exe, args, opts) => {
    if (exe === '/usr/bin/setpriv') assert.deepEqual(args.slice(0,3), ['--reuid=1201','--regid=1202','--clear-groups'], 'SHU71_SERVICE_NAME_RESOLUTION');
    return run(exe,args,opts);
  };
  const p = provisioner(revision, h.boundary); p.install();
  assert.equal(p.precondition().ok, true, 'SHU71_SERVICE_NAME_RESOLUTION');
  h.groups().splice(h.groups().findIndex(g => g.name === 'shu-coordinator'),1);
  assert.equal(row(p, PATHS.checkout).code, 'ACT_SERVICE_IDENTITY_MISSING', 'SHU71_SERVICE_GROUP_REQUIRED');
});
test('SHU71 review checkout rejects symlink and wrong owner', t => {
  const h = fixture(t), p = provisioner(revision, h.boundary);
  fs.symlinkSync('/does-not-exist', h.root + PATHS.checkout + '/link');
  assert.equal(row(p, PATHS.checkout).code, 'ACT_PREREQUISITE_CHECKOUT_ACCESS', 'SHU71_CHECKOUT_NO_SYMLINK');
  h.remove(PATHS.checkout + '/link'); h.owners.set(PATHS.checkout, [123,980]);
  assert.equal(row(p, PATHS.checkout).code, 'ACT_PREREQUISITE_CHECKOUT', 'SHU71_CHECKOUT_SERVICE_OWNER');
});
const mutants = [
  ['worktrees group', 'SHU71_WORKTREES_REAL_SHAPE', '(s.mode & 0o7777) === 0o3770', '(s.mode & 0o7777) === 0o3770 && s.gid === serviceIdentity().gid', (t,m,l) => {
    const h=fixture(t); assert.equal(row(m.provisioner(revision,h.boundary), '/srv/shu/worktrees').ok,true,l);
  }],
  ['worktrees mode', 'SHU71_WORKTREES_MODE', '(s.mode & 0o7777) === 0o3770', 'true', (t,m,l) => {
    const h=fixture(t); h.directory('/srv/shu/worktrees',0o770,999,980); assert.equal(row(m.provisioner(revision,h.boundary),'/srv/shu/worktrees').ok,false,l);
  }],
  ['checkout group', 'SHU71_CHECKOUT_GROUP_INDEPENDENT', 's.uid === uid,', 's.uid === uid && s.gid === gid,', (t,m,l) => {
    const h=fixture(t); h.owners.set(PATHS.checkout,[999,980]); assert.equal(row(m.provisioner(revision,h.boundary),PATHS.checkout).ok,true,l);
  }],
  ['checkout access', 'SHU71_CHECKOUT_READABILITY', "need(!r.error && r.status === 0, 'ACT_PREREQUISITE_CHECKOUT_ACCESS');", '', (t,m,l) => {
    const h=fixture(t); h.write(PATHS.checkout+'/secret','secret',0o600); assert.equal(row(m.provisioner(revision,h.boundary),PATHS.checkout).ok,false,l);
  }],
  ['service group name', 'SHU71_SERVICE_GROUP_REQUIRED', "groups.filter(g => g.name === 'shu-coordinator')", "groups.filter(g => g.name === 'shu-workspace')", (t,m,l) => {
    const h=fixture(t); assert.equal(row(m.provisioner(revision,h.boundary),PATHS.checkout).ok,true,l);
  }],
  ['allocator occupied', 'SHU71_ALLOCATOR_OCCUPIED', 'n !== 996 && !used.has(n)', 'n !== 996', (t,m,l) => allocation(t,m,'occupied',l)],
  ['allocator free 996', 'SHU71_ALLOCATOR_FREE_996', 'n !== 996 && !used.has(n)', '!used.has(n)', (t,m,l) => allocation(t,m,'free996',l)],
  ['pre useradd collision', 'SHU71_PRE_USERADD_COLLISION', "need(!users.some(u => u.uid === allocated.uid || u.name === BROKER), 'ACT_BROKER_UID_COLLISION');", '', (t,m,l) => {
    const h=fixture(t), run=h.boundary.run; let injected=false;
    h.boundary.run=(exe,args,opts) => {
      const r=run(exe,args,opts);
      if (!injected && exe === '/usr/bin/getent' && args[0] === 'passwd' && fs.existsSync(h.root+PATHS.receipt) && JSON.parse(h.f.readFileSync(PATHS.receipt)).effects.some(e=>e.kind==='identity')) {
        injected=true; return {...r,stdout:r.stdout+'\nracer:x:100:500::/nonexistent:/usr/sbin/nologin'};
      }
      return r;
    };
    assert.throws(()=>m.provisioner(revision,h.boundary).install(),{code:'ACT_BROKER_UID_COLLISION'},l);
    assert.ok(!h.events.some(e=>e==='command:/usr/sbin/groupadd'),l);
  }],
  ['messagebus prohibition', 'SHU71_MESSAGEBUS_PROHIBITION', "need(!u || u.uid !== 996 && u.name !== 'messagebus', 'ACT_BROKER_MESSAGEBUS');", '', (t,m,l) => {
    const h=fixture(t); provisioner(revision,h.boundary).install(); h.users().find(u=>u.name==='messagebus').uid=995; h.users().find(u=>u.name===BROKER).uid=996;
    assert.throws(()=>m.provisioner(revision,h.boundary).identity(),{code:'ACT_BROKER_MESSAGEBUS'},l);
  }],
  ...[['sudoers','/etc/sudoers.d/shu-reviewer'],['wrapper','/usr/local/libexec/shu-reviewer-sandbox'],['tree','/usr/local/lib/shu71/coordinator']].map(([key,value]) =>
    ['literal '+key,'SHU71_LITERAL_'+key.toUpperCase(), `${key}: '${value}'`,`${key}: '${value}-typo'`,(t,m,l)=>assert.equal(m.PATHS[key],value,l)]),
  ['test exclusion', 'SHU71_EXCLUDE_TEST_FILES', "if (m[3].slice(PREFIX.length).split('/').includes('test')) return null;", '', (t,m,l) => {
    const h=fixture(t); m.provisioner(revision,h.boundary).install(); assert.equal(fs.existsSync(h.root+PATHS.tree+'/test/excluded.test.mjs'),false,l);
  }],
  ['raw errno', 'SHU71_ABSENT_ROW_CODE', "e.code === 'ENOENT' ? 'ACT_PREREQUISITE_PATH_MISSING'", "e.code === 'ENOENT' ? e.code", (t,m,l) => {
    const h=fixture(t); h.remove('/etc/shu/keys/shu71-activation-ed25519.pem'); assert.equal(row(m.provisioner(revision,h.boundary),'/etc/shu/keys/shu71-activation-ed25519.pem').code,'ACT_PREREQUISITE_PATH_MISSING',l);
  }],
  ['rollback success', 'SHU71_INSTALL_RECOVERY_NOT_SUCCESS', "...rollback(old), ok: false", "...rollback(old), ok: true", (t,m,l) => {
    const h=fixture(t); unfinished(h); assert.equal(m.provisioner(revision,h.boundary).install().ok,false,l);
  }],
  ['rollback exit', 'SHU71_INSTALL_RECOVERY_EXIT', 'if(r.ok === false) process.exitCode = 2;', 'if(r.ok === false) process.exitCode = 0;', recoveryCli],
];
for (const [name,label,from,to,check] of mutants) test(`SHU71 review named mutation killed: ${name}`, async t => {
  check(t,implementation,label);
  assert.ok(source.includes(from),'SHU71_REVIEW_MUTATION_SOURCE');
  let text=source.replace(from,to);
  for (const dep of ['host-suite-contract','shu71-production']) text=text.replace(`'./${dep}.mjs'`,JSON.stringify(new URL('../'+dep+'.mjs',import.meta.url).href));
  const m=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
  assert.throws(()=>check(t,m,label),e=>e.code==='ERR_ASSERTION' && e.message.includes(label),label+': mutant must die by name');
});
test('SHU71 review path neutral mutation killed', () => {
  const text=fs.readFileSync(docURL,'utf8'), check=s=>assert.doesNotMatch(s,/\/home\/bawes\/work\/prov\//,'SHU71_PATH_NEUTRAL_COMMANDS');
  check(text); assert.ok(text.includes('--import=$PWD/'),'SHU71_PATH_NEUTRAL_SOURCE');
  assert.throws(()=>check(text.replace('--import=$PWD/','--import=/home/bawes/work/prov/')),e=>e.code==='ERR_ASSERTION' && e.message.includes('SHU71_PATH_NEUTRAL_COMMANDS'),'SHU71_PATH_NEUTRAL_COMMANDS');
});

test('SHU71 review recovery process exit status', () => {
  const script = `import vm from 'node:vm';
    import { fixture, revision } from ${JSON.stringify(new URL('./provision-prerequisites-fixture.mjs', import.meta.url).href)};
    import { runCli, provisioner, PATHS } from ${JSON.stringify(sourceURL.href)};
    const cleanup=[]; const h=fixture({after:fn=>cleanup.push(fn)});
    h.write(PATHS.receipt,JSON.stringify({version:1,revision,state:'INSTALLING',effects:[]}),0o600);
    const b={...h.boundary,run(exe,args){const child={exitCode:0};
      vm.runInNewContext(args.at(-1).replace(/^import .*?; /,''),{provisioner:rev=>provisioner(rev,h.boundary),console,process:child});
      return {status:child.exitCode}; }};
    try { process.exitCode=runCli(['install',revision],b); } finally {cleanup.forEach(fn=>fn());}`;
  const r=spawnSync(process.execPath,['--input-type=module'],{input:script,encoding:'utf8'});
  assert.equal(r.status,2,'SHU71_INSTALL_RECOVERY_PROCESS_EXIT');
  assert.equal(JSON.parse(r.stdout).ok,false,'SHU71_INSTALL_RECOVERY_PROCESS_RESULT');
});
