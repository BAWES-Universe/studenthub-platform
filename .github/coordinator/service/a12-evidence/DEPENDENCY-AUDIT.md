# A12 dependency audit — successful inert-probe capture

The required-file derivation is the literal `SUITE_ROOTS` filter and sort from `suite-runner-spec.mjs:42-43`, applied to `git ls-tree -r --name-only HEAD`. Its output is committed in `required-files.json`: **85 files**. No glob narrowing is used.

A capability is a host precondition, with exactly the detection claim in the contract; it is not an assurance that every operation works. Node core filesystem/process APIs are the baseline. Private writable temporary storage, POSIX modes/ownership, symlinks, atomic rename and file descriptors are required by the fixture filesystem operations. The `temp` probe only proves its stated create/read/write/remove operation, not all those semantics.

This record does not prove production deployment, service identity authorization, systemd activation, namespace isolation, sudo policy, remote credentials, CI success, a settled revision, or an independent verdict. Command doubles are not host evidence. Privilege probes do not prove authorization for arbitrary worker commands or supplementary groups.

The historical refusal below is superseded by the successful capture in `successful-run.jsonl` and `DERIVATION.md`. The historical call-site enumeration is retained; current per-file mappings and refreshed call-site references are in `file-requirements.json` and the table at the end.

## Distinct dependencies and disposition

| Dependency | Vocabulary / disposition | Call sites and execution boundary |
|---|---|---|
| Node, child Node, generated Node executables | baseline Node; existing `node` infrastructure probe | Literal `process.execPath`, `nodeBin`, `node`, fork and executable fixture scripts listed below; operational wrapper additionally pins `/usr/bin/node`. |
| Git, local upload/receive pack | `git` | Real Git fixture helpers and production workspace/broker calls; file transport only in real repository fixtures. Git supplies its own helpers. |
| Bash | `bash` | `hermes-adversarial` executes the repository-policy block; `attempt-workspace` executes host-tick; `shu239-reviewer-launch` parses/refuses reviewer-sandbox; `shu261-reviewer-isolation` executes reviewer-sandbox directly; cleanup-network extracts shipped Bash functions with privileged commands doubled. |
| /bin/sh, dirname | new `shell_toolchain` | service/shu251-operational-bindings.sh:1,25,27, directly executed by host-window-bindings; host-tick.sh:16 also invokes dirname. Executed generated shell wrappers in attempt-workspace, reviewer-evidence and shu249-role-authority; shu237-portability only resolves fixture paths and does not execute its shebangs; shell builtins are not separate binaries. |
| env, true | `shell_toolchain`; env node restored at d09f50d | codex-contract:505 retains #!/usr/bin/env node. Probe executes /usr/bin/env node --version on the child PATH as service identity. env /usr/bin/true remains probed; service.test lock-release alone uses child Node. |
| chmod (inherent) | new `shell_toolchain` | attempt-workspace.mjs:246 workerRun("chmod", ["0750", "--", cwd]); production permission behavior preserved. |
| mktemp, rm (inherent) | new `shell_toolchain` | workflows/repository-policy.yml policy block, extracted and executed unchanged by hermes-adversarial.test.mjs:182-206. This is artifact behavior, not test-only cleanup. |
| chmod, rm (incidental) | removed; Node fs.chmodSync/fs.rmSync | attempt-workspace cleanup and metadata protection retain worker identity via the same switchCommand; shu241-scoped-build cleanup recursively adds owner-write. Symlinks are not traversed. |
| grep (incidental) | removed; recursive Node Buffer matching | shu241-scoped-build sentinel scan; original grep.status == 1 assertion and diagnostic unchanged. Filesystem errors now throw rather than masquerade as absence. |
| touch, cat | retained fixtures, declared `shell_toolchain` | push-broker-gitconfig:164,432 and workspace-result:67,70 retain shell marker/filter/hook scripts restored at d09f50d. Probe checks /usr/bin/touch --version and /usr/bin/cat --version. Only service.test second writer uses Node appendFileSync. |
| cp (incidental) | earlier fs.cpSync fix retained | durable-handoff and merge-readiness mutation copies; assertions and mutation lists unchanged. |
| sudo, setpriv, id; distinct ownership | existing `privilege`, `worker_uid` | attempt-workspace:22-24/worker launches; shu241-scoped-build:26-30; two-fixture-revision-reader uses Node spawn uid/gid for real non-owner Git. Exact eight skip bindings remain authoritative. |
| systemd-analyze | existing `systemd_analyze` | units.mjs:155, called by service installation/syntax tests and supervisor-service unit tests. No system manager activation occurs. |
| flock | existing `flock` | service.test:86-96; host-tick.sh:20. |
| cvtsudoers or cvtsudoers.ws | existing `cvtsudoers` | host-suite-contract parser real installed provider; other parser cases use injected filesystem/process fixtures. Absence/ambiguity has explicit refusal controls. |
| Linux procfs, process identity, signals, inherited FDs | new `linux_proc` | workspace-result.mjs descriptor-relative reads; review-execution.mjs and review-execution-child.mjs process/environment/descriptor canaries; residual-process.mjs and supervisor-service.mjs process stat; codex process lifecycle controls. |
| Unix-domain sockets | existing `unix_socket` | supervisor.test round trip; supervisor-service and residual live daemon tests. |
| IPv4 loopback TCP | retained `loopback_socket`, repaired to allocate no filesystem resources | capability-requirements executes the real positive probe. Reviewer evidence/isolation/findings inject listenProbeImpl; their imported production default alone is not an executed dependency. |
| systemctl, systemd-run, systemd-notify, unshare, setfacl, getent, visudo, ss, gh, installed claude/codex/hermes, network services | not additional suite requirements where doubled, source-inspected or refused before execution | Production lifecycle fixtures inject command boundaries; reviewer cleanup/network harness defines Bash functions for privileged tools. Direct reviewer-sandbox invalid invocation exits before privileged commands. Existing preflight vocabulary remains unchanged for its infrastructure probes. No installed model CLI or remote service is substituted as evidence. |

## All required files: call-site enumeration

Line references below enumerate child-process calls, executable fixture shebangs, OS interfaces, helper invocations and imported modules. Imports require tracing execution rather than treating all reachable production commands as executed. Mutation subprocesses inherit the dependencies of the selected target tests. A source literal inside an injected double or mutation string is not by itself a real command.

