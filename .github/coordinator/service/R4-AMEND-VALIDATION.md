# R4 H1 amendment — repository-only writer evidence

Starting head: `de54fb46dacd475aad1b05c106eb07e0c427c468` (PR #135).
Both `/home/bawes/work/verdict-135-r4.md` and its JSON were read before changes.
R4 independently confirmed G1, F1 and F4 closed. Its sole AMEND item was H1:
a scheduled tick could write during gate-off preflight/first readiness before
watchers and inventory existed, and still receive a successful zero-write proof.

This is the writer's correction, not independent exact-head PASS or live acceptance.
**A2 remains CLOSED at repository scope / OPEN at host scope; A3/A4/A5/A7
remain PARTIAL; A6 remains OPEN.** The HOST-LIFECYCLE A2–A7 table is byte-identical.

## Before and identical interleaving after

Before editing production code, `reproduce.mjs` ran the production provider through
`productionFixture` at the starting head. After install/start it injected one tick
at `gh api`, first `ss` readiness, or first poll, into each state root. It called
`scheduledTick()` first and wrote only on exit 0; it counted completed writes.
The six cases each made **one actual modeled write, zero lock conflicts**.
The four preflight/readiness cases returned **ok=true, ticks=3, writes=0,
before==after**. Both poll controls refused `SHU251_PROVIDER_GATE_OFF`.

After the fix the identical six injections each made **one actual write, zero
conflicts**, and **all six refused SHU251_PROVIDER_GATE_OFF**. The injector was
unchanged; only the expected outcome changed. Logs/scripts are retained under
`node_modules/.cache/shu251-r4-amend/` (gitignored):

| Log | SHA-256 |
| --- | --- |
| before.log | 7f5b9cadcc824c87fbab3aea8558bae8d475ca35ec44ca4f67f811020d6d2fc1 |
| after-identical.log | 442649bcbed67684499b383478cd902d35d103b6593d6bf4c8f55694c51add6b |

## Observation and custody

- `executeLifecycle(running-gate-off)` now runs inside `observeGateOff`, before
  initialization, lock acquisition, preflight and first readiness. Configuration
  is validated before watching. The observer remains alive through finalization,
  then inventories, lets queued events run, checks, and closes on success/failure.
- A single recursive watcher on the common ancestor covers both state roots.
  Its callback counts changes within either root (and ancestor changes); unknown
  filenames and watcher errors fail closed. No second-root registration gap is
  introduced. Inventory includes directory mtime/ctime as well as file hashes,
  size, mtime and ctime, retaining the original symlink/type guards.
- Moving a watcher earlier alone cannot cover its own initial registration.
  `start` therefore captures `gate_off_baseline` under its **existing** writer
  custody and includes it in the durable, digest-bound start receipt. Gate-off
  loads that journal under journal custody and compares the recorded baseline
  with the observer's baseline before preflight or receipt resumption. A write
  even before watcher registration cannot simply become a new trusted baseline.
  Directory timestamps also expose a create/delete pair in that interval.
- Older start receipts missing this field refuse `SHU251_PROVIDER_GATE_OFF`.
  This is intentionally conservative: any recorded-state drift since start
  refuses. Reconstruction of the production provider retains the durable baseline.
- `runningGateOff()` consumes the same observer rather than taking a new baseline
  after preflight. Direct writer-custody provider calls retain their original
  handoff and checks. The G1 custody mechanism, observing lists, writerHeld guards,
  and conditional writer handoff/reacquisition are unchanged.
- Gate-off still **never acquires host-tick.lock**. New G1 sweeps inject **853
  before + 849 after = 1,702** scheduled completions, **zero conflicts**. The four
  single-tick network/readiness cases also have zero conflicts. F1 remains
  **3,098** readiness/restart injections, **zero conflicts**.

## New coverage and named mutations

Thirteen new ordinary regression tests and four new named mutations (17 tests).
Eleven tests inject into both roots: initialize, git preflight, gh preflight,
first readiness, poll, final readiness, finalize, baseline scan, before first
watch registration, create/delete before first watch, and capability preflight.
That is **22 actual modeled writes, zero conflicts, 22 named refusals**.
The capability case deletes its temporary file; it is still detected.

The separate-root regression uses sibling rather than nested state directories,
reconstructs the provider, asserts one common-ancestor registration and exactly
one close, and tests two more actual writes, a clean positive control, watcher
error and initialization error. The last test verifies writer-only baseline
capture and missing legacy baseline refusal with a correctly recomputed receipt
digest (it does not bypass the existing digest guard).

| Named mutation | What changes | Actual writes / conflicts | Kill |
| --- | --- | --- | --- |
| H1 preflight observation omitted | Remove outer observer and recorded-baseline check; restores the old late observation mechanism | 1 / 0 | false successful receipt fails H1_WRITE_OBSERVATION_REQUIRED |
| H1 first readiness observation omitted | Same mechanism, injection at first readiness | 1 / 0 | same |
| H1 persisted baseline omitted | Remove recorded/baseline equality; write before first watcher | 1 / 0 | same |
| H1 final observation omitted | Remove final observation check; write at finalize | 1 / 0 | same |

Each mutation runs a passing control, requires exact replacement counts, syntax
checks every changed module, then requires exit 1, exactly one failed test,
ERR_ASSERTION and the named assertion. The H1 harness additionally requires the
failed test's diagnostic to show **actualWrites=1, conflicts=0, outcome=fulfilled**;
a guard refusal or intention to write cannot count as its kill. The first two
mutations require two replacements because the two independent observation
mechanisms both protect the early window. Each fails on the first root; passing
controls exercise both. The 24 ordinary regression writes (22 + two disjoint-root
writes) are separate from mutation/control writes.

The existing four G1 mutations remain killed by actual conflict counts:

| Mutation | Scheduled ticks | Conflicts | Outcome |
| --- | ---: | ---: | --- |
| gate-off whole-step writer contention | 392 | 286 | SHU251_WRITER_LOCK |
| gate-off executor observation scope | 392 | 286 | SHU251_WRITER_LOCK |
| gate-off post-poll writer reacquisition | 702 | 101 | SHU251_PROVIDER_READINESS |
| gate-off single network tick contention | 1 | 1 | SHU251_WRITER_LOCK |

Counts changed from R4's historical 379/282, 379/282, 701/101, 1/1 because the
observation now begins earlier and adds inventory boundaries. The conflict
assertions still precede outcome inspection. No existing assertion was removed
or weakened, and no guard, error code or skip allowance was removed or relaxed.

## Verification

Runner: Node v22.22.3. Final source/test runs use the same commands as R3,
with the cache directory changed to `shu251-r4-amend`:

```sh
chmod -R go-w .github/coordinator
umask 0002
export SHU251_NO_SYSTEMD=1
export TMPDIR="$PWD/node_modules/.cache/shu251-r4-amend/tmp"
node --test .github/coordinator/service/test/{host-lifecycle,production-lifecycle,phase-a-driver,host-window-bindings}.test.mjs
node --test --test-name-pattern=mutation .github/coordinator/service/test/{host-lifecycle,production-lifecycle,phase-a-driver,host-window-bindings}.test.mjs
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/.cache/shu251-r4-amend/full-tmp"
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/.cache/shu251-r4-amend/combined-tmp"
```

All paths in production-provider tests are translated into disposable storage;
commands are recorded/interpreted, never forwarded to a real service or remote.
Full suites use a private user/mount namespace, repository-backed `/tmp`, dropped
capabilities, and the unchanged `SHU251_NO_SYSTEMD=1` prohibition.

| Final run | Tests | Pass | Fail | Skip | Cancelled | Todo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Focused four files | 271 | 271 | 0 | 0 | 0 | 0 |
| Explicit mutations, four files | 117 | 117 | 0 | 0 | 0 | 0 |
| Full service | 472 | 461 | 0 | 11 | 0 | 0 |
| Full coordinator + service | 1613 | 1594 | 0 | 19 | 0 | 0 |

Relative to R4's measured starting head: +17 tests/passes in focused and full
suites, +4 in the explicit mutation subset. Initial runs before the last two
regressions passed 269 focused / 117 mutations / 470 service (459 pass, 11 skip).
The legacy-baseline fixture initially failed because changing its receipt without
recomputing the digest correctly triggered SHU251_EVIDENCE_DIGEST. Fixing that
fixture reached the intended guard. No failure was reclassified as a skip.

The wrapper is byte-identical (`ed905d66e188af5ee0bf50cc5a212c57bf51553f`);
its binding/driver tests still run. F4 remains closed. `host-suite-contract.mjs`,
including PERMITTED_SKIPS, is byte-identical with SHA-256
`37e8824a22c5bf5c7313305dcb3ca551dd917212f8dff00503dd092e70a3971f`.
The extracted A2–A7 table is byte-identical (SHA-256
`0a5e5ca169bfb4da162b68b1272fc4fe4c308652f90b8276bebdd23944c52b0c`).
The 19 sorted skip lines reproduce the exact R4/R3/base profile SHA-256
`da2dad94fbc8f6246141f5cdbf2a57525c19831f023e0aeb2b0ff64f82aa6cbe`;
zero new skips or allowances.
No refusal code was removed; executor check calls increased 47 → 48 and provider
guard calls 61 → 64. `git diff --check` passes.

| Retained final TAP log | SHA-256 |
| --- | --- |
| focused.tap | 84831c2122af1b8222bb40a9b674782d7d77c78c535808163333b12bc4406f32 |
| mutations.tap | 3960415e455631bdc3069e29d0bfc2ab842de9a32b1337d9056fc387e502b800 |
| service.tap | ae3636631df361d50c891e3a68843caad09b6eecf98353de5f586401d5c24041 |
| full.tap | 733e59c37ae9b99fb88a5dfaca4c8378f0b9788e2081637ec090af919b8b8127 |


## Residual findings and limits

- **F2 remains open:** executed preflight persists evidence while exempt from
  the driver's mutation-approval flag gate; owner authentication remains required.
- **F3 remains open:** historical D1/D3/D6/D8/D9/D10 survivors and the broader
  pin-only, inventory-equality, crossed-environment, strictly-newer-timestamp and
  redundant post-rollback clause coverage gaps are not re-adjudicated or claimed
  closed. New baseline equality coverage does not close the broader finding.
- **G2 remains residual:** neither this observer nor its recorded baseline
  inventories `repo_dir`; no freedom from concurrent external checkout writes.
- **G3 remains unclosed:** M5 (accept either observing lock state) and M10
  (drop journal-custody conjunct) remain disclosed historical survivors. Passing
  every shipped mutation is not an exhaustive mutation proof.
- **Capability-preflight incompatibility is explicit:** the real capability
  probes intentionally create/remove temporary objects in workspace state. Under
  whole-action observation those writes correctly refuse zero-write acceptance.
  The fixture usually records/interprets these commands without executing their
  scripts; its positive receipts do not prove live acceptance. The added
  capability-write regression confirms refusal when such a write is modeled.
  No writes are exempted, no probe or guard is weakened, and no live successful
  A5 path is claimed. Separating prerequisite capability checks from the acceptance
  action would require a separately reviewed contract change.
- The recorded baseline is conservative across the interval from start, not just
  the current action. Filesystem timestamps/recursive-watch delivery retain their
  platform limitations; no hostile privileged timestamp manipulation or exhaustive
  kernel event-loss proof is claimed. Watching a distant common ancestor may be
  costly or unavailable and fails closed on setup/error rather than falling back.
- F5 `launches: 0` remains literal. No remote-authoritative-state or complete
  transient-process observation. A5 remains partial.
- No transactional claim couples a filesystem observation to receipt/archive
  persistence. A late failure can leave durable artifacts; recovery at every
  evidence/archive syscall remains unproved. The recorded-start comparison also
  applies before receipt resumption, so persisted state drift cannot be accepted
  merely by returning a prior receipt on retry.
- A3 credential isolation, A4 worker bootstrap/transitional-state/live systemd,
  A6 unconditional shutdown/lock-failure cleanup/full inventory/syscall recovery,
  and A7 expiry teardown/continuous approval/key provisioning/executing-tool tree
  binding remain unsupported. H2/H3 informational observations were not changed.
- No host behavior, actual timer trigger rate, real dispatch-off coordinator
  no-write premise, external Git-writer atomicity, base-suite rerun, application
  npm suites, future-clock/depth-1 variants, or independent final-head PASS is
  claimed. The 11 real-systemd tests remain prohibited and skipped.

No host access, push, PR creation/modification, merge, GitHub/Linear comment,
activation, deployment or real-key signing occurred. Final commit SHA is reported
in the delivery response.
