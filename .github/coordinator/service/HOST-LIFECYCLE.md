# Typed Phase-A host lifecycle — L1 correction

This repository-only correction extends branch `fix/shu251-typed-host-lifecycle-executor`
from the independently reviewed head `5a3c95610fce3fd4f90caac55ac19711a430dfdd`. It is **not a complete L1 closure
or an authorization to operate a host**. The remaining gaps below keep the
static execution-closure gate blocked. Historical verification follows this
current contract and does not establish acceptance for this revision.

## Actions and evidence

The reviewed path remains `main → drive → defaultIO.lifecycleProvider →
createProductionLifecycle → executeLifecycle`. The CLI accepts no replacement
provider or command boundary. Existing mutation flags remain necessary; a
signature-verified owner artifact is additionally required in production.

| Action | Current behavior |
| --- | --- |
| `preflight` | Verify approval, approved remote/API main, clean approved checkout, identity, split environment metadata, capabilities and evidence custody. It may create the approved evidence directory; it is not a read-only host probe. |
| `pin` | Accept the explicitly recorded stale checkout baseline. Journal the real checkout tuple and activation ref before changes. Fetch the approved object without changing tracking refs, verify its tree, detach without force, CAS local main and origin/main together while verifying HEAD, then attach main. Recheck remote/API main and emit durable evidence. |
| `install` | Preserve existing rendering, destination, dispatch-off, staging and exact-byte placement guards; journal every placement and reload. |
| `start` / `readiness` | Prove service readiness without requiring an acceptance worker. Starting the coordinator hands off its writer lock while retaining journal custody; exit 2 is not a successful tick. |
| `running-gate-off` | Observe three new successful timer ticks with supervisor and timer active. Watch state directories, compare contents and file timestamps, require no supervisor children and both dispatch gates off. The legacy `gate-off` remains a separate stopped-quiescence observation and is not production running-system acceptance. |
| `restart` | Keep the original live-worker, transport, single-use custody and adoption checks. No new acceptance-worker bootstrap is provided. |
| `host-rollback` | Validate durable journal/approval custody independently of forward preflight, attempt independent reverse operations after errors, persist bounded aggregate failures, and retain the first named refusal. |
| `pin-restore` | After host rollback, reject checkout drift and restore the recorded real tuple and activation ref. Compare the full *modeled* snapshot afterward. |
| `pin-retain` | Verify the approved real tuple and activation ref. Final retention after rollback must match the approved teardown policy. An earlier retention observation does not prohibit a later owner-approved restore. |

`spec.lifecycle.checkout_before` is required and closed: `sha`, `head_ref`
(`refs/heads/main` or null for detached), `main`, `origin_main`, `tree`, `clean`.
The baseline must be clean. Other lifecycle fields retain their prior shape.
Supervisor environment metadata is root:root 0600; coordinator metadata is the
approved service UID/GID 0600. Metadata probes never read either file's values.

The journal stores pending intents before effects and done/undone state after
durable completion. Checkout recovery recognizes only the exact recorded before,
detached, ref-updated, and final tuples. Git expected-old-value transactions guard
both branch refs and HEAD. No force checkout or hard reset is used. Independent
observed drift blocks restore. This is not proof of atomicity against a concurrent
external Git writer between checkout commands.

Service readiness and worker-survival acceptance have separate provider methods.
The existing worker checks remain mandatory for `restart`. The coordinator must
report Result=success, exit 0 and a strictly newer completion timestamp when
started. Throughout `readiness`, `restart` and `running-gate-off`, only the journal lock is acquired:
no driver writer-lock acquisition occurs during preflight, observations, supervisor
restart or finalization. Scheduled coordinator ticks retain access to their writer
lock. Other effects still require writer custody; exit 2 is still refused.
[R3-AMEND-VALIDATION.md](R3-AMEND-VALIDATION.md) records the boundary-interleaving
proof and mutations. R3 finding G1 identified a previously undisclosed,
pre-existing exposure: gate-off held the writer lock across `git ls-remote`,
`gh api` and both bracketing readiness calls, releasing it only for polling.
One scheduled tick could conflict-exit 2 and refuse the A5 acceptance step.
The fix extends journal-only custody across the complete gate-off action,
including those calls and receipt finalization; it never reacquires the writer
lock on return from polling. A 240-poll, one-second bound refuses missing ticks.
The `launches: 0` receipt field is a literal, not a measurement.
The launch claim relies on zero observed local authoritative-state writes (including durable
launch receipts), unchanged inventory, dispatch disabled, and no observed children;
it does not independently observe every possible transient kernel process.

