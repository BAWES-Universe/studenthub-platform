# SHU-261 round-three validation

## Revision and scope

Starting HEAD: `0025cd84d22c7c573502086b19276d6278cfacdc`.
Branch: `fix/shu-261-protected-class-and-error-preservation`.
Working clone throughout: `/home/bawes/work/shu261can`.
Baseline: local `origin/main`, `514169b7a32608bcce8603aa32304a5c165b82c8`;
there is no local branch named `main`. No remote state was changed or queried.
The final local commit SHA is recorded in the writer's completion report.

This round changes the caller and three test files, plus this report. It restores
an observable environment-value canary and closes the preflight, directory-map,
and process-marker mutation gaps. The lost control was a defence-in-depth probe,
not an open credential path: the independent forbidden-key control and deployed
systemd boundary were unchanged. No deployment or host validation is claimed.

## Route 1: restore the wrapper-environment canary

Exact resulting caller code:

```js
const safeEnv = buildReviewExecutionEnvironment(env);
// The wrapper receives this value; the confined child must not inherit it.
safeEnv.SHU261_ENV_CANARY = environmentCanary;
```

`safeEnv` is passed as `env:` to the wrapper invocation. The sanitizer still
constructs its fixed clean environment. The canary is deliberately added **after**
that call, so its presence does not depend on a discarded sanitizer argument.
The child receives the same expected value through `--env-canary` and must report
its absence from its own environment.

The discarded `canarySourceEnv` object and guard are removed. The old wording
`review environment canary is not live before confinement` is replaced by the
precise comment above and a test at the actual wrapper invocation boundary:

```js
assert.equal(options.env.SHU261_ENV_CANARY, get('env-canary'),
  'SHU261_CALLER_ENVIRONMENT: wrapper environment must contain the exact canary supplied to the child probe');
```

Deleting the assignment produced this observed assertion failure (random nonce
abbreviated; it is a generated test value):

```text
SHU261_CALLER_ENVIRONMENT: wrapper environment must contain the exact canary supplied to the child probe
+ actual - expected
+ undefined
- 'SHU261_ENV_<generated nonce>'
code: ERR_ASSERTION
name: AssertionError
```

The committed mutation is named
`SHU-261 mutation: wrapper environment canary placement removed`. It removes
`safeEnv.SHU261_ENV_CANARY = environmentCanary;`, runs the caller test, and requires
exit 1, `AssertionError`, and specifically `SHU261_CALLER_ENVIRONMENT`, while
rejecting syntax/module-load crashes.

### Two instruction conflicts resolved explicitly

1. The original **literal m3** anchor,
   `buildReviewExecutionEnvironment(canarySourceEnv)`, no longer exists under the
   explicitly permitted route 1. Its replacement mutation removes the actual
   assignment to the wrapper environment, the same control tested by main's m8.
   This adapted m3 is **KILLED by SHU261_CALLER_ENVIRONMENT**. This report does not
   claim that a nonexistent textual anchor was applied or killed. Replacing the
   sanitizer's now-irrelevant input would correctly have no effect on placement.
2. Renaming `SHU261_CALLER_CANARIES: real caller supplies live canaries to loaded
   child` would violate zero test names lost versus main. The historical parent
   name is retained and its behavior is strengthened: it now starts the **real**
   process marker and asserts its visibility, instead of returning a fake kill
   handle. Five precisely worded subtests are added:
   `wrapper environment contains probe canary; omitted child option=<option>`,
   for `null`, `protected-paths-json`, `fd-canary`, `env-canary`, `process-canary`.
   The environment assertion no longer claims that a discarded value was stripped.
   The old name is now accurate about source canaries; the loaded child still uses
   documented confined-OS doubles. A clarification was offered; no response was
   received before proceeding with this resolution.

## Coverage additions

- `SHU261_PREFLIGHT_PATHS`: calls the real `readOnlyHostPreflight` with identity
  and filesystem doubles, then deep-equals both inspected paths and returned paths
  against the complete independently enumerated list. No `/srv` path is accessed.
- `SHU261_HOST_CLASS_DIRECTORIES`: extracts the shipped `classDirectories`
  declaration and deep-equals its complete sorted key list. This is a source pin,
  not execution of the host-mutating validator.
- `SHU261_PROCESS_MARKER_LIVENESS`: directly calls the newly exported, otherwise
  unchanged `processCanaryMarker`. A real marker proves the positive case. A
  filesystem double returning an unrelated cmdline must cause rejection with the
  production liveness error. Test teardown also handles an incorrectly returned
  marker under mutation.
- The caller now surfaces callback assertion errors with `assert.ifError`.
  Inventory-error identity is pinned to strengthen the inherited removal audit.

## Required suites

All runs used `TMPDIR=/tmp`, the existing `umask 0002`, and the verifier's
`chmod -R go-w .github/coordinator` normalization. An initial unnormalized focused
run failed at the trusted-child file-permission gate; it was corrected before the
reported suites. No fixture failure was discounted as a passing test.

```sh
TMPDIR=/tmp node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
TMPDIR=/tmp SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs" npm run test:coordinator
```

