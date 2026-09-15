# SHU-261 review fixes — PR 117 writer evidence

Mandatory initial `git rev-parse HEAD`: `f3f89f5f50954eec8190ce69c46ba384fd603dae`.
Branch: `feat/shu-261-reviewer-filesystem-isolation`. All findings inspected at that head, not the older review commit.

## Fixed-tree locations

- Finding 1: `.github/coordinator/review-execution.mjs:222` (creation), `:254` (arguments); `.github/coordinator/review-execution-child.mjs:42`, `:57`, `:61`, `:76` (fail-closed predicates), `:156` (execution conjunction).
- Finding 2: `.github/coordinator/service/reviewer-host-validation.mjs:224` (collection), `:228` (per-callback catch), `:231` (inventory), `:236` (aggregate).
- Finding 3: `.github/coordinator/service/shu-reviewer.sudoers:4` (OAuth keep), `:5` (NOSETENV); `.github/coordinator/review-execution.mjs:107` (length), `:108` (index).
- Reproducers: `.github/coordinator/test/shu261-review-findings.test.mjs:61` (canaries), `:73` (cleanup), `:101` (policy), `:135` (caller), `:170` (argv/docs).

## Findings and current-head evidence

### 1. REPRODUCED AND FIXED — missing isolation canaries

The hole was live in `runReviewEvidence`, which ended its child arguments immediately after target SHA. The child treated absent canaries as successful checks. The review's stated host-validation entry is inaccurate: that separate entry already passed all four arguments. This does not make the ordinary caller omission safe.

Baseline surrounding code:

`.github/coordinator/review-execution.mjs:236` at mandatory base:

```text
236:       "--cwd", resolvedCwd,
237:       "--expected-uid", String(expectedUid),
238:       "--protected-path", protectedPath,
239:       "--sibling-probe-path", siblingProbePath,
240:       "--probe-port", String(port),
241:       "--target-sha", target_sha,
242:       "--",
243:       ...files,
244:     ], {
245:       cwd: resolvedCwd,
```

`.github/coordinator/review-execution-child.mjs:40` at mandatory base:

```text
40:
41: export function inheritedDescriptorDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {
42:   if (!canary) return true;
43:   let descriptors = [];
```

`.github/coordinator/review-execution-child.mjs:54` at mandatory base:

```text
54: export function environmentValueDenied(canary, env = process.env) {
55:   return !canary || !Object.values(env).some((value) => String(value).includes(canary));
56: }
57:
58: export function processInspectionDenied(canary, { fsImpl = fs, pid = process.pid } = {}) {
59:   if (!canary) return true;
```

`.github/coordinator/review-execution-child.mjs:73` at mandatory base:

```text
73: export function protectedProbes(raw) {
74:   if (!raw) return { ok: true, classes: {}, symlink: "NOT_REQUESTED", traversal: "NOT_REQUESTED" };
75:   let probes;
76:   try { probes = JSON.parse(raw); } catch { return { ok: false, classes: {}, symlink: "INVALID", traversal: "INVALID" }; }
77:   if (!Array.isArray(probes) || probes.length === 0 || probes.length > 16) {
78:     return { ok: false, classes: {}, symlink: "INVALID", traversal: "INVALID" };
```

`.github/coordinator/review-execution-child.mjs:156` at mandatory base:

```text
156:
157:   const report = {
158:     version: "1.0.0",
159:     target_sha: targetSha,
```

`.github/coordinator/review-execution-child.mjs:180` at mandatory base:

```text
180:       cwd,
181:       env: process.env,
182:       encoding: "utf8",
183:       timeout: 15 * 60 * 1000,
```

`.github/coordinator/service/reviewer-host-validation.mjs:197` at mandatory base:

```text
197:       "SHU261_POSITIVE_ENVIRONMENT: innocent-key canary must be live before confinement");
198:     const run = await runChild(SUDO, args, {
199:       cwd: REPO,
200:       env: childEnvironment,
201:       stdio: ["ignore", "pipe", "pipe", fd],
202:     });
```

