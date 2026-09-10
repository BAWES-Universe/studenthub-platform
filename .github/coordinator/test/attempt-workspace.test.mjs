import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { prepareAttemptWorkspace } from "../attempt-workspace.mjs";
import { resolveCoordinatorRevision } from "../single-run-activation.mjs";
import { preparedLaunchOptions } from "../reconcile.mjs";
import { pushExactSha } from "../push-broker.mjs";
import * as codex from "../adapters/codex-cli.mjs";
import * as claude from "../adapters/claude-code.mjs";
import { createEpisodeHarness } from "./fixture/episode-harness.mjs";

const REPO = "BAWES-Universe/studenthub-platform";
const git = (cwd, ...args) => execFileSync("git", ["-c", `safe.directory=${cwd}`, ...args], {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
}).trim();
const wrapper = `${process.getuid() === 0 ? "" : "sudo -n --preserve-env=PATH "}setpriv --reuid=65534 --regid=65534 --clear-groups`;
const switchCommand = wrapper.split(" ");
const canSwitch = spawnSync(switchCommand[0], [...switchCommand.slice(1), "id", "-u"], { timeout: 2000 }).status === 0;
const nodeBin = process.execPath;

test("SHU-227: CI must execute the distinct-uid integration tests", () => {
  if (process.env.GITHUB_ACTIONS === "true") assert.equal(canSwitch, true, "CI must support distinct-uid proof; do not silently skip it");
});

