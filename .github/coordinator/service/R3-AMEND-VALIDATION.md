# PR #135 R3 G1 amendment (repository only)

Starting head: `ac67bc1395d0bdd165d61c3675d80ee68d0018bf`. Both full R3
verdicts (`/home/bawes/work/verdict-135-r3.md` and `.json`) were read before
implementation. R3 confirmed **F1 readiness/restart contention CLOSED** and
**F4 wrapper documentation CLOSED**. Those fixes are preserved. The wrapper
code remains byte-identical to that head (Git blob
`ed905d66e188af5ee0bf50cc5a212c57bf51553f`).

The adjudication remains **A2 CLOSED at repository scope (OPEN at host scope);
A3/A4/A5/A7 PARTIAL; A6 OPEN**. This is the writer's G1 correction and evidence,
not an independent exact-head PASS or live acceptance.

## Finding, reproduction and fix

G1 was pre-existing, including at `5a3c9561`; it was not introduced by the F1
amendment. It was previously undisclosed in shipped documentation. The A5
`running-gate-off` action held `host-tick.lock` across `git ls-remote` and `gh api`
(each has a 30-second production timeout), and across both executor
`serviceReady()` calls. Only its polling loop released the lock. A scheduled
coordinator tick could conflict-exit 2, which systemd treats as Result=success,
while readiness correctly refuses ExecMainStatus=2. Failing closed still blocked
the required acceptance step.

Before changing production source, the two new regression tests were run against
`ac67bc1` source. Both failed on their conflict-count assertions:

| Injection | Modeled ticks | Actual modeled conflicts | Action outcome |
| --- | ---: | ---: | --- |
| Before every filesystem/command boundary | 554 | 457 | `SHU251_PROVIDER_READINESS` |
| Single tick at `gh api` | 1 | 1 | `SHU251_PROVIDER_READINESS` |

These are our measured counts, not the verifier's differently instrumented
1,107-point/913-conflict sweep. Each regression stops on its first failing case,
so the before-fix run does not claim the later after-boundary or single-site cases
executed. Retained log: `node_modules/.cache/shu251-r3-amend/before.tap`.

The provider now acquires only `journal.lock` throughout `running-gate-off`,
including preflight, both readiness calls, polling, durable receipt and archive
finalization. The executor requires the exact `delegated-to-coordinator` probe
state for this action. The polling helper releases/reacquires a writer descriptor
only when its caller actually holds one; it never releases journal custody.
This preserves direct writer-custody callers while avoiding post-poll writer
reacquisition in the complete action. The fake fixture mirrors the action scope.

No readiness, approval, custody, order, inventory, tick, error-code or skip guard
was removed or relaxed. Writer effects still require writer custody. Existing
exit-2 refusal remains tested. The existing custody/refusal/exception-release
test now also exercises journal-only gate-off custody.

## Regression evidence and non-vacuous mutations

After the fix, the same regressions report:

| Injection | Modeled ticks | Conflicts | Outcome |
| --- | ---: | ---: | --- |
| Before every boundary | 844 | 0 | Valid receipt |
| After every boundary | 840 | 0 | Valid receipt |
| Single tick at `gh api` | 1 | 0 | Valid receipt |
| Single tick at `git ls-remote` | 1 | 0 | Valid receipt |
| Single tick at first executor readiness | 1 | 0 | Valid receipt |
| Single tick at second executor readiness | 1 | 0 | Valid receipt |

The sweep checks journal custody continuity and final lock release; the single
site test confirms all three provider readiness calls executed (two executor
calls and the helper's internal check). F1's existing regression still injects
**3,098 ticks at 3,098 boundaries with zero conflicts**. Retained log: `after.tap`.

Four new named mutations each execute a passing control, change exactly one
source occurrence in a disposable copy, pass `node --check`, then fail exactly
one targeted regression with ERR_ASSERTION. The killing assertion counts ticks
actually modeled as exit 2, before inspecting the action outcome; a guard refusal
alone is not credited as a kill. Separate diagnostic reruns recorded:

| Named mutation | Ticks | Conflicts | Killing assertion |
| --- | ---: | ---: | --- |
| gate-off whole-step writer contention | 379 | 282 | `GATE_OFF_TIMER_CONFLICTS_REQUIRED` |
| gate-off executor observation scope | 379 | 282 | `GATE_OFF_TIMER_CONFLICTS_REQUIRED` |
| gate-off post-poll writer reacquisition | 701 | 101 | `GATE_OFF_TIMER_CONFLICTS_REQUIRED` |
| gate-off single network tick contention | 1 | 1 | `GATE_OFF_SINGLE_TICK_CONFLICTS_REQUIRED` |

The first, second and fourth also refuse with `SHU251_WRITER_LOCK`, because the
unchanged exact observing-state guard detects the mutated custody. Their kills
are nevertheless the counted 282/282/1 modeled conflicts, not that refusal.
The post-poll mutant refuses with `SHU251_PROVIDER_READINESS`. Diagnostic logs
are `mutant-{whole-step,executor-scope,post-poll,single-tick}.tap`. The four
existing F1 mutation tests retain their assertions and pass with updated source
anchors. Two regression tests plus four mutations add six tests.

## Validation commands and results

All logs below are under `node_modules/.cache/shu251-r3-amend/` (gitignored).
Tests interpret production operations through disposable recorded boundaries;
no command is forwarded to a real service, remote Git, API or credential store.
Full suites retain `SHU251_NO_SYSTEMD=1` and bind repository-backed temporary
storage inside a private user/mount namespace with retained capabilities dropped.

```sh
chmod -R go-w .github/coordinator
umask 0002
export SHU251_NO_SYSTEMD=1
export TMPDIR="$PWD/node_modules/.cache/shu251-r3-amend/tmp"
node --test .github/coordinator/service/test/{host-lifecycle,production-lifecycle,phase-a-driver,host-window-bindings}.test.mjs
node --test --test-name-pattern=mutation .github/coordinator/service/test/{host-lifecycle,production-lifecycle,phase-a-driver,host-window-bindings}.test.mjs
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/.cache/shu251-r3-amend/full-tmp"
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/.cache/shu251-r3-amend/full-tmp"
```

Runner: Node v22.22.3. All final runs completed successfully.

| Run | Tests | Pass | Fail | Skip | Cancelled | Todo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Focused four files | 254 | 254 | 0 | 0 | 0 | 0 |
| Explicit mutations, four files | 113 | 113 | 0 | 0 | 0 | 0 |
| Full service | 455 | 444 | 0 | 11 | 0 | 0 |
| Full coordinator + service | 1596 | 1577 | 0 | 19 | 0 | 0 |

Compared with R3's confirmed head, all suites gain six tests/passes (the explicit
mutation subset gains four). The combined suite executes every shipped
coordinator/service test file, including its mutation families, subject only to
the unchanged skip profile. No final run failed; the deliberate before-fix
regression failures and mutant failures above are not reclassified as skips.