Fix: generate per-invocation nonce canaries, hold the source descriptor open, start a coordinator process marker, pass the environment canary under an innocent key, and supply protected path probes. The child refuses absent/empty/malformed canaries and unknown protected classes. Each scalar canary requires its correct kind prefix and 32 hexadecimal nonce characters. Its unchanged conjunction gates the builder phase.

The loaded-child VM replaces OS confinement responses, **not the predicates or control flow**. The builder spawn executes a real temporary Node test that writes a marker; invocation counts must agree with that marker. Baseline: each omitted canary produces `builder_calls=1 exit=0`. Fixed: each absent, empty, unknown, and malformed value produces `builder_calls=0 exit=70`. The real caller test proves source FD, environment, and process canaries are live, passes its actual arguments into the loaded child, and individually deletes each argument to prove refusal. The valid control runs the builder test.

Activating the FD scan exposed an existing blocking pipe read in an unconfined child. It now checks for a regular file before reading, matching the sentinel type. The existing real unconfined-child test completes and the existing descriptor-leak mutation remains binding. Existing attack canaries were updated to valid nonce shapes, and mutation anchors were updated without loosening assertions.

Mutations remove one term from the loaded production `probeOk` conjunction:

- `SHU261_CANARY_0` → `AssertionError: SHU261_CANARY_MISSING_MUST_FAIL_0: protected-paths-json must block builder execution`
- `SHU261_CANARY_1` → `AssertionError: SHU261_CANARY_MISSING_MUST_FAIL_1: fd-canary must block builder execution`
- `SHU261_CANARY_2` → `AssertionError: SHU261_CANARY_MISSING_MUST_FAIL_2: env-canary must block builder execution`
- `SHU261_CANARY_3` → `AssertionError: SHU261_CANARY_MISSING_MUST_FAIL_3: process-canary must block builder execution`

### 2. REPRODUCED AND FIXED — aborting cleanup

The hole was live: an assertion thrown by worktree removal escaped the reverse loop and bypassed the final inventory check.

`.github/coordinator/service/reviewer-host-validation.mjs:130` at mandatory base:

```text
130:         assert.equal(removed.status, 0, `SHU261_HOST_WORKTREE: temporary worktree cleanup must succeed: ${removed.stderr}`);
131:       });
132:       assert.equal(spawnSync(GIT, ["rev-parse", "HEAD"], { cwd: candidate, encoding: "utf8" }).stdout.trim(), approvedRevision,
133:         "SHU261_HOST_WORKTREE: each temporary checkout must bind the approved exact head");
134:     }
135:     sentinels.sibling_attempts = writeSentinel(siblingWorkspace, "sibling_attempts", nonce);
```

`.github/coordinator/service/reviewer-host-validation.mjs:223` at mandatory base:

```text
223:   } finally {
224:     if (server) await new Promise((resolve) => server.close(resolve));
225:     if (markerProcess) markerProcess.kill("SIGTERM");
226:     for (const remove of cleanup.reverse()) remove();
227:   }
228:   const worktreesAfter = spawnSync(GIT, ["worktree", "list", "--porcelain"], { cwd: REPO, encoding: "utf8" });
229:   assert.equal(worktreesAfter.status, 0, `SHU261_HOST_WORKTREE: final inventory must succeed: ${worktreesAfter.stderr}`);
230:   assert.equal(worktreesAfter.stdout, worktreesBefore.stdout,
231:     "SHU261_HOST_WORKTREE: bounded validation must restore the exact worktree inventory");
232:   return evidence;
233: }
234:
```

Fix: collect each callback failure, run every callback, run the unchanged inventory assertions inside `finally`, then throw `AggregateError`. Socket/process cleanup joins the same callback mechanism.

The test executes the loaded cleanup/inventory region with three counted callbacks. The first callback in cleanup order throws. Baseline counts: `[0,0,1]`, inventory `0`. Fixed counts: `[1,1,1]`, inventory `1`, followed by `AggregateError`. A second run changes inventory output: all callback counts reach `[2,2,2]`, inventory count reaches `2`, and the aggregate retains both the callback error and the original named inventory AssertionError.

