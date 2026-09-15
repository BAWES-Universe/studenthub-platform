# SHU-86 approved integration verification — 2026-09-14

Implementation lane: `/home/bawes/work/res107h`, branch
`feat/shu86-durable-claim-before-announce`, PR #107.
Starting head: `a728a491cb7a15d2cf18cb2a78678c2a11d24ea1`.
Merged main: `d3544962de6a7c60b066a5e424720fb4e1c2f100`.
Final tested source head: `4ac59488ede7e9f6cd38f0a996be1fe76e88d9ee`.
This report is the only subsequent tree edit. The final documentation commit and
post-push remote equality proof are reported in the implementation-lane response.

## Approved resolutions applied

- A/A2 and E/D1: receiptless stored running/completed/failed claims return exactly
  `{ ok: false, stage: 'UNLAUNCHED', reason: 'launch receipt missing or invalid' }`.
  A genuinely attempted failed spawn retains internal failed/SPAWN_FAILED evidence;
  it does not become public execution evidence.
- B/B2/B3/D1: require the conjunction of confirmed phase `launched`, matching
  issue/attempt/target SHA, positive integer PID, and the preserved 64-hex hash.
  The main positive fixture is rebound below. Marker-only receipts and missing or
  invalid bindings are rejected for each execution state. Pre-spawn phase/hash
  assertions observe the actual marker before the injected spawn failure and are
  checked outside the supervisor's intentional catch boundary.
- C/C2: exact schemas retain all eight base success fields. ACCEPTED and
  receiptless HOLD add required enumerated hold_code. Confirmed execution and
  confirmed-spawn operational HOLD add required bound launch_receipt instead.
  Ordinary refusals retain the three-field HOLD schema; unavailable attempts add
  exactly MISSING_CLAIM; receiptless execution has the exact UNLAUNCHED refusal.
  Unknown, removed and renamed fields remain failures; no subset validation.
- C3: authenticated ACCEPTED is queued admission; announcement status remains
  UNLAUNCHED. The local restart adapter waits for a real confirmed receipt before
  claiming RUNNING.
- C4/D: authenticate and bind, validate stored state, validate any completion, then
  check intent/receipt and project. Unknown stored states fail before projection,
  including when intent is absent. Status does not repair files.
- F–I and related boundaries: recovery preserves existing markers/process identity,
  creates safe bound legacy accepted intents or typed ambiguity holds as appropriate,
  and never infers confirmed spawn from liveness. Submission, recovery and stale
  launch callbacks honor pending holds. Local integrity assertions, safe issue
  filename restrictions, intent-before-admission history, and the socket error
  boundary remain. Existing operational error codes remain separate.
- The original 93-call-site ledger is preserved in the imported design record.
  No assertion or skip control was deleted or weakened. D1 explicitly changes the
  original positive receipt's phase and supplies all required successful-spawn
  bindings; the original hash requirement and named assertion remain.

## Explicit fixture rebinding