| Run | Total | Pass | Fail | Skipped | Cancelled | Todo | Exit |
|---|---:|---:|---:|---:|---:|---:|---:|
| Final ordinary suite | 1110 | 1103 | 0 | 7 | 0 | 0 | 0 |
| Final future-clock suite | 1110 | 1103 | 0 | 7 | 0 | 0 | 0 |
| Pinned main source, ordinary suite | 1062 | 1055 | 0 | 7 | 0 | 0 | 0 |

Ordinary duration: `65362.482654 ms`; future: `66264.61549 ms`;
main source: `65316.608328 ms`.

For main, the 19 differing source files were saved as bytes and modes, temporarily
loaded from the pinned Git objects **in this clone**, tested, then restored in a
`finally` block. All 19 restorations were independently byte-compared. HEAD and
branch never changed; no separate working clone was used for these verifier runs.
The existing committed mutation-test harness still uses temporary fixture copies.

### Exact skips, identical in all three suites

1. `SHU-227: worker owns its checkout and recovery preserves descendant commits`
   — requires root or passwordless sudo for distinct-uid proof.
2. `SHU-227: non-owner service account resolves revision with no global Git trust`
   — requires distinct-uid execution.
3. `SHU-227: empty-root main drives real Git, both real adapters and real broker through four launches`
   — requires distinct-uid execution.
4. `SHU-228: empty-root main drives real Git, both real adapters and real broker through four launches`
   — requires distinct-uid execution.
5. `SHU-241 A2 host: R1 uses the existing bundle transport through the distinct worker identity`
   — host cannot switch to the fixture worker uid.
6. `SHU-244 A10: distinct-root scoped handoff production workspace`
   — host cannot switch worker uid.
7. `SHU-71 restricted capability refusal`
   — production vocabulary has no undeclared runtime/role pair.

Skips are not passes. No SHU-261 test is skipped.

### Test-name multiset

Collected every actual TAP `ok`/`not ok` name, including nested subtests, and
removed only skip annotations before comparing Counters:

- Main: **1062** names; final ordinary: **1110**; final future: **1110**.
- Main names lost: **0**; names added: **48**.
- Ordinary versus future multiset difference: **0**.
- Starting-head count was 1098: this round adds **12** tests (4 mutations,
  3 direct coverage tests, 5 caller subtests).

## Verifier mutant table

Each mutation used a unique-anchor check, ran in this clone, and restored the
original file before the next mutation. m1/m2/m9 ran their focused isolation test;
m3 ran the caller test and its five subtests; m4–m7 ran all 18 cleanup/network
tests; m8 ran the original caller test against pinned main source. These are
focused mutant totals, not claims of full-suite mutant runs.

| Mutant | Change | Total/pass/fail/skip | Result and observed assertion |
|---|---|---|---|
| m1 | Remove service-home Claude path from preflight | 1/0/1/0 | KILLED: `SHU261_PREFLIGHT_PATHS` |
| m2 | Remove service-home Claude directory-map entry | 1/0/1/0 | KILLED: `SHU261_HOST_CLASS_DIRECTORIES` |
| m3 (adapted) | Remove wrapper environment canary assignment | 6/0/6/0 | KILLED: `SHU261_CALLER_ENVIRONMENT` (five failed subtests plus their parent) |
| m4 | Remove lock-release cleanup step | 18/6/12/0 | KILLED: `SHU261_CLEANUP_ALL_STEPS` |
| m5 | Cleanup-only `exit 1` becomes `exit 0` | 18/15/3/0 | KILLED: `SHU261_CLEANUP_EXIT` |
| m6 | Capture primary status as zero | 18/10/8/0 | KILLED: `SHU261_CLEANUP_EXIT` |
| m7 | Remove `trap - EXIT HUP INT TERM` | 18/18/0/0 | SURVIVED: known equivalent mutant |
| m8 (main) | Remove `safeEnv.SHU261_ENV_CANARY = envCanary;` | 1/0/1/0 | KILLED: `SHU261_CALLER_CANARIES` |
| m9 | Delete process-marker cmdline liveness guard | 1/0/1/0 | KILLED: `SHU261_PROCESS_MARKER_LIVENESS` |

Nine table entries: **8 killed / 1 equivalent survivor / 0 non-equivalent
survivors**. Aggregate focused totals: **82 tests / 49 pass / 33 fail / 0 skip**.
Failures here are intentional mutation detections. The 39 committed SHU-261
mutation tests all pass in both full suites.

## Removed assertion-line audit

Mechanical rule: removed diff lines, excluding `---` headers, matching
`assert|expect|throw`. Round-three count: **3**. Full PR versus main: **8**.
No unadjudicated removal remains. Counts include prose/scaffolding, not just
executable assertions.

### Three lines removed in this round

1. Old: `throw new Error("review environment canary is not live before confinement");`
   New: the exact `SHU261_CALLER_ENVIRONMENT` equality assertion above, checked at
   the wrapper invocation, plus its named kill mutation. The removed guard only
   tested a just-constructed discarded object; the replacement can fail on the
   actual boundary property and demonstrably does. No reachable guard condition
   is lost from the shipped production code.