Mutation `SHU261_CLEANUP_RUNS_ALL_CALLBACKS` removes the per-callback catch and dies with `AssertionError: SHU261_CLEANUP_RUNS_ALL_CALLBACKS: every callback must run exactly once`.

### 3. REPRODUCED AND FIXED — unrestricted sudo environment

The hole was live in the reviewed policy, before the Bash wrapper could clean the transient-service environment:

`.github/coordinator/service/shu-reviewer.sudoers:1` at mandatory base:

```text
1: # SHU-261: install as root:root 0440 only in a separately approved host window.
2: # SETENV applies only to this reviewed wrapper. The wrapper constructs a clean
3: # transient-service environment and forwards only CLAUDE_CODE_OAUTH_TOKEN.
4: Defaults!/usr/local/libexec/shu-reviewer-sandbox env_keep += "CLAUDE_CODE_OAUTH_TOKEN"
5: shu-coordinator ALL=(root) NOPASSWD:SETENV: /usr/local/libexec/shu-reviewer-sandbox *
```

`.github/coordinator/reviewer-sandbox.sh:1` at mandatory base:

```text
1: #!/usr/bin/env bash
2: # Install this reviewed file root-owned and non-writable at
3: # /usr/local/libexec/shu-reviewer-sandbox. The coordinator invokes it through a
4: # narrowly-scoped sudo rule. It executes both phases of review as shu-reviewer:
5: # builder-authored tests use the no-network `test` profile and Claude uses the
6: # provider-network-only `model` profile. Both profiles share the same filesystem,
7: # process and identity boundary.
8: set -euo pipefail
9:
```

`.github/coordinator/review-execution.mjs:103` at mandatory base:

```text
103:   const executable = trustedRootPath(wrapper[0], fsImpl);
104:   const normalized = [executable, ...wrapper.slice(1)];
105:   if (path.basename(wrapper[0]) === "sudo" || path.basename(executable) === "sudo") {
106:     const expectedLength = model ? 4 : 3;
107:     const sandboxIndex = model ? 3 : 2;
108:     if (wrapper.length !== expectedLength || wrapper[1] !== "-n"
109:       || (model && wrapper[2] !== "--preserve-env=CLAUDE_CODE_OAUTH_TOKEN")
110:       || !path.isAbsolute(wrapper[sandboxIndex] ?? "")) {
111:       throw new Error(model
112:         ? "sudo reviewer model wrapper must preserve only CLAUDE_CODE_OAUTH_TOKEN in the fixed noninteractive command form"
113:         : "sudo review wrapper must be the fixed noninteractive command form");
114:     }
115:     normalized[sandboxIndex] = trustedRootPath(wrapper[sandboxIndex], fsImpl);
```

Fix: `NOPASSWD:NOSETENV:`, retain command-specific `env_keep += "CLAUDE_CODE_OAUTH_TOKEN"`, and use `["/usr/bin/sudo","-n","/usr/local/libexec/shu-reviewer-sandbox"]` for both profiles. Runtime validation and tests pin length **3**, sandbox index **2**. Both activation documents and the model-launch contract agree.

The local probe parses the actual sudoers bytes with `/usr/bin/cvtsudoers`. Its parsed `setenv` and command-specific `env_keep` determine environment admission, then `/usr/bin/unshare --user --map-root-user /bin/bash <actual-wrapper>` executes the unmodified wrapper with no arguments. It exits 64 before locks, ACLs, /srv or systemd. Baseline `BASH_ENV` writes `0:local-oauth-canary`, demonstrating uncontrolled startup execution at namespace UID 0. Fixed policy produces no startup marker while preserving OAuth through `env_keep`.

**Proof boundary:** sudo environment admission is modeled from the real parsed policy. The wrapper startup and namespace UID are real. This is not a real sudo-plugin enforcement test or a deployed-host integration test; installed policy, host-root escalation, and live Claude authentication were not exercised. No host access/activation was authorized. Thus the requested literal end-to-end proof through an installed sudo policy is not established here.

