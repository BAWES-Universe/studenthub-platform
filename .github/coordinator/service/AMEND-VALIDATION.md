# PR #135 round-2 amendment (repository only)

Historical record for `ac67bc1`; R3 independently confirmed F1 and F4 closed.
The subsequent G1 fix and current results are in
[R3-AMEND-VALIDATION.md](R3-AMEND-VALIDATION.md).

Starting head: `5a3c95610fce3fd4f90caac55ac19711a430dfdd`. Both independent
round-2 verdict files (`verdict-135-r2.md` and `.json`) were read before changes.
This amendment addresses the two requested items: F1 readiness/restart writer-lock
contention and F4 wrapper-contract documentation. It does not claim a new
independent verdict or complete A2–A7 closure.

The verifier's adjudication is retained: **A2 CLOSED at repository scope (OPEN at
host scope); A3, A4, A5 and A7 PARTIAL; A6 OPEN.** No marker is upgraded.

## Readiness/restart determinism

`executeLifecycle` supplies the action to `withLock`. For the complete `readiness`
and `restart` action, the production provider acquires only `journal.lock`; it
never opens or acquires `host-tick.lock`. This includes the network preflight,
worker/transport subprocess observations, supervisor restart, receipt saves and
archive finalization. There is consequently no driver-owned writer descriptor
with which a scheduled coordinator tick can conflict during either action.
Journal custody continues to serialize lifecycle evidence and restart consumption.
The preflight lock assertion requires the exact `delegated-to-coordinator` state
for these actions; other steps retain their existing required lock state.

The existing descriptor/inode custody guard is retained and strengthened to
require journal custody explicitly. Placement, staging, checkout, pin and systemd
effects other than supervisor restart explicitly require writer custody. Existing
exit-0, restart single-use/adoption, approval, order and durability guards remain.

The recorded-boundary test runs both actions with scheduled completions injected
before every boundary, then after every boundary: **3,098 completions across
3,098 filesystem/command points** in four executions. The fixture models a tick
under writer contention as `Result=success`, `ExecMainStatus=2`; otherwise it
records exit 0 with an advancing timestamp. All injected ticks complete with exit
0, both actions produce valid receipts, journal custody is retained through the
operation, and descriptors are released at exit. Commands include remote Git/API
preflight and both restart worker/transport observations.

A separate control deliberately holds the writer lock, observes exit 2 and proves
`SHU251_PROVIDER_READINESS` still refuses it. Another test proves writer-dependent
effects refuse journal-only custody and that exception paths release the journal
lock. Four syntax-checked mutations restore contention: writer acquisition for
readiness alone, restart alone, both actions, and removal of the executor's action
argument. Each runs a passing
control and is killed by exactly one assertion failure containing
`DETERMINISTIC_TIMER_CUSTODY_REQUIRED`. The assertion counts actual modeled
lock-conflict ticks; an unrelated refusal is not credited as a kill. These mutations execute the real provider
through fixture boundaries; no host commands are forwarded.

This proves removal of the adjudicated driver/timer lock-conflict mechanism at
repository scope. It does not prove live systemd behavior, transitional unit-state
handling, or freedom from interference by external writers.

## Wrapper contract: documents changed

`SHU-251-HOST-BINDINGS.md` and `PHASE-A-DRIVER.md` now describe the shipped split:
nine legacy actions require exactly an action plus absolute window-spec path and
route to `host-window-bindings.mjs`; ten lifecycle actions take an absolute driver
spec and forward flags to `phase-a-driver.mjs`. Caller environment is inherited,
the driver's closed parser/approval checks apply, and no approval is manufactured.
Lifecycle execution can install units and start/restart services. The legacy test
title now identifies its nine-action scope.

The wrapper code is unchanged because its split routing and flag/approval
boundaries were upheld by the verifier. The contradictory documents were stale.

## Verification

All suite runs set `SHU251_NO_SYSTEMD=1`; no systemd-interacting test is enabled. Full suites use
repository-backed `/tmp` in a private user/mount namespace and drop retained
capabilities. Temporary fixtures, archive copies and mutation trees remain inside
this repository. No assertion, refusal code or permitted skip is removed.

Commands (logs retained under `node_modules/.cache/shu251-amend/`):

```sh
chmod -R go-w .github/coordinator
umask 0002
export SHU251_NO_SYSTEMD=1
export TMPDIR="$PWD/node_modules/.cache/shu251-amend/tmp"
node --test .github/coordinator/service/test/host-lifecycle.test.mjs .github/coordinator/service/test/production-lifecycle.test.mjs .github/coordinator/service/test/phase-a-driver.test.mjs .github/coordinator/service/test/host-window-bindings.test.mjs
node --test --test-name-pattern=mutation .github/coordinator/service/test/host-lifecycle.test.mjs .github/coordinator/service/test/production-lifecycle.test.mjs .github/coordinator/service/test/phase-a-driver.test.mjs .github/coordinator/service/test/host-window-bindings.test.mjs
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/.cache/shu251-amend/full-tmp"
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/.cache/shu251-amend/full-tmp"
```