Before (main's synthetic execution-positive loop):

```js
{ attempt_id: order.attempt_id, phase: 'spawn_attempted',
  completion_token_hash: 'a'.repeat(64) }
```

After (same RUNNING/COMPLETED/FAILED positive stage assertions):

```js
{ issue_id: order.issue_id, attempt_id: order.attempt_id,
  target_sha: order.target_sha, pid: 7001, phase: 'launched',
  completion_token_hash: 'a'.repeat(64) }
```

Here order.issue_id is SHU-140, attempt_id is
`11111111-2222-4333-8444-555555555555`, and target_sha is `'a'.repeat(40)`.
This remains an explicitly synthetic fixture. The separate live restart test
observes the actual spawned child PID, preserves its receipt byte-for-byte across
restart, and verifies one launch and one durable completion.

## Every changed file and reason

Paths below are relative to the repository root. “Imported” means the file was
brought in unchanged from main as part of the authorized merge, not independently
edited by this implementation lane.

| File | Reason |
| --- | --- |
| `.github/coordinator/SHU-86-INTEGRATION-DESIGN.md` | Copy the requested design, absent from this clone and remote branch, from the read-only res107g design lane; annotate D1 approval without rewriting its historical ledger. |
| `.github/coordinator/SHU-86-INTEGRATION-VALIDATION.md` | Record changes, exact fixture, commands, outcomes and limitations. |
| `.github/coordinator/SUPERVISOR.md` | Document confirmed-spawn evidence, UNLAUNCHED refusal and separate admission projection. |
| `.github/coordinator/intended-work.mjs` | Add the required 64-hex hash to the shared confirmed-spawn predicate, including transport consumers. |
| `.github/coordinator/reconcile.mjs` | Restore the explicitly hypothetical gates-off reservation diagnostic alongside UNLAUNCHED; no dispatch decision or activation logic changed. |
| `.github/coordinator/supervisor.mjs` | Resolve the merge conflict; restore validation precedence and exact projections; honor pending holds; recover legacy accepted intents safely. |
| `.github/coordinator/service/residual-validation.mjs` | Extend exact schemas and conjoin receipt bindings, preserving named receipt/shape failures and positive-control assertions. |
| `.github/coordinator/service/test/residual.test.mjs` | Rebind positive fixture, await real launch in restart adapter, add schema/binding/precedence negatives; omit process-token diagnostic output. |
| `.github/coordinator/test/shu86-durable-intent.test.mjs` | Retain all existing assertions and six mutations; add admitted-hold, legacy-recovery, pre-spawn hash and failed-spawn coverage. |
| `.github/coordinator/service/README.md` | Imported residual acceptance documentation. |
| `.github/coordinator/service/check-status.mjs` | Imported authenticated read-only status client. |
| `.github/coordinator/service/test/fixture/residual-process.mjs` | Imported local real-process restart fixture. |
| `.github/coordinator/service/test/service.test.mjs` | Imported service acceptance test updates. |
| `.github/coordinator/service/test/supervisor-service.test.mjs` | Imported service test update. |
| `deploy/coolify/SHU-251-RESIDUAL-VALIDATION.md` | Import main's residual record and update status schemas, D1 spawn semantics, validation order and recovery boundaries. |
| `deploy/coolify/DEPLOY-FLOW.md` | Imported main's deployment-flow documentation. |
| `deploy/coolify/TRIGGER-DIAGNOSIS.md` | Imported main's trigger diagnosis. |
| `deploy/coolify/test/artifact-selection.test.mjs` | Imported main's artifact-selection tests. |
| `deploy/coolify/test/trigger-selected-mutations.test.mjs` | Imported main's trigger mutation tests. |
| `deploy/coolify/test/trigger-selected.test.mjs` | Imported main's trigger tests. |
| `deploy/coolify/trigger-selected.mjs` | Imported main's typed trigger outcomes. No external deployment was performed. |

## Sequential full-command results

No merge/edit ran concurrently with tests. Each source correction was committed,
the tree was clean, then root tests preceded the coordinator globs. Logs are local
in `/tmp/shu86-res107h-evidence/`.

| Invocation | Passed | Failed | Skipped | Other result |
| --- | ---: | ---: | ---: | --- |
| Root `npm test`, attempt 1 | 0 | 0 tests executed | 0 | Exit 2 during build: dependencies absent, missing Node types. |
| `npm ci` | N/A | N/A | N/A | Exit 0; lockfile unchanged. |
| Root `npm test`, attempt 2 | 421 TAP + 27 Vitest | 0 | 0 | Exit 0; 79/79 standalone mutations killed; observability exercise passed. |
| Coordinator globs, attempt 1 | 915 | 1 | 7 | Exit 1; 923 total. Hypothetical dry-run line absent. |
| Root `npm test`, attempt 3 | 421 TAP + 27 Vitest | 0 | 0 | Exit 0; 79/79 standalone mutations killed; exercise passed. |
| Coordinator globs, attempt 2 | 916 | 0 | 7 | Exit 0; 923 total. |
| Root `npm test`, attempt 4 (final) | 421 TAP + 27 Vitest | 0 | 0 | Exit 0; 79/79 standalone mutations killed; exercise passed. |
| Coordinator globs, attempt 3 (final) | 916 | 0 | 7 | Exit 0; 923 total, zero cancelled/todo. |

Each coordinator invocation was exactly:

```sh
umask 0002
chmod -R go-w .github/coordinator
node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
```

All three chmod commands exited 0. The first coordinator failure was exactly
`SHU251_GATE_OFF_POSITIVE_CONTROL same pending tick differs only by gate`, with
`SHU251_GATE_OFF_POSITIVE_CONTROL: the same eligible pending work with free capacity must launch exactly once when only the gate changes`.
It required `/next reservation \(if dispatch were on\): SHU-140 via codex-cli/`;
actual output included `UNLAUNCHED SHU-140 via codex-cli; HOLD=MISSING_AUTHORITY`.
Adding the hypothetical diagnostic preserved both assertions and reporting
semantics. The suppression mutation still kills on its named assertion.

Root subcommand counts, separately, identical in attempts 2, 3 and 4:

| Root test component | Passed / killed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Primary compiled TAP invocation | 258 | 0 | 0 |
| `test:profile:mutations` | 10/10 killed | 0 survivors | 0 |
| `test:idempotency:mutations` | 3/3 killed | 0 survivors | 0 |
| `test:assertion` | 27 (one Vitest file) | 0 | 0 |
| `test:deployment` | 72 | 0 | 0 |
| `test:web` | 15 | 0 | 0 |
| `test:documents` | 19 | 0 | 0 |
| `test:documents:mutations` | 17/17 killed | 0 survivors | 0 |
| `test:documents:hardening` | 10 | 0 | 0 |
| `test:documents:hardening:mutations` | 10/10 killed | 0 survivors | 0 |
| `test:observability` | 15 | 0 | 0 |
| `test:observability:mutations` | 17/17 killed | 0 survivors | 0 |
| `exercise:observability` | Exit 0; synthetic exercise completed | 0 | N/A |
| `test:documents:lifecycle` | 25 | 0 | 0 |
| `test:documents:lifecycle:mutations` | 22/22 named kills | 0 survivors | 0 |
| `test:documents:r2` | 7 | 0 | 0 |

## Named reruns, each a separate command

All ran after the final full coordinator run, sequentially, with zero failures,
zero skips, zero cancelled/todo and exit 0. Mutation wrappers passed only when the
expected named assertion was observed. Counts below are not aggregated across
commands; repeated positive tests intentionally run in each requested variant.

| Named assertion / variant | Tests passed | Observed result |
| --- | ---: | --- |
| `SHU251_STATUS_SHAPE` | 3 | Exact positive schemas and removal/rename/extra-field negatives pass. |
| `SHU251_STATUS_RECEIPT` | 3 | Confirmed receipts accepted; absent, marker-only and invalid bindings rejected; forged launch mutation killed. |
| `SHU251_GATE_OFF_POSITIVE_CONTROL` | 2 | Off: 0 launches/0 writes. On: 1 launch/3 fixture writes. Suppression mutation killed. |
| `SHU251_RESTART_NO_DUPLICATE` | 2 | One worker across daemon restart and replay; unchanged receipt; duplicate-evidence mutation killed. |
| `SHU251_RESTART_DURABLE` | 2 | Bound completion retained and recovered; lost-receipt mutation killed. |
| `ANNOUNCE_WITHOUT_CLAIM` | 2 | Volatile announcement refused; durable recovery launches; missing-claim-check mutation killed. |
| `REPORT_WITHOUT_RECEIPT_durable` | 3 | Durable intent and capacity alone remain UNLAUNCHED; receipt-removal mutation killed. |
| `REPORT_WITHOUT_RECEIPT_transport` | 2 | Forged submission remains LAUNCH_UNKNOWN; transport-receipt mutation killed. |
| `RECOVERY_NOT_EXACTLY_ONCE_pending` | 2 | Three cumulative restart counts [1,1,1]; pending-recovery mutation killed. |
| `RECOVERY_NOT_EXACTLY_ONCE_election` | 2 | Crash/stale wakeup never reelects spawn; claim-election mutation killed. |
| `HOLD_CODE_REQUIRED` | 2 | Absent/unknown codes rejected and holds persist; optional-code mutation killed. |

Exact commands:

```sh
node --test '--test-name-pattern=SHU251_STATUS_SHAPE|required status field' .github/coordinator/service/test/residual.test.mjs
node --test '--test-name-pattern=SHU251_STATUS_RECEIPT|pins all states|status claims launch' .github/coordinator/service/test/residual.test.mjs
node --test '--test-name-pattern=SHU251_GATE_OFF_POSITIVE_CONTROL|suppress positive-control' .github/coordinator/service/test/residual.test.mjs
node --test '--test-name-pattern=live worker restart|duplicate spawn evidence' .github/coordinator/service/test/residual.test.mjs
node --test '--test-name-pattern=live worker restart|terminal receipt lost' .github/coordinator/service/test/residual.test.mjs
node --test '--test-name-pattern=unpersisted next-action|remove persist-before-announce' .github/coordinator/test/shu86-durable-intent.test.mjs
node --test '--test-name-pattern=reporting requires|capacity occupancy|remove receipt requirement' .github/coordinator/test/shu86-durable-intent.test.mjs
node --test '--test-name-pattern=reporting requires|remove transport receipt requirement' .github/coordinator/test/shu86-durable-intent.test.mjs
node --test '--test-name-pattern=three restarts|remove pending recovery' .github/coordinator/test/shu86-durable-intent.test.mjs
node --test '--test-name-pattern=crash after spawn retains|remove launch claim election' .github/coordinator/test/shu86-durable-intent.test.mjs
node --test '--test-name-pattern=pending HOLD codes|make HOLD code optional' .github/coordinator/test/shu86-durable-intent.test.mjs
```

A subsequent direct `node --input-type=module` gate assertion command also exited
0: config.enable_dispatch false, off launches 0, off writes 0; its paired positive
control returned on launches 1 and on fixture writes 3. The implementation-lane
Git diff assertion confirmed configuration and activation files unchanged.

## Limitations and completion boundary

The seven existing skips are unchanged: six require distinct worker identities /
root or passwordless sudo (SHU-227 three, SHU-228 one, SHU-241 A2 one, SHU-244 A10
one); SHU-71 restricted-capability refusal has no undeclared production runtime /
role pair. No skip was added, bypassed or used to conceal a failure.

No Coolify/host access, activation, dispatch-gate changes, main-branch writes,
rebase, force push, or external messages. Only local synthetic fixtures enable a
gate for their required positive control. No unresolved semantic contradiction
remains and no requested implementation work was stopped. Push uses the
environment-backed Git credential helper, with no credential in a URL or output;
the final response records the post-push local/remote head equality assertion.