- `SHU261_NO_SETENV` restores `SETENV` and dies with `AssertionError: SHU261_NO_SETENV: uncontrolled BASH_ENV must not execute in privileged wrapper startup`.
- `SHU261_OAUTH_ENV_KEEP` replaces the permitted OAuth key and dies with `AssertionError: SHU261_OAUTH_ENV_KEEP: command-specific env_keep must preserve OAuth`.

## Verification counts, separately by command

Normalization: `chmod -R go-w .github/coordinator`; every measurement uses `TMPDIR=/tmp/shu261fix-tmp` outside the checkout.

1. `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`
   - Completed run: **974 tests, 967 pass, 0 fail, 7 skipped, 0 cancelled, 0 todo**, exit **0**.
   - Six existing skips require unavailable distinct host UID execution (SHU-227/228/241/244); one existing SHU-71 skip states that production vocabulary has no undeclared runtime/role pair. No added skips.
   - Earlier interrupted run: **504 emitted passes, 0 emitted failures**, no completed total. Genuine newly activated FD-scanner hang; the real unconfined child blocked while scanning non-regular descriptors. Stopped only local test processes, fixed regular-file filtering, then reran successfully. This was not dismissed as a flake.
2. Root `npm test`
   - First attempt: exit **2**, **0 tests executed**. Environment failure: `TS2688: Cannot find type definition file for 'node'`. Resolved with `npm ci --ignore-scripts` using the existing lockfile (125 packages installed; no tracked dependency changes).
   - Completed retry: exit **0**. Node TAP **459 tests, 459 pass, 0 fail, 0 skipped, 0 cancelled, 0 todo**; Vitest **27 tests passed, 1 file passed**. Combined ordinary tests **486 passed**.
   - Node stages: main **258/258**, deployment **97/97**, web **28/28**, documents **19/19**, hardening **10/10**, observability **15/15**, lifecycle **25/25**, R2 **7/7**.
   - Additional mutation stages: profile **10/10**, idempotency **3/3**, navigation **6/6**, documents **17/17**, hardening **10/10**, observability **17/17**, lifecycle **22/22**: **85/85 killed**. Synthetic observability exercise exits **0**.
3. Focused findings: **8 tests, 8 pass, 0 fail, 0 skipped**, exit **0**. Baseline reproducer: **6 tests, 0 pass, 6 intentional assertion failures**, exit **1**. Seven control-removal runs: each **1 test, 0 pass, 1 named assertion failure**, exit **1**.
4. Existing plus new SHU-261 and reviewer-evidence tests: **48 tests, 48 pass, 0 fail**, exit **0**. The preceding test-development run had **43 pass, 5 fail** because nested Node tests inherited `NODE_TEST_CONTEXT` and never wrote the builder marker. Removing that test-runner-only environment key fixed the harness; no production assertion was relaxed. Initial exploratory VM harness errors (missing fake `fs.constants`, malformed extracted block braces) were corrected before the recorded baseline reproduction. No failures were classified as flakes.

Dispatch remains `false` in `.github/coordinator/config.json`. No activation state, host files, fixture branch, systemd, Coolify, PR, push, deploy, or Linear write was performed. Root npm's deployment tests are local tests, not deployment actions.

## Raw reproduction and mutation output

Trailing whitespace is trimmed for Markdown; all output lines are retained. These are the full outputs for the baseline/fixed directions and every removed-control direction. Stack line numbers reflect the test revision at each run. The baseline option loads the mandatory base's source via `git show`; mutations alter only the source being evaluated in the test VM or temporary parsed policy.

### Baseline reproducer (exit 1)