## Approval and archive contract

See [PRODUCTION-LIFECYCLE.md](PRODUCTION-LIFECYCLE.md) for the exact signed artifact,
public-key custody and executable test evidence. The driver verifies revision,
tree, activation, scope and operation order through the whole-spec digest, and
checks the approval interval before forward work. Cleanup may run after expiry;
expiry itself does not schedule physical teardown. It cannot substitute for a
completed cleanup receipt.

Evidence is root-owned under `<evidence_root>/<activation_id>`. Initialization
creates that directory, journal lock and binding manifest safely. Preflight persists `preflight.json`. Other actions
persist their receipts in `journal.json`, then write/fsync `archive.json` containing
the manifest, journal digest and receipt digests. Stdout is not the archive.
When an archive is absent or behind the journal, completed non-restart actions
can recover their existing receipt after modeled-snapshot equality and rewrite the
archive without repeating effects. An archive rename that succeeded before an
ambiguous directory-fsync failure is not covered by that retry proof. Restart retains its no-replay rule.

## Finding disposition and unsupported claims

| Finding | Evidence delivered | Remaining limitation / disposition |
| --- | --- | --- |
| A2 (CLOSED at repository scope; OPEN at host scope) | Actual tuple pin/restore/retain, signed baseline, remote/API equality, dirty/tree/ambiguous-fetch refusals, provider reconstruction at every Git command boundary | Source/fake-boundary correction; no live Git/host proof or concurrent external checkout-writer atomicity claim. |
| A3 (PARTIAL) | Approved split ownership accepted; metadata remains value-free | **CONFIRMED_BLOCKER** for complete per-process credential isolation: units still share a UID, and transport/child credential delivery belongs to B2. File metadata alone cannot establish the requested process isolation. |
| A4 (PARTIAL) | Fresh baseline starts without a worker; writer handoff, exit-2 rejection, timer observation; original restart adoption guards retained | No live systemd proof or transitional-state coverage. Worker-survival acceptance still needs a separately reviewed bootstrap/composition; the strictly-newer timestamp conjunct remains an F3 coverage gap. |
| A5 (PARTIAL) | Distinct running timer proof, filesystem watchers/inventory, stopped/no-tick/write/child negative controls | No remote-authoritative-write inventory is included; inventory equality remains an F3 coverage gap and `launches` is a literal (F5). Full end-to-end zero-write/zero-launch acceptance remains unproved. |
| A6 (OPEN) | Cleanup bypasses forward preflight, continues independent undo, aggregates durable errors | **CONFIRMED_BLOCKER**: writer-lock acquisition can still prevent cleanup; runtime-gate disable/admission stop are not an unconditional first phase. Snapshot omits enablement-link topology, full process/listener and state-path inventory, and L4 disposable-checkout custody. |
| A7 (PARTIAL) | Signature/digest-bound spec, time/order/teardown guards, evidence creation, durable receipts/archive and restart of archive finalization | **CONFIRMED_BLOCKER** for complete execution closure: no expiry-triggered physical teardown; remaining A6 recovery/inventory gaps; canonical owner artifact/key provisioning and executing the corrected tool from a stale deployed checkout are unproved. Preflight mutation-approval classification remains F2; approval is checked before an action, not continuously. |

