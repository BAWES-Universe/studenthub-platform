import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { pushExactSha } from "../push-broker.mjs";
import { snapshotWorkspaceResult } from "../workspace-result.mjs";
import * as codex from "../adapters/codex-cli.mjs";
import { buildClaudeArgs } from "../adapters/claude-code.mjs";

function metadata(dir) {
  return fs.readdirSync(dir).sort().map(name=>{
    const p=path.join(dir,name);
    return [name,fs.lstatSync(p).isDirectory()?metadata(p):createHash("sha256").update(fs.readFileSync(p)).digest("hex")];
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "shu228-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
  const wt = path.join(root, "worker"), state = path.join(root, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  git(root, "init", wt); git(wt, "config", "user.name", "Fixture"); git(wt, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(wt, "file.txt"), "old\n");
  git(wt, "add", "."); git(wt, "commit", "-m", "base");
  const target_sha = git(wt, "rev-parse", "HEAD");
  const remote = path.join(root, "BAWES-Universe", "studenthub-platform.git");
  fs.mkdirSync(path.dirname(remote)); git(root, "init", "--bare", remote);
  git(wt, "push", remote, "HEAD:refs/heads/coordinator/test");
  const options = { stateDir: state, attempt_id: randomUUID(), target_sha, result_sha: null, workspaceReady: true,
    branch: "coordinator/test", repo: "BAWES-Universe/studenthub-platform", worktree: wt,
    allowedRoot: root, remoteUrl: `file://${remote}`, allowedHost: "file", gitImpl: execFile, env: process.env };
  return { root, wt, state, remote, git, options, edit: () => fs.writeFileSync(path.join(wt, "file.txt"), "new\n"),
    remoteHead: () => git(remote, "rev-parse", "refs/heads/coordinator/test"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("SHU-228: host commits raw files with one bound parent and leaves worker metadata untouched", async () => {
  const f = fixture(); try {
    f.edit(); fs.writeFileSync(path.join(f.wt,"new.txt"),"new file\n");
    const index = fs.readFileSync(path.join(f.wt,".git/index"));
    const result = await pushExactSha(f.options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(result.remote_head, f.options.target_sha);
    assert.equal(f.git(f.remote,"rev-list","--parents","-n","1",result.remote_head), `${result.remote_head} ${f.options.target_sha}`);
    assert.equal(f.git(f.remote,"show",`${result.remote_head}:file.txt`),"new");
    assert.equal(f.git(f.remote,"show",`${result.remote_head}:new.txt`),"new file");
    assert.equal(f.git(f.wt,"rev-parse","HEAD"),f.options.target_sha);
    assert.deepEqual(fs.readFileSync(path.join(f.wt,".git/index")),index);
    const again = await pushExactSha(f.options);
    assert.equal(again.stage,"ALREADY_PUSHED",JSON.stringify(again));
    assert.equal(again.remote_head,result.remote_head,"reconstruction preserves exact commit identity");
    fs.writeFileSync(path.join(f.wt,"file.txt"),"changed again\n");
    const conflict=await pushExactSha(f.options);
    assert.equal(conflict.ok,false); assert.match(conflict.reason,/binding conflict/);
    assert.equal(f.remoteHead(),result.remote_head);
  } finally { f.cleanup(); }
});

test("SHU-228: filters, hooks, worker index and URL rewrites cannot influence host snapshot or push", async () => {
  const f=fixture(); try {
    const sentinel=path.join(f.root,"executed");
    f.git(f.wt,"config","filter.evil.clean",`touch ${sentinel}`);
    f.git(f.wt,"config","core.hooksPath",path.join(f.root,"hooks"));
    fs.mkdirSync(path.join(f.root,"hooks"));
    fs.writeFileSync(path.join(f.root,"hooks/pre-commit"),`#!/bin/sh\ntouch ${sentinel}\n`,{mode:0o755});
    f.git(f.wt,"config",`url.file:///foreign/.insteadOf`,f.options.remoteUrl);
    fs.writeFileSync(path.join(f.wt,".gitattributes"),"*.txt filter=evil\n");
    // Corrupting the worker index is harmless: only the broker index is read.
    fs.writeFileSync(path.join(f.wt,".git/index"),"not an index");
    const before=metadata(path.join(f.wt,".git"));
    f.edit(); const result=await pushExactSha(f.options);
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(fs.existsSync(sentinel),false);
    assert.deepEqual(metadata(path.join(f.wt,".git")),before,"host never modifies worker metadata or stores result objects there");
    assert.equal(f.git(f.remote,"show",`${result.remote_head}:file.txt`),"new");
  } finally { f.cleanup(); }
});

for (const kind of ["empty","symlink","directory symlink","alternate","hardlink","submodule","private state","raced","wrong head"]) {
  test(`SHU-228: refuses ${kind} without changing remote`, async () => {
    const f=fixture(); try {
      if(kind!=="empty")f.edit();
      if(kind==="symlink"){ fs.unlinkSync(path.join(f.wt,"file.txt")); fs.symlinkSync("/etc/passwd",path.join(f.wt,"file.txt")); }
      if(kind==="directory symlink"){
        fs.mkdirSync(path.join(f.wt,"sub"));fs.writeFileSync(path.join(f.wt,"sub/file.txt"),"base");
        f.git(f.wt,"add","sub");f.git(f.wt,"commit","-m","sub"); f.options.target_sha=f.git(f.wt,"rev-parse","HEAD");
        fs.rmSync(path.join(f.wt,"sub"),{recursive:true});fs.symlinkSync(f.root,path.join(f.wt,"sub"));
      }
      if(kind==="alternate") fs.writeFileSync(path.join(f.wt,".git/objects/info/alternates"),"/tmp/foreign\n");
      if(kind==="hardlink") fs.linkSync(path.join(f.wt,"file.txt"),path.join(f.root,"alias"));
      if(kind==="submodule"){
        f.git(f.wt,"update-index","--add","--cacheinfo","160000",f.options.target_sha,"sub"); f.git(f.wt,"commit","-m","submodule");
        f.options.target_sha=f.git(f.wt,"rev-parse","HEAD");
      }
      if(kind==="private state")fs.chmodSync(f.state,0o755);
      if(kind==="wrong head")f.options.target_sha="a".repeat(40);
      if(kind==="raced"){
        let n=0; f.options.snapshotImpl=async args=>{const result=await snapshotWorkspaceResult(args);if(++n===1)fs.writeFileSync(path.join(f.wt,"file.txt"),"race");return result;};
      }
      const before=f.remoteHead(); const result=await pushExactSha(f.options);
      assert.equal(result.ok,false,JSON.stringify(result)); assert.equal(result.stage,"HOLD"); assert.equal(f.remoteHead(),before);
    } finally {f.cleanup();}
  });
}

test("SHU-228: lost push response reuses the deterministic commit; divergent remote is never overwritten",async()=>{
  const f=fixture();try{
    f.edit(); const real=execFile;
    const lost=(file,args,options,callback)=>real(file,args,options,(err,out,stderr)=>callback(args.includes("push")?new Error("lost response"):err,out,stderr));
    const ambiguous=await pushExactSha({...f.options,gitImpl:lost});assert.equal(ambiguous.ok,false);
    const remote=f.remoteHead(); assert.notEqual(remote,f.options.target_sha);
    const recovered=await pushExactSha(f.options);assert.equal(recovered.stage,"ALREADY_PUSHED");assert.equal(recovered.remote_head,remote);
    f.git(f.wt,"commit","--allow-empty","-m","foreign branch advance");f.git(f.wt,"push","--force",f.remote,"HEAD:refs/heads/coordinator/test");
    const divergent=f.remoteHead();assert.equal((await pushExactSha(f.options)).ok,false);assert.equal(f.remoteHead(),divergent);
  }finally{f.cleanup();}
});

test("SHU-228: expiry during snapshot refuses publication",async()=>{
  const f=fixture();try{
    f.edit();let checks=0;
    const result=await pushExactSha({...f.options,beforePublish:()=>++checks===1});
    assert.equal(result.ok,false);assert.match(result.reason,/authorization expired/);
    assert.equal(checks,2);assert.equal(f.remoteHead(),f.options.target_sha);
    assert.equal(fs.existsSync(path.join(f.state,`push-${f.options.attempt_id}.json`)),false);
  }finally{f.cleanup();}
});

test("SHU-228: workspace-ready callback is bound and host refusal never publishes a result",async()=>{
  const f=fixture();try{
    const input={issue_id:"SHU-228",authorization_ref:"SHU-228",attempt_id:f.options.attempt_id,target_sha:f.options.target_sha};
    const cb={...input,result_sha:null,stage:"BUILD_READY",links:["file.txt tests"]};
    assert.equal(codex.callbackValid(cb,input),true);
    for(const changed of [{attempt_id:randomUUID()},{target_sha:"b".repeat(40)},{stage:"PASS"},{stage:"FAILED"},{result_sha:""}]) assert.equal(codex.callbackValid({...cb,...changed},input),false);
    const run=async(over={})=>codex.launchBuilder({...input,cwd:f.wt,readHeadImpl:async()=>input.target_sha,env:{...process.env,SHU_WORKER_LAUNCH_WRAPPER:"test-wrapper"},
      io:{codexStateDir:f.state,worktreeRoot:f.root,pushRemoteUrl:f.options.remoteUrl},
      execFileImpl:(_f,_a,_o,done)=>done(null,[{type:"thread.started",thread_id:randomUUID()},
      {type:"item.completed",item:{type:"agent_message",text:JSON.stringify(cb)}}].map(x=>JSON.stringify(x)).join("\n"),""),...over});
    let called=0;
    const refused=await run({pushBrokerImpl:async()=>{called++;return{ok:false,reason:"refused"};}});
    assert.equal(called,1,JSON.stringify(refused)); assert.equal(refused.stage,"HOLD");assert.equal(refused.callback.result_sha,null);
    // Use another attempt, so the durable session from this call cannot be overwritten.
    input.attempt_id=randomUUID();cb.attempt_id=input.attempt_id;
    const result="c".repeat(40);
    const accepted=await run({pushBrokerImpl:async args=>{assert.equal(args.workspaceReady,true);assert.equal(args.result_sha,null);return{ok:true,remote_head:result};}});
    assert.equal(accepted.stage,"COMPLETED");assert.equal(accepted.callback.result_sha,result);
    input.attempt_id=randomUUID();cb.attempt_id="wrong-attempt";
    let invalidCalls=0;
    const invalid=await run({pushBrokerImpl:async()=>{invalidCalls++;return{ok:true,remote_head:result};}});
    assert.equal(invalid.stage,"HOLD");assert.equal(invalidCalls,0,"no host commit before valid callback");
  }finally{f.cleanup();}
});

test("SHU-228: new and resumed model choices and worker network are explicit",()=>{
  const input={attempt_id:randomUUID(),target_sha:"a".repeat(40)};
  for(const resume of [false,true]){
    const args=codex.buildCodexArgs(input,{resume,sessionId:randomUUID(),schemaFile:"/tmp/schema",cwd:"/tmp/worker"});
    assert.equal(args[args.indexOf("--model")+1],"gpt-5.6-sol");
    assert.equal(args[args.indexOf("--config")+1],"sandbox_workspace_write.network_access=false");
    const review=buildClaudeArgs(input,{resume});assert.equal(review[review.indexOf("--model")+1],"opus");
  }
});