```text
$ TMPDIR=/tmp/shu261fix-tmp SHU261_BASELINE=true node --test --test-name-pattern='SHU261_CANARY_MISSING|SHU261_CLEANUP_RUNS|SHU261_NO_SETENV' .github/coordinator/test/shu261-review-findings.test.mjs
TAP version 13
# protected-paths-json=undefined builder_calls=1 exit=0
# fd-canary=undefined builder_calls=1 exit=0
# env-canary=undefined builder_calls=1 exit=0
# process-canary=undefined builder_calls=1 exit=0
# cleanup_calls=[0,0,1] inventory_calls=0 error=Error: early cleanup failure
# parsed_setenv=true namespace_root_startup=0:local-oauth-canary oauth_preserved=true
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_0: protected-paths-json
not ok 1 - SHU261_CANARY_MISSING_MUST_FAIL_0: protected-paths-json
  ---
  duration_ms: 291.583078
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:61:40'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_CANARY_MISSING_MUST_FAIL_0: protected-paths-json must block builder execution

    1 !== 0

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:67:12)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_1: fd-canary
not ok 2 - SHU261_CANARY_MISSING_MUST_FAIL_1: fd-canary
  ---
  duration_ms: 300.633365
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:61:40'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_CANARY_MISSING_MUST_FAIL_1: fd-canary must block builder execution

    1 !== 0

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:67:12)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_2: env-canary
not ok 3 - SHU261_CANARY_MISSING_MUST_FAIL_2: env-canary
  ---
  duration_ms: 263.897023
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:61:40'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_CANARY_MISSING_MUST_FAIL_2: env-canary must block builder execution

    1 !== 0

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:67:12)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_3: process-canary
not ok 4 - SHU261_CANARY_MISSING_MUST_FAIL_3: process-canary
  ---
  duration_ms: 335.188066
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:61:40'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_CANARY_MISSING_MUST_FAIL_3: process-canary must block builder execution

    1 !== 0

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:67:12)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: SHU261_CLEANUP_RUNS_ALL_CALLBACKS
not ok 5 - SHU261_CLEANUP_RUNS_ALL_CALLBACKS
  ---
  duration_ms: 93.409436
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:73:1'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_CLEANUP_RUNS_ALL_CALLBACKS: every callback must run exactly once
    + actual - expected

      [
    +   0,
    +   0,
        1,
    -   1,
    -   1
      ]

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
    0: 1
    1: 1
    2: 1
  actual:
    0: 0
    1: 0
    2: 1
  operator: 'deepStrictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:87:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: SHU261_NO_SETENV: parsed policy controls real wrapper startup and preserves OAuth
not ok 6 - SHU261_NO_SETENV: parsed policy controls real wrapper startup and preserves OAuth
  ---
  duration_ms: 87.193583
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:93:1'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_NO_SETENV: uncontrolled BASH_ENV must not execute in privileged wrapper startup
    + actual - expected

    + '0:local-oauth-canary'
    - null

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: ~
  actual: '0:local-oauth-canary'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:121:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
    Test.postRun (node:internal/test_runner/test:1173:19)
    Test.run (node:internal/test_runner/test:1101:12)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
1..6
# tests 6
# suites 0
# pass 0
# fail 6
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1437.075303
```

### Fixed controls (exit 0)

