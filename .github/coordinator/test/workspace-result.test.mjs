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

// SHU-71 run 5: the host check refused a correct revision at publication and the
// receipt could not say which check it was. Its name now rides on the held result.
test("SHU71_PUBLISH_DENIAL_NAMED: a named host denial reaches the held result",async()=>{
  const f=fixture();try{
    f.edit();
    const snapshot=await pushExactSha({...f.options,beforePublish:()=>({code:"HOST_AUTH_EVIDENCE_UNAVAILABLE"})});
    assert.equal(snapshot.ok,false);assert.match(snapshot.reason,/authorization expired/);
    assert.equal(snapshot.reason_code,"HOST_AUTH_EVIDENCE_UNAVAILABLE","SHU71_DENIAL_NAMED_AT_SNAPSHOT");
    let checks=0;
    const push=await pushExactSha({...f.options,beforePublish:()=>++checks===1||{code:"HOST_AUTH_TARGET_NOT_ALLOWED"}});
    assert.equal(checks,2);assert.equal(push.reason_code,"HOST_AUTH_TARGET_NOT_ALLOWED","SHU71_DENIAL_NAMED_AT_PUSH");
    assert.equal(f.remoteHead(),f.options.target_sha,"SHU71_NAMED_DENIAL_NEVER_PUBLISHES");
    // Only a host check's own name is carried; anything else is held unnamed.
    for(const verdict of [false,{code:"LIVE_HEAD_STALE"},{code:"HOST_AUTH_x; rm"},{}]){
      const held=await pushExactSha({...f.options,beforePublish:()=>verdict});
      assert.equal(held.ok,false);assert.equal(held.reason_code,undefined,`SHU71_UNNAMED_DENIAL: ${JSON.stringify(verdict)}`);
    }
  }finally{f.cleanup();}
});

test("SHU71_PUBLISH_DENIAL_CARRIED: the Codex writer carries a host denial's name, nothing else",async()=>{
  const f=fixture();try{
    const input={issue_id:"SHU-228",authorization_ref:"SHU-228",attempt_id:f.options.attempt_id,target_sha:f.options.target_sha};
    const run=async reason_code=>{
      input.attempt_id=randomUUID();
      const cb={...input,result_sha:null,stage:"REVISION_READY",links:["file.txt tests"]};
      return codex.launchBuilder({...input,role:"revise",scope_phase:"revision",cwd:f.wt,readHeadImpl:async()=>input.target_sha,env:{...process.env,SHU_WORKER_LAUNCH_WRAPPER:"test-wrapper"},
        io:{codexStateDir:f.state,worktreeRoot:f.root,pushRemoteUrl:f.options.remoteUrl},
        execFileImpl:(_f,_a,_o,done)=>done(null,[{type:"thread.started",thread_id:randomUUID()},
        {type:"item.completed",item:{type:"agent_message",text:JSON.stringify(cb)}}].map(x=>JSON.stringify(x)).join("\n"),""),
        pushBrokerImpl:async()=>({ok:false,stage:"HOLD",reason:"result authorization expired or revoked",reason_code})});
    };
    const named=await run("HOST_AUTH_ACT_STALE_SEED_HEAD");
    assert.equal(named.stage,"HOLD");assert.equal(named.reason_code,"HOST_AUTH_ACT_STALE_SEED_HEAD","SHU71_CODEX_CARRIES_DENIAL");
    assert.equal((await run("B3_RECOVERY_AUTHORIZATION")).reason_code,undefined,"SHU71_CODEX_CARRIES_ONLY_HOST_DENIAL");
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
    const review=buildClaudeArgs(input,{resume});assert.equal(review[review.indexOf("--model")+1],"claude-opus-5");
  }
});

test("SHU71_UNCHANGED_BUILD_NAMED: a workspace with no changes is refused by name and publishes nothing", async () => {
  const f = fixture(); try {
    const result = await pushExactSha(f.options);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason_code, "RESULT_EMPTY", "the refusal says the writer changed nothing");
    assert.match(result.reason, /contains no changes/);
    assert.equal(f.remoteHead(), f.options.target_sha, "the lane keeps the bound head");
  } finally { f.cleanup(); }
});

test("SHU71_UNCHANGED_BUILD_AFTER_BINDING: an attempt that already bound a result is never reported unchanged", async () => {
  const f = fixture(); try {
    f.edit();
    const first = await pushExactSha(f.options);
    assert.equal(first.ok, true, JSON.stringify(first));
    fs.writeFileSync(path.join(f.wt, "file.txt"), "old\n");
    const again = await pushExactSha(f.options);
    assert.equal(again.ok, false, JSON.stringify(again));
    assert.equal(again.reason_code, undefined, "not RESULT_EMPTY, so no adapter can treat it as an unchanged build");
    assert.match(again.reason, /binding conflict/);
    assert.equal(f.remoteHead(), first.remote_head, "the published result stays");
  } finally { f.cleanup(); }
});

test("SHU71_SNAPSHOT_GIT_CAUSE: a failed snapshot step is held by its code with git's own last line", async () => {
  const failing = (stderr) => (file, args, options, callback) => {
    if (args.includes("--work-tree") && args.includes("read-tree")) return callback(Object.assign(new Error("exit 128"), { code: 128 }), "", stderr);
    return execFile(file, args, options, callback);
  };
  const f = fixture(); try {
    f.edit();
    const held = await pushExactSha({ ...f.options, gitImpl: failing("warning: noise\nfatal: simulated snapshot failure\n") });
    assert.equal(held.ok, false, JSON.stringify(held));
    assert.equal(held.reason_code, "SNAPSHOT_READ_TREE_FAILED");
    assert.match(held.reason, /failed at read-tree: fatal: simulated snapshot failure$/);
    const secret = await pushExactSha({ ...f.options, attempt_id: randomUUID(), gitImpl: failing("fatal: could not read https://user:hunter2@example.invalid/repo\n") });
    assert.equal(secret.reason_code, "SNAPSHOT_READ_TREE_FAILED");
    assert.doesNotMatch(secret.reason, /hunter2/);
    assert.match(secret.reason, /failed at read-tree$/);
    assert.equal(f.remoteHead(), f.options.target_sha, "a held snapshot publishes nothing");
    const commitTree = await pushExactSha({ ...f.options, attempt_id: randomUUID(), gitImpl: (file, args, options, callback) =>
      args.includes("commit-tree") ? callback(Object.assign(new Error("exit 128"), { code: 128 }), "", "fatal: simulated commit-tree failure\n")
        : execFile(file, args, options, callback) });
    assert.equal(commitTree.reason_code, "SNAPSHOT_COMMIT_TREE_FAILED", "a step behind -c options is named by its subcommand");
    assert.match(commitTree.reason, /failed at commit-tree: fatal: simulated commit-tree failure$/);
    let snapshots = 0;
    const verification = await pushExactSha({ ...f.options, attempt_id: randomUUID(), snapshotImpl: async (options) => {
      if (++snapshots === 1) return snapshotWorkspaceResult(options);
      throw Object.assign(new Error("workspace snapshot Git operation failed at write-tree"), { workspaceCode: "SNAPSHOT_WRITE_TREE_FAILED" });
    } });
    assert.equal(verification.reason_code, "SNAPSHOT_WRITE_TREE_FAILED", "the verification snapshot carries its code too");
    assert.equal(f.remoteHead(), f.options.target_sha, "a held snapshot publishes nothing");
  } finally { f.cleanup(); }
});