2. Old: `verifyInventory: () => { inventory++; throw new Error('SHU261_HOST_WORKTREE: bounded validation must restore the exact worktree inventory'); },`
   New: `verifyInventory: () => { inventory++; throw inventoryError; },` plus
   `assert.equal(caught.errors[1], inventoryError, 'SHU261_CLEANUP_INVENTORY_IDENTITY: retain the exact inventory error unchanged');`.
   Same error message and throw behavior, now stronger exact-object identity.
3. Old: `assert.equal(Object.values(options.env).includes(get('env-canary')), false,`
   New: `assert.equal(options.env.SHU261_ENV_CANARY, get('env-canary'),` with the
   named message quoted above. A tautology becomes a proven presence assertion.

### Eight inherited/main-relative lines, old and replacement

1. Old prose: `mutation must fail a named assertion.` New prose retains
   `Every mutation must fail a named` / `assertion.` and enumerates additional
   controls. Rewrap, not executable assertion removal; stronger coverage list.
2. Old: `if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "SHU261_HOST_CLEANUP: cleanup or final inventory failed");`
   New: `throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors, ...,
   { cause: primaryError ?? cleanupErrors[0] });` and `if (primaryError) throw primaryError;`.
   Stronger: every cleanup step and inventory still run, primary error is retained
   as cause and first detail, and clean cleanup rethrows it unchanged.
3. Old: `assert.ok(start > 0 && end > start, 'loaded cleanup region must be found');`
   New: direct imported `finalizeHostValidation` calls with
   `assert.deepEqual(calls, [1, 1, 1], 'SHU261_CLEANUP_RUNS_ALL_CALLBACKS: every callback must run exactly once');`
   and inventory/error assertions, now including exact error identity. The real
   exported function is exercised instead of a parsed source region; a missing
   export cannot silently bypass this check.
4. Old: `const context = { assert, server: null, markerProcess: null, cleanup: [`.
   New: `const cleanupCallbacks = [` passed to the real function. This was VM
   scaffolding containing the word `assert`, not an assertion. The stronger real
   function tests replace that scaffold.
5. Old: `assert.equal(caught.errors[1].name, 'AssertionError');`
   New: `assert.equal(caught.errors[1].name, 'Error');` and the exact-object
   `SHU261_CLEANUP_INVENTORY_IDENTITY` assertion quoted above. The injected fixture
   is an Error; identity is stricter than an error-name comparison.
6. Old: `assert.equal(options.env.SHU261_ENV_CANARY, get('env-canary'));`
   New: the same equality with the named `SHU261_CALLER_ENVIRONMENT` message,
   five explicit boundary subtests, and a named kill mutation. Restored and stronger.
7. Old: `assert.equal(processInspectionDenied(get('process-canary')), false, 'SHU261_CALLER_PROCESS: live marker must be visible before confinement');`
   New: the same actual visibility equality with message
   `SHU261_CALLER_PROCESS_VISIBLE: real marker must be observable before confinement`,
   plus `assert.equal(processCanaryStarted, get('process-canary'), ...)`, the real
   production guard, and the direct rejection test that kills m9. Stronger.
8. Old: `assert.throws(() => validateReviewWrapper([...], fsImpl, { model: true }), /fixed noninteractive/);`
   New (inherited, unchanged this round): same call with `/fixed .*noninteractive/`.
   The reviewer explicitly required leaving this message-compatible regex alone.
   Its substantive policy is pinned more strongly by `SHU261_NO_SETENV`, the
   parsed-policy assertions, and the SETENV mutation. This report does not claim
   the regex alone became stricter; the stronger policy assertions are the basis
   for adjudication. See the independent verdict's R8.

## Byte identity and hygiene

Git blob comparison, pinned main blob = working-file `git hash-object`:

| File | Both blob OIDs |
|---|---|
| `.github/coordinator/config.json` | `8a0317173d76f4c09811b9365e25b380b38dc93d` |
| `docs/parity/organizations-stores-and-contacts.md` | `7a8c17fbdf2372f6f1ed358d14034b194b9dce46` |
| `.github/coordinator/service/SHU-261-REVIEW-FIXES.md` | `ae7f89f3e1b7cf927b76ab7579e8cb50fe0d3746` |

All three are byte-identical, not merely free of visible diffs. Dispatch remains
OFF. No SHU-140, workflow, production, database, deployment, or credential changes.

`git diff --check`: exit 0. `bash -n .github/coordinator/reviewer-sandbox.sh`:
exit 0 after restoring temporary shell mutants; no shell file is in this round's
committed diff. Added lines contain no conflict markers or secret values.

Remaining limits: host validation is still pending; filesystem/identity preflight
uses doubles, directory-map coverage is a source assertion, and the loaded child
uses confined-OS doubles. No real sudo/systemd reviewer boundary or ACL operation
was exercised. The seven skipped tests remain unverified. No push, PR write,
merge, activation, host mutation, deployed checkout, or database access occurred.