```text
$ TMPDIR=/tmp/shu261fix-tmp node --test .github/coordinator/test/shu261-review-findings.test.mjs
TAP version 13
# protected-paths-json=undefined builder_calls=0 exit=70
# protected-paths-json= builder_calls=0 exit=70
# protected-paths-json=unknown builder_calls=0 exit=70
# protected-paths-json=[{"class":"unknown","path":"/protected"}] builder_calls=0 exit=70
# fd-canary=undefined builder_calls=0 exit=70
# fd-canary= builder_calls=0 exit=70
# fd-canary=unknown builder_calls=0 exit=70
# fd-canary=SHU261_FD_unknown builder_calls=0 exit=70
# env-canary=undefined builder_calls=0 exit=70
# env-canary= builder_calls=0 exit=70
# env-canary=unknown builder_calls=0 exit=70
# env-canary=SHU261_ENV_unknown builder_calls=0 exit=70
# process-canary=undefined builder_calls=0 exit=70
# process-canary= builder_calls=0 exit=70
# process-canary=unknown builder_calls=0 exit=70
# process-canary=SHU261_PROCESS_unknown builder_calls=0 exit=70
# cleanup_calls=[1,1,1] inventory_calls=1 error=AggregateError: SHU261_HOST_CLEANUP: cleanup or final inventory failed
# parsed_setenv=false namespace_root_startup=null oauth_preserved=true
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_0: protected-paths-json
ok 1 - SHU261_CANARY_MISSING_MUST_FAIL_0: protected-paths-json
  ---
  duration_ms: 79.954609
  type: 'test'
  ...
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_1: fd-canary
ok 2 - SHU261_CANARY_MISSING_MUST_FAIL_1: fd-canary
  ---
  duration_ms: 68.618338
  type: 'test'
  ...
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_2: env-canary
ok 3 - SHU261_CANARY_MISSING_MUST_FAIL_2: env-canary
  ---
  duration_ms: 62.308604
  type: 'test'
  ...
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_3: process-canary
ok 4 - SHU261_CANARY_MISSING_MUST_FAIL_3: process-canary
  ---
  duration_ms: 59.551052
  type: 'test'
  ...
# Subtest: SHU261_CLEANUP_RUNS_ALL_CALLBACKS
ok 5 - SHU261_CLEANUP_RUNS_ALL_CALLBACKS
  ---
  duration_ms: 3.811185
  type: 'test'
  ...
# Subtest: SHU261_NO_SETENV: parsed policy controls real wrapper startup and preserves OAuth
ok 6 - SHU261_NO_SETENV: parsed policy controls real wrapper startup and preserves OAuth
  ---
  duration_ms: 6.650338
  type: 'test'
  ...
# Subtest: SHU261_CALLER_CANARIES: real caller supplies live canaries to loaded child
ok 7 - SHU261_CALLER_CANARIES: real caller supplies live canaries to loaded child
  ---
  duration_ms: 88.658843
  type: 'test'
  ...
# Subtest: SHU261_MODEL_ARGV: contract pins length 3 and sandbox index 2
ok 8 - SHU261_MODEL_ARGV: contract pins length 3 and sandbox index 2
  ---
  duration_ms: 0.725353
  type: 'test'
  ...
1..8
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 422.248211
```

### SHU261_CANARY_0

```text
$ SHU261_MUTATION=SHU261_CANARY_0 node --test --test-name-pattern=SHU261_CANARY_MISSING_MUST_FAIL_0 .github/coordinator/test/shu261-review-findings.test.mjs
TAP version 13
# protected-paths-json=undefined builder_calls=1 exit=0
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_0: protected-paths-json
not ok 1 - SHU261_CANARY_MISSING_MUST_FAIL_0: protected-paths-json
  ---
  duration_ms: 148.714965
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:61:40'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_CANARY_MISSING_MUST_FAIL_0: protected-paths-json must block builder execution

    1 !== 0

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:67:12)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 201.320248

exit=1
```

### SHU261_CANARY_1

```text
$ SHU261_MUTATION=SHU261_CANARY_1 node --test --test-name-pattern=SHU261_CANARY_MISSING_MUST_FAIL_1 .github/coordinator/test/shu261-review-findings.test.mjs
TAP version 13
# fd-canary=undefined builder_calls=1 exit=0
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_1: fd-canary
not ok 1 - SHU261_CANARY_MISSING_MUST_FAIL_1: fd-canary
  ---
  duration_ms: 182.67501
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:61:40'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_CANARY_MISSING_MUST_FAIL_1: fd-canary must block builder execution

    1 !== 0

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:67:12)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 242.785511

exit=1
```

### SHU261_CANARY_2

```text
$ SHU261_MUTATION=SHU261_CANARY_2 node --test --test-name-pattern=SHU261_CANARY_MISSING_MUST_FAIL_2 .github/coordinator/test/shu261-review-findings.test.mjs
TAP version 13
# env-canary=undefined builder_calls=1 exit=0
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_2: env-canary
not ok 1 - SHU261_CANARY_MISSING_MUST_FAIL_2: env-canary
  ---
  duration_ms: 320.627509
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:61:40'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_CANARY_MISSING_MUST_FAIL_2: env-canary must block builder execution

    1 !== 0

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:67:12)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 384.286643

exit=1
```