Base comparison uses a complete `git archive 00eb979800b5ef6dfb918b57002d167802238612`
under `node_modules/.cache/shu251-amend/base`, with the same combined command and
a separate repository-backed temporary directory. The full combined glob executes
every shipped coordinator/service mutation suite, beyond the explicit four-file
mutation run. These declared mutation tests are not an exhaustive set of all
possible guard mutations (see F3 below).

Diagnostic iterations are not hidden or classified as skips. The first new
determinism test had 3 tests / 2 passes / 1 failure because a before-close hook
cannot observe the release after that close; after-hooks now assert the release,
and both phases assert the final descriptors are absent. The first base run used
an incomplete coordinator-only archive and reported 1,388 tests / 1,361 passes /
8 failures / 19 skips: seven missing-file failures and one existing VM script's
100ms timeout. The complete-base rerun passed. An earlier candidate full run
passed 1,588 / 1,569 / 0 / 19 before adding two action-specific mutation tests and
tightening the mutation assertion to count conflicts explicitly. Final counts
below supersede these diagnostic runs; no timeout, guard or skip was relaxed.

## Final measured results

| Run | Tests | Pass | Fail | Skip | Cancelled | Todo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Focused four files | 248 | 248 | 0 | 0 | 0 | 0 |
| Explicit mutations, four files | 109 | 109 | 0 | 0 | 0 | 0 |
| Full service | 449 | 438 | 0 | 11 | 0 | 0 |
| Full coordinator + service | 1590 | 1571 | 0 | 19 | 0 | 0 |
| Base full coordinator + service | 1388 | 1369 | 0 | 19 | 0 | 0 |

Relative to the verifier's head, this adds **7 tests and 7 passes** with no new
skips. Relative to base, it adds **202 tests and 202 passes**. The sorted skip
profile is byte-identical to base by name and reason: 19 entries, including the
11 existing `SHU251_NO_SYSTEMD` skips. `host-suite-contract.mjs`, including
`PERMITTED_SKIPS`, is byte-identical to base. Skip-profile SHA-256:
`da2dad94fbc8f6246141f5cdbf2a57525c19831f023e0aeb2b0ff64f82aa6cbe`.

All 109 explicit mutation tests pass, including four new contention mutations;
this statement is limited to the declared cases, not the F3 surviving mutations
reported by the verifier. The full suite also executes all other shipped
coordinator/service mutation suites. The final determinism diagnostic remains
3,098 injected completions at 3,098 boundaries.

| Retained TAP log | SHA-256 |
| --- | --- |
| `focused.tap` | `58a8c7493d02c005f2d7d47ccd052789ec35e3fccd62bcf324c5ca90dc5901bb` |
| `mutations.tap` | `062ce121fd6818d0c102c70e45b824cde98b14bbb403dbdbeae350c740c7a7cd` |
| `service.tap` | `cf700f24fe7205b5930fd95c3708b574e32ace2e1368187a30d00a611abe5f6f` |
| `full.tap` | `65b9be1536f42487d9177a93bbb2b83f743e5df7ffc012914be175be9dac9eb4` |
| `base-full.tap` | `8d7caa2d521fac79163299ca3e78e5ca428ab87a840584d7093153d3d5dc0487` |

The final commit is reported as `FINAL_HEAD` in the delivery response. This
record is included in that commit; no independent exact-head PASS is claimed.

## Findings and evidence that remain unsupported

The requested two-item amendment does not close the verifier's other findings:

- F2: executed preflight still creates durable evidence while exempt from the
  driver's host-mutation approval flag gate; signed owner approval and uid 0 are
  still required. No claim that this classification is fixed.
- F3: the verifier's six surviving targeted mutations remain recorded limitations:
  gate-off writer release (D1), pin-only baseline relaxation (D3), gate-off inventory
  equality (D6), crossed environment paths (D8), strictly-newer tick timestamp
  (D9), and the redundant post-rollback clause (D10). Passing declared mutation
  families does not establish exhaustive mutation coverage or overturn those
  adjudications.
- F5: gate-off `launches` remains literal zero; the actual evidence is the local
  watcher/inventory plus a single children sample, not a measurement of every
  transient launch or remote authoritative write.
- A3 still lacks per-process credential isolation. A4 still lacks acceptance-worker
  bootstrap, live systemd proof and transitional-state coverage. A6 still lacks
  unconditional admission/gate shutdown before undo, cleanup despite writer-lock
  acquisition failure, full host inventory and every evidence/archive syscall
  recovery case. A7 still lacks expiry-triggered physical teardown, continuous
  approval enforcement, owner artifact/key provisioning proof and binding of the
  initially executing stale-checkout tool bytes to the approved tree.
- No live-host acceptance, external Git-writer atomicity, application npm suite,
  future-clock/depth-1 rerun, or independent review of the final amendment is claimed.

No host access, push, PR creation/modification, merge, GitHub/Linear comment,
activation, reseed, dispatch or real-key signing occurred.