The A2 production path is `executeLifecycle(pin/pin-restore/pin-retain)` →
`provider.checkout`, verified by `CLOSURE stale local main stale origin main
detached HEAD restore and retain`, the every-Git-command interruption test and
the checkout guard mutations. This classification does not approve live execution.

Legacy operational routes retain their earlier contract; the new artifact does
not authenticate an end-to-end legacy/Phase-B composition. No independent
exact-head verifier has reviewed this G1 amendment yet. The independent R3
AMEND at `ac67bc1` confirmed F1 and F4 closed and retained A2 closed at repository scope; A3/A4/A5/A7
partial; A6 open. This amendment does not upgrade those markers. Current counts
and limitations are in [R3-AMEND-VALIDATION.md](R3-AMEND-VALIDATION.md).

These limitations are not reclassified as LIVE_ONLY: several require source-level
composition with the separately scoped credential and disposable-checkout lanes.
No host access, push, PR, merge, external comment, real-key signing, reseed,
activation, fixture mutation or dispatch was performed. Tests sign only disposable
local test approval envelopes. No skip allowance was changed.

## Original executor verification (commit ab6c634b)

All temporary storage and local clones were placed below this checkout. Some
existing tests require a literal `/tmp` path and a temporary directory outside
any apparent Git root. A private user/mount namespace binds repository-backed
storage onto `/tmp` for the suite process only; it does not change the host's
mount namespace. Capabilities are dropped after the bind, preserving ordinary
non-root unreadable-file tests. No existing assertion or skip was relaxed.

Preparation, run before the suites:

```sh
mkdir -p node_modules/t node_modules/u node_modules/.cache/shu251
chmod 700 node_modules/t node_modules/u
chmod -R go-w .github/coordinator
umask 0002
```

Focused command (new lifecycle tests plus existing Phase-A driver tests):

```sh
TMPDIR="$PWD/node_modules/t" node --test \
  .github/coordinator/service/test/host-lifecycle.test.mjs \
  .github/coordinator/service/test/phase-a-driver.test.mjs
```

Normal complete coordinator and service suites:

```sh
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/t"
```

The shallow check used a local `file://` clone with `--depth 1 --single-branch
--branch fix/shu251-typed-host-lifecycle-executor`, under
`node_modules/shu251-shallow`. The changed files were overlaid from the working
tree, then its coordinator tree was made non-group/world-writable.
`rev-parse --is-shallow-repository` printed `true`; the only branch and remote
tracking ref named this task branch (no `main`). The executable files and tests
were compared byte-for-byte with the working tree.

Future-clock complete coordinator and service suites in that shallow clone:

```sh
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && cd "$2" && TMPDIR=/tmp SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$2/.github/coordinator/test/fixture/shift-wall-clock.mjs" setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/u" "$PWD/node_modules/shu251-shallow"
```

Earlier diagnostic runs found three existing-test failures when `TMPDIR` was a
path inside the checkout, then two unreadable-file failures when the temporary
namespace retained capabilities. The final commands above resolve those runner
conditions without changing tests, guards or skip allowances.

The tracked `config.json` blob remains
`8a0317173d76f4c09811b9365e25b380b38dc93d`, identical to the pre-change HEAD.

Final observed results (2026-09-16):

| Run | Tests | Pass | Fail | Skip | Cancelled / Todo |
| --- | ---: | ---: | ---: | ---: | ---: |
| Focused lifecycle + existing Phase-A driver | 136 | 136 | 0 | 0 | 0 / 0 |
| Complete normal coordinator + service | 1489 | 1481 | 0 | 8 | 0 / 0 |
| Complete future-clock coordinator + service, depth-1 clone | 1489 | 1481 | 0 | 8 | 0 / 0 |

All 37 new named mutation tests passed: 37 matched permitted controls and
37 syntax-clean mutants killed by their named assertions, no survivors.
The final durability matrix includes failures both before and after a save
becomes durable. The eight full-suite skips retain the existing exact
`PERMITTED_SKIPS` names/reasons. These results are fake-only executor validation,
not host-window acceptance or evidence for an ambient OS capability provider.