### `.github/coordinator/service/test/activation-window-reconciliation.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import { tmpdir } from 'node:os';
5: import { join } from 'node:path';
6: import { render, assertPolicy, serviceParameters, names } from '../units.mjs';
7: import { fixtureParameters } from '../verify.mjs';
```

### `.github/coordinator/service/test/capability-requirements.test.mjs`

```text
1: import test from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import { pathToFileURL } from 'node:url';
7: import { spawnSync } from 'node:child_process';
8: import * as contract from '../host-suite-contract.mjs';
83: assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0, 'syntax clean');
100: return spawnSync(file, [...args.slice(0, -1), source], { encoding: 'utf8' });
139: ['proc content', 'linux_proc', "if(!fs.readFileSync('/proc/self/'+name).length)throw Error('proc');", "fs.readFileSync('/proc/self/'+name);",
140: "import fs from 'node:fs';|import fs from 'node:fs';const read=fs.readFileSync;fs.readFileSync=(p,...a)=>['/proc/self/stat','/proc/self/cmdline','/proc/self/environ'].includes(p)?Buffer.alloc(0):read(p,...a);"],
141: ['proc descriptor', 'linux_proc', "if(fs.readFileSync('/proc/self/fd/'+fd,'utf8')!=='proof')throw Error('proc fd');", "fs.readFileSync('/proc/self/fd/'+fd,'utf8');",
142: "import fs from 'node:fs';|import fs from 'node:fs';const read=fs.readFileSync;fs.readFileSync=(p,...a)=>String(p).startsWith('/proc/self/fd/')?'wrong':read(p,...a);"],
154: return spawnSync(file, [...args.slice(0, -1), args.at(-1).replace(from, to)], { encoding: 'utf8' });
```

### `.github/coordinator/service/test/cli-amendments.test.mjs`

```text
1: import test from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import { fileURLToPath } from 'node:url';
7: import { spawnSync } from 'node:child_process';
24: return spawnSync(process.execPath, ['--import', preload, file, action, spec], { env, encoding: 'utf8', timeout: 10000 });
55: assert.equal(spawnSync(process.execPath, ['--check', mutant]).status, 0, 'syntax clean');
```

### `.github/coordinator/service/test/environment-content-mutations.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import { tmpdir } from 'node:os';
5: import { join } from 'node:path';
6: import { spawnSync } from 'node:child_process';
31: const run = args => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env });
```

### `.github/coordinator/service/test/environment-content.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import { tmpdir } from 'node:os';
5: import { join } from 'node:path';
6: import { render, assertPolicy, WORKSPACE_STATE_DIR } from '../units.mjs';
```

### `.github/coordinator/service/test/host-lifecycle.test.mjs`

```text
1: import test from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import { spawnSync } from 'node:child_process';
7: import { drive, hash, canonical, UNIT_NAMES, LIFECYCLE_ACTIONS, validateReceipt } from '../phase-a-driver.mjs';
8: import { FILES, TARGETS, DROP_IN_DIRECTORIES, expectedManifest, REQUIRED_CAPABILITIES, executeLifecycle } from '../host-lifecycle.mjs';
14: import { fixture } from './lifecycle-fixture.mjs';
218: const run = () => spawnSync(process.execPath, ['--test', `--test-name-pattern=^LIFECYCLE guard ${code}$`, path.join(root, 'test/host-lifecycle.test.mjs')],
229: assert.equal(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status, 0, 'syntax-clean mutation');
```

### `.github/coordinator/service/test/host-suite-contract.test.mjs`

```text
1: import test from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import { fileURLToPath } from 'node:url';
7: import { spawnSync } from 'node:child_process';
8: import { runInNewContext } from 'node:vm';
9: import { CAPABILITIES, PERMITTED_SKIPS, preflight, evaluateSuite, runSuite, hostProbe, resolveCvtsudoers, CVTSUDOERS_CANDIDATES } from '../host-suite-contract.mjs';
210: assert.equal(file, '/proc/self/fd/3', 'PINNED_EXECUTION: execute only the inherited descriptor');
309: ['pinned execution removed', 'conventional identity', "io.run('/proc/self/fd/3',", 'io.run(candidate,', 'CONVENTIONAL_ACCEPTED'],
328: const run = () => spawnSync(process.execPath, ['--test', `--test-name-pattern=^SHU251 parser ${controlName}$`, path.join(root, 'test/host-suite-contract.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
335: assert.equal(spawnSync(process.execPath, ['--check', target]).status, 0, 'syntax clean mutant');
377: const mutant = code.replace(from, "spawnSync('/usr/bin/cvtsudoers', ['-f', 'json', file], { encoding: 'utf8' })");
```

### `.github/coordinator/service/test/host-window-bindings.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import path from 'node:path';
5: import { tmpdir } from 'node:os';
6: import { spawnSync } from 'node:child_process';
11: } from '../host-window-bindings.mjs';
49: const rejected = spawnSync(wrapper, ['sh -c anything', '/tmp/spec.json'], { encoding: 'utf8' });
143: const run = spawnSync(process.execPath, [new URL('../host-window-bindings.mjs', import.meta.url).pathname,
162: const result = spawnSync(wrapper, [action, driverFile, '--approved-host-mutation', SHA], {
169: const denied = spawnSync(wrapper, [action, driverFile, '--execute'], {
176: const unknown = spawnSync(wrapper, ['untested-new-action', driverFile], { encoding: 'utf8' });
179: const override = spawnSync(wrapper, ['install', driverFile, '--provider', '/attacker.mjs'], { encoding: 'utf8' });
```

### `.github/coordinator/service/test/phase-a-driver.test.mjs`

```text
1: import test from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import { spawnSync } from 'node:child_process';
7: import { ACTIONS, LIFECYCLE_ACTIONS, UNIT_NAMES, drive, hash, custodyPath, main, receipt, validateReceipt, assertRollbackSafe } from '../phase-a-driver.mjs';
220: return spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
287: const run = () => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 30000 });
295: assert.equal(spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' }).status, 0, 'mutant must be syntax clean');
344: const run = () => spawnSync(process.execPath, ['--test', '--test-name-pattern=^ROUTING complete', path.join(root, 'test/phase-a-driver.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
348: assert.equal(spawnSync(process.execPath, ['--check', target]).status, 0);
```

### `.github/coordinator/service/test/production-lifecycle.test.mjs`

```text
1: import test from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import { spawnSync } from 'node:child_process';
7: import { productionFixture } from './production-fixture.mjs';
8: import { createProductionLifecycle } from '../production-lifecycle.mjs';
9: import { FILES } from '../host-lifecycle.mjs';
10: import { main, defaultIO, hash, canonical } from '../phase-a-driver.mjs';
459: const run = () => spawnSync(process.execPath, ['--test', `--test-name-pattern=^${mutation.pattern}`, path.join(root, 'test/production-lifecycle.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
467: assert.equal(spawnSync(process.execPath, ['--check', extraFile]).status, 0);
469: assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
516: if (fault === 'uid') f.write('/proc/123/status', 'Uid: 0 0 0 0\nGid: 1001 1001 1001 1001\nGroups: 1001 1002\n');
517: if (fault === 'gate') f.write('/proc/123/environ', 'ENABLE_DISPATCH=true\0');
599: if (fault === 'children') f.write('/proc/123/task/123/children', '4321');
```

### `.github/coordinator/service/test/reporter-amendments.test.mjs`

```text
1: import test from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import { pathToFileURL, fileURLToPath } from 'node:url';
7: import { spawnSync } from 'node:child_process';
8: import * as contract from '../host-suite-contract.mjs';
23: const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporterFile}`, file], { env, encoding: 'utf8' });
45: const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporterFile}`, file], { env, encoding: 'utf8', timeout: 10000 });
85: assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0, 'syntax clean');
100: assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
```

### `.github/coordinator/service/test/residual.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import { tmpdir } from 'node:os';
5: import { join } from 'node:path';
6: import { fork } from 'node:child_process';
7: import { once } from 'node:events';
8: import { setTimeout as delay } from 'node:timers/promises';
9: import { verifyGatePositiveControl, assertStatusShape, POSITIVE, SHAPE, RECEIPT } from '../residual-validation.mjs';
10: import { DurableSupervisor, SupervisorStore, signedSupervisorRequest, submitToSupervisor } from '../../supervisor.mjs';
11: import { hasLaunchReceipt } from '../../intended-work.mjs';
12: import { checkStatus } from '../check-status.mjs';
13: import { probeProcess } from '../supervisor-service.mjs';
14: import { createEpisodeHarness } from '../../test/fixture/episode-harness.mjs';
50: const daemon = fork(new URL('./fixture/residual-process.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {} });
```

### `.github/coordinator/service/test/service.test.mjs`

```text
1: import { test as nodeTest } from 'node:test';
7: import assert from 'node:assert/strict';
8: import fs from 'node:fs';
9: import { tmpdir } from 'node:os';
10: import { join } from 'node:path';
11: import { spawn, spawnSync } from 'node:child_process';
12: import { once } from 'node:events';
13: import { pathToFileURL } from 'node:url';
14: import { render, assertPolicy, verifySyntax, names, WORKSPACE_STATE_DIR, serviceParameters } from '../units.mjs';
15: import { install, rollback, snapshot } from '../install.mjs';
16: import { verify, fixtureParameters, assertQuiet } from '../verify.mjs';
17: import { assertFixtureEnvironmentUnchanged } from '../verify.mjs';
38: verifySyntax(root);
86: const holder = spawn('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '2', lock, process.execPath,
90: const rejected = spawnSync('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '2', lock, process.execPath, '-e', "require('node:fs').appendFileSync(process.argv[1], '');", join(root, 'second-writer')]);
96: assert.equal(spawnSync('/usr/bin/flock', ['--nonblock', lock, '/usr/bin/true']).status, 0, 'SHU251_LOCK_RELEASE: writer exit must release the lock');
```

### `.github/coordinator/service/test/suite-runner-spec.test.mjs`

```text
1: import test from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import { spawnSync } from 'node:child_process';
7: import { pathToFileURL } from 'node:url';
8: import { runInNewContext } from 'node:vm';
9: import * as runner from '../suite-runner-spec.mjs';
10: import { runSuite } from '../host-suite-contract.mjs';
11: import { createDisposableSuite, removeDisposableSuite, verifyDisposableSuite, recordDisposableSuite } from '../disposable-suite.mjs';
131: assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
142: const out = spawnSync('/usr/bin/git', ['-C', source, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
145: git('init'); git('config', 'user.name', 'A12 fixture'); git('config', 'user.email', 'fixture@example.invalid');
151: git('add', '.'); git('commit', '-m', 'isolated A12 fixture');
152: const s = { ...spec, revision: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
167: return spawnSync(file, args, { encoding: 'utf8', ...options });
218: assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
238: "\nchild.spawnSync('/usr/bin/systemctl', ['start', 'fixture']);", context);
```

### `.github/coordinator/service/test/supervisor-service.test.mjs`

```text
1: import { fixtureEnvironmentFiles } from '../verify.mjs';
2: import { test as nodeTest } from 'node:test';
7: import assert from 'node:assert/strict';
8: import fs from 'node:fs';
9: import { tmpdir } from 'node:os';
10: import { join } from 'node:path';
11: import { spawnSync } from 'node:child_process';
12: import { EventEmitter } from 'node:events';
13: import { pathToFileURL } from 'node:url';
14: import { startSupervisor, supervisorState, probeProcess } from '../supervisor-service.mjs';
15: import { serviceParameters, render, assertPolicy, names, verifySyntax } from '../units.mjs';
16: import { SupervisorStore, signedSupervisorRequest, submitToSupervisor } from '../../supervisor.mjs';
57: const listen = '  const server = await listenSupervisor({ supervisor, socketPath });';
133: verifySyntax(join(params.stateDir, '..'));
136: const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
179: const result = spawnSync(process.execPath, [new URL('../supervisor-service.mjs', import.meta.url).pathname], {
```

### `.github/coordinator/test/activation.test.mjs`

```text
16: import { test } from "node:test";
17: import assert from "node:assert/strict";
18: import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
19: import { tmpdir } from "node:os";
20: import { join } from "node:path";
25: } from "../activation.mjs";
26: import { activationPreflightFor, ACTIVATION_GATED_ADAPTERS, verifyActivationTarget } from "../reconcile.mjs";
```

### `.github/coordinator/test/adapter.test.mjs`

```text
6: import { test } from "node:test";
7: import assert from "node:assert/strict";
13: } from "../adapters/workspace-agents.mjs";
14: import { launchIdempotencyKey } from "../reconcile.mjs";
```

### `.github/coordinator/test/attempt-workspace.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import path from "node:path";
5: import { tmpdir } from "node:os";
6: import { pathToFileURL } from "node:url";
7: import { execFile, execFileSync, spawnSync } from "node:child_process";
8: import { randomUUID } from "node:crypto";
9: import { prepareAttemptWorkspace, workspaceFailureCode } from "../attempt-workspace.mjs";
10: import { resolveCoordinatorRevision, validateActivationRecord } from "../single-run-activation.mjs";
11: import { preparedLaunchOptions, foldLaunchOutcome, createReceipt, nextReceiptState } from "../reconcile.mjs";
12: import { pushExactSha } from "../push-broker.mjs";
13: import * as codex from "../adapters/codex-cli.mjs";
14: import * as claude from "../adapters/claude-code.mjs";
15: import { createEpisodeHarness } from "./fixture/episode-harness.mjs";
18: const git = (cwd, ...args) => execFileSync("git", ["-c", `safe.directory=${cwd}`, ...args], {
24: const canSwitch = spawnSync(switchCommand[0], [...switchCommand.slice(1), "id", "-u"], { timeout: 2000 }).status === 0;
36: git(dir, "init", "--bare", remote);
38: git(dir, "init", seed);
39: git(seed, "config", "user.name", "Fixture");
40: git(seed, "config", "user.email", "fixture@example.invalid");
42: git(seed, "add", "."); git(seed, "commit", "-m", "fixture seed");
43: const sha = git(seed, "rev-parse", "HEAD");
44: git(seed, "push", remote, "HEAD:refs/heads/coordinator/SHU-140");
59: execFileSync(switchCommand[0], [...switchCommand.slice(1), nodeBin, "-e",
71: assert.equal(git(cwd, "rev-parse", "HEAD"), f.sha);
72: assert.equal(git(cwd, "status", "--porcelain"), "");
76: assert.equal(git(cwd, "remote"), "", "worker checkout has no push remote");
83: assert.equal(git(f.seed, "rev-parse", "HEAD"), f.sha, "source checkout untouched");
104: git(cwd, "add", "."); git(cwd, "commit", "-m", "changed reviewer tree");
137: execFileSync(args[0], [...args.slice(1), "git", "-C", cwd, "commit", "--allow-empty", "-m", "worker result"], { env: f.env });
138: const result = git(cwd, "rev-parse", "HEAD");
141: assert.equal(git(cwd, "rev-parse", "HEAD"), result, "resume never resets the writer's result");
164: const result = execFileSync(args[0], [...args.slice(1), nodeBin, "--input-type=module", "-e", code], {
172: const common = `const fs=require('fs'),cp=require('child_process');const args=process.argv.slice(2); const prompt=args.at(-1); const attempt=/Attempt: ([0-9a-f-]+)/.exec(prompt)[1]; const target=/Bound head: ([0-9a-f]+)/.exec(prompt)[1]; const git=(...a)=>cp.execFileSync('git',a,{encoding:'utf8'}).trim(); if(git('rev-parse','HEAD')!==target)throw Error('wrong input head'); if(process.env.GITHUB_TOKEN||process.env.LINEAR_API_TOKEN||process.env.SHU_PUSH_SSH_COMMAND)throw Error('credential leak');`;
180: if(git('remote')!=='')throw Error('worker has a remote');
182: const result=null;` : `git('add','round');git('commit','-m','fixture writer round '+round); const result=git('rev-parse','HEAD');`}
192: fs.writeFileSync(path.join(f.bin, name), `#!${nodeBin}\n${body}\n`, { mode: 0o755 });
235: else execFileSync(switchCommand[0],[...switchCommand.slice(1),nodeBin,"-e",
258: assert.equal(git(f.remote, "rev-parse", "refs/heads/coordinator/SHU-140"), brokerPushes[1]);
357: if (file === "git") return execFile(file, args, options, cb);
376: assert.equal(spawnSync("bash",[script,...args],{env:f.env}).status,2);
378: assert.equal(spawnSync("bash",[script,"/tmp/activation.json",f.sha],{env:{...f.env,ENABLE_DISPATCH:"false"}}).status,2);
379: fs.writeFileSync(path.join(f.bin,"node"),`#!/bin/sh\nprintf '%s\\n' "$DISPATCH_TARGET_SHA" "$@"\n`,{mode:0o755});
380: const result=spawnSync("bash",[script,"/tmp/activation.json",f.sha],{env:{...f.env,ENABLE_DISPATCH:"true"},encoding:"utf8"});
405: if (execFileSync("git",["--version"],{encoding:"utf8"}).trim()==="git version 2.43.0" && canSwitch) {
417: const child=spawnSync(nodeBin,["--test","--test-name-pattern",m.test,path.join(dir,"test/attempt-workspace.test.mjs")],{encoding:"utf8",timeout:20000,env:testEnv});
```

### `.github/coordinator/test/capacity-scheduler.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
4: import { tmpdir } from "node:os";
5: import { join } from "node:path";
6: import { pathToFileURL } from "node:url";
7: import { spawn } from "node:child_process";
13: } from "../capacity-scheduler.mjs";
365: const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
```

### `.github/coordinator/test/claude-contract.test.mjs`

```text
1: import { after, test } from "node:test";
2: import assert from "node:assert/strict";
3: import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
4: import { tmpdir } from "node:os";
5: import { join } from "node:path";
6: import { pathToFileURL } from "node:url";
15: } from "../adapters/claude-code.mjs";
22: } from "../reconcile.mjs";
310: import { main, parseReceiptsFromComments } from "../reconcile.mjs";
```

### `.github/coordinator/test/codex-contract.test.mjs`

```text
10: import { test } from "node:test";
11: import assert from "node:assert/strict";
12: import { spawn } from "node:child_process";
13: import { EventEmitter } from "node:events";
14: import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
15: import { tmpdir } from "node:os";
16: import { join } from "node:path";
35: } from "../adapters/codex-cli.mjs";
36: import { adapterNameFor, adapterLaunchOptions, createReceipt, foldLaunchOutcome, nextReceiptState } from "../reconcile.mjs";
505: writeFileSync(fakeCodex, `#!/usr/bin/env node\nconst fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(aliveMarker)}, "alive"); process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "thread.started", thread_id: THREAD })}\n`)}); setTimeout(() => { fs.unlinkSync(${JSON.stringify(aliveMarker)}); process.exit(0); }, 1000);\n`);
518: const coordinator = spawn(process.execPath, [runner], { stdio: "ignore" });
1233: // Linux WITH a missing or unreadable procfs. ENOENT on /proc/<pid>/stat only
1307: if (p.includes("/proc/self/")) return selfStat;
1334: if (p.includes("/proc/self/")) return "1 (";
1369: if (p.includes("/proc/self/")) return `1 (node) S ${Array.from({ length: 18 }, (_, i) => i).join(" ")} 900`;
```

### `.github/coordinator/test/dispatch-durability.test.mjs`

```text
6: import { test } from "node:test";
7: import assert from "node:assert/strict";
8: import { writeFileSync, mkdtempSync } from "node:fs";
9: import { tmpdir } from "node:os";
10: import { join } from "node:path";
20: } from "../reconcile.mjs";
```

### `.github/coordinator/test/durable-handoff.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
4: import { tmpdir } from 'node:os';
5: import { join } from 'node:path';
6: import { spawnSync } from 'node:child_process';
7: import * as coordinator from '../reconcile.mjs';
8: import { handoffContinuations } from '../durable-handoff.mjs';
204: const child = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${pattern}$`, join(dir, 'coordinator/test/durable-handoff.test.mjs')],
```

### `.github/coordinator/test/eligibility.test.mjs`

```text
2: import { test } from "node:test";
3: import assert from "node:assert/strict";
4: import fs from "node:fs";
5: import { computeEligibility, requestedWorkerFor, compareIdentifiers, resolveAuthorizationRef, SAME_FAMILY_VERIFIERS, WORKER_FAMILIES } from "../reconcile.mjs";
```

### `.github/coordinator/test/episode-boundary.test.mjs`

```text
16: import { test } from "node:test";
17: import assert from "node:assert/strict";
18: import fs from "node:fs";
19: import os from "node:os";
20: import path from "node:path";
21: import { join, dirname } from "node:path";
22: import { fileURLToPath } from "node:url";
23: import { spawnSync } from "node:child_process";
24: import * as reconcile from "../reconcile.mjs";
25: import * as routing from "../review-routing.mjs";
26: import * as activation from "../single-run-activation.mjs";
27: import { createEpisodeHarness, SHA_INPUT, SHA_WRITE, REVISION } from "./fixture/episode-harness.mjs";
380: import assert from "node:assert/strict";
381: import fs from "node:fs";
382: import os from "node:os";
383: import path from "node:path";
384: import * as reconcile from "./reconcile.mjs";
385: import * as activation from "./single-run-activation.mjs";
386: import { createEpisodeHarness, SHA_INPUT, SHA_WRITE, REVISION } from "./test/fixture/episode-harness.mjs";
532: const child = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 120000, cwd: tmp });
```

### `.github/coordinator/test/episode-stale-head.regression.test.mjs`

```text
6: import { test } from "node:test";
7: import assert from "node:assert/strict";
8: import { main } from "../reconcile.mjs";
9: import { createEpisodeHarness, SHA_INPUT, SHA_WRITE } from "./fixture/episode-harness.mjs";
```

### `.github/coordinator/test/episode-successor-dispatch.test.mjs`

```text
12: import { test } from "node:test";
13: import assert from "node:assert/strict";
14: import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, rmSync, chmodSync, symlinkSync } from "node:fs";
15: import { tmpdir } from "node:os";
16: import { join, dirname } from "node:path";
17: import { fileURLToPath } from "node:url";
18: import { execFileSync } from "node:child_process";
19: import * as reconcile from "../reconcile.mjs";
20: import * as routing from "../review-routing.mjs";
21: import * as activation from "../single-run-activation.mjs";
22: import { createEpisodeHarness, SHA_INPUT, SHA_WRITE, SHA_REVISED, REVISION } from "./fixture/episode-harness.mjs";
610: execFileSync("node", [probe], { cwd: dir, stdio: "pipe" });
```

### `.github/coordinator/test/future-clock.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import { tmpdir } from 'node:os';
5: import { join } from 'node:path';
6: import { fileURLToPath } from 'node:url';
7: import { spawnSync } from 'node:child_process';
29: const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(Date.now()))'], { encoding: 'utf8' });
33: const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: shiftedEnv(), encoding: 'utf8', timeout: 20000 });
48: const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, path], { env: shiftedEnv(), encoding: 'utf8', timeout: 20000 });
```

### `.github/coordinator/test/hermes-adversarial.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import { syncBuiltinESMExports } from 'node:module';
5: import { execFileSync, spawnSync } from 'node:child_process';
6: import { tmpdir } from 'node:os';
7: import { join } from 'node:path';
8: import { launchBuilder, monitorRun } from '../adapters/hermes-pool.mjs';
32: execFileSync(process.execPath, ['--input-type=module', '-e', `
108: const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
206: return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', repositoryPolicyScript()], { cwd, encoding: 'utf8' });
210: execFileSync('git', ['init', '-q', dir]);
211: return () => execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
221: execFileSync('git', ['-C', f.poolDir, 'add', '.']);
231: execFileSync('git', ['-C', f.poolDir, 'add', '.']);
243: execFileSync('git', ['-C', f.poolDir, 'add', '.']);
273: spawnSync(process.execPath, ['--input-type=module', '-e', `
319: spawnSync(process.execPath, ['--input-type=module', '-e', `
```

### `.github/coordinator/test/hermes-pool.test.mjs`

```text
5: import { test } from "node:test";
6: import assert from "node:assert/strict";
7: import { writeFileSync, mkdtempSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
8: import { tmpdir } from "node:os";
9: import { join } from "node:path";
10: import { launchBuilder, monitorRun, validateCallbackEvidence, buildWorkOrder, launchIdempotencyKey, readLease } from "../adapters/hermes-pool.mjs";
11: import { main, parseReceiptsFromComments, receiptCommentBody, adapterNameFor, adapterModuleFor } from "../reconcile.mjs";
352: import { EventEmitter } from "node:events";
353: import { validateReceipt, createReceipt, nextReceiptState } from "../reconcile.mjs";
709: import { utimesSync } from "node:fs";
```

### `.github/coordinator/test/lifecycle.test.mjs`

```text
6: import { test } from "node:test";
7: import assert from "node:assert/strict";
8: import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
9: import { tmpdir } from "node:os";
10: import { join } from "node:path";
11: import { main, parseReceiptsFromComments, receiptCommentBody, parseEvidenceFromComments } from "../reconcile.mjs";
```

### `.github/coordinator/test/linear-issues.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
13: } from "../reconcile.mjs";
```

### `.github/coordinator/test/merge-readiness.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
4: import { tmpdir } from 'node:os';
5: import { join } from 'node:path';
6: import { spawnSync } from 'node:child_process';
7: import * as coordinator from '../reconcile.mjs';
8: import { consumeMergeReadiness, mergeAttemptCommentBody, parseMergeAttemptsFromComments } from '../merge-readiness.mjs';
265: const child = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${pattern}$`, join(dir, 'coordinator/test/merge-readiness.test.mjs')],
```

### `.github/coordinator/test/push-broker-gitconfig.test.mjs`

```text
17: import { test } from "node:test";
18: import assert from "node:assert/strict";
19: import { execFile } from "node:child_process";
20: import { promisify } from "node:util";
21: import { mkdtempSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
22: import { tmpdir } from "node:os";
23: import { join } from "node:path";
25: import { pushExactSha, brokerGitEnv, BROKER_GIT_CONFIG_ARGS } from "../push-broker.mjs";
42: async function git(args, cwd) {
43: return execFileAsync("git", args, { cwd, env: CLEAN_ENV });
59: await git(["init", "-q", "-b", "main", "."], wt);
61: await git(["add", "a.txt"], wt);
62: await git(["commit", "-qm", "base"], wt);
63: const target_sha = (await git(["rev-parse", "HEAD"], wt)).stdout.trim();
65: await git(["add", "a.txt"], wt);
66: await git(["commit", "-qm", "worker result"], wt);
67: const result_sha = (await git(["rev-parse", "HEAD"], wt)).stdout.trim();
74: await git(["init", "-q", "--bare", legit], root);
80: await git(["init", "-q", "--bare", foreign], root);
106: await git(["cat-file", "-e", `${sha}^{commit}`], bare);
120: await git(["config", `url.file://${f.foreign}.insteadOf`, `file://${f.legit}`], f.wt);
123: assert.equal((await git(["status", "--porcelain"], f.wt)).stdout.trim(), "");
137: const ref = (await git(["rev-parse", "refs/heads/coordinator/SHU-63"], f.legit)).stdout.trim();
146: await git(["config", `url.file://${f.foreign}.insteadOf`, `file://${f.legit}`], f.wt);
149: await git(["push", `file://${f.foreign}`, `${f.result_sha}:refs/heads/coordinator/SHU-63`], f.wt);
153: const legitRef = (await git(["rev-parse", "refs/heads/coordinator/SHU-63"], f.legit)).stdout.trim();
164: writeFileSync(script, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(marker)}, ""); process.exit(1);\n`, { mode: 0o755 });
172: await git(["config", "core.sshCommand", script], f.wt);
192: await git(["config", key, script], f.wt);
208: await git(["config", "include.path", included], f.wt);
356: const ref = (await git(["rev-parse", "refs/heads/coordinator/SHU-63"], f.legit)).stdout.trim();
359: const refs = (await git(["for-each-ref", "--format=%(refname)"], f.legit)).stdout.trim().split("\n");
392: await git(["push", `file://${f.legit}`, `${f.target_sha}:refs/heads/coordinator/SHU-63`], f.wt);
398: const ref = (await git(["rev-parse", "refs/heads/coordinator/SHU-63"], f.legit)).stdout.trim();
405: const tree = (await git(["rev-parse", "HEAD^{tree}"], f.wt)).stdout.trim();
406: const unrelated = (await git(["commit-tree", tree, "-m", "not ours"], f.wt)).stdout.trim();
407: await git(["push", `file://${f.legit}`, `${unrelated}:refs/heads/coordinator/SHU-63`], f.wt);
417: const ref = (await git(["rev-parse", "refs/heads/coordinator/SHU-63"], f.legit)).stdout.trim();
432: writeFileSync(script, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(marker)}, ""); process.stdin.pipe(process.stdout);\n`, { mode: 0o755 });
439: await git(["add", ".gitattributes"], f.wt);
440: await git(["commit", "-qm", "attrs"], f.wt);
441: const result_sha = (await git(["rev-parse", "HEAD"], f.wt)).stdout.trim();
442: await git(["config", "filter.p.clean", script], f.wt);
464: const tree = (await git(["rev-parse", "HEAD^{tree}"], f.wt)).stdout.trim();
465: const stray = (await git(["commit-tree", tree, "-m", "does not descend from target"], f.wt)).stdout.trim();
467: await git(["push", `file://${f.legit}`, `${stray}:refs/heads/coordinator/SHU-63`], f.wt);
485: const tree = (await git(["rev-parse", "HEAD^{tree}"], f.wt)).stdout.trim();
487: const orphan = (await git(["commit-tree", tree, "-m", "orphan result"], f.wt)).stdout.trim();
488: await git(["checkout", "-q", orphan], f.wt);          // worktree HEAD === result_sha
489: await git(["replace", "--graft", orphan, f.target_sha], f.wt);
492: await git(["merge-base", "--is-ancestor", f.target_sha, orphan], f.wt);
```

### `.github/coordinator/test/push-broker.test.mjs`

```text
14: import { test } from "node:test";
15: import assert from "node:assert/strict";
16: import { mkdirSync, mkdtempSync } from "node:fs";
17: import { tmpdir } from "node:os";
18: import { join } from "node:path";
23: } from "../push-broker.mjs";
40: // A scriptable git(1) executor. `fn(binary, args, opts, cb)` matches the
```

### `.github/coordinator/test/receipt-clock.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import { tmpdir } from "node:os";
5: import { join } from "node:path";
6: import { spawnSync } from "node:child_process";
7: import { createReceipt, nextReceiptState, foldLaunchOutcome } from "../reconcile.mjs";
8: import { createEpisodeHarness } from "./fixture/episode-harness.mjs";
98: const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, join(dir, "test", file)],
```

### `.github/coordinator/test/receipt-state.test.mjs`

```text
6: import { test } from "node:test";
7: import assert from "node:assert/strict";
17: } from "../reconcile.mjs";
```

### `.github/coordinator/test/reseed-append-contract.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import { spawnSync } from 'node:child_process';
7: import { createHash } from 'node:crypto';
8: import * as contract from '../reseed-append-contract.mjs';
35: const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, input, env: { ...process.env,
73: return { refs: txt(f.git(['show-ref'])), objects: txt(f.git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])),
74: counts: txt(f.git(['count-objects', '-v'])), status: txt(f.git(['status', '--porcelain'])) };
113: const historical = f.git(['cat-file', 'commit', f.parent]);
118: const git = (args, options) => { calls.push(args); return f.git(args, options); };
123: assert.equal(txt(f.git(['rev-parse', 'refs/heads/coordinator/SHU-140'])), binding.expected_seed_head, 'RESEED exact resulting SHA');
124: const raw = f.git(['cat-file', 'commit', binding.expected_seed_head]);
126: for (const write of [[], ['-w']]) assert.equal(txt(f.git(['hash-object', '-t', 'commit', ...write, '--stdin'], { input: raw })), binding.expected_seed_head);
127: assert.deepEqual(f.git(['cat-file', 'commit', f.parent]), historical, 'RESEED prior history verbatim');
128: f.git(['merge-base', '--is-ancestor', f.parent, binding.expected_seed_head]);
133: assert.equal(txt(f.git(['rev-parse', `${binding.expected_seed_head}:${name}`])), hash);
134: assert.deepEqual(f.git(['show', `${f.parent}:${name}`]), f.git(['show', `${binding.expected_seed_head}:${name}`]), 'RESEED sealed bytes preserved');
137: f.git(['merge-tree', '--write-tree', f.parent, f.revision]);
146: f.git(['merge-tree', '--write-tree', f.parent, f.revision], options);
169: const driftId = txt(f.git(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: drift }));
172: const git = (args, options) => args[0] === 'rev-parse' && args[1] === '--show-object-format' ? Buffer.from('sha256\n') : f.git(args, options);
179: if (args[0] === 'update-ref') return f.git([...args.slice(0, 3), f.base], options);
180: return f.git(args, options);
183: assert.equal(txt(f.git(['rev-parse', 'refs/heads/coordinator/SHU-140'])), f.parent, 'RESEED bad CAS leaves branch unchanged');
185: assert.equal(txt(f.git(['cat-file', '-t', f.binding.expected_seed_head])), 'commit', 'RESEED pre-CAS crash leaves installed object only');
193: assert.equal(txt(f.git(['rev-parse', 'refs/heads/coordinator/SHU-140'])), f.parent, 'RESEED refusal precedes history update');
201: const parent = txt(f.git(['rev-parse', 'HEAD']));
205: const revision = txt(f.git(['rev-parse', 'HEAD'])), before = snapshot(f);
218: const revision = txt(f.git(['rev-parse', 'HEAD']));
231: const gitlink = txt(f.git(['mktree'], { input: Buffer.from(`160000 commit ${f.parent}\tmodule\n`) }));
233: const empty = txt(f.git(['mktree'], { input: Buffer.alloc(0) }));
234: const tree = txt(f.git(['mktree'], { input: Buffer.from(`040000 tree ${empty}\tempty\n`) }));
249: const id = txt(f.git(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: Buffer.from(bytes) }));
255: const revision = txt(f.git(['rev-parse', 'HEAD']));
347: assert.equal(txt(f.git(['rev-parse', ref])), f.binding.expected_parent);
351: assert.equal(txt(f.git(['rev-parse', ref])), f.binding.expected_seed_head);
362: f.git(['update-ref', ref, f.base, f.binding.expected_seed_head]);
372: assert.equal(txt(f.git(['rev-parse', ref])), f.base);
```

### `.github/coordinator/test/reseed-append-mutations.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import { spawnSync } from 'node:child_process';
27: const run = () => spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${pattern}$`, path.join(root, 'test/reseed-append-contract.test.mjs')],
35: const syntax = spawnSync(process.execPath, ['--check', target], { env, encoding: 'utf8' });
```

### `.github/coordinator/test/review-routing.test.mjs`

```text
8: import { test } from "node:test";
9: import assert from "node:assert/strict";
25: } from "../review-routing.mjs";
```

### `.github/coordinator/test/reviewer-evidence.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { pathToFileURL } from "node:url";
7: import { spawnSync } from "node:child_process";
11: } from "../adapters/claude-code.mjs";
12: import { runReviewEvidence } from "../review-execution.mjs";
13: import { bounded, MAX_CAPTURE_BYTES } from "../review-execution-child.mjs";
14: import { CANONICAL_SEED, inspectFixtureSeed, SEED_MARKER } from "../fixture-seed.mjs";
15: import { createReceipt, foldLaunchOutcome } from "../reconcile.mjs";
16: import { createEpisodeHarness, SHA_INPUT, SHA_WRITE } from "./fixture/episode-harness.mjs";
239: const actual = spawnSync(process.execPath, ["--test", ...files], {
251: const result = await runReviewEvidence({
308: fs.writeFileSync(unconfinedWrapper, `#!/bin/sh\nprintf ran > ${JSON.stringify(wrapperMarker)}\nshift 7\nexec "$@"\n`, { mode: 0o700 });
312: const result = await runReviewEvidence({
348: const seeded = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { scanVacuousTests } from "../scan-vacuous.mjs";\n${CANONICAL_SEED}\n`;
362: const run = spawnSync(process.execPath, ["--test", "tools/fixture/test/scan-vacuous.test.mjs"], { cwd: root, encoding: "utf8" });
417: const result = await runReviewEvidence({
444: const refused = await runReviewEvidence({
```

### `.github/coordinator/test/schema.test.mjs`

```text
2: import { test } from "node:test";
3: import assert from "node:assert/strict";
4: import { validateReceipt, createReceipt, nextReceiptState, receiptCommentBody, parseReceiptCommentBody, STAGES } from "../reconcile.mjs";
```

### `.github/coordinator/test/shu219-rule6-mutation.test.mjs`

```text
4: import { test } from "node:test";
5: import assert from "node:assert/strict";
6: import fs from "node:fs";
7: import { spawnSync } from "node:child_process";
8: import { tmpdir } from "node:os";
9: import { join } from "node:path";
10: import { fileURLToPath, pathToFileURL } from "node:url";
48: const child = spawnSync(process.execPath, ["--input-type=module", "-e", scenario], { encoding: "utf8", timeout: 30000 });
```

### `.github/coordinator/test/shu224-dispatch-scope.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import { spawnSync } from "node:child_process";
5: import { tmpdir } from "node:os";
6: import { join } from "node:path";
7: import { fileURLToPath, pathToFileURL } from "node:url";
16: } from "../reconcile.mjs";
288: const child = spawnSync(process.execPath, [probePath], { encoding: "utf8", timeout: 30000 });
```

### `.github/coordinator/test/shu226-incident-reporting.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
8: } from "../reconcile.mjs";
20: } from "../incident-reporting.mjs";
21: import { createEpisodeHarness, SHA_INPUT, SHA_WRITE, SHA_REVISED, REVISION } from "./fixture/episode-harness.mjs";
```

### `.github/coordinator/test/shu226-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
7: import { fileURLToPath } from "node:url";
110: const run = spawnSync(process.execPath, [
```

### `.github/coordinator/test/shu232-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
92: const run = spawnSync(process.execPath, [
```

### `.github/coordinator/test/shu237-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
166: const run = spawnSync(process.execPath, [
```

### `.github/coordinator/test/shu237-portability.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { runReviewEvidence, validateReviewWrapper } from "../review-execution.mjs";
97: fs.writeFileSync(sudoTarget, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
98: fs.writeFileSync(sandboxTarget, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
126: const result = await runReviewEvidence({
219: const result = await runReviewEvidence({
```

### `.github/coordinator/test/shu239-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
60: const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${mutation.pattern}`,
```

### `.github/coordinator/test/shu239-reviewer-launch.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
7: import { buildClaudeArgs, buildClaudeEnvironment, launchBuilder } from "../adapters/claude-code.mjs";
8: import { runReviewEvidence } from "../review-execution.mjs";
116: const result = await runReviewEvidence({ attempt_id: ATTEMPT, target_sha: SHA, cwd: f.workspace, env: f.env, ...safeProbes,
127: const refused = await runReviewEvidence({ attempt_id: ATTEMPT, target_sha: SHA, cwd: f.workspace, env: f.env, ...safeProbes,
135: const writable = await runReviewEvidence({ attempt_id: ATTEMPT, target_sha: SHA, cwd: f.workspace, env: f.env, ...safeProbes,
148: const wrongAttempt = await runReviewEvidence({ attempt_id: "23923923-9239-4239-8239-239239239230", target_sha: SHA,
162: const syntax = spawnSync("bash", ["-n", script.pathname], { encoding: "utf8" });
164: const refused = spawnSync("bash", [script.pathname, "node", "--test"], { encoding: "utf8" });
```

### `.github/coordinator/test/shu240-evidence-binding.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { pathToFileURL } from "node:url";
11: } from "../adapters/claude-code.mjs";
12: import { createReceipt, foldLaunchOutcome } from "../reconcile.mjs";
13: import { routeSuccessorFromReceipts } from "../review-routing.mjs";
```

### `.github/coordinator/test/shu240-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
34: const run = spawnSync(process.execPath, [
```

### `.github/coordinator/test/shu241-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import path from "node:path";
5: import { tmpdir } from "node:os";
6: import { spawnSync } from "node:child_process";
16: ["M3 full tree bundled instead of scoped tree", "attempt-workspace.mjs", 'git(["read-tree", "--empty"]);', 'git(["read-tree", target_sha]);', "SHU-241 A2:"],
17: ["M4 scoped base given the full target as parent", "attempt-workspace.mjs", 'const scopedBase = git(["-c", "commit.gpgSign=false", "commit-tree", tree, "-m", scopedCommitMessage(target_sha, scope.paths)]);\n    if (git(["rev-list", "--parents", "-n", "1", scopedBase]) !== scopedBase) throw new Error("scoped base must be parentless");', 'const scopedBase = git(["-c", "commit.gpgSign=false", "commit-tree", tree, "-p", target_sha, "-m", scopedCommitMessage(target_sha, scope.paths)]);', "SHU-241 A2:"],
19: ["M6 scoped snapshot starts empty", "workspace-result.mjs", 'await git("read-tree", workspace_scope === "scoped" ? target_sha : "--empty");', 'await git("read-tree", "--empty");', "SHU-241 A3"],
31: ["M18 reviewer missing-object check removed", "attempt-workspace.mjs", 'git(["fsck", "--full", "--no-dangling"]);', 'git(["rev-parse", "HEAD"]);', "SHU-241 A7"],
48: const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, path.join(dir, "test/shu241-scoped-build.test.mjs")],
```

### `.github/coordinator/test/shu241-scoped-build.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import path from "node:path";
5: import { tmpdir } from "node:os";
6: import { execFileSync, spawnSync } from "node:child_process";
7: import { randomUUID } from "node:crypto";
8: import { deriveScopedBaseCommit, deriveScopedBaseShaFromRemote, prepareAttemptWorkspace, REMOTE_RETIRE_ARGS, workspaceBindingConflicts } from "../attempt-workspace.mjs";
9: import { pushExactSha } from "../push-broker.mjs";
10: import { validateScopedResultDiff } from "../workspace-result.mjs";
11: import { baseBundlePath, BaseBundleUnavailableError } from "../base-bundle.mjs";
12: import { callbackBindingValid, createReceipt, foldLaunchOutcome, nextReceiptState, preparedLaunchOptions, receiptCommentBody, validateReceipt } from "../reconcile.mjs";
13: import { createEpisodeHarness } from "./fixture/episode-harness.mjs";
14: import * as claude from "../adapters/claude-code.mjs";
15: import { parseWorkOrderDirective, renderWorkOrderDirective, routeSuccessorFromReceipts } from "../review-routing.mjs";
22: } from "../workspace-scope.mjs";
27: const worker = (cwd, ...args) => spawnSync(wrapper.split(" ")[0], [...wrapper.split(" ").slice(1), ...args], {
30: const canSwitch = worker("/", "id", "-u").status === 0;
31: const git = (cwd, ...args) => execFileSync("git", ["-c", `safe.directory=${cwd}`, ...args], {
37: const remote = path.join(dir, "BAWES-Universe", "studenthub-platform.git"); fs.mkdirSync(path.dirname(remote)); git(dir, "init", "--bare", remote);
38: const seed = path.join(dir, "seed"); git(dir, "init", seed); git(seed, "config", "user.name", "Fixture"); git(seed, "config", "user.email", "fixture@example.invalid");
45: git(seed, "add", "."); git(seed, "commit", "-m", "fixture"); const sha = git(seed, "rev-parse", "HEAD"); const hiddenBlob = git(seed, "rev-parse", `${sha}:${SHU140_TRAP_PATH}`);
46: git(seed, "push", remote, `HEAD:refs/heads/${BRANCH}`);
60: const source = path.join(f.dir, `source-${randomUUID()}`); git(f.dir, "init", "--bare", source);
61: git(source, "fetch", "--no-tags", `file://${f.remote}`, f.sha); git(source, "update-ref", "refs/heads/bound", f.sha); git(source, "symbolic-ref", "HEAD", "refs/heads/bound");
62: git(source, "bundle", "create", path.join(f.state, `${attemptId}.base.bundle`), "refs/heads/bound"); fs.chmodSync(path.join(f.state, `${attemptId}.base.bundle`), 0o600);
64: git(source, "update-ref", "refs/heads/scoped", scoped_base_sha); git(source, "symbolic-ref", "HEAD", "refs/heads/scoped");
65: const bundle = path.join(source, "scoped.bundle"); git(source, "bundle", "create", bundle, "refs/heads/scoped");
66: const cwd = path.join(f.root, attemptId); git(f.root, "clone", "--no-local", "--no-checkout", "--template=", "--", bundle, cwd);
67: git(cwd, "checkout", "--detach", scoped_base_sha, "--"); git(cwd, "config", "--remove-section", "remote.origin");
91: git(f.seed, "add", "README.md"); git(f.seed, "commit", "-m", "hidden-only target change");
92: const changedTarget = git(f.seed, "rev-parse", "HEAD");
95: assert.equal(git(cwd, "rev-list", "--parents", "-n", "1", "HEAD"), scoped_base_sha, "scoped base is parentless");
98: assert.equal(git(cwd, "remote"), "", "scoped bundle checkout retains no remote");
99: const read = spawnSync("git", ["-C", cwd, "cat-file", "-p", f.hiddenBlob], { encoding: "utf8" });
101: assert.notEqual(spawnSync("git", ["-C", cwd, "cat-file", "-e", `${f.sha}^{commit}`]).status, 0, "full target commit must not reach the worker object store");
102: const names = git(cwd, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
112: assert.doesNotThrow(() => git(cwd, "fsck", "--full", "--no-dangling"));
114: const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
117: const stage = spawnSync("git", ["-C", cwd, "add", "--", SHU140_INITIAL_BUILD_PATHS[0]], { encoding: "utf8" });
126: assert.equal(worker(cwd, "git", "-C", cwd, "cat-file", "-p", f.hiddenBlob).status === 0, false, "worker cannot recover a hidden blob");
127: assert.equal(worker(cwd, "git", "-C", cwd, "cat-file", "-e", `${f.sha}^{commit}`).status === 0, false, "worker cannot recover the full target commit");
128: assert.equal(worker(cwd, "git", "-C", cwd, "status", "--porcelain").status, 0, "ordinary scoped bundle repository remains usable");
140: const names = git(f.remote, "diff", "--name-status", f.sha, result.remote_head);
142: assert.equal(git(f.remote, "show", `${result.remote_head}:${SHU140_TRAP_PATH}`), "SHU241_HIDDEN_SENTINEL", "hidden base entry is preserved, not deleted");
143: assert.equal(git(f.remote, "rev-parse", `${result.remote_head}^`), f.sha, "scoped and full flows retain the exact bound parent");
158: assert.equal(git(f.remote, "rev-parse", `refs/heads/${BRANCH}`), result.remote_head);
159: assert.equal(git(f.remote, "rev-parse", `${result.remote_head}^`), f.sha);
160: assert.equal(git(f.remote, "show", `${result.remote_head}:${SHU140_TRAP_PATH}`), "SHU241_HIDDEN_SENTINEL");
161: assert.equal(git(f.remote, "diff", "--name-only", f.sha, result.remote_head), SHU140_INITIAL_BUILD_PATHS[0]);
189: assert.equal(git(f.remote, "rev-parse", `refs/heads/${BRANCH}`), f.sha);
252: const before = git(f.remote, "rev-parse", `refs/heads/${BRANCH}`);
257: assert.equal(git(f.remote, "rev-parse", `refs/heads/${BRANCH}`), before, `${name}: scope refusal cannot advance the remote`);
346: assert.doesNotThrow(() => git(cwd, "fsck", "--full", "--no-dangling"));
347: assert.equal(git(cwd, "rev-parse", "HEAD"), f.sha);
```

### `.github/coordinator/test/shu245-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
58: const run = spawnSync(process.execPath, [
```

### `.github/coordinator/test/shu245-reviewer-citations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { pathToFileURL } from "node:url";
7: import { launchBuilder, validateCallback } from "../adapters/claude-code.mjs";
```

### `.github/coordinator/test/shu246-episode-backfill.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import { readFileSync } from "node:fs";
10: } from "../reconcile.mjs";
14: } from "../single-run-activation.mjs";
19: } from "../review-routing.mjs";
20: import { createEpisodeHarness } from "./fixture/episode-harness.mjs";
```

### `.github/coordinator/test/shu246-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
50: const run = spawnSync(process.execPath, [
```

### `.github/coordinator/test/shu247-callback-notes.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
7: } from "../reconcile.mjs";
```

### `.github/coordinator/test/shu247-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
46: const run = spawnSync(process.execPath, [
```

### `.github/coordinator/test/shu249-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import path from "node:path";
5: import { spawnSync } from "node:child_process";
27: const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, path.join(dir, "test/shu249-role-authority.test.mjs")], { encoding: "utf8", timeout: 30000, env });
```

### `.github/coordinator/test/shu249-role-authority.test.mjs`

```text
1: import { test, mock } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import path from "node:path";
5: import { execFileSync } from "node:child_process";
6: import { LANE_NAMES, RUNTIMES, ROLES, laneForRuntimeRole, resolveReceiptRoleAuthority } from "../launch-vocabulary.mjs";
7: import { createReceipt, validateReceipt, receiptCommentBody, parseReceiptCommentBody, adapterNameFor, parseReceiptsFromComments, preparedLaunchOptions } from "../reconcile.mjs";
8: import { validWorkOrder, reviewVerdictProvenanceValid, routeSuccessorFromReceipts } from "../review-routing.mjs";
9: import { initialWorkspaceScope, normalizeReceiptWorkspaceScope } from "../workspace-scope.mjs";
10: import { deriveScopedBaseCommit, prepareAttemptWorkspace } from "../attempt-workspace.mjs";
11: import { CapacityScheduler } from "../capacity-scheduler.mjs";
12: import * as claude from "../adapters/claude-code.mjs";
58: const dir = temp(t), git = (cwd, ...args) => execFileSync("git", ["-c", `safe.directory=${cwd}`, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
59: const seed = path.join(dir, "seed"); fs.mkdirSync(seed); git(seed, "init"); git(seed, "config", "user.name", "Fixture"); git(seed, "config", "user.email", "fixture@example.invalid");
60: fs.writeFileSync(path.join(seed, "allowed.txt"), "allowed\n"); fs.writeFileSync(path.join(seed, "hidden.txt"), "hidden\n"); git(seed, "add", "."); git(seed, "commit", "-m", "fixture");
61: const sha = git(seed, "rev-parse", "HEAD"), scoped = deriveScopedBaseCommit({ source: seed, target_sha: sha, allowed_paths: ["allowed.txt"] });
62: const remote = path.join(dir, "BAWES-Universe", "studenthub-platform.git"); fs.mkdirSync(path.dirname(remote)); git(seed, "clone", "--bare", seed, remote);
64: const wrapper = path.join(dir, "wrapper"); fs.writeFileSync(wrapper, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
74: assert.equal(git(result.cwd, "rev-parse", "HEAD"), scoped); assert.equal(fs.existsSync(path.join(result.cwd, "hidden.txt")), false);
```

### `.github/coordinator/test/shu260-incident-triage.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import path from "node:path";
5: import { fileURLToPath } from "node:url";
6: import { createReceipt, receiptCommentBody } from "../reconcile.mjs";
7: import { createEpisodeHarness, REVISION, SHA_WRITE } from "./fixture/episode-harness.mjs";
22: } from "../incident-triage.mjs";
```

### `.github/coordinator/test/shu260-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
7: import { fileURLToPath } from "node:url";
80: const run = spawnSync(process.execPath, [
```

### `.github/coordinator/test/shu261-cleanup-network.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import { spawnSync } from "node:child_process";
5: import { assertReviewerSandboxContract } from "../service/reviewer-isolation.mjs";
15: return spawnSync("/bin/bash", ["-p", "-c", `
82: const run = spawnSync("/bin/bash", ["-p", "-c", `
```

### `.github/coordinator/test/shu261-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
87: from: "#!/bin/bash -p", to: "#!/bin/bash",
91: from: "#!/bin/bash -p", to: "#!/usr/bin/env bash", pattern: "SHU261 wrapper contract" },
106: const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${mutation.pattern}`,
```

### `.github/coordinator/test/shu261-review-findings.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import vm from 'node:vm';
7: import { spawnSync } from 'node:child_process';
8: import { processCanaryMarker, runReviewEvidence, validateReviewWrapper } from '../review-execution.mjs';
9: import { inheritedDescriptorDenied, processInspectionDenied } from '../review-execution-child.mjs';
10: import { PROTECTED_CLASSES } from '../service/reviewer-isolation.mjs';
11: import { finalizeHostValidation } from '../service/reviewer-host-validation.mjs';
13: import { resolveCvtsudoers } from '../service/host-suite-contract.mjs';
20: const run = spawnSync('git', ['show', `f3f89f5f50954eec8190ce69c46ba384fd603dae:${relativePath}`], { encoding: 'utf8' });
58: spawnSync: () => { calls++; const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return spawnSync(process.execPath, ['--test', builderTest], { env, encoding: 'utf8' }); },
153: const result = await runReviewEvidence({ attempt_id: attempt, target_sha: '6'.repeat(40), cwd: workspace,
```

### `.github/coordinator/test/shu261-reviewer-isolation.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import os from "node:os";
5: import path from "node:path";
6: import { spawn, spawnSync } from "node:child_process";
7: import { pathToFileURL } from "node:url";
8: import { launchBuilder, validateCallback } from "../adapters/claude-code.mjs";
9: import { processCanaryMarker, runReviewEvidence, runtimeIsolationEvidenceValid } from "../review-execution.mjs";
10: import { environmentValueDenied, inheritedDescriptorDenied, processInspectionDenied, protectedProbes } from "../review-execution-child.mjs";
11: import { PROTECTED_CLASSES, REVIEWER_IDENTITIES, REVIEWER_LAYOUT, assertIsolationEvidence, assertReviewerSandboxContract } from "../service/reviewer-isolation.mjs";
12: import { readOnlyHostPreflight } from "../service/reviewer-isolation.mjs";
13: import { finalizeHostValidation } from "../service/reviewer-host-validation.mjs";
66: assert.match(source, /^#!\/bin\/bash -p$/m,
68: assert.doesNotMatch(source, /^#!\/usr\/bin\/env\s+/m,
99: fs.writeFileSync(fakeBash, `#!/bin/sh\nprintf PATH > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
102: const run = spawnSync(script.pathname, ["invalid"], {
152: const result = await runReviewEvidence({
317: const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", processCanary], { stdio: "ignore" });
378: assert.ok(fs.readFileSync(`/proc/${marker.pid}/cmdline`, "utf8").includes(canary),
```

### `.github/coordinator/test/shu68-wiring.test.mjs`

```text
16: import { test } from "node:test";
17: import assert from "node:assert/strict";
18: import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
19: import { tmpdir } from "node:os";
20: import { join } from "node:path";
31: } from "../reconcile.mjs";
42: } from "../review-routing.mjs";
```

### `.github/coordinator/test/shu71-activation-package.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import path from "node:path";
5: import os from "node:os";
6: import { spawnSync } from "node:child_process";
7: import { sign } from "node:crypto";
13: } from "../shu71-activation-package.mjs";
15: import { ephemeralPublicSource } from "./fixture/ephemeral-public-source.mjs";
256: const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=^${pattern}:`, path.join(root, "test/shu71-activation-package.test.mjs")],
267: import { killExecutionMutant } from './fixture/execution-mutants.mjs';
284: const observed = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
```

### `.github/coordinator/test/shu71-battery.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import { tmpdir } from 'node:os';
5: import { join } from 'node:path';
6: import { EventEmitter } from 'node:events';
7: import { spawn, spawnSync } from 'node:child_process';
8: import { pathToFileURL } from 'node:url';
9: import { runInNewContext } from 'node:vm';
10: import { once } from 'node:events';
11: import { RUNTIMES, ROLES, RUNTIME_ROLE_SUPPORT, laneForRuntimeRole, resolveReceiptRoleAuthority } from '../launch-vocabulary.mjs';
12: import { createReceipt, validateReceipt, foldLaunchOutcome, receiptCommentBody, parseReceiptCommentBody, parseReceiptsFromComments, main } from '../reconcile.mjs';
13: import { validWorkOrder, routeSuccessorFromReceipts } from '../review-routing.mjs';
14: import { CapacityScheduler } from '../capacity-scheduler.mjs';
15: import { DurableSupervisor, signedSupervisorRequest } from '../supervisor.mjs';
16: import { supervisorOrder } from '../supervisor-dispatch.mjs';
17: import { createEpisodeHarness, SHA_INPUT, SHA_WRITE } from './fixture/episode-harness.mjs';
141: const child = working ? spawn(process.execPath, ['-e', `
253: const child = spawn(process.execPath, [worker, dir, JSON.stringify(order)],
331: const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, join(dir, 'test/shu71-battery.test.mjs')],
```

### `.github/coordinator/test/shu71-public-key.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import path from 'node:path';
5: import { fileURLToPath } from 'node:url';
6: import { spawnSync } from 'node:child_process';
7: import { loadShu71PublicKey, SHU71_PUBLIC_KEY_PATH } from '../shu71-public-key.mjs';
8: import { publicKeyFingerprint, validateAnchor as validateBoundAnchor, validateShu71Package } from '../shu71-activation-package.mjs';
9: import { validateTwoFixtureActivation } from '../two-fixture-activation.mjs';
90: const run = spawnSync(process.execPath, ['--input-type=module', '-e',
91: "import assert from 'node:assert/strict'; import {loadShu71PublicKey} from './shu71-public-key.mjs'; assert.throws(() => loadShu71PublicKey(), /ACT_PUBLIC_KEY_PATH:/, 'ACT_PUBLIC_KEY_MISSING_MUTATION');"],
111: const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${pattern}:`, path.join(root, 'test/shu71-public-key.test.mjs')],
```

### `.github/coordinator/test/shu73-enforcement.test.mjs`

```text
9: import { test } from "node:test";
10: import assert from "node:assert/strict";
11: import fs from "node:fs";
12: import { spawnSync } from "node:child_process";
13: import { tmpdir } from "node:os";
14: import { join } from "node:path";
15: import { fileURLToPath } from "node:url";
17: import { workerIdentity as claudeWorkerIdentity } from "../adapters/claude-code.mjs";
18: import { workerIdentity as codexWorkerIdentity } from "../adapters/codex-cli.mjs";
19: import { reviewVerdictProvenanceValid } from "../review-routing.mjs";
20: import { nextReceiptState } from "../reconcile.mjs";
183: const child = spawnSync(process.execPath, ["--input-type=module", "-e", scenario], { encoding: "utf8", timeout: 30_000 });
```

### `.github/coordinator/test/shu86-durable-intent.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import { tmpdir } from 'node:os';
5: import { join } from 'node:path';
6: import { EventEmitter } from 'node:events';
7: import { spawnSync } from 'node:child_process';
8: import { DurableSupervisor, signedSupervisorRequest } from '../supervisor.mjs';
9: import { readableTaskStatus } from '../capacity-scheduler.mjs';
10: import { requireHoldCode } from '../intended-work.mjs';
11: import { carriedSupervisorOutcome, supervisorAdapter } from '../supervisor-dispatch.mjs';
161: const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, join(dir, 'test/shu86-durable-intent.test.mjs')],
```

### `.github/coordinator/test/single-run-activation.test.mjs`

```text
14: import { test } from "node:test";
15: import assert from "node:assert/strict";
16: import fs from "node:fs";
17: import { spawnSync } from "node:child_process";
18: import { tmpdir } from "node:os";
19: import { join } from "node:path";
20: import { fileURLToPath, pathToFileURL } from "node:url";
32: } from "../single-run-activation.mjs";
33: import { routeSuccessorFromReceipts } from "../review-routing.mjs";
41: } from "../reconcile.mjs";
895: import assert from "node:assert/strict";
896: import fs from "node:fs";
897: import os from "node:os";
898: import path from "node:path";
899: import * as mod from MODULE_URL;
1114: const child = spawnSync(process.execPath, [probePath], { encoding: "utf8", timeout: 30000 });
```

### `.github/coordinator/test/supervisor-dispatch.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import { EventEmitter } from "node:events";
4: import fs from "node:fs";
5: import { tmpdir } from "node:os";
6: import { join } from "node:path";
7: import { spawnSync } from "node:child_process";
8: import { DurableSupervisor, signedSupervisorRequest, SUPERVISOR_PROTOCOL_VERSION } from "../supervisor.mjs";
9: import { carriedSupervisorOutcome, supervisorOrder } from "../supervisor-dispatch.mjs";
10: import { runFixtureDriver, restoreFixture } from "../fixture-driver.mjs";
11: import { createEpisodeHarness, SHA_INPUT, SHA_WRITE } from "./fixture/episode-harness.mjs";
195: const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, join(dir, "test/supervisor-dispatch.test.mjs")], { env, encoding: "utf8", timeout: 15000 });
```

### `.github/coordinator/test/supervisor.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import { EventEmitter } from "node:events";
4: import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
5: import { tmpdir } from "node:os";
6: import { dirname, join } from "node:path";
16: } from "../supervisor.mjs";
353: await listenSupervisor({ supervisor: instance, socketPath, serverFactory: () => fakeServer });
368: await listenSupervisor({
394: await listenSupervisor({
424: server = await listenSupervisor({ supervisor: instance, socketPath });
```

### `.github/coordinator/test/two-fixture-activation.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import path from 'node:path';
5: import { tmpdir } from 'node:os';
6: import { spawnSync } from 'node:child_process';
7: import { generateKeyPairSync, sign } from 'node:crypto';
8: import { validateTwoFixtureActivation, reviewedActivationBytes } from '../two-fixture-activation.mjs';
9: import { readTwoFixtureEvidence } from '../two-fixture-evidence.mjs';
10: import { singleRunActivationStatus } from '../single-run-activation.mjs';
11: import { dispatchEnabledFor, main } from '../reconcile.mjs';
13: import { ephemeralPublicSource } from './fixture/ephemeral-public-source.mjs';
136: const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${code}:`, path.join(dir, 'test/two-fixture-activation.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
158: const result = spawnSync(exe, [args[0], args[1], prelude + args[2]], options);
170: import { killExecutionMutant } from './fixture/execution-mutants.mjs';
182: const observed = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
206: const git = (...args) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
208: git('init'); git('config', 'user.name', 'B3 isolated test'); git('config', 'user.email', 'b3@example.invalid');
209: git('commit', '--allow-empty', '-m', 'signed seed'); const seed = git('rev-parse', 'HEAD');
213: git('commit', '--allow-empty', '-m', 'authorized build descendant'); const descendant = git('rev-parse', 'HEAD');
214: git('merge-base', '--is-ancestor', seed, descendant); x.heads[x.record.fixtures[0].branch] = descendant;
```

### `.github/coordinator/test/two-fixture-lanes.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import { tmpdir } from "node:os";
5: import path from "node:path";
6: import { spawnSync } from "node:child_process";
7: import { main, resolveAuthorizationRef, resolveDispatchScope, selectNextReservation } from "../reconcile.mjs";
8: import { initialWorkspaceScope, successorWorkspaceScope, resolveFixtureLane, normalizeReceiptWorkspaceScope, validateFixtureScopePolicy } from "../workspace-scope.mjs";
9: import { routeSuccessorFromReceipts } from "../review-routing.mjs";
10: import { prepareAttemptWorkspace } from "../attempt-workspace.mjs";
11: import { singleRunActivationStatus } from "../single-run-activation.mjs";
145: const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, path.join(dir, "test/two-fixture-lanes.test.mjs")], { env, encoding: "utf8", timeout: 30000 });
```

### `.github/coordinator/test/two-fixture-progression.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import path from 'node:path';
5: import { tmpdir } from 'node:os';
6: import { execFile, execFileSync, spawnSync } from 'node:child_process';
7: import { randomUUID, sign } from 'node:crypto';
8: import { ephemeralPublicSource } from './fixture/ephemeral-public-source.mjs';
9: import { reviewedActivationBytes } from '../two-fixture-activation.mjs';
10: import { singleRunActivationStatus } from '../single-run-activation.mjs';
11: import { createReceipt, receiptCommentBody, parseReceiptsFromComments, validateReceipt } from '../reconcile.mjs';
12: import { pushExactSha } from '../push-broker.mjs';
13: import { readProgressionPush } from '../two-fixture-progression.mjs';
18: const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
24: git(root, 'init', wt); git(wt, 'config', 'user.name', 'Isolated B3'); git(wt, 'config', 'user.email', 'b3@example.invalid');
25: fs.writeFileSync(path.join(wt, 'content'), 'seed'); git(wt, 'add', '.'); git(wt, 'commit', '-m', 'seed');
26: const seed = git(wt, 'rev-parse', 'HEAD');
28: fs.mkdirSync(path.dirname(remote)); git(root, 'init', '--bare', remote);
36: for (const f of record.fixtures) git(wt, 'push', remote, `${seed}:refs/heads/${f.branch}`);
49: fixtureHeadResolver: branch => git(remote, 'rev-parse', `refs/heads/${branch}`),
50: fixtureAncestryResolver: (base, head) => spawnSync('git', ['-C', remote, 'merge-base', '--is-ancestor', base, head]).status === 0,
66: git(wt, 'reset', '--hard', r.target_sha);
72: return execFile(exe, args, options, callback);
76: git(wt, 'fetch', remote, `refs/heads/${r.branch}`);
104: assert.equal(h.git(h.remote, 'rev-parse', 'refs/heads/coordinator/SHU-254'), h.seed, 'B3_ONE_LANE_ADVANCEMENT');
115: REWIND: h => { h.git(h.remote, 'update-ref', 'refs/heads/coordinator/SHU-140', h.seed); return {}; },
166: const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${pattern}:`, path.join(dir, 'test/two-fixture-progression.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
175: import { createEpisodeHarness } from './fixture/episode-harness.mjs';
176: import { activationDigest } from '../two-fixture-progression.mjs';
177: import { readFixtureAncestry } from '../two-fixture-evidence.mjs';
206: return execFileSync(exe, [args[0], args[1], prelude + args[2]], opts);
225: import { nextReceiptState, receiptCommentActorId, RECEIPT_IMMUTABLE_FIELDS } from '../reconcile.mjs';
258: fixtureHeadResolver: branch => f.git(f.remote, 'rev-parse', `refs/heads/${branch}`),
259: fixtureAncestryResolver: (base, head) => spawnSync('git', ['-C', f.remote, 'merge-base', '--is-ancestor', base, head]).status === 0,
298: assert.equal(f.git(f.remote, 'rev-parse', 'refs/heads/coordinator/SHU-254'), f.seed, 'B3_MAIN_OTHER_LANE_UNCHANGED');
305: const tree = h.git(h.remote, 'rev-parse', `${built}^{tree}`);
306: const commit = (...parents) => h.git(h.remote, '-c', 'user.name=B3', '-c', 'user.email=b3@example.invalid', 'commit-tree', tree, ...parents, '-m', 'unauthorized');
309: h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, head);
315: h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, unrelated);
320: import { recoverTwoFixturePush } from '../two-fixture-recovery.mjs';
321: import { recoverExactSha, persistPrePush, readPrePushRecord } from '../push-broker.mjs';
324: h.git(h.wt, 'reset', '--hard', r.target_sha);
334: heads: Object.fromEntries(h.record.fixtures.map(f => [f.branch, h.git(h.remote, 'rev-parse', `refs/heads/${f.branch}`)])),
337: isAncestor: (base, head) => spawnSync('git', ['-C', h.remote, 'merge-base', '--is-ancestor', base, head]).status === 0 };
340: if (!args.includes('push')) return execFile(exe, args, opts, cb);
343: return execFile(exe, args, opts, () => cb(new Error('lost response'), '', ''));
363: h.git(h.wt, 'fetch', h.remote, `refs/heads/${r.branch}`);
378: return execFile(exe, args, options, cb);
395: const tree = h.git(h.remote, 'rev-parse', `${h.seed}^{tree}`);
396: const commit = (...parents) => h.git(h.remote, '-c', 'user.name=B3', '-c', 'user.email=b3@example.invalid', 'commit-tree', tree, ...parents, '-m', 'foreign');
399: if (head) h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, head);
400: else h.git(h.remote, 'update-ref', '-d', `refs/heads/${r.branch}`);
406: h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, h.seed);
408: h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, h.seed);
429: h.git(h.wt, 'add', '.'); h.git(h.wt, 'commit', '-m', 'local');
433: assert.equal(h.git(h.remote, 'rev-parse', `refs/heads/${r.branch}`), h.seed);
446: ${phase === 'before' ? `options.persistImpl = args => { persistPrePush(args); process.kill(process.pid, 'SIGKILL'); };` : `options.gitImpl = (exe,args,opts,cb) => execFile(exe,args,opts,(err,out,stderr) => { if(args.includes('push') && !err) process.kill(process.pid,'SIGKILL'); cb(err,out,stderr); });`}
448: const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
451: const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `import { recoverExactSha } from ${JSON.stringify(module)};
468: assert.equal(h.git(h.remote, 'rev-parse', `refs/heads/${r.branch}`), built);
513: assert.equal(h.git(h.remote, 'rev-parse', `refs/heads/${r.branch}`), h.seed);
523: h.git(h.wt, 'reset', '--hard', h.seed);
524: const tree = h.git(h.wt, 'rev-parse', 'HEAD^{tree}');
525: const orphan = h.git(h.wt, 'commit-tree', tree, '-m', 'orphan');
526: h.git(h.wt, 'reset', '--hard', orphan);
527: h.git(h.wt, 'push', '--force', h.remote, `${orphan}:refs/heads/${r.branch}`);
544: h.git(h.remote, 'update-ref', `refs/heads/${r.branch}`, built);
550: h.git(h.remote, 'update-ref', 'refs/heads/coordinator/SHU-254', built);
552: h.git(h.remote, 'update-ref', 'refs/heads/coordinator/SHU-254', h.seed);
```

### `.github/coordinator/test/two-fixture-revision-reader.test.mjs`

```text
1: import { test } from 'node:test';
2: import assert from 'node:assert/strict';
3: import fs from 'node:fs';
4: import os from 'node:os';
5: import path from 'node:path';
6: import cp from 'node:child_process';
7: import { syncBuiltinESMExports } from 'node:module';
8: import { singleRunActivationStatus } from '../single-run-activation.mjs';
9: import { BROKER_GIT_CONFIG_ARGS, brokerGitEnv } from '../push-broker.mjs';
70: function git(dir, ...args) {
71: return realExec('git', [...BROKER_GIT_CONFIG_ARGS, '-C', dir, ...args], { env: brokerGitEnv(process.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
75: git(dir, 'init', '-b', 'main');
76: git(dir, '-c', 'user.name=Reader Test', '-c', 'user.email=reader@example.invalid', 'commit', '--allow-empty', '--no-gpg-sign', '-m', name);
77: return { dir, revision: git(dir, 'rev-parse', 'HEAD') };
85: assert.throws(() => git(nested, 'rev-parse', '--verify', 'refs/heads/main'), /dubious ownership/, 'READER_OWNERSHIP_CONTROL: untrusted Git must fail');
98: assert.notEqual(cp.spawnSync('git', args, options).status, 0, 'READER_REAL_OWNER_CONTROL');
99: const out = cp.spawnSync('git', ['-c', `safe.directory=${r.dir}`, ...args], options);
116: git(r.dir, 'checkout', '--detach');
117: git(r.dir, '-c', 'user.name=Reader Test', '-c', 'user.email=reader@example.invalid', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'advance');
118: const head = git(r.dir, 'rev-parse', 'HEAD');
124: git(r.dir, 'checkout', '--detach');
125: git(r.dir, '-c', 'user.name=Reader Test', '-c', 'user.email=reader@example.invalid', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'drift');
141: const run = () => cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${pattern}`, path.join(root, 'test/two-fixture-revision-reader.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
147: const syntax = cp.spawnSync(process.execPath, ['--check', target], { env, encoding: 'utf8' });
```

### `.github/coordinator/test/workspace-contract.test.mjs`

```text
5: import { test } from "node:test";
6: import assert from "node:assert/strict";
13: } from "../adapters/workspace-agents.mjs";
14: import { launchIdempotencyKey } from "../reconcile.mjs";
```

### `.github/coordinator/test/workspace-result-mutations.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import path from "node:path";
5: import { tmpdir } from "node:os";
6: import { spawnSync } from "node:child_process";
20: ["M10 wrong tree", "workspace-result.mjs", 'const tree = (await git("write-tree")).trim();', 'const tree = (await git("rev-parse", `${target_sha}^{tree}`)).trim();', "host commits raw files"],
35: const result=spawnSync(process.execPath,["--test",`--test-name-pattern=${pattern}`,path.join(root,"test/workspace-result.test.mjs")],
```

### `.github/coordinator/test/workspace-result.test.mjs`

```text
1: import { test } from "node:test";
2: import assert from "node:assert/strict";
3: import fs from "node:fs";
4: import path from "node:path";
5: import { tmpdir } from "node:os";
6: import { execFile, execFileSync } from "node:child_process";
7: import { randomUUID, createHash } from "node:crypto";
8: import { pushExactSha } from "../push-broker.mjs";
9: import { snapshotWorkspaceResult } from "../workspace-result.mjs";
10: import * as codex from "../adapters/codex-cli.mjs";
11: import { buildClaudeArgs } from "../adapters/claude-code.mjs";
22: const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
28: git(root, "init", wt); git(wt, "config", "user.name", "Fixture"); git(wt, "config", "user.email", "fixture@example.invalid");
30: git(wt, "add", "."); git(wt, "commit", "-m", "base");
31: const target_sha = git(wt, "rev-parse", "HEAD");
33: fs.mkdirSync(path.dirname(remote)); git(root, "init", "--bare", remote);
34: git(wt, "push", remote, "HEAD:refs/heads/coordinator/test");
39: remoteHead: () => git(remote, "rev-parse", "refs/heads/coordinator/test"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
49: assert.equal(f.git(f.remote,"rev-list","--parents","-n","1",result.remote_head), `${result.remote_head} ${f.options.target_sha}`);
50: assert.equal(f.git(f.remote,"show",`${result.remote_head}:file.txt`),"new");
51: assert.equal(f.git(f.remote,"show",`${result.remote_head}:new.txt`),"new file");
52: assert.equal(f.git(f.wt,"rev-parse","HEAD"),f.options.target_sha);
68: fs.writeFileSync(markerScript, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(sentinel)}, "");\n`, { mode: 0o755 });
69: f.git(f.wt,"config","filter.evil.clean",markerScript);
70: f.git(f.wt,"config","core.hooksPath",path.join(f.root,"hooks"));
72: fs.writeFileSync(path.join(f.root,"hooks/pre-commit"),`#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(sentinel)}, "");\n`,{mode:0o755});
73: f.git(f.wt,"config",`url.file:///foreign/.insteadOf`,f.options.remoteUrl);
82: assert.equal(f.git(f.remote,"show",`${result.remote_head}:file.txt`),"new");
93: f.git(f.wt,"add","sub");f.git(f.wt,"commit","-m","sub"); f.options.target_sha=f.git(f.wt,"rev-parse","HEAD");
99: f.git(f.wt,"update-index","--add","--cacheinfo","160000",f.options.target_sha,"sub"); f.git(f.wt,"commit","-m","submodule");
100: f.options.target_sha=f.git(f.wt,"rev-parse","HEAD");
120: f.git(f.wt,"commit","--allow-empty","-m","foreign branch advance");f.git(f.wt,"push","--force",f.remote,"HEAD:refs/heads/coordinator/test");
```

## Capture gate

Capture command (run only after all source/test changes):

```sh
node --test --test-reporter=./.github/coordinator/service/host-suite-contract.mjs .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs > /tmp/a12-post-change-run.jsonl 2> /tmp/a12-post-change-run.stderr
```

Do not derive suite-inventory.json unless exit status is zero, outcomes are nonempty, exactly one terminal complete marker exists and no outcome has status fail. The old /tmp/a12-full-run.jsonl is not evidence.

## Preserved findings

deriveRequirements retains its closed vocabulary rejection SHU251_PREFLIGHT_REQUIREMENTS. The earlier cp replacements stay intact. The direct /bin/sh shebang and dirname dependency are declared rather than rewritten. Incidental cleanup chmod/rm and scan grep calls remain removed. The service lock touch replacement remains; push-broker/workspace touch and cat fixtures were restored at d09f50d and are declared shell_toolchain. PERMITTED_SKIPS and ci.yml are not edited.

The previous capture failed; see the historical REFUSAL.md and rejected-run-summary.json. This pass repaired the probes without changing scratch-count assertions: 1,736 pass / 0 fail / 8 skip, 1,744 outcomes, one terminal complete marker. The current derivation is recorded in DERIVATION.md.

## Current file → dependency → vocabulary → call-site mapping

Node core APIs are the baseline. `[]` means no successful non-Node capability is required. File mappings are conservative execution unions across the file, including selected mutation children; they are not claims that every callback exercises every member. Exact optional distinct-identity proofs receive privilege/worker_uid with their existing permitted reason. The three reviewed Option A proof mappings override their file union. No inferred requirement is assigned merely from a transitive import.

| Required file | Vocabulary | Justification and call sites |
|---|---|---|
| `.github/coordinator/service/test/activation-window-reconciliation.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/service/test/capability-requirements.test.mjs` | `shell_toolchain, linux_proc, loopback_socket` | dependencyControl executes each real fixed-argv probe; all other capabilities use injected boundaries; .github/coordinator/service/test/capability-requirements.test.mjs:83, .github/coordinator/service/test/capability-requirements.test.mjs:110, .github/coordinator/service/test/capability-requirements.test.mjs:164 |
| `.github/coordinator/service/test/cli-amendments.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/service/test/cli-amendments.test.mjs:24, .github/coordinator/service/test/cli-amendments.test.mjs:55 |
| `.github/coordinator/service/test/environment-content-mutations.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/service/test/environment-content-mutations.test.mjs:31 |
| `.github/coordinator/service/test/environment-content.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/service/test/host-lifecycle.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/service/test/host-lifecycle.test.mjs:218, .github/coordinator/service/test/host-lifecycle.test.mjs:229 |
| `.github/coordinator/service/test/host-suite-contract.test.mjs` | `cvtsudoers, linux_proc` | real installed provider control calls resolveCvtsudoers, which executes pinned /proc/self/fd/3; other parser controls inject IO; .github/coordinator/service/test/host-suite-contract.test.mjs:150, .github/coordinator/service/test/host-suite-contract.test.mjs:159, .github/coordinator/service/test/host-suite-contract.test.mjs:161, .github/coordinator/service/test/host-suite-contract.test.mjs:164, .github/coordinator/service/test/host-suite-contract.test.mjs:181, .github/coordinator/service/test/host-suite-contract.test.mjs:186, .github/coordinator/service/test/host-suite-contract.test.mjs:222, .github/coordinator/service/test/host-suite-contract.test.mjs:271, .github/coordinator/service/test/host-suite-contract.test.mjs:272, .github/coordinator/service/test/host-suite-contract.test.mjs:328, .github/coordinator/service/test/host-suite-contract.test.mjs:335, .github/coordinator/service/test/host-suite-contract.test.mjs:364, .github/coordinator/service/test/host-suite-contract.test.mjs:375, .github/coordinator/service/test/host-suite-contract.test.mjs:377, .github/coordinator/service/test/host-suite-contract.test.mjs:386 |
| `.github/coordinator/service/test/host-window-bindings.test.mjs` | `shell_toolchain` | direct spawnSync(wrapper): operational wrapper /bin/sh shebang and dirname calls; provider commands intercepted by preload; .github/coordinator/service/test/host-window-bindings.test.mjs:49, .github/coordinator/service/test/host-window-bindings.test.mjs:143, .github/coordinator/service/test/host-window-bindings.test.mjs:162, .github/coordinator/service/test/host-window-bindings.test.mjs:169, .github/coordinator/service/test/host-window-bindings.test.mjs:176, .github/coordinator/service/test/host-window-bindings.test.mjs:179 |
| `.github/coordinator/service/test/phase-a-driver.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/service/test/phase-a-driver.test.mjs:220, .github/coordinator/service/test/phase-a-driver.test.mjs:287, .github/coordinator/service/test/phase-a-driver.test.mjs:295, .github/coordinator/service/test/phase-a-driver.test.mjs:344, .github/coordinator/service/test/phase-a-driver.test.mjs:348 |
| `.github/coordinator/service/test/production-lifecycle.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/service/test/production-lifecycle.test.mjs:459, .github/coordinator/service/test/production-lifecycle.test.mjs:467, .github/coordinator/service/test/production-lifecycle.test.mjs:469 |
| `.github/coordinator/service/test/reporter-amendments.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/service/test/reporter-amendments.test.mjs:23, .github/coordinator/service/test/reporter-amendments.test.mjs:45, .github/coordinator/service/test/reporter-amendments.test.mjs:85, .github/coordinator/service/test/reporter-amendments.test.mjs:100 |
| `.github/coordinator/service/test/residual.test.mjs` | `unix_socket, linux_proc` | fork fixture/residual-process.mjs; live supervisor socket and probeProcess stat identity; .github/coordinator/service/test/residual.test.mjs:50 |
| `.github/coordinator/service/test/service.test.mjs` | `systemd_analyze, flock` | verify/install syntax uses units.verifySyntax; common flock test executes /usr/bin/flock; .github/coordinator/service/test/service.test.mjs:38, .github/coordinator/service/test/service.test.mjs:86, .github/coordinator/service/test/service.test.mjs:90, .github/coordinator/service/test/service.test.mjs:96 |
| `.github/coordinator/service/test/suite-runner-spec.test.mjs` | `git` | disposableFixture creates, commits and clones real local Git repositories; lifecycle tools are doubled; .github/coordinator/service/test/suite-runner-spec.test.mjs:131, .github/coordinator/service/test/suite-runner-spec.test.mjs:142, .github/coordinator/service/test/suite-runner-spec.test.mjs:167, .github/coordinator/service/test/suite-runner-spec.test.mjs:218, .github/coordinator/service/test/suite-runner-spec.test.mjs:238 |
| `.github/coordinator/service/test/supervisor-service.test.mjs` | `systemd_analyze, unix_socket, linux_proc` | verifySyntax; live supervisor fixture; process identity reads /proc/self/stat; .github/coordinator/service/test/supervisor-service.test.mjs:133, .github/coordinator/service/test/supervisor-service.test.mjs:179 |
| `.github/coordinator/test/activation.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/adapter.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/attempt-workspace.test.mjs` | `git, bash, shell_toolchain, flock` | real git helper, host-tick.sh execution (dirname/flock), production attempt-workspace workerRun chmod; identity-dependent tests separately bound; .github/coordinator/test/attempt-workspace.test.mjs:18, .github/coordinator/test/attempt-workspace.test.mjs:24, .github/coordinator/test/attempt-workspace.test.mjs:59, .github/coordinator/test/attempt-workspace.test.mjs:137, .github/coordinator/test/attempt-workspace.test.mjs:164, .github/coordinator/test/attempt-workspace.test.mjs:172, .github/coordinator/test/attempt-workspace.test.mjs:235, .github/coordinator/test/attempt-workspace.test.mjs:376, .github/coordinator/test/attempt-workspace.test.mjs:378, .github/coordinator/test/attempt-workspace.test.mjs:380, .github/coordinator/test/attempt-workspace.test.mjs:405, .github/coordinator/test/attempt-workspace.test.mjs:417 |
| `.github/coordinator/test/capacity-scheduler.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/capacity-scheduler.test.mjs:365 |
| `.github/coordinator/test/claude-contract.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/codex-contract.test.mjs` | `linux_proc, shell_toolchain` | real orphan-process lifecycle and procfs; restored executable uses #!/usr/bin/env node and requires node resolution on the child PATH; .github/coordinator/test/codex-contract.test.mjs:505, .github/coordinator/test/codex-contract.test.mjs:518 |
| `.github/coordinator/test/dispatch-durability.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/durable-handoff.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/durable-handoff.test.mjs:204 |
| `.github/coordinator/test/eligibility.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/episode-boundary.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/episode-boundary.test.mjs:532 |
| `.github/coordinator/test/episode-stale-head.regression.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/episode-successor-dispatch.test.mjs` | `shell_toolchain` | execFileSync("node", ...) resolves child node on PATH; shell_toolchain establishes this resolution via /usr/bin/env node --version; no shell interpreter used by this call; .github/coordinator/test/episode-successor-dispatch.test.mjs:610 |
| `.github/coordinator/test/future-clock.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/future-clock.test.mjs:29, .github/coordinator/test/future-clock.test.mjs:33, .github/coordinator/test/future-clock.test.mjs:48 |
| `.github/coordinator/test/hermes-adversarial.test.mjs` | `git, bash, shell_toolchain` | runPolicyIn executes extracted repository-policy.yml unchanged: Git, Bash, mktemp and rm; .github/coordinator/test/hermes-adversarial.test.mjs:32, .github/coordinator/test/hermes-adversarial.test.mjs:108, .github/coordinator/test/hermes-adversarial.test.mjs:206, .github/coordinator/test/hermes-adversarial.test.mjs:210, .github/coordinator/test/hermes-adversarial.test.mjs:211, .github/coordinator/test/hermes-adversarial.test.mjs:221, .github/coordinator/test/hermes-adversarial.test.mjs:231, .github/coordinator/test/hermes-adversarial.test.mjs:243, .github/coordinator/test/hermes-adversarial.test.mjs:273, .github/coordinator/test/hermes-adversarial.test.mjs:319 |
| `.github/coordinator/test/hermes-pool.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/lifecycle.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/linear-issues.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/merge-readiness.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/merge-readiness.test.mjs:265 |
| `.github/coordinator/test/push-broker-gitconfig.test.mjs` | `git, shell_toolchain` | real Git broker/filter controls; restored /bin/sh marker and clean-filter scripts execute touch and cat; .github/coordinator/test/push-broker-gitconfig.test.mjs:43, .github/coordinator/test/push-broker-gitconfig.test.mjs:164, .github/coordinator/test/push-broker-gitconfig.test.mjs:432 |
| `.github/coordinator/test/push-broker.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/receipt-clock.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/receipt-clock.test.mjs:98 |
| `.github/coordinator/test/receipt-state.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/reseed-append-contract.test.mjs` | `git` | real spawnSync git helper and local signed fixture repository; .github/coordinator/test/reseed-append-contract.test.mjs:35 |
| `.github/coordinator/test/reseed-append-mutations.test.mjs` | `git` | selected reseed-append-contract subprocess controls execute real Git fixtures; .github/coordinator/test/reseed-append-mutations.test.mjs:27, .github/coordinator/test/reseed-append-mutations.test.mjs:35 |
| `.github/coordinator/test/review-routing.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/reviewer-evidence.test.mjs` | `shell_toolchain, linux_proc` | unconfined /bin/sh fixture directly executes reviewer child; descriptor/environment/process canary reads; TCP and process-canary launch doubled; .github/coordinator/test/reviewer-evidence.test.mjs:239, .github/coordinator/test/reviewer-evidence.test.mjs:251, .github/coordinator/test/reviewer-evidence.test.mjs:312, .github/coordinator/test/reviewer-evidence.test.mjs:362, .github/coordinator/test/reviewer-evidence.test.mjs:417, .github/coordinator/test/reviewer-evidence.test.mjs:444 |
| `.github/coordinator/test/schema.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/shu219-rule6-mutation.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu219-rule6-mutation.test.mjs:48 |
| `.github/coordinator/test/shu224-dispatch-scope.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu224-dispatch-scope.test.mjs:288 |
| `.github/coordinator/test/shu226-incident-reporting.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/shu226-mutations.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu226-mutations.test.mjs:110 |
| `.github/coordinator/test/shu232-mutations.test.mjs` | `shell_toolchain, linux_proc` | selected reviewer-evidence subprocess controls inherit wrapper and procfs dependencies; .github/coordinator/test/shu232-mutations.test.mjs:92 |
| `.github/coordinator/test/shu237-mutations.test.mjs` | `[]` | Node only: executable fixture bytes and/or validated argv inspected, process/transport boundaries injected; no successful shell or socket operation required; .github/coordinator/test/shu237-mutations.test.mjs:166 |
| `.github/coordinator/test/shu237-portability.test.mjs` | `[]` | Node only: executable fixture bytes and/or validated argv inspected, process/transport boundaries injected; no successful shell or socket operation required; .github/coordinator/test/shu237-portability.test.mjs:126, .github/coordinator/test/shu237-portability.test.mjs:219 |
| `.github/coordinator/test/shu239-mutations.test.mjs` | `bash` | selected reviewer-launch controls execute shipped Bash wrapper; .github/coordinator/test/shu239-mutations.test.mjs:60 |
| `.github/coordinator/test/shu239-reviewer-launch.test.mjs` | `bash` | spawnSync bash -n and invalid reviewer-sandbox invocation before privileged commands; .github/coordinator/test/shu239-reviewer-launch.test.mjs:116, .github/coordinator/test/shu239-reviewer-launch.test.mjs:127, .github/coordinator/test/shu239-reviewer-launch.test.mjs:135, .github/coordinator/test/shu239-reviewer-launch.test.mjs:148, .github/coordinator/test/shu239-reviewer-launch.test.mjs:162, .github/coordinator/test/shu239-reviewer-launch.test.mjs:164 |
| `.github/coordinator/test/shu240-evidence-binding.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/shu240-mutations.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu240-mutations.test.mjs:34 |
| `.github/coordinator/test/shu241-mutations.test.mjs` | `git, shell_toolchain, linux_proc` | selected scoped-build subprocesses inherit real Git and workspace snapshot dependencies; .github/coordinator/test/shu241-mutations.test.mjs:48 |
| `.github/coordinator/test/shu241-scoped-build.test.mjs` | `git, shell_toolchain, linux_proc` | real Git scoped bundles and broker workspace snapshot /proc/self/fd; production worker chmod; identity requirements separately bound; .github/coordinator/test/shu241-scoped-build.test.mjs:27, .github/coordinator/test/shu241-scoped-build.test.mjs:31, .github/coordinator/test/shu241-scoped-build.test.mjs:99, .github/coordinator/test/shu241-scoped-build.test.mjs:101, .github/coordinator/test/shu241-scoped-build.test.mjs:114, .github/coordinator/test/shu241-scoped-build.test.mjs:117 |
| `.github/coordinator/test/shu245-mutations.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu245-mutations.test.mjs:58 |
| `.github/coordinator/test/shu245-reviewer-citations.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/shu246-episode-backfill.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/shu246-mutations.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu246-mutations.test.mjs:50 |
| `.github/coordinator/test/shu247-callback-notes.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/shu247-mutations.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu247-mutations.test.mjs:46 |
| `.github/coordinator/test/shu249-mutations.test.mjs` | `git, shell_toolchain` | selected role-authority subprocesses inherit real Git/workspace wrapper dependencies; .github/coordinator/test/shu249-mutations.test.mjs:27 |
| `.github/coordinator/test/shu249-role-authority.test.mjs` | `git, shell_toolchain` | real Git helper, generated /bin/sh worker wrapper, production workspace chmod; .github/coordinator/test/shu249-role-authority.test.mjs:58 |
| `.github/coordinator/test/shu260-incident-triage.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/shu260-mutations.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu260-mutations.test.mjs:80 |
| `.github/coordinator/test/shu261-cleanup-network.test.mjs` | `bash` | shipped Bash functions executed; setfacl/flock/systemd-run are Bash function doubles; .github/coordinator/test/shu261-cleanup-network.test.mjs:15, .github/coordinator/test/shu261-cleanup-network.test.mjs:82 |
| `.github/coordinator/test/shu261-mutations.test.mjs` | `bash, cvtsudoers, linux_proc` | selected isolation/findings subprocesses; direct privileged Bash startup, real parser, process canaries; .github/coordinator/test/shu261-mutations.test.mjs:106 |
| `.github/coordinator/test/shu261-review-findings.test.mjs` | `cvtsudoers, linux_proc` | Real sudoers parsing and live descriptor/process canaries. Historical Git branch is only opt-in SHU261_BASELINE, not executed by the required command. TCP listener doubled.; .github/coordinator/test/shu261-review-findings.test.mjs:20, .github/coordinator/test/shu261-review-findings.test.mjs:58, .github/coordinator/test/shu261-review-findings.test.mjs:122, .github/coordinator/test/shu261-review-findings.test.mjs:153 |
| `.github/coordinator/test/shu261-reviewer-isolation.test.mjs` | `bash, linux_proc` | direct reviewer-sandbox startup; real child process inspection; TCP probe doubled; .github/coordinator/test/shu261-reviewer-isolation.test.mjs:102, .github/coordinator/test/shu261-reviewer-isolation.test.mjs:152, .github/coordinator/test/shu261-reviewer-isolation.test.mjs:317 |
| `.github/coordinator/test/shu68-wiring.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/shu71-activation-package.test.mjs` | `git` | real revision Git read and mutation execution binding controls; .github/coordinator/test/shu71-activation-package.test.mjs:256, .github/coordinator/test/shu71-activation-package.test.mjs:284 |
| `.github/coordinator/test/shu71-battery.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu71-battery.test.mjs:141, .github/coordinator/test/shu71-battery.test.mjs:253, .github/coordinator/test/shu71-battery.test.mjs:331 |
| `.github/coordinator/test/shu71-public-key.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu71-public-key.test.mjs:90, .github/coordinator/test/shu71-public-key.test.mjs:111 |
| `.github/coordinator/test/shu73-enforcement.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu73-enforcement.test.mjs:183 |
| `.github/coordinator/test/shu86-durable-intent.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/shu86-durable-intent.test.mjs:161 |
| `.github/coordinator/test/single-run-activation.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/single-run-activation.test.mjs:1114 |
| `.github/coordinator/test/supervisor-dispatch.test.mjs` | `[]` | Node only: executable fixture bytes and/or validated argv inspected, process/transport boundaries injected; no successful shell or socket operation required; .github/coordinator/test/supervisor-dispatch.test.mjs:195 |
| `.github/coordinator/test/supervisor.test.mjs` | `unix_socket` | startSupervisorServer and submitToSupervisor real socket round trip; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/two-fixture-activation.test.mjs` | `git` | real revision and isolated ancestry Git repository controls; .github/coordinator/test/two-fixture-activation.test.mjs:136, .github/coordinator/test/two-fixture-activation.test.mjs:158, .github/coordinator/test/two-fixture-activation.test.mjs:182, .github/coordinator/test/two-fixture-activation.test.mjs:206 |
| `.github/coordinator/test/two-fixture-lanes.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; .github/coordinator/test/two-fixture-lanes.test.mjs:145 |
| `.github/coordinator/test/two-fixture-progression.test.mjs` | `git, linux_proc` | real Git fixture/broker workspace snapshots and recovery subprocess controls; .github/coordinator/test/two-fixture-progression.test.mjs:18, .github/coordinator/test/two-fixture-progression.test.mjs:50, .github/coordinator/test/two-fixture-progression.test.mjs:166, .github/coordinator/test/two-fixture-progression.test.mjs:206, .github/coordinator/test/two-fixture-progression.test.mjs:259, .github/coordinator/test/two-fixture-progression.test.mjs:337, .github/coordinator/test/two-fixture-progression.test.mjs:448, .github/coordinator/test/two-fixture-progression.test.mjs:451 |
| `.github/coordinator/test/two-fixture-revision-reader.test.mjs` | `git` | real local Git repository ownership and revision controls; distinct identity requirement separately bound; .github/coordinator/test/two-fixture-revision-reader.test.mjs:98, .github/coordinator/test/two-fixture-revision-reader.test.mjs:99, .github/coordinator/test/two-fixture-revision-reader.test.mjs:141, .github/coordinator/test/two-fixture-revision-reader.test.mjs:147 |
| `.github/coordinator/test/workspace-contract.test.mjs` | `[]` | Node core filesystem/process APIs; external command boundaries doubled or source inspected, no successful external tool operation required; Node-only assertion/source/fixture controls in this file |
| `.github/coordinator/test/workspace-result-mutations.test.mjs` | `git, linux_proc, shell_toolchain` | selected workspace-result mutation children inherit Git, procfs and the restored shell filter/hook controls (M2/M3); .github/coordinator/test/workspace-result-mutations.test.mjs:12, .github/coordinator/test/workspace-result-mutations.test.mjs:13, .github/coordinator/test/workspace-result-mutations.test.mjs:35 |
| `.github/coordinator/test/workspace-result.test.mjs` | `git, linux_proc, shell_toolchain` | real Git and /proc/self/fd snapshot reads; restored shell clean filter and pre-commit hook use touch, including negative security controls; .github/coordinator/test/workspace-result.test.mjs:22, .github/coordinator/test/workspace-result.test.mjs:67, .github/coordinator/test/workspace-result.test.mjs:70 |

## Restored-fixture re-audit

All 85 required files were re-scanned at the d09f50d baseline plus this correction; `head-dependency-audit.json` records each reviewed source hash and command/fixture candidates. The three restored files gain shell_toolchain. The remaining 82 include two additional corrections: workspace-result-mutations inherits its selected shell filter/hook controls; episode-successor-dispatch:610 resolves literal node on PATH, now covered by the env node probe. Other declarations remain unchanged. Bash-only execution is covered by bash; source-only shebangs and command doubles do not establish execution. SHU261 root interpreter PATH mutation selects the source-inspection wrapper-contract test, so its fake /bin/sh executable is not run.