The 19 sorted `<name> # SKIP <reason>` lines match both retained prior-head and
base profiles byte-for-byte. SHA-256:
`da2dad94fbc8f6246141f5cdbf2a57525c19831f023e0aeb2b0ff64f82aa6cbe`.
`host-suite-contract.mjs` (including PERMITTED_SKIPS) is byte-identical to the
starting head; SHA-256 remains
`37e8824a22c5bf5c7313305dcb3ca551dd917212f8dff00503dd092e70a3971f`.
The A2–A7 disposition table is byte-identical too. Source refusal-code sets
are unchanged, as are 47 executor `check` calls and 61 provider `guard` calls.
`git diff --check` passes.

| Retained TAP log | SHA-256 |
| --- | --- |
| `before.tap` | `21c217944b69f07fc0fd40524823f797d9f59202f86c3495e7580e6de620e25a` |
| `after.tap` | `050a3209e375d5b3c3cbac583a0cc06c999d2cf26dc5f90c6d53eced958b17a9` |
| `focused.tap` | `b641bd3cdd3fbbe0db7ff1b9ad1ee6267f4e25c79c2cc2d11509cae31b39120f` |
| `mutations.tap` | `de3e6ddc0656a5a7834f12833c0e793ef4bfa52972a9ebf9e5349972a4472dfc` |
| `service.tap` | `83e2e84450b109421fcc99c46daa280f2d1cf94bce92be0abdaf139ee6cd7796` |
| `full.tap` | `ef0da2212652fe3717dceef399c6201e543d0a3aa1f510acc7a97a9edb548c47` |

## Unclosed findings and unsupported claims

- **F2 remains open:** executed preflight persists durable evidence while exempt
  from the driver's host-mutation approval flag gate; owner signature and uid 0
  remain required. This amendment does not change that classification.
- **F3 remains open:** R2's surviving D1/D3/D6/D8/D9/D10 mutations remain part of
  the disclosed historical verdict. This amendment adds gate-off conflict
  coverage and changes its lock arrangement; it does not claim to close the
  broader F3 adjudication or independently re-adjudicate all six mutations.
  Pin-only relaxation, inventory equality, crossed environment paths,
  strictly-newer timestamp and redundant post-rollback clause coverage gaps
  are not fixed here. Passing every shipped mutation is not exhaustive coverage.
- **G2 remains residual:** gate-off watches/inventories the two state directories,
  not `repo_dir`. We do not prove a concurrent dispatch-off coordinator tick
  never modifies the checkout. Such interference can fail closed at
  `SHU251_LIFECYCLE_CHECKOUT`; no freedom-from-external-writer claim is made.
- **G3 remains informational/unclosed:** R3's M5 (accept either observing lock
  state) and M10 (drop the journal-custody conjunct) survived its targeted suite.
  These guard coverage gaps are not fixed or claimed killed here.
- F5's `launches: 0` is still literal. No complete transient-process or remote
  authoritative-write observation is delivered. A5 stays partial.
- A3 credential isolation, A4 worker bootstrap/transitional-state/live systemd
  proof, A6 unconditional shutdown/cleanup under lock failure/full inventory and
  syscall recovery, and A7 expiry teardown/continuous approval/key provisioning/
  executing-tool tree binding remain unsupported as previously disclosed.
- No live-host behavior or real timer trigger rate, external Git-writer atomicity,
  application npm suite, future-clock/depth-1 variants, or independent review of
  this final amendment is claimed. The 11 prohibited systemd tests stay skipped.
  Base suite counts are R3-confirmed historical evidence; no fresh base run is
  claimed here. No PR/CI/Linear state was queried or changed.

No host access, push, PR creation/modification, merge, GitHub/Linear comment,
activation, reseeding, dispatch or real-key signing occurred. The local commit's
`FINAL_HEAD` is reported in the delivery response.
