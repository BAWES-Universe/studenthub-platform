# Durable handoff consumption

The existing `main()` reconcile tick consumes completed work from **Linear's
existing coordinator receipt comments**. No scheduler, workflow, storage service,
or dispatcher is added. Existing service serialization and the reservation /
LAUNCH_UNKNOWN / adapter idempotency path remain responsible for execution.
The committed dispatch flag remains false. Activation-requested ticks retain the
existing activation/backfill path; consumption does not supply activation authority.
Receipt and handoff comments are accepted for this path only when Linear supplies
an immutable actor ID present in `linear_receipt_actor_ids`; mutable display names
and structurally valid comments from any other actor are ignored.

## Record and action

The input is an existing receipt: `receipt_version`, `issue_id`, `attempt_id`,
`authorization_ref`, `repo`, `branch`, `target_sha`, `requested_worker` (and
role/runtime on v1.1), `stage`, `verdict_stage`, `result_sha`, observed
`worker_identity` / `external_run_id`, timestamps, notes, and evidence links.
`COMPLETED + BUILD_READY/REVISION_READY` is a lane completion;
`COMPLETED + PASS` or `HOLD + BLOCKED/FAILED` is a review handoff.
The existing callback validation persists those facts before consumption.

Consumption appends a new version of that **same receipt**, adding the optional
`handoff` property defined in `receipt-schema.json`:

```json
{
  "source_attempt_id": "<source receipt UUID>",
  "target_sha": "<exact reviewed head, or completed writer output head>",
  "verdict_stage": "PASS | BLOCKED | FAILED | BUILD_READY | REVISION_READY | null",
  "action": "merge-readiness | work-order | HOLD",
  "hold_code": "<existing intended-work.mjs HOLD code>",
  "reason": "<present for HOLD>",
  "order": "<present for work-order: existing review-routing work order>",
  "claim_attempt_id": "<optional: successor reservation UUID after claim>"
}
```

The work order retains the existing deterministic attempt ID and role/runtime,
actor, authorization and workspace scope fields. It additionally binds `repo`,
`branch`, and `findings: {notes: string[], evidence_links: string[]}`. The receipt
comment is the queue entry and consumed marker together, not a second queue.
The existing work-order reader also reads these receipt-embedded orders and
collapses their later claim updates by attempt ID.

PASS records merge-readiness at the exact reviewed head with
`MISSING_AUTHORITY`; it neither merges nor grants merge authority. BLOCK routes
to the same-branch writer with findings attached, using the existing routing
and revision-bound logic. A completed writer routes to an eligible independent
reviewer. Invalid evidence, stale/unverifiable live head, missing reviewer, or
branch occupancy records an existing typed HOLD, including the reason.
Later same-branch durable lane records supersede older completions.

On a subsequent tick, an eligible queued order enters the existing reservation
selector. Scope, capacity, pause, eligibility and preflight checks still apply.
An active same-branch receipt prevents another writer. Findings reach the
writer's task context. Activation-specific branch selection and task context
remain unchanged.

## Durability and restart proof

The action and consumption marker commit in one Linear comment. Publication is
reported only after successful acknowledgement **and durable readback**. A lost
response after commit causes a later tick to read the same consumed receipt,
not write a second action. A crash before commit leaves the terminal receipt
available for the next tick. Successor identity is deterministic; existing
RESERVED-before-launch and LAUNCH_UNKNOWN recovery provide execution idempotency.
After reservation, the source records `claim_attempt_id`. Missing recorded claims
are UNKNOWN and cannot re-enter selection. Queue status never infers liveness
from a historical RUNNING receipt: it reports UNKNOWN until an authoritative
lifecycle observation supplies evidence. Unclaimed durable orders are UNLAUNCHED
with MISSING_CLAIM, not running.

Exactly-once here is under the existing serialized coordinator writer contract,
not a claim that Linear comments provide cross-writer transactions. No new writer
or parallel dispatcher is introduced. If the durable store cannot be read or
there is no issue UUID to write to, the coordinator fails closed and reports
UNKNOWN/typed HOLD; it cannot persist into an inaccessible store. HOLDs do not
authorize automatic policy bypasses. No live wake/launch/merge is demonstrated:
gates remain off and all execution proofs use injected synthetic adapters.

## Synthetic tests first

Before implementation, `landing-verdict-consumed-exactly-once` failed with the
named LANDING_VERDICT_CONSUMED_EXACTLY_ONCE AssertionError (missing consumer).
`test/durable-handoff.test.mjs` now contains the following cases and exact named
AssertionError messages:

| Test | AssertionError text |
| --- | --- |
| landing-verdict-consumed-exactly-once | `LANDING_VERDICT_CONSUMED_EXACTLY_ONCE: PASS must durably route once to merge-readiness at the reviewed head` |
| BLOCK-routes-to-writer | `BLOCK_ROUTES_TO_WRITER: BLOCK must queue the same-branch writer with findings attached` |
| duplicate-consumption | `HANDOFF_CONSUMED_TWICE: two ticks and a reconstructed session must produce exactly one action` |
| unbacked-claim | `HANDOFF_RECORD_REQUIRED: missing durable work must never be reported as running or complete` |
| resume-after-termination | `RESUME_WITHOUT_PROMPT: a fresh coordinator tick must consume the queued completion without a human prompt` |
| handoff-author-authentication | `HANDOFF_AUTHOR_REQUIRED: an untrusted Linear commenter must never create launchable work` |

The seventh test, `durable-handoff named mutation controls`, copies the coordinator
into a temporary directory and applies six source mutations: replace PASS's
action, remove findings, remove the consumed guard, fabricate RUNNING for absent
records, suppress consumption, and remove the trusted-comment author gate. Each
child must fail with its corresponding
named AssertionError; syntax/import failures and surviving mutants fail the
control. Its control assertions are `mutation anchor <name>`, `<name> mutation
survived`, and `<name> must die by named AssertionError: <child output>`.

Non-vacuous coverage includes two landing ticks, repeated reconstructed
consumption, a lost response after commit, a successful write response whose
record vanished, stale live heads, completed-build review routing, typed HOLD
for no reviewer, and a producer termination followed by fresh `main()` ticks
without event/prompt/session input. The BLOCK test drives three real `main()`
ticks through one persistent fake Linear store: queue, one adapter launch, then
no duplicate launch. It verifies the launch-intent receipt exists before the
adapter runs, findings arrive, and removal of the claimed successor yields
UNKNOWN with no second selection.

## Verification

All final commands use `umask 0002`; before the coordinator commands,
`chmod -R go-w .github/coordinator` was applied. No deployment or running-system
verification was performed. Root `npm test` invokes the repository's local
`test:deployment` unit tests; no deployment command was run.

| Command | Final result |
| --- | --- |
| Root `npm test` | 477 reported TAP/Vitest tests passed; 85 mutation controls killed; observability exercise completed; zero failures |
| `node --test .github/coordinator/test/*.test.mjs` | 866 tests: 859 passed, 7 skipped, 0 failed |
| `node --test .github/coordinator/service/test/*.test.mjs` | 71 tests: 71 passed, 0 skipped, 0 failed |
| Gates-off assertion plus `verifyKillSwitch()` | `enable_dispatch=false`; 2 ticks; 0 launches; 0 writes; empty state diff |
| `git diff --check` | Passed |

Root npm command breakdown (counts kept separate):

| npm stage | Tests passed | Mutations killed |
| --- | ---: | ---: |
| Main built-JS test command | 258 | — |
| `test:profile:mutations` | — | 10 |
| `test:idempotency:mutations` | — | 3 |
| `test:assertion` | 27 | — |
| `test:deployment` | 88 | — |
| `test:web` | 28 | 6 |
| `test:documents` | 19 | — |
| `test:documents:mutations` | — | 17 |
| `test:documents:hardening` | 10 | — |
| `test:documents:hardening:mutations` | — | 10 |
| `test:observability` | 15 | — |
| `test:observability:mutations` | — | 17 |
| `exercise:observability` | completed (exercise, not a test count) | — |
| `test:documents:lifecycle` | 25 | — |
| `test:documents:lifecycle:mutations` | — | 22 |
| `test:documents:r2` | 7 | — |

The seven coordinator skips comprise six existing distinct-UID/privilege
fixtures and one capability-negative fixture for which the production vocabulary
has no undeclared role/runtime combination. No privilege escalation was attempted.

Development failures were resolved: the first root npm attempt stopped before
tests because dependencies were absent (`npm ci` restored lockfile dependencies);
the first combined coordinator run was 905 passed / 25 failed / 7 skipped due
to an erroneous recovery reference and related effects; the next was 929 passed /
1 failed / 7 skipped because a HOLD delayed unrelated eligible work. Both defects
were fixed, followed by 930 passed / 0 failed / 7 skipped in the combined globs
and the final separate-glob runs above. Existing assertions were not weakened.