function setup() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "shu227-"));
  fs.chmodSync(dir, 0o755);
  const remote = path.join(dir, "BAWES-Universe", "studenthub-platform.git");
  fs.mkdirSync(path.dirname(remote));
  git(dir, "init", "--bare", remote);
  const seed = path.join(dir, "seed");
  git(dir, "init", seed);
  git(seed, "config", "user.name", "Fixture");
  git(seed, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(seed, "round"), "0");
  git(seed, "add", "."); git(seed, "commit", "-m", "fixture seed");
  const sha = git(seed, "rev-parse", "HEAD");
  git(seed, "push", remote, "HEAD:refs/heads/coordinator/SHU-140");
  const root = path.join(dir, "workspaces"), state = path.join(dir, "state"), bin = path.join(dir, "bin");
  fs.mkdirSync(root); fs.chmodSync(root, 0o1777); fs.mkdirSync(state, { mode: 0o700 }); fs.mkdirSync(bin);
  const env = { ...process.env, SHU_WORKTREE_ROOT: root, SHU_WORKSPACE_STATE_DIR: state,
    SHU_PUSH_REMOTE_URL: `file://${remote}`, SHU_WORKER_UID: "65534", SHU_WORKER_LAUNCH_WRAPPER: wrapper,
    PATH: `${bin}:${process.env.PATH}`, HOME: dir, SHU_PUSH_BROKER_ENABLED: "true" };
  const receipt = (over = {}) => ({ attempt_id: randomUUID(), issue_id: "SHU-140", authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    requested_worker: "claude-verifier", repo: REPO, branch: "coordinator/SHU-140", target_sha: sha, ...over });
  const prepare = (r, more = {}) => prepareAttemptWorkspace({ receipt: r, env, allowedHost: "file", ...more });
  return { dir, remote, seed, sha, root, state, bin, env, receipt, prepare,
    cleanup() {
      if (canSwitch && process.getuid() !== 0) {
        for (const name of fs.readdirSync(root)) {
          const target = path.join(root, name);
          if (!fs.lstatSync(target).isSymbolicLink() && fs.statSync(target).uid === 65534) {
            execFileSync(switchCommand[0], [...switchCommand.slice(1), "rm", "-rf", "--", target]);
          }
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } };
}

test("SHU-227: empty root provisions an independent exact-head reviewer checkout", () => {
  const f = setup(); try {
    const r = f.receipt(); const { cwd } = f.prepare(r);
    assert.equal(git(cwd, "rev-parse", "HEAD"), f.sha);
    assert.equal(git(cwd, "status", "--porcelain"), "");
    assert.ok(fs.lstatSync(path.join(cwd, ".git")).isDirectory(), "no shared linked-worktree metadata");
    assert.equal(fs.existsSync(path.join(cwd, ".git/objects/info/alternates")), false);
    assert.equal(git(cwd, "remote"), "", "worker checkout has no push remote");
    assert.equal(f.prepare(r).cwd, cwd, "replay reuses its own checkout");
    assert.notEqual(f.prepare(f.receipt()).cwd, cwd, "another attempt gets another checkout");
    assert.equal(git(f.seed, "rev-parse", "HEAD"), f.sha, "source checkout untouched");
  } finally { f.cleanup(); }
});

test("SHU-227: binding conflicts, symlink paths, missing resume and invalid source refuse without overwriting", () => {
  const f = setup(); try {
    const r = f.receipt(); const { cwd } = f.prepare(r);
    fs.writeFileSync(path.join(cwd, "uncommitted"), "preserve me");
    assert.throws(() => f.prepare({ ...r, branch: "coordinator/SHU-999" }), /binding conflict/);
    assert.throws(() => f.prepare({ ...r, target_sha: "f".repeat(40) }), /binding conflict/);
    assert.throws(() => f.prepare(f.receipt(), { resume: true }), /resume workspace is missing/);
    assert.throws(() => f.prepare(f.receipt({ attempt_id: "../escape" })), /binding/);
    assert.throws(() => f.prepare(f.receipt({ repo: "foreign/repo" })), /binding/);
    assert.throws(() => f.prepare(f.receipt(), { env: { ...f.env, SHU_PUSH_REMOTE_URL: "https://example.invalid/foreign/repo" } }), /approved repository/);
    const symlink = f.receipt(); fs.symlinkSync(f.seed, path.join(f.root, symlink.attempt_id));
    assert.throws(() => f.prepare(symlink), /path already exists/);
    const alias = path.join(f.dir, "alias"); fs.symlinkSync(f.dir, alias);
    assert.throws(() => f.prepare(f.receipt(), { env: { ...f.env, SHU_WORKTREE_ROOT: path.join(alias,"workspaces") } }), /symlink/);
    assert.equal(fs.readFileSync(path.join(cwd, "uncommitted"), "utf8"), "preserve me");
    git(cwd, "add", "."); git(cwd, "commit", "-m", "changed reviewer tree");
    assert.throws(() => f.prepare(r), /HEAD does not match/);
    assert.throws(() => f.prepare(r, { resume: true }), /HEAD does not match/);
  } finally { f.cleanup(); }
});

test("SHU-227: interrupted preparation and concurrent ownership stay HOLD without reset", () => {
  const f = setup(); try {
    const r = f.receipt();
    fs.writeFileSync(path.join(f.state, r.attempt_id + ".lock"), "owner", { mode: 0o600 });
    assert.throws(() => f.prepare(r), /locked/);
    assert.equal(fs.existsSync(path.join(f.root, r.attempt_id)), false);
    const interrupted = f.receipt();
    fs.writeFileSync(path.join(f.state, interrupted.attempt_id + ".json"), JSON.stringify({ ...interrupted, status: "preparing" }), { mode: 0o600 });
    assert.throws(() => f.prepare(interrupted), /interrupted/);
  } finally { f.cleanup(); }
});

test("SHU-227: both real adapters require preparation; fixed shared cwd is never the fallback", async () => {
  const f = setup(); try {
    for (const [adapter, worker] of [["codex-cli", "codex-builder"], ["claude-code", "claude-verifier"]]) {
      await assert.rejects(preparedLaunchOptions(adapter, f.receipt({ requested_worker: worker }), {
        CODEX_WORKTREE_PATH: f.seed, CLAUDE_WORKTREE_PATH: f.seed,
      }), /workspace directory/);
    }
  } finally { f.cleanup(); }
});

test("SHU-227: worker owns its checkout and recovery preserves descendant commits", { skip: !canSwitch && "requires root or passwordless sudo for distinct-uid proof" }, () => {
  const f = setup(); try {
    const r = f.receipt({ requested_worker: "codex-builder" }); const { cwd } = f.prepare(r);
    assert.equal(fs.statSync(cwd).uid, 65534);
    const args = wrapper.split(" ");
    execFileSync(args[0], [...args.slice(1), "git", "-C", cwd, "commit", "--allow-empty", "-m", "worker result"], { env: f.env });
    const result = git(cwd, "rev-parse", "HEAD");
    assert.notEqual(result, f.sha);
    assert.equal(f.prepare(r, { resume: true }).cwd, cwd);
    assert.equal(git(cwd, "rev-parse", "HEAD"), result, "resume never resets the writer's result");
    assert.throws(() => f.prepare(r), /HEAD does not match/);
  } finally { f.cleanup(); }
});

test("SHU-227: coordinator revision binds the executing root, ignoring cwd and injected git paths", () => {
  const f = setup(); try {
    const sub = path.join(f.seed, ".github", "coordinator"); fs.mkdirSync(sub, { recursive: true });
    const old = process.env.GIT_DIR;
    process.env.GIT_DIR = "/nonexistent/unrelated.git";
    try { assert.equal(resolveCoordinatorRevision({ dir: sub }), f.sha); }
    finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
  } finally { f.cleanup(); }
});

test("SHU-227: non-owner service account resolves revision with no global Git trust", { skip: !canSwitch && "requires distinct-uid execution" }, () => {
  const f = setup(); try {
    const sub = path.join(f.seed, ".github", "coordinator"); fs.mkdirSync(sub, { recursive: true });
    // Copy the coordinator modules into the small test repo; no dependency on
    // this workspace's ancestor directory permissions for the non-owner probe.
    fs.cpSync(new URL("../", import.meta.url), sub, { recursive: true });
    const args = wrapper.split(" ");
    const code = `import {resolveCoordinatorRevision} from ${JSON.stringify("file://" + path.join(sub,"single-run-activation.mjs"))}; console.log(resolveCoordinatorRevision({dir:${JSON.stringify(sub)}}));`;
    const result = execFileSync(args[0], [...args.slice(1), nodeBin, "--input-type=module", "-e", code], {
      cwd: "/", encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    }).trim();
    assert.equal(result, f.sha);
  } finally { f.cleanup(); }
});

function installCliDoubles(f) {
  const common = `const fs=require('fs'),cp=require('child_process');const args=process.argv.slice(2); const prompt=args.at(-1); const attempt=/Attempt: ([0-9a-f-]+)/.exec(prompt)[1]; const target=/Bound head: ([0-9a-f]+)/.exec(prompt)[1]; const git=(...a)=>cp.execFileSync('git',a,{encoding:'utf8'}).trim(); if(git('rev-parse','HEAD')!==target)throw Error('wrong input head'); if(process.env.GITHUB_TOKEN||process.env.LINEAR_API_TOKEN||process.env.SHU_PUSH_SSH_COMMAND)throw Error('credential leak');`;
  const writer = common + `
    if(process.getuid()!==65534)throw Error('writer identity not dropped');
    JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
    const round=Number(fs.readFileSync('round','utf8'))+1; fs.writeFileSync('round',String(round));
    git('add','round');git('commit','-m','fixture writer round '+round); const result=git('rev-parse','HEAD');
    console.log(JSON.stringify({type:'thread.started',thread_id:require('crypto').randomUUID()}));
    const cb={attempt_id:attempt,target_sha:target,result_sha:result,stage:round===1?'BUILD_READY':'REVISION_READY',links:['round fixture at commit '+result],summary:'fixture'};
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(cb)}}));
    console.log(JSON.stringify({type:'turn.completed'}));`;
  const reviewer = common + `
    const round=Number(fs.readFileSync('round','utf8'));console.log(JSON.stringify({type:'result',subtype:'success',session_id:attempt,structured_output:{attempt_id:attempt,target_sha:target,stage:round===1?'BLOCKED':'PASS',links:['https://example.invalid/fixture-evidence']}}));`;
  for (const [name, body] of [["codex", writer], ["claude", reviewer]]) {
    fs.writeFileSync(path.join(f.bin, name), `#!${nodeBin}\n${body}\n`, { mode: 0o755 });
  }
}

test("SHU-227: empty-root main drives real Git, both real adapters and real broker through four launches", { skip: !canSwitch && "requires distinct-uid execution" }, async () => {
  const f = setup(); installCliDoubles(f);
  const h = createEpisodeHarness({ githubToken: "fake-read-token", initialBranchHead: f.sha });
  try {
    assert.equal(fs.readdirSync(f.root).length, 0);
    const snapshots = [], brokerPushes = [];
    const io = { adapterModules: { "codex-cli": codex, "claude-code": claude }, codexStateDir: f.state,
      prepareWorkspace: (options) => {
        assert.ok(h.receipts().some(r => r.attempt_id === options.receipt.attempt_id && r.stage === "LAUNCH_UNKNOWN"), "reservation and launch intent precede preparation");
        const workspace = prepareAttemptWorkspace({ ...options, allowedHost: "file" });
        snapshots.push({ ...options.receipt, cwd: workspace.cwd }); return workspace;
      },
      pushBrokerImpl: async options => {
        const result = await pushExactSha({ ...options, allowedHost: "file" });
        if (result.ok) { h.branchHead.value = result.remote_head; brokerPushes.push(result.remote_head); }
        return result;
      },
    };
    const env = { ...f.env, GITHUB_TOKEN: "fake-read-token", LINEAR_API_TOKEN: "fake-linear-token", DISPATCH_TARGET_SHA: f.sha };
    for (let i=0; i<4; i++) {
      const tick = await h.runTick({ env, io });
      assert.equal(tick.code, i===1 ? 2 : 0, tick.text + JSON.stringify(h.receipts()));
      const latest = h.receipts().at(-1);
      assert.equal(latest.stage, i===1 ? "HOLD" : "COMPLETED", JSON.stringify(latest));
    }
    assert.deepEqual(snapshots.map(r=>r.requested_worker), ["codex-builder", "claude-verifier", "codex-builder", "claude-verifier"]);
    assert.equal(new Set(snapshots.map(r=>r.cwd)).size, 4, "each actor gets an independent checkout");
    assert.equal(brokerPushes.length, 2, "only the host broker pushes writer results");
    assert.deepEqual(snapshots.map(r=>r.target_sha), [f.sha, brokerPushes[0], brokerPushes[0], brokerPushes[1]]);
    assert.equal(git(f.remote, "rev-parse", "refs/heads/coordinator/SHU-140"), brokerPushes[1]);
    assert.equal((await h.runTick({ env, io })).code, 2, "PASS spends the episode");
    assert.equal(snapshots.length, 4, "no extra preparation or launch after PASS");
  } finally { h.cleanup(); f.cleanup(); }
});

test("SHU-227: disabled/refused runs never provision; preparation refusal never launches", async () => {
  const h = createEpisodeHarness({ githubToken: "fake-token" }); let calls = 0;
  const io = { prepareWorkspace() { calls++; throw new Error("setup deliberately refused"); } };
  try {
    await h.runTick({ env: { ENABLE_DISPATCH: "false" }, io });
    await h.runTick({ now: new Date("2026-09-12T12:00:00Z"), io });
    assert.equal(calls, 0); assert.equal(h.comments.length, 0);
    await h.runTick({ io });
    assert.equal(calls, 1); assert.equal(h.launched.length, 0);
    assert.equal(h.receipts()[0].stage, "HOLD");
  } finally { h.cleanup(); }
});

test("SHU-227: activation expiring during preparation never reaches an adapter", async () => {
  const h = createEpisodeHarness({ githubToken: "fake-token" });
  try {
    await h.runTick({ io: { prepareWorkspace() {
      fs.writeFileSync(h.activationPath, JSON.stringify({ ...h.record, expires_at: "2020-01-01T00:00:00Z" }));
      return { cwd: "/unused-test-checkout" };
    } } });
    assert.equal(h.launched.length, 0); assert.equal(h.receipts()[0].stage, "HOLD");
  } finally { h.cleanup(); }
});

test("SHU-227: generated schema is worker-readable while session authority remains private", async () => {
  const f = setup(); let schemaPath; const observed=[];
  try {
    const r = f.receipt({ requested_worker: "codex-builder" });
    const execFileImpl = (file, args, options, cb) => {
      if (file === "git") return execFile(file, args, options, cb);
      schemaPath = args[args.indexOf("--output-schema")+1];
      observed.push(fs.statSync(path.dirname(schemaPath)).mode & 0o777,
        fs.statSync(schemaPath).mode & 0o777,fs.statSync(f.state).mode & 0o777,
        JSON.parse(fs.readFileSync(schemaPath,"utf8")));
      cb(Object.assign(new Error("fixture stops before model invocation"), { code: 23 }), "", "");
    };
    await codex.launchBuilder({ ...r, cwd: f.seed, env: f.env, execFileImpl, io: { codexStateDir:f.state, pushBrokerEnabled:false } });
    assert.ok(schemaPath, "real checkout check reached schema/CLI boundary");
    assert.deepEqual(observed,[0o755,0o644,0o700,codex.CALLBACK_SCHEMA],"schema is readable by worker; session state is private");
    assert.equal(fs.existsSync(schemaPath), false, "public schema cleaned after invocation");
  } finally { f.cleanup(); }
});

test("SHU-227: host tick requires an explicit initial head and an already-enabled gate", () => {
  const f=setup(); try {
    const script=new URL("../host-tick.sh",import.meta.url).pathname;
    for (const args of [[], ["/tmp/activation.json"], ["/tmp/activation.json","main"]]) {
      assert.equal(spawnSync("bash",[script,...args],{env:f.env}).status,2);
    }
    assert.equal(spawnSync("bash",[script,"/tmp/activation.json",f.sha],{env:{...f.env,ENABLE_DISPATCH:"false"}}).status,2);
    fs.writeFileSync(path.join(f.bin,"node"),`#!/bin/sh\nprintf '%s\\n' "$DISPATCH_TARGET_SHA" "$@"\n`,{mode:0o755});
    const result=spawnSync("bash",[script,"/tmp/activation.json",f.sha],{env:{...f.env,ENABLE_DISPATCH:"true"},encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);
    assert.ok(result.stdout.startsWith(f.sha+"\n"),"initial head is passed to the tick");
    assert.match(result.stdout,/reconcile\.mjs\n--activation\n\/tmp\/activation\.json/);
  } finally {f.cleanup();}
});

test("SHU-227 MUTATIONS: preparation, path, binding, revision and schema guards are bound", () => {
  const mutations = [
    { file:"attempt-workspace.mjs", from:"if (record && BINDINGS.some(k => record[k] !== binding[k]))", to:"if (false)", test:"binding conflicts, symlink paths", reason:/Missing expected exception/ },
    { file:"attempt-workspace.mjs", from:'if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(p) !== path.resolve(p))', to:'if (!s.isDirectory() || s.isSymbolicLink())', test:"binding conflicts, symlink paths", reason:/Missing expected exception/ },
    { file:"attempt-workspace.mjs", from:'if (!resume || !writer) throw new Error("workspace HEAD does not match the bound commit");', to:'if (false) throw new Error("workspace HEAD does not match the bound commit");', test:"binding conflicts, symlink paths", reason:/Missing expected exception/ },
    { file:"reconcile.mjs", from:'const prepare = io.prepareWorkspace ?? (io.adapterModules?.[adapter] ? null : prepareAttemptWorkspace);', to:'const prepare = null;', test:"both real adapters require preparation", reason:/Missing expected rejection/ },
    { file:"single-run-activation.mjs", from:'let root = fs.realpathSync(dir);', to:'let root = fs.realpathSync(process.cwd());', test:"coordinator revision binds the executing root", reason:/AssertionError/ },
    { file:"adapters/codex-cli.mjs", from:'fs.chmodSync(schemaDir, 0o755);', to:'fs.chmodSync(schemaDir, 0o700);', test:"generated schema is worker-readable", reason:/AssertionError|schema directory is traversable/ },
    { file:"reconcile.mjs", from:'currentActivation.state !== "armed" || !activationAllowsTarget(currentActivation, receipt.issue_id)', to:'false', test:"activation expiring during preparation", reason:/AssertionError/ },
  ];
  for (const m of mutations) {
    const dir=fs.mkdtempSync(path.join(tmpdir(),"shu227-mutation-"));
    try {
      fs.cpSync(new URL("../",import.meta.url),dir,{recursive:true});
      const target=path.join(dir,m.file), source=fs.readFileSync(target,"utf8");
      assert.equal(source.split(m.from).length,2,`one exact mutation anchor: ${m.file}`);
      fs.writeFileSync(target,source.replace(m.from,m.to));
      const { NODE_TEST_CONTEXT: _nestedTestContext, ...testEnv } = process.env;
      const child=spawnSync(nodeBin,["--test","--test-name-pattern",m.test,path.join(dir,"test/attempt-workspace.test.mjs")],{encoding:"utf8",timeout:20000,env:testEnv});
      assert.notEqual(child.status,0,`mutation survived: ${m.test}\n${child.stdout}\n${child.stderr}`);
      assert.match(child.stdout+child.stderr,m.reason,`mutation must fail the named assertion: ${m.test}`);
      assert.equal(child.signal,null,"a crash or timeout is not a mutation kill");
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
});