### SHU261_CANARY_3

```text
$ SHU261_MUTATION=SHU261_CANARY_3 node --test --test-name-pattern=SHU261_CANARY_MISSING_MUST_FAIL_3 .github/coordinator/test/shu261-review-findings.test.mjs
TAP version 13
# process-canary=undefined builder_calls=1 exit=0
# Subtest: SHU261_CANARY_MISSING_MUST_FAIL_3: process-canary
not ok 1 - SHU261_CANARY_MISSING_MUST_FAIL_3: process-canary
  ---
  duration_ms: 131.89159
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:61:40'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_CANARY_MISSING_MUST_FAIL_3: process-canary must block builder execution

    1 !== 0

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:67:12)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 206.351026

exit=1
```

### SHU261_CLEANUP_RUNS_ALL_CALLBACKS

```text
$ SHU261_MUTATION=SHU261_CLEANUP_RUNS_ALL_CALLBACKS node --test --test-name-pattern=SHU261_CLEANUP_RUNS_ALL_CALLBACKS .github/coordinator/test/shu261-review-findings.test.mjs
TAP version 13
# cleanup_calls=[0,0,1] inventory_calls=0 error=Error: early cleanup failure
# Subtest: SHU261_CLEANUP_RUNS_ALL_CALLBACKS
not ok 1 - SHU261_CLEANUP_RUNS_ALL_CALLBACKS
  ---
  duration_ms: 3.090131
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:73:1'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_CLEANUP_RUNS_ALL_CALLBACKS: every callback must run exactly once
    + actual - expected

      [
    +   0,
    +   0,
        1,
    -   1,
    -   1
      ]

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
    0: 1
    1: 1
    2: 1
  actual:
    0: 0
    1: 0
    2: 1
  operator: 'deepStrictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:87:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 61.64647

exit=1
```

### SHU261_NO_SETENV

```text
$ SHU261_MUTATION=SHU261_NO_SETENV node --test --test-name-pattern=SHU261_NO_SETENV .github/coordinator/test/shu261-review-findings.test.mjs
TAP version 13
# parsed_setenv=true namespace_root_startup=0:local-oauth-canary oauth_preserved=true
# Subtest: SHU261_NO_SETENV: parsed policy controls real wrapper startup and preserves OAuth
not ok 1 - SHU261_NO_SETENV: parsed policy controls real wrapper startup and preserves OAuth
  ---
  duration_ms: 14.450068
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:93:1'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_NO_SETENV: uncontrolled BASH_ENV must not execute in privileged wrapper startup
    + actual - expected

    + '0:local-oauth-canary'
    - null

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: ~
  actual: '0:local-oauth-canary'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:121:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.start (node:internal/test_runner/test:944:17)
    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 69.470844

exit=1
```

### SHU261_OAUTH_ENV_KEEP

```text
$ SHU261_MUTATION=SHU261_OAUTH_ENV_KEEP node --test --test-name-pattern=SHU261_NO_SETENV .github/coordinator/test/shu261-review-findings.test.mjs
TAP version 13
# parsed_setenv=false namespace_root_startup=null oauth_preserved=false
# Subtest: SHU261_NO_SETENV: parsed policy controls real wrapper startup and preserves OAuth
not ok 1 - SHU261_NO_SETENV: parsed policy controls real wrapper startup and preserves OAuth
  ---
  duration_ms: 11.259807
  type: 'test'
  location: '/home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:93:1'
  failureType: 'testCodeFailure'
  error: |-
    SHU261_OAUTH_ENV_KEEP: command-specific env_keep must preserve OAuth
    + actual - expected

    + undefined
    - 'local-oauth-canary'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'local-oauth-canary'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///home/bawes/work/shu261fix/.github/coordinator/test/shu261-review-findings.test.mjs:122:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.start (node:internal/test_runner/test:944:17)
    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 70.967979

exit=1
```
