# SHU-86 durable claim before announcement

Intended work is stored by `SupervisorStore` in the existing supervisor state
root under `intents/<issue_id>-<attempt_id>.json`. This reuses the store's JSON,
owner-only permissions, fsync, atomic hard-link creation, and atomic rename
replacement discipline; it introduces no alternate serialization or database.
The directory is created on the first authorized intention, so merely opening
an empty store does not change the existing service inventory.

`intend` requires a valid bound work order and an explicit enumerated HOLD code.
Acceptance writes that intention before scheduling or acknowledging work.
`announce` asserts that the intention exists and reads it back; `reportIntent`
can diagnose a volatile plan as `UNLAUNCHED/MISSING_CLAIM`, but cannot advertise
it as a next action. An intention without a bound `phase: launched` receipt is
`UNLAUNCHED` with a typed reason. A capacity reservation is occupancy, not proof
of execution, and its readable projection follows the same rule.

The supervisor's existing atomic launch election is retained. The existing
pre-spawn marker prevents a second process from crossing the spawn boundary.
After spawn returns a PID, the supervisor persists a launch receipt bound to
issue, attempt, and target SHA. The coordinator no longer translates an
accepted-but-unlaunched acknowledgement into a RUNNING receipt; it retains
LAUNCH_UNKNOWN until launch evidence exists. Receipt-confirmed recovery can
poll in the same tick, preserving terminal-result and heartbeat processing.

Recovery discovers intentions even when no accepted order exists, replays
acceptance with the same attempt, and schedules through the existing launch
election. Approved-window and other explicit holds survive restart without
launching. Corrupt, missing, or unknown HOLD codes throw
`AssertionError: HOLD_CODE_REQUIRED: an enumerated HOLD code is required`.
A crash after the pre-spawn marker remains `AMBIGUOUS_LAUNCH`; this is a typed
hold requiring inspection, not permission to risk a duplicate spawn. Exactly-once
recovery is proven for pending intentions before that ambiguous boundary.

## Acceptance tests

All names below are prefixed `SHU-86: `:

- unpersisted next-action plan is UNLAUNCHED and autonomous idle recovery launches
- reporting requires an actual bound launch receipt
- three restarts recover pending work exactly once
- pending HOLD codes are mandatory and survive idle restart
- capacity occupancy never substitutes for a launch receipt
- crash after spawn retains claim and stale wakeup cannot duplicate

The idle test constructs a volatile next-action plan with no durable record,
checks that announcement fails and status is UNLAUNCHED/MISSING_CLAIM, then
runs recovery via the event loop with no human input. Three fresh supervisor
instances recover the same disk state, yielding cumulative launch counts
`[1, 1, 1]`; duplicate wakeups do not change those counts. A separate crash
injection after spawn proves that a stale scheduled callback and three restarts
cannot spawn a second child. The transport test asserts that its valid work
order actually reaches the injected transport, avoiding a configuration-refusal
false positive.

## Mutation tests

Each name is prefixed `SHU-86 mutation: `. Every mutant runs the real test in a
separate Node process against a disposable source copy and must exit 1 with
`AssertionError` and the exact named message below.

| Mutation name | Named AssertionError message |
| --- | --- |
| remove persist-before-announce check | ANNOUNCE_WITHOUT_CLAIM: announcement must refuse a volatile plan |
| remove receipt requirement | REPORT_WITHOUT_RECEIPT: durable intent alone cannot report running |
| remove transport receipt requirement | REPORT_WITHOUT_RECEIPT: submission acknowledgement cannot report running |
| remove pending recovery | RECOVERY_NOT_EXACTLY_ONCE: each restart must retain exactly one launch |
| remove launch claim election | RECOVERY_NOT_EXACTLY_ONCE: durable launch election must prevent duplicate spawn |
| make HOLD code optional | HOLD_CODE_REQUIRED: absent or unknown HOLD codes must fail closed |

## Compatibility and boundaries

No existing assertion was removed or relaxed. The two SHU-71 isolation fixtures
now reconcile after draining simulated launches before checking RUNNING, and
add assertions that both units remain LAUNCH_UNKNOWN before the drain. Their
existing isolation, responsiveness, child-count, and final-state assertions and
mutation checks remain in place. The dispatch switch, scope, gates, activation
implementation, and service launch gates are unchanged.

Disabled reconcile remains a zero-write diagnostic path: it can report
UNLAUNCHED/MISSING_AUTHORITY, but cannot create intentions or launch workers.
No real service, deployment, external issue/repository write, push, or host
operation is part of this validation.

## Verification results

With `umask 0002`, after `chmod -R go-w .github/coordinator`:

1. `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`
   exited 0: **909 tests, 902 passed, 7 skipped, 0 failed**. This includes all
   12 new SHU-86 tests (six behavioral tests and six named mutation kills),
   `ACT_GATES_OFF: actual tick has zero launches and writes; manual pair gates
   cannot bypass review`, and the supervisor dispatch-disabled no-side-effect
   test. The seven pre-existing skips cover six unavailable distinct-UID/host
   fixtures and one hypothetical undeclared-runtime-capability case.
2. Repository-root `npm test` exited 0: **407 Node tests plus 27 Vitest tests
   passed**, with no test failures, and its mutation scripts and synthetic
   observability exercise passed. This is a separate command/count from the
   coordinator suite. The initial invocation failed before tests because the
   clone lacked Node type dependencies; `npm ci --ignore-scripts` installed the
   existing lockfile, after which the full command passed.

`git diff --check` passed. `config.json` still has `enable_dispatch: false`;
there is no diff to dispatch scope, activation implementation, or service gates.
No live launch or distinct-UID host validation was attempted. No push, PR,
deployment, Coolify action, host or `/srv` access, secret access, or external
Linear/GitHub write was performed.
