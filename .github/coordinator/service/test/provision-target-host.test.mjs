import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import * as shipped from '../provision-shu71-prerequisites.mjs';
import { revision } from './provision-prerequisites-fixture.mjs';
import { targetFixture, refusal, procNoise } from './provision-target-host-fixture.mjs';
const sourceURL = new URL('../provision-shu71-prerequisites.mjs',import.meta.url);
const source = fs.readFileSync(sourceURL,'utf8');
const attempt = fn => { try { return fn(); } catch(e) { return e; } };
const controls = {
  ARGV(t,m) {
    const h=targetFixture(t); attempt(()=>m.provisioner(revision,h.boundary).install());
    const args=h.argv.find(([exe,a])=>exe==='/usr/sbin/useradd' && a[0]!=='-D')?.[1];
    assert.ok(args && !args.includes('-K'),'TARGET_ARGV');
  },
  PROPERTIES(t,m) {
    const h=targetFixture(t), p=m.provisioner(revision,h.boundary), r=attempt(()=>p.install());
    assert.equal(r.state,'VERIFIED','TARGET_PROPERTIES');
    const args=h.argv.find(([exe,a])=>exe==='/usr/sbin/useradd' && a[0]!=='-D')[1];
    assert.deepEqual(args,['--system','--no-create-home','--no-log-init','--uid',String(r.broker.uid),'--gid',String(r.broker.gid),'--home-dir','/nonexistent','--shell','/usr/sbin/nologin',shipped.BROKER],'TARGET_PROPERTIES');
    assert.deepEqual(h.broker(),{name:shipped.BROKER,uid:r.broker.uid,gid:r.broker.gid,home:'/nonexistent',shell:'/usr/sbin/nologin'},'TARGET_PROPERTIES');
    assert.equal(h.groups().find(g=>g.name===shipped.BROKER).members,'','TARGET_PROPERTIES');
    assert.equal(r.broker.uid,100,'TARGET_PROPERTIES');
  },
  MAIL_DEFAULT(t,m) {
    for(const value of ['yes','']) {
      const h=targetFixture(t); h.faults.mailDefault=value;
      assert.equal(attempt(()=>m.provisioner(revision,h.boundary).install()).code,'ACT_PREREQUISITE_MAIL_SPOOL_DEFAULT','TARGET_MAIL_DEFAULT');
      assert.ok(!h.broker(),'TARGET_MAIL_DEFAULT');
    }
  },
  CONFIGURATION(t,m) {
    const h=targetFixture(t),run=h.boundary.run;
    h.boundary.run=(exe,args,opts)=>{ if(exe==='/usr/sbin/useradd'&&args[0]!=='-D') args.push('-K','CREATE_MAIL_SPOOL=no'); return run(exe,args,opts); };
    // Exercise command error classification with the measured rc/stderr.
    const r=attempt(()=>m.provisioner(revision,h.boundary).install());
    assert.equal(r.code,'ACT_PREREQUISITE_USERADD_CONFIGURATION','TARGET_CONFIGURATION');
    assert.equal(r.stderr,refusal,'TARGET_CONFIGURATION');
    assert.equal(r.argument,'-K CREATE_MAIL_SPOOL=no','TARGET_CONFIGURATION');
    assert.deepEqual(r.rollback,{ok:true,state:'ROLLED_BACK'},'TARGET_CONFIGURATION');
  },
  FILE(t,m) {
    for(const kind of ['uid','gid']) {
      const h=targetFixture(t),p=m.provisioner(revision,h.boundary); p.install();
      h.write('/srv/unrelated/deep/held','held',0o600,kind==='uid'?h.broker().uid:0,kind==='gid'?h.broker().gid:0);
      assert.equal(attempt(()=>p.rollback()).code,'ACT_ROLLBACK_IDENTITY_IN_USE','TARGET_FILE');
      assert.ok(h.broker() && h.f.lstatSync(shipped.PATHS.receipt),'TARGET_FILE');
    }
  },
  PROCESS(t,m) {
    for(const field of ['Uid','Gid','Groups']) {
      const h=targetFixture(t),p=m.provisioner(revision,h.boundary); p.install();
      h.write('/proc/123/status',`${field}:\t${field==='Uid'?h.broker().uid:h.broker().gid}\n`);
      assert.equal(attempt(()=>p.rollback()).code,'ACT_ROLLBACK_IDENTITY_IN_USE','TARGET_PROCESS');
      assert.ok(h.broker(),'TARGET_PROCESS');
    }
  },
  PROC_RACE(t,m) {
    const h=targetFixture(t),before=h.snapshot(),p=m.provisioner(revision,h.boundary); p.install();
    assert.deepEqual(h.boundary.run('/usr/bin/find',['/','-uid',String(h.broker().uid)]),{status:1,stdout:'',stderr:procNoise},'TARGET_PROC_RACE');
    assert.equal(attempt(()=>p.rollback()).state,'ROLLED_BACK','TARGET_PROC_RACE');
    assert.deepEqual(h.snapshot(),before,'TARGET_PROC_RACE');
    const args=h.argv.filter(([e])=>e==='/usr/bin/find').at(-1)[1];
    for(const p of ['/proc','/sys','/dev']) assert.ok(args.includes(p),'TARGET_PROC_RACE');
  },
  ENUMERATION(t,m) {
    const h=targetFixture(t),p=m.provisioner(revision,h.boundary); p.install(); h.faults.enumeration=true;
    assert.equal(attempt(()=>p.rollback()).code,'ACT_PREREQUISITE_COMMAND','TARGET_ENUMERATION');
    assert.ok(h.broker()&&h.f.lstatSync(shipped.PATHS.receipt),'TARGET_ENUMERATION');
  },
  RECOVERY(t,m) {
    const h=targetFixture(t); h.faults.rejectConfiguration=true; h.faults.enumeration=true;
    const r=m.prerequisiteFailure(attempt(()=>m.provisioner(revision,h.boundary).install()));
    assert.equal(r.code,'ACT_PREREQUISITE_ROLLBACK_REQUIRED','TARGET_RECOVERY');
    assert.equal(r.ok,false,'TARGET_RECOVERY');
    assert.equal(r.original?.code,'ACT_PREREQUISITE_USERADD_CONFIGURATION','TARGET_RECOVERY');
    assert.deepEqual(r.rollback,{ok:false,code:'ACT_PREREQUISITE_COMMAND'},'TARGET_RECOVERY');
    assert.equal(JSON.parse(h.f.readFileSync(shipped.PATHS.receipt)).state,'INSTALLING','TARGET_RECOVERY');
    assert.ok(h.groups().some(g=>g.name===shipped.BROKER),'TARGET_RECOVERY');
  },
  IDENTITY_CRASH(t,m) {
    const h=targetFixture(t),before=h.snapshot(); let dead=false;
    h.faults.after=name=>dead || (dead=name==='command:/usr/sbin/groupadd');
    h.faults.before=()=>dead;
    attempt(()=>m.provisioner(revision,h.boundary).install());
    h.faults.after=null; h.faults.before=null;
    assert.equal(attempt(()=>m.provisioner(revision,h.boundary).rollback()).state,'ROLLED_BACK','TARGET_IDENTITY_CRASH');
    assert.deepEqual(h.snapshot(),before,'TARGET_IDENTITY_CRASH');
  },
  CLI(t,m) {
    for(const broken of [false,true]) {
      const h=targetFixture(t); h.faults.rejectConfiguration=true; h.faults.enumeration=broken;
      const output=[],process={exitCode:0};
      const b={uid:()=>0,run(exe,args) {
        const script=args.at(-1).replace(/^import .*?; /,'');
        vm.runInNewContext(script,{provisioner:r=>m.provisioner(r,h.boundary),prerequisiteFailure:m.prerequisiteFailure,console:{log:s=>output.push(JSON.parse(s))},process});
        return {status:process.exitCode};
      }};
      const rc=attempt(()=>m.runCli(['install',revision],b,r=>output.push(r)));
      assert.equal(rc,2,'TARGET_CLI');
      assert.equal(output.length,1,'TARGET_CLI');
      assert.equal(output[0].ok,false,'TARGET_CLI');
      assert.equal(output[0].original?.code??output[0].code,'ACT_PREREQUISITE_USERADD_CONFIGURATION','TARGET_CLI');
      assert.equal(output[0].rollback?.ok,!broken,'TARGET_CLI');
    }
  },
};
for(const [name,control] of Object.entries(controls)) test('TARGET_'+name,t=>control(t,shipped));
const mutants = [
  ['ARGV','ARGV',s=>s.replace("'--no-log-init',","'--no-log-init', '-K', 'CREATE_MAIL_SPOOL=no',")],
  ...['--no-create-home','--no-log-init','--system'].map(flag=>['PROPERTY_'+flag.slice(2).replaceAll('-','_'),'PROPERTIES',s=>flag==='--system'?s.replace("command('/usr/sbin/useradd', ['--system',","command('/usr/sbin/useradd', ["):s.replace(`'${flag}', `,'')]),
  ['HOME','PROPERTIES',s=>s.replace("'--home-dir', '/nonexistent'","'--home-dir', '/wrong-home'")],
  ['SHELL','PROPERTIES',s=>s.replace("'--shell', '/usr/sbin/nologin'","'--shell', '/bin/sh'")],
  ['PRIVATE_GROUP','PROPERTIES',s=>s.replace("'--gid', String(allocated.gid), '--home-dir'","'--gid', 'wrong-group', '--home-dir'")],
  ['WRITE_AHEAD','IDENTITY_CRASH',s=>s.replace('j.effects.push(record); save(j); perform();','perform(); j.effects.push(record); save(j);')],
  ['CONFIGURATION_ARGUMENT','CONFIGURATION',s=>s.replace("argument: args.includes('-K') ? '-K ' + args[args.indexOf('-K') + 1] : null",'argument: null')],
  ['MAIL_DEFAULT','MAIL_DEFAULT',s=>s.replace("defaults.length === 1 && defaults[0] === 'CREATE_MAIL_SPOOL=no'",'true')],
  ['CONFIGURATION','CONFIGURATION',s=>s.replace("r.status === 3 && /unknown item/.test(String(r.stderr))",'false')],
  ['FILE_UID','FILE',s=>s.replace("'-uid', String(e.uid)","'-uid', String(e.uid + 1)")],
  ['FILE_GID','FILE',s=>s.replace("'-gid', String(e.gid)","'-gid', String(e.gid + 1)")],
  ['PROCESS','PROCESS',s=>s.replace("!ids.includes(e.uid) && !ids.includes(e.gid)",'true')],
  ...['proc','sys','dev'].map(p=>['PRUNE_'+p.toUpperCase(),'PROC_RACE',s=>s.replace(`'-path', '/${p}'`,`'-path', '/omitted-${p}'`)]),
  ['ENUMERATION','ENUMERATION',s=>s.replace("!r.error && r.status === 0","!r.error && (r.status === 0 || exe === '/usr/bin/find')")],
  ['ORIGINAL','RECOVERY',s=>s.replace('original: prerequisiteFailure(error)','original: undefined')],
  ['ROLLBACK_OUTCOME','RECOVERY',s=>s.replace("rollback: { ok: false, code: recovery.code", "rollback: { ok: true, code: recovery.code")],
  ['CLI','CLI',s=>s.replace('JSON.stringify(prerequisiteFailure(e))','JSON.stringify({ok:false,code:e.code})')],
];
for(const [name,control,mutate] of mutants) test('TARGET_KILL_'+name,async t=>{
  const changed=mutate(source); assert.notEqual(changed,source,'TARGET_MUTATION_APPLIED_'+name);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shu71-target-mutant-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'mutant.mjs');
  fs.writeFileSync(file,changed.replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,(_,p,q,r)=>`${p}${q}${new URL(r,sourceURL)}${q}`));
  const m=await import(pathToFileURL(file));
  assert.throws(()=>controls[control](t,m),e=>e.code==='ERR_ASSERTION'&&e.message.includes('TARGET_'+control),'TARGET_NAMED_KILL_'+name);
});
