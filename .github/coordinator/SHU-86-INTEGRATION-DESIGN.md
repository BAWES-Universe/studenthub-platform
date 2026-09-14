> Implementation lane: D1 approved by the operator on 2026-09-14. The design below is preserved as the original review record; its blocked/deferred status describes that earlier design lane. Implementation and verification are recorded in SHU-86-INTEGRATION-VALIDATION.md.

# SHU-86 / SHU-251 integration design

Status: DESIGN BLOCKED on D1 below. This agent has performed no implementation,
merge, test run, commit, or push. An independently started unresolved merge was
observed during the final document check (see workspace finding below).
This is a reviewable design, not a
claim that the current branch implements it.

## Inputs and scope

- Clone: `/home/bawes/work/res107g`.
- Branch: `feat/shu86-durable-claim-before-announce`, PR #107.
- SHU-86 HEAD: `a728a491cb7a15d2cf18cb2a78678c2a11d24ea1`.
- Fetched main: `aac05b1055c719924f8f305d25238fdfed05d806`.
- Fetched feature head equals the local starting head.
- Read both complete supervisor implementations and their complete diff,
  main's `service/residual-validation.mjs` and `service/test/residual.test.mjs`,
  and the branch's `test/shu86-durable-intent.test.mjs` and
  `SHU-86-VALIDATION.md`. The residual files do not yet exist on this branch;
  the SHU-86 test/document do not exist on main. They were read with `git show`,
  without starting the merge.
- Also inspected `intended-work.mjs`, the dispatch receipt consumers, main's
  status client, local restart fixture, residual schema documentation, and
  incoming service-test/document changes to check the integration boundaries.
- No host, Coolify, main-branch write, dispatch-gate edit, rebase, or force push.

## Step 1: complete contradiction inventory

Rows distinguish direct assertion conflicts from other observable model
differences. A difference is not evidence of a failing test unless stated.

| ID / contradiction | Main requirement or behavior | SHU-86 requirement or behavior | Why they cannot both hold literally / disposition |
| --- | --- | --- | --- |
| A / receiptless execution-state label | Stored running/completed/failed without a valid receipt returns `ok:false`, `stage:HOLD`, exact reason `launch receipt missing or invalid`. Error schema asserts HOLD. | Stored running without a launched receipt is asserted to return `stage:UNLAUNCHED`. | One response cannot have both labels. Operator already chose UNLAUNCHED; retain false and the exact reason. Apply consistently to receiptless execution claims, without changing other HOLD refusals. |
| A2 / refusal versus successful diagnostic | Missing-receipt execution claims are refusals with a reason. | `status()` returns `ok:true,durable:true` plus `hold_code` before checking terminal evidence whenever `reportIntent()` is UNLAUNCHED. | The same invalid execution claim cannot be both successful and refused. The operator's decision explicitly resolves this in favor of `ok:false` and the main reason. This is more than SHU-86's current label behavior, but does not change its stage assertion. |
| B / current receipt phase | `assertStatusShape` and production status require the current launch record's `phase === 'spawn_attempted'` for RUNNING/COMPLETED/FAILED. Main leaves this phase unchanged after spawn. | Successful spawn replaces that phase with `launched`; `hasLaunchReceipt` accepts only `launched`. | The same current string cannot equal both. Checking main's predicate earlier changes its original binding to a launch-claiming status. D1: operator decision required. |
| B2 / sufficient receipt evidence | The synthetic positive-state test writes only attempt ID, `spawn_attempted`, and a 64-hex completion hash, then asserts RUNNING/COMPLETED/FAILED. | An actual receipt also requires matching issue ID, target SHA and positive integer PID, with phase `launched`. | Main's exact positive fixture has no evidence of successful spawn and must be rejected by SHU-86. Adding fields alone does not resolve B. D1 must explicitly authorize rebinding these positive fixtures to confirmed spawn. |
| B3 / hash validation | Main requires a 64-hex completion hash for a launch claim. | `hasLaunchReceipt` ignores the hash; status can accept a launched receipt with matching issue/attempt/SHA/PID and a missing or malformed hash. | Their accepted receipt sets differ independently of phase. Proposed combined validation is the conjunction of both binding checks; do not drop the hash requirement. No existing SHU-86 positive fixture needs a missing hash. |
| C / exact successful schema | Exactly eight fields: version, ok, durable, attempt_id, target_sha, stage, result, heartbeat. | Launched status adds `launch_receipt`; unlaunched status uses `hold_code` and omits result and heartbeat. | Exact equality rejects both forms. Operator requires new fields/statuses to be legal. Use explicit exact schemas by state, with all base fields retained on successful status and each new field required and typed in its applicable variant. Do not use subset checking. |
| C2 / exact refusal schema | Exactly ok, stage, reason, with stage HOLD. | Unavailable-attempt status adds `hold_code:MISSING_CLAIM`; other refusal paths still return the original three keys. | A single three-key schema cannot accept both. Define exact refusal variants by reason, with enumerated hold codes where present; A's UNLAUNCHED refusal remains distinct from authentication/unavailability HOLD. |
| C3 / accepted-state vocabulary | The positive-state loop asserts `status.stage === state.toUpperCase()` for accepted, including ACCEPTED without any receipt. | Current authenticated status maps accepted without a receipt to UNLAUNCHED; submission already has `stage:ACCEPTED` and `status:UNLAUNCHED`. | A single stage cannot equal both, but the APIs have different purposes. Proposed binding: authenticated stage ACCEPTED means queued admission only, while announcement status remains UNLAUNCHED. This retains main's exact accepted-stage assertion and every SHU-86 accepted-work test assertion; document the two projections explicitly. |
| C4 / unknown run states | Production rejects stages outside the five-state vocabulary with `unknown durable run state`; validator rejects them. | Once a receipt exists, status uppercases an arbitrary stored status; without a receipt it masks unknown state as UNLAUNCHED. | Main's fail-closed state validation is lost if SHU-86's early return is retained literally. Restore validation before projection, retaining the finite enum including the operator-authorized UNLAUNCHED diagnostic. |
| D / terminal validation precedence | Validate a present completion before deciding stage or launch-receipt refusal. An invalid completion yields its explicit refusal. | Receipt/intent reporting returns early, masking invalid terminal evidence when launch or intent is missing. | The same doubly-invalid record gets different reasons and `ok` values. Proposed order: authenticate/bind, validate stored state, validate any completion, then check execution receipt. Retain exact missing-receipt reason when that is the failure being diagnosed. |
| E / failed spawn versus failed execution | A throwing spawn writes failed with `spawn_attempted`; main documents and reports FAILED even though no child started. | No successfully bound receipt means UNLAUNCHED, including a stored failed run. | The FAILED token denotes different events. Proposed model retains failed/SPAWN_FAILED internally but reports receiptless execution as UNLAUNCHED refusal. This revises main's documented public failed-spawn semantics; covered by D1, not silently recast as a successful launch. |
| F / older durable state | Main admits, recovers and reports accepted/running/terminal records with no intent directory and only pre-spawn-style launch records. | Announcement requires an intent; recovery's accepted-plus-launch branch calls `holdIntent`, which requires that intent file. Reporting a legacy running record yields MISSING_CLAIM even with main's valid launch record. | Existing main state cannot simply be treated as fully SHU-86-confirmed state. Proposed compatibility policy: preserve files/process identity, never synthesize successful-spawn evidence or relaunch; report missing claim/ambiguous launch. Recover missing intent only from bound accepted order when it is safe to queue, and create a typed ambiguity intent before holding an older accepted-plus-marker record. Main's new-to-new restart test is not a migration test. |
| G / assertion errors versus protocol refusal | `status` catches all exceptions and returns unavailable/HOLD. | It rethrows AssertionError so corrupt or absent enumerated intent codes remain named `HOLD_CODE_REQUIRED` failures; the socket layer still catches them as invalid requests. | Local callers cannot receive both a returned object and a thrown assertion. Preserve SHU-86's local integrity assertions and the existing socket failure boundary; the status shape validator applies to returned JSON, not thrown errors. No residual test demands that a corrupt intent return success. |
| H / issue identifier admissibility | `validWorkOrder` permits any nonempty issue string; main has no issue-based filename restriction. | `intentPath` asserts `/^[A-Za-z0-9-]+$/`; accept translates most intent assertions into a work-order-binding refusal. | Some formerly valid requests are now refused before admission. Retain safe-path assertion and fail closed; document the narrower supported identifiers. All existing fixtures use safe identifiers. Changing the external order contract or encoding filenames is outside this design. |
| I / rejected admission is durable pending history | Main returns branch-occupied/ambiguous ownership without an intent record. | SHU-86 persists intent before branch election, assigns BRANCH_OCCUPIED or MISSING_AUTHORITY, and retains it across recovery. | The durable side effects of a refused admission differ. Preserve SHU-86 intent-before-announcement; these explicit holds are not retry authorization and must not launch on idle recovery. Disabled dispatch still must not reach this operation. |

## Related boundaries checked, not additional cross-branch contradictions

- Both models write `running` before SHU-86 writes `launched`. There is a real
  crash window with a running record and only spawn_attempted evidence. Never
  promote that marker merely because the process probe succeeds. Adoption can
  retain occupancy while reporting lacks launch authority.
- Both launch elections refuse a second claim, including a `reserved` marker.
  Recovery must not erase a marker or treat reserved as permission to retry.
- Restart receipt byte equality in the residual test is bound after successful
  launch, not before spawn. A reserved -> spawn_attempted -> launched progression
  can preserve that assertion unchanged once the receipt has reached launched.
- The SHU-86 HOLD-code test covers intent-only approved-window holds. Its doc
  broadly says other holds survive restart, but the accepted-run recovery loop
  currently schedules accepted/no-marker work regardless of a changed intent
  hold code. Likewise submit schedules accepted work without consulting that
  code. This is a gap within SHU-86, not proof that the existing test covers it.
  Proposed integrated scheduling must require AWAITING_LAUNCH at both sites.
- Existing process/output/deadline HOLDs use error_code/reason and do not all
  have a run hold_code. The enumerated requirement is on pending intent codes;
  retain operational error codes separately. Do not relabel all errors as
  AMBIGUOUS_LAUNCH or expand the out-of-scope enum silently.
- A token-bound completion may arrive in the crash window before a confirmed
  receipt. Retain and validate it, but do not synthesize `launched` from it.
  Existing completion-validation and branch-release checks are independent
  from public launch reporting and must remain intact.
- The residual restart adapter returns a synthetic RUNNING adapter outcome
  immediately after checking submit.ok; it is a local test adapter, not the
  production SHU-86 transport. Preserve its one-launch/terminal/socket checks;
  strengthen it to await real receipt before claiming execution if D1 proceeds.
- Gate positive control uses the same fixture/config/clock/capacity/IO on both
  ticks; suppressLaunch changes only the mutation adapter. This is compatible
  with durable intent and must remain unchanged, including assertQuiet.

## Step 2: proposed integrated lifecycle

The following is coherent as a model, but cannot satisfy B/B2's original
post-spawn predicates literally. It is a proposal pending D1, not an approved
replacement for those assertions.

| State | Durable evidence / transition | Public meaning and recovery |
| --- | --- | --- |
| S0 volatile | No intent, order or launch claim. | reportIntent is UNLAUNCHED/MISSING_CLAIM with null next action; announce throws ANNOUNCE_WITHOUT_CLAIM. |
| S1 intended | Immutable bound intent, explicit enumerated hold code, fsync before acknowledgment. | Announcement UNLAUNCHED. Only AWAITING_LAUNCH may proceed automatically. Other intent holds survive restart. |
| S2 admitted | Branch ownership plus bound order and accepted run. | Authenticated stage ACCEPTED is durable queue admission; announcement status UNLAUNCHED. Receiptless forged RUNNING is refused. Duplicate submission does not create another attempt. |
| S3 reserved | Atomic launch-file create elects exactly one owner. | No execution claim. A restart with this marker holds AMBIGUOUS_LAUNCH; no second spawn. |
| S4 spawn attempted | Fsync phase spawn_attempted, attempt ID, timestamp, 64-hex completion hash before invoking spawnWorker. | This is a duplicate-prevention boundary, not successful execution evidence. A crash or failed spawn cannot produce a launch claim. |
| S5 confirmed spawn | Spawn returns positive PID, run/process identity is persisted, then launched receipt with issue/attempt/target/PID is persisted, preserving completion hash and spawn-attempt timestamp. | Require both SHU-86 receipt binding and main hash binding. Known process identity permits RUNNING; unknown identity remains operational HOLD. Receiptless stored running remains UNLAUNCHED/false/exact reason. |
| S6 terminal | Validated durable completion; retain launched receipt unchanged. | COMPLETED/FAILED with validated result, heartbeat and bound launch receipt. HOLD precedence remains for operational uncertainty. Completion is not callback/publish authority. |

Launch-file phase progression is strictly `reserved -> spawn_attempted ->
launched`; no regression, no deletion, no re-election after a marker. Preserve
the pre-spawn hash through completion and restart. The post-spawn crash window
is explicit; it must not be papered over by a phase rewrite during recovery.

Status and submission are separate protocol projections. Preserve submit's
durable acknowledgment, duplicate and attempt/target binding. Its ACCEPTED
stage is never execution proof: announcement status and receipt-aware transport
keep it UNLAUNCHED/LAUNCH_UNKNOWN. Authenticated status uses exact state-specific
schemas. Base successful fields remain required; admission has result and
heartbeat null and an enumerated pending hold code, confirmed launch adds a
required bound launch_receipt. Receiptless execution refusal has exactly
`ok:false, stage:UNLAUNCHED, reason:'launch receipt missing or invalid'`.
Authentication/binding/unknown-state errors retain their exact three-field
HOLD refusal; unavailable attempt retains its explicitly typed MISSING_CLAIM
variant. Unknown fields and removed/renamed fields must still fail SHAPE.

Validation precedence: envelope -> request/order binding -> known run state ->
present completion integrity -> intent integrity and launch evidence -> public
projection. Pure status reads must not create or repair durable intent/launch
records. Recovery is the state-changing path and must honor existing holds.

### D1: operator decision required before implementation

The direct conflict is in test **SHU251_STATUS_SHAPE pins all states and launch
receipt binding**, its calls into `assertStatusShape`, and the shared validator
used by **SHU251 live worker restart adopts once and recovers durable completion**.

Exact main assertion:

```js
assert.ok(launch.attempt_id === attemptId && launch.phase === 'spawn_attempted' && /^[0-9a-f]{64}$/.test(launch.completion_token_hash), RECEIPT);
```

It is guarded by `['RUNNING', 'COMPLETED', 'FAILED'].includes(status.stage)`.
The positive fixture writes:

```js
if (['running', 'completed', 'failed'].includes(state)) store.markLaunch(order.attempt_id, { attempt_id: order.attempt_id, phase: 'spawn_attempted', completion_token_hash: 'a'.repeat(64) });
assert.equal(status.stage, state.toUpperCase());
```

SHU-86's **reporting requires an actual bound launch receipt** asserts:

```js
supervisor.store.claimLaunch(order.attempt_id, { attempt_id: order.attempt_id, phase: 'spawn_attempted' });
assert.equal(supervisor.store.announce(order).status, 'UNLAUNCHED');
```

And its documented receipt predicate starts with:

```js
return receipt?.phase === 'launched' && receipt.attempt_id === order.attempt_id
  && receipt.issue_id === order.issue_id && receipt.target_sha === order.target_sha
  && Number.isInteger(receipt.pid) && receipt.pid > 0;
```

At S4 main's phase predicate is true, but a RUNNING claim is not permitted by
SHU-86. At S5/S6 SHU-86 permits a launch claim, but main's phase predicate is
false. No placement makes the original whole main assertion true at its
original public-status boundary in this model. Accepting either phase would
weaken the execution-evidence requirement. Keeping a permanently attempted
claim and manufacturing a different launched projection would change the
meaning of the stored receipt and would not preserve SHU-86 literally either.

Requested decision: authorize replacing main's launch-claiming positive fixture
with confirmed launched evidence and replacing its post-spawn phase predicate
with a launched predicate, while retaining a separate exact pre-spawn
spawn_attempted/hash assertion at S4 and adding rejection coverage for the
old synthetic marker-only RUNNING/COMPLETED/FAILED claims. Preserve the exact
named failure, hash requirement, all bindings, exact schema checks, and all
restart/positive-control/mutation checks. Also explicitly adopt UNLAUNCHED for
failed spawn without confirmed launch, revising main's failed-spawn prose.

This preserves and strengthens the intended execution-evidence safety property,
but it changes an existing literal positive assertion and its state binding.
Under the user's hard rule, that decision cannot be inferred or silently made.

### Existing assertion bindings

The appendix below records individual source assertions. This table explains
the state and strength of each family, including runtime assertions and the
negative/mutation wrappers. An assertion marked blocked is not claimed preserved.

| Test/function | Bound state and preservation argument |
| --- | --- |
| verifyGatePositiveControl / gate positive test | Gate-off S0 diagnostic: code 0, exact dry-run eligibility/next reservation and assertQuiet; same fixture gate-on S1-S5: code 0, exactly one launch, positive write count, config false. No change to operands or gate semantics. |
| suppress positive-control launch | Same gate-on state with launch suppressed must throw named POSITIVE. Preserve assert.rejects and exact message match. |
| assertStatusShape structural/type/UUID/SHA/result/heartbeat assertions | Every returned variant: preserve exact equality and value/type checks. C authorizes new explicit variants, not arbitrary keys or omission of base success fields. Error HOLD assertion applies to ordinary errors; A explicitly changes missing-receipt refusal to UNLAUNCHED. |
| assertStatusShape receipt presence/attempt/order SHA | S5/S6 launch-claiming responses: retain store presence, identical attempt and matching order SHA. Add successful-spawn binding and hash conjunction. |
| assertStatusShape phase/hash conjunction | BLOCKED D1 at S5/S6. Hash and attempt conditions remain applicable; phase equality cannot hold literally. A pre-spawn check alone cannot discharge the original post-spawn assertion. |
| liveRestart start/stop helper | S2->S5 startup readiness and authenticated socket; stop exits exactly [0,null]. Preserve actual daemon exits and identities. |
| liveRestart body | S5 before/after measured interval and daemon exit: same live worker; new daemon PID; shape/client equality, RUNNING, same worker PID, one start. S6: completed journal, no orphan, durable validated completion, COMPLETED, folded terminal run, exact one-start/one-completion journal, unchanged receipt bytes. Only shared phase validator is blocked D1. |
| duplicate spawn / lost terminal mutations | Same S5/S6 path, deliberately duplicated journal or deleted completion: exact named assert.rejects must still detect the defect. Not source-mutation evidence. |
| pins all states positive loop | S2 ACCEPTED and operational HOLD remain exact. RUNNING/COMPLETED/FAILED marker-only positives are BLOCKED D1; they are not merely missing realistic fixture fields. |
| pins all states receipt removal loop | Corrupted S5/S6 without receipt: shape-valid refusal, false, exact receipt reason. Preserve every state iteration; A authorizes UNLAUNCHED label. |
| required status field removed or renamed | S2 success: each original invalid type/value and every removed/renamed key must still throw SHAPE. Extend the same checks across all explicit variants so receipt/hold/result/heartbeat checks cannot be bypassed by malformed fixture shape. |
| status claims launch without receipt | S2 response forged RUNNING: throw RECEIPT for absent execution evidence. Ensure the forged object has a legal RUNNING structural shape first so SHAPE cannot kill the mutant for the wrong reason. The exact assert.throws and named error requirement remain. |
| unpersisted next-action plan | S0 report UNLAUNCHED/MISSING_CLAIM/null action; exact announce refusal; S1 has no accepted order; autonomous event loop reaches S5 with one child and RUNNING announcement. Preserve all operands and assertions. |
| reporting requires actual receipt | S2 submit/announce UNLAUNCHED and AWAITING_LAUNCH; forged RUNNING transport remains LAUNCH_UNKNOWN and exactly one transport contact; corrupt receiptless running stage UNLAUNCHED (A additionally requires false/reason); S4 marker alone remains UNLAUNCHED. Preserve every existing assertion. |
| three restarts recover pending work exactly once | S1 then S5 across three supervisors and duplicate wakeups: each child count 1, each announcement RUNNING, exact cumulative [1,1,1]. No new exactly-once claim beyond the ambiguous boundary. |
| pending HOLD codes mandatory / idle restart | S1 invalid code attempts throw exact named error; approved-window intent-only state stays unlaunched through three recoveries; persisted code unchanged; deleting it causes named integrity failure. Preserve each invalid input and assertion. |
| capacity occupancy never substitutes | Reservation/dispatch/running/queued/in-review metadata without receipt: each yields UNLAUNCHED/MISSING_LAUNCH_RECEIPT/null action. Keep all five inputs. |
| crash after spawn / stale wakeup | S4 crash after actual spawn before running persistence: rejects simulated crash, stale wakeup and three restarts retain one child and both run/announcement AMBIGUOUS_LAUNCH. Preserve injection boundary and exact assertions. |
| six SHU-86 mutation tests | Unique source anchor, disposable copy, same real behavioral test, child exit exactly 1, AssertionError and exact named message. Preserve all six mutants and named messages. Do not accept unrelated assertion failures as kills. |
| supervisor intentPath/intend/report/announce assertions | S0/S1/admission/report: safe identifier, validated bound order, immutable canonical binding, correct filename key, durable intent before announcement. Retain exact checks and named messages; preserve rethrow of integrity failures. |
| requireHoldCode | Every persisted pending-intent write/read/recovery requires enumerated code. Preserve exact assertion and mutation anchor in the out-of-scope helper. |

## Steps 3-5: deferred, not claimed complete

This agent added only this design document, to make the whole inventory and the
exact blocked assertion reviewable. This agent edited no source or test assertion
and started no merge. The requested merge-then-settle-then-test sequence has not
yet reached its test phase.

Workspace finding: the initial worktree/index were clean. During the final
document check, the tree contained an unresolved merge with MERGE_HEAD
`aac05b1055c719924f8f305d25238fdfed05d806`, supervisor.mjs unmerged, and the incoming
main files staged. MERGE_HEAD and supervisor.mjs had filesystem timestamp
`2026-09-14 15:01:18.620867467 +0300`. None of this agent's commands initiated
that merge. Its origin is unknown; do not attribute it to a specific person or
process without evidence. Those changes were left untouched. `git diff --check`
exited 2 and reported leftover conflict markers in supervisor.mjs at lines
495, 502, and 506. This is an observed merge-state failure, not a test failure.

| Requested command/check | Observed result in this lane |
| --- | --- |
| Repository-root npm test | NOT RUN; no test counts measured. |
| umask 0002; chmod -R go-w .github/coordinator; coordinator test globs | NOT RUN; no test counts measured. |
| SHU251_STATUS_SHAPE | NOT RUN; static conflict C/D1 recorded, not an observed test failure. |
| SHU251_STATUS_RECEIPT | NOT RUN; static conflict B/D1 recorded, not an observed test failure. |
| SHU251_GATE_OFF_POSITIVE_CONTROL | NOT RUN. |
| ANNOUNCE_WITHOUT_CLAIM | NOT RUN. |
| REPORT_WITHOUT_RECEIPT: durable intent variant | NOT RUN. |
| REPORT_WITHOUT_RECEIPT: transport variant | NOT RUN. |
| RECOVERY_NOT_EXACTLY_ONCE: pending recovery variant | NOT RUN. |
| RECOVERY_NOT_EXACTLY_ONCE: launch election variant | NOT RUN. |
| HOLD_CODE_REQUIRED | NOT RUN. |
| Push and post-push local == remote assertion | NOT RUN; no new head produced. Initial fetched equality is not a push proof. |

After D1 is resolved, implement the whole design together within the allowed
files, complete the merge from the pinned main (checking whether it advanced),
let the tree settle, and run repository npm test first. Then apply the required
umask/chmod and run both coordinator globs. Report each command's TAP/Vitest,
mutation and skip counts separately, followed by each requested named rerun.
Do not change skip controls to conceal failures. Push the feature branch over
HTTPS using an environment-backed credential helper and read the exact remote
branch head back to assert equality to the new local head. Never include a
credential in a URL or output.

## Appendix: individual assertion source ledger
Source coordinates refer to the pinned input revisions, not future edited line numbers. Every executable `assert.*` call in the two specified tests, residual validator and SHU-86 supervisor/helper is listed, including inline mutation wrappers. Shared validator calls bind its full assertion set at the caller states documented above. Literal mutation replacement strings are not executable assertions in this process.

### `origin/main:.github/coordinator/service/residual-validation.mjs`

L18 — Gate-off S0 then same eligible gate-on S1-S5; retain exact gate assertions.

```js
assert.equal(off.code, 0, POSITIVE);
```

L19 — Gate-off S0 then same eligible gate-on S1-S5; retain exact gate assertions.

```js
assert.match(off.text, /DRY-RUN \(dispatch disabled, no writes\)/, POSITIVE);
```

L20 — Gate-off S0 then same eligible gate-on S1-S5; retain exact gate assertions.

```js
assert.match(off.text, /eligible=1\s+excluded=0/, POSITIVE);
```

L21 — Gate-off S0 then same eligible gate-on S1-S5; retain exact gate assertions.

```js
assert.match(off.text, /next reservation \(if dispatch were on\): SHU-140 via codex-cli/, POSITIVE);
```

L27 — Gate-off S0 then same eligible gate-on S1-S5; retain exact gate assertions.

```js
assert.equal(on.code, 0, POSITIVE);
```

L28 — Gate-off S0 then same eligible gate-on S1-S5; retain exact gate assertions.

```js
assert.equal(h.launched.length, 1, POSITIVE);
```

L29 — Gate-off S0 then same eligible gate-on S1-S5; retain exact gate assertions.

```js
assert.ok(writes > 0, POSITIVE);
```

L37 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.ok(status && typeof status === 'object' && !Array.isArray(status), SHAPE);
```

L38 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.equal(typeof status.ok, 'boolean', SHAPE);
```

L40 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.deepEqual(Object.keys(status).sort(), keys.sort(), SHAPE);
```

L42 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.equal(status.stage, 'HOLD', SHAPE);
```

L43 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.equal(typeof status.reason, 'string', SHAPE);
```

L46 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.equal(status.version, '2.0.0', SHAPE);
```

L47 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.equal(status.durable, true, SHAPE);
```

L48 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.equal(typeof status.attempt_id, 'string', SHAPE);
```

L49 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.match(status.attempt_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, SHAPE);
```

L50 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.equal(typeof status.target_sha, 'string', SHAPE);
```

L51 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.match(status.target_sha, /^[0-9a-f]{40}$/, SHAPE);
```

L52 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.ok(['ACCEPTED', 'RUNNING', 'HOLD', 'COMPLETED', 'FAILED'].includes(status.stage), SHAPE);
```

L53 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.ok(status.result === null || (typeof status.result === 'object' && !Array.isArray(status.result)), SHAPE);
```

L54 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.ok(status.heartbeat === null || (typeof status.heartbeat === 'string' && Number.isFinite(Date.parse(status.heartbeat))), SHAPE);
```

L56 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.ok(store && attemptId === status.attempt_id && store.hasLaunch(attemptId), RECEIPT);
```

L58 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.ok(launch.attempt_id === attemptId && launch.phase === 'spawn_attempted' && /^[0-9a-f]{64}$/.test(launch.completion_token_hash), RECEIPT);
```

L59 — Returned status variant: exact keys/types remain strict; C expands explicit variants. Receipt phase at S5/S6 is BLOCKED D1; A authorizes only the missing-receipt error label change.

```js
assert.equal(store.readOrder(attemptId).target_sha, status.target_sha, RECEIPT);
```

### `origin/main:.github/coordinator/service/test/residual.test.mjs`

L27 — Bounded fixture/helper failure remains an assertion, not a pass.

```js
assert.fail(message);
```

L32 — Same eligible gate-off/on fixture; configured gate remains false.

```js
assert.equal(evidence.configGate, false);
```

L53 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal((await ready)[0].ready, true, 'SHU251_RESTART_SOCKET: restarted service must return authenticated status');
```

L58 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.deepEqual(await exited, [0, null], 'SHU251_RESTART_SOCKET: supervisor must stop cleanly');
```

L64 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal(response.ok, true);
```

L68 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal((await h.runTick()).code, 0);
```

L72 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal(probeProcess(run), true, 'SHU251_RESTART_LIVE: worker must be live before restart');
```

L76 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal(probeProcess(run), true, 'SHU251_RESTART_LIVE: worker must be live before restart');
```

L79 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal(probeProcess(run), true, 'SHU251_RESTART_LIVE: worker must survive supervisor exit');
```

L81 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.notEqual(second.pid, first.pid);
```

L85 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.deepEqual(await checkStatus({ ...params, order: bound }), adopted);
```

L86 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal(adopted.stage, 'RUNNING', 'SHU251_RESTART_SOCKET: restarted service must return authenticated status');
```

L87 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal(store.readRun(bound.attempt_id).pid, run.pid, 'SHU251_RESTART_ADOPTED: recovered attempt must retain the same live process identity');
```

L91 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal(fs.readFileSync(params.journal, 'utf8').split('\n').filter(x => x.startsWith('started ')).length, 1,
    'SHU251_RESTART_NO_DUPLICATE: restart and replay must spawn exactly one worker');
```

L97 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.ok(store.hasCompletion(bound.attempt_id), 'SHU251_RESTART_DURABLE: recovery must retain the bound terminal receipt');
```

L98 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal(store.validatedCompletion(bound.attempt_id).ok, true, 'SHU251_RESTART_DURABLE: recovery must retain the bound terminal receipt');
```

L99 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal((await status()).stage, 'COMPLETED');
```

L102 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal(store.readRun(bound.attempt_id).status, 'completed', 'SHU251_RESTART_DURABLE: recovery must retain the bound terminal receipt');
```

L103 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.equal(fs.readFileSync(params.journal, 'utf8'), `started ${run.pid}\ncompleted ${run.pid}\n`, 'SHU251_RESTART_TERMINAL: adopted worker must complete exactly once');
```

L104 — S5 live restart then S6 terminal recovery; retain exact process, receipt, completion and socket observations.

```js
assert.deepEqual(fs.readFileSync(store.paths(bound.attempt_id).launch), receipt, 'SHU251_RESTART_NO_DUPLICATE: restart and replay must spawn exactly one worker');
```

L112 — S5 duplicate journal mutation must throw exact no-duplicate assertion.

```js
assert.rejects(() => liveRestart(t, { duplicate: true }), named('SHU251_RESTART_NO_DUPLICATE: restart and replay must spawn exactly one worker'));
```

L113 — S6 lost completion mutation must throw exact durable-receipt assertion.

```js
assert.rejects(() => liveRestart(t, { loseReceipt: true }), named('SHU251_RESTART_DURABLE: recovery must retain the bound terminal receipt'));
```

L124 — Positive S2 ACCEPTED/HOLD; marker-only execution positives BLOCKED D1. Receipt removal at S5/S6 retains false and exact reason; A changes label only.

```js
assert.equal(status.stage, state.toUpperCase());
```

L132 — Positive S2 ACCEPTED/HOLD; marker-only execution positives BLOCKED D1. Receipt removal at S5/S6 retains false and exact reason; A changes label only.

```js
assert.equal(refused.ok, false, RECEIPT);
```

L133 — Positive S2 ACCEPTED/HOLD; marker-only execution positives BLOCKED D1. Receipt removal at S5/S6 retains false and exact reason; A changes label only.

```js
assert.equal(refused.reason, 'launch receipt missing or invalid', RECEIPT);
```

L141 — S2 schema mutations: exact invalid types/values and each removed/renamed field fail SHAPE; extend to other variants without dropping these inputs.

```js
assert.throws(() => assertStatusShape({ ...status, [key]: value }), named(SHAPE));
```

L145 — S2 schema mutations: exact invalid types/values and each removed/renamed field fail SHAPE; extend to other variants without dropping these inputs.

```js
assert.throws(() => assertStatusShape(removed), named(SHAPE));
```

L146 — S2 schema mutations: exact invalid types/values and each removed/renamed field fail SHAPE; extend to other variants without dropping these inputs.

```js
assert.throws(() => assertStatusShape({ ...removed, [`renamed_${key}`]: status[key] }), named(SHAPE));
```

L153 — S2 forged RUNNING with absent receipt must fail RECEIPT, not an unrelated SHAPE assertion.

```js
assert.throws(() => assertStatusShape({ ...status, stage: 'RUNNING' }, { store: supervisor.store, attemptId: order.attempt_id }), named(RECEIPT));
```

### `HEAD:.github/coordinator/test/shu86-durable-intent.test.mjs`

L35 — S0 volatile refusal, S1 durable intent without order, autonomous S5 exactly one child.

```js
assert.equal(before.status, 'UNLAUNCHED', 'ANNOUNCE_WITHOUT_CLAIM: volatile plan cannot be reported as work');
```

L36 — S0 volatile refusal, S1 durable intent without order, autonomous S5 exactly one child.

```js
assert.equal(before.hold_code, 'MISSING_CLAIM');
```

L37 — S0 volatile refusal, S1 durable intent without order, autonomous S5 exactly one child.

```js
assert.equal(before.next_automatic_action, null);
```

L38 — S0 volatile refusal, S1 durable intent without order, autonomous S5 exactly one child.

```js
assert.throws(() => supervisor.store.announce(plan), { name: 'AssertionError',
    message: 'ANNOUNCE_WITHOUT_CLAIM: durable intent required before announcement' },
  'ANNOUNCE_WITHOUT_CLAIM: announcement must refuse a volatile plan');
```

L44 — S0 volatile refusal, S1 durable intent without order, autonomous S5 exactly one child.

```js
assert.equal(fs.existsSync(supervisor.store.paths(order.attempt_id).order), false);
```

L47 — S0 volatile refusal, S1 durable intent without order, autonomous S5 exactly one child.

```js
assert.equal(f.children.length, 1, 'RECOVERY_NOT_EXACTLY_ONCE: autonomous idle must launch the pending fix once');
```

L48 — S0 volatile refusal, S1 durable intent without order, autonomous S5 exactly one child.

```js
assert.equal(supervisor.store.announce(order).status, 'RUNNING');
```

L54 — S2 acknowledgment/announcement remain UNLAUNCHED; forged transport is LAUNCH_UNKNOWN and contacted once; receiptless running and S4 marker remain UNLAUNCHED.

```js
assert.equal(response.status, 'UNLAUNCHED', 'REPORT_WITHOUT_RECEIPT: durable intent alone cannot report running');
```

L55 — S2 acknowledgment/announcement remain UNLAUNCHED; forged transport is LAUNCH_UNKNOWN and contacted once; receiptless running and S4 marker remain UNLAUNCHED.

```js
assert.equal(response.hold_code, 'AWAITING_LAUNCH');
```

L57 — S2 acknowledgment/announcement remain UNLAUNCHED; forged transport is LAUNCH_UNKNOWN and contacted once; receiptless running and S4 marker remain UNLAUNCHED.

```js
assert.equal(report.status, 'UNLAUNCHED', 'REPORT_WITHOUT_RECEIPT: durable intent alone cannot report running');
```

L59 — S2 acknowledgment/announcement remain UNLAUNCHED; forged transport is LAUNCH_UNKNOWN and contacted once; receiptless running and S4 marker remain UNLAUNCHED.

```js
assert.equal(carriedSupervisorOutcome(forged, order).stage, 'LAUNCH_UNKNOWN',
    'REPORT_WITHOUT_RECEIPT: transport must refuse running without a launch receipt');
```

L64 — S2 acknowledgment/announcement remain UNLAUNCHED; forged transport is LAUNCH_UNKNOWN and contacted once; receiptless running and S4 marker remain UNLAUNCHED.

```js
assert.equal((await adapter.launchBuilder({})).stage, 'LAUNCH_UNKNOWN', 'REPORT_WITHOUT_RECEIPT: submission acknowledgement cannot report running');
```

L65 — S2 acknowledgment/announcement remain UNLAUNCHED; forged transport is LAUNCH_UNKNOWN and contacted once; receiptless running and S4 marker remain UNLAUNCHED.

```js
assert.equal(contacts, 1, 'REPORT_WITHOUT_RECEIPT: fixture must reach the transport');
```

L67 — S2 acknowledgment/announcement remain UNLAUNCHED; forged transport is LAUNCH_UNKNOWN and contacted once; receiptless running and S4 marker remain UNLAUNCHED.

```js
assert.equal(supervisor.status(signedSupervisorRequest(order, secret, 'status')).stage, 'UNLAUNCHED');
```

L69 — S2 acknowledgment/announcement remain UNLAUNCHED; forged transport is LAUNCH_UNKNOWN and contacted once; receiptless running and S4 marker remain UNLAUNCHED.

```js
assert.equal(supervisor.store.announce(order).status, 'UNLAUNCHED');
```

L81 — S1 recovery through S5 over three restarts: one child each, RUNNING announcements, exact [1,1,1].

```js
assert.equal(f.children.length, 1, 'RECOVERY_NOT_EXACTLY_ONCE: each restart must retain exactly one launch');
```

L82 — S1 recovery through S5 over three restarts: one child each, RUNNING announcements, exact [1,1,1].

```js
assert.equal(supervisor.store.announce(order).status, 'RUNNING');
```

L84 — S1 recovery through S5 over three restarts: one child each, RUNNING announcements, exact [1,1,1].

```js
assert.deepEqual(counts, [1, 1, 1]);
```

L91 — S1 invalid/corrupt codes throw; approved-window intent-only hold survives three idle restarts without children.

```js
assert.throws(() => supervisor.store.intend(order, new Date().toISOString(), code), /HOLD_CODE_REQUIRED/, 'HOLD_CODE_REQUIRED: absent or unknown HOLD codes must fail closed');
```

L92 — S1 invalid/corrupt codes throw; approved-window intent-only hold survives three idle restarts without children.

```js
assert.throws(() => requireHoldCode(code), { name: 'AssertionError',
      message: 'HOLD_CODE_REQUIRED: an enumerated HOLD code is required' },
    'HOLD_CODE_REQUIRED: absent or unknown HOLD codes must fail closed');
```

L98 — S1 invalid/corrupt codes throw; approved-window intent-only hold survives three idle restarts without children.

```js
assert.equal(f.children.length, 0);
```

L99 — S1 invalid/corrupt codes throw; approved-window intent-only hold survives three idle restarts without children.

```js
assert.equal(f.make().store.announce(order).hold_code, 'BLOCKED_BY_APPROVED_WINDOW');
```

L102 — S1 invalid/corrupt codes throw; approved-window intent-only hold survives three idle restarts without children.

```js
assert.throws(() => f.make().recover(), /HOLD_CODE_REQUIRED/);
```

L109 — All five capacity-only states without receipt remain UNLAUNCHED, missing receipt, null next action.

```js
assert.equal(report.status, 'UNLAUNCHED', 'REPORT_WITHOUT_RECEIPT: capacity occupancy is not execution evidence');
```

L110 — All five capacity-only states without receipt remain UNLAUNCHED, missing receipt, null next action.

```js
assert.equal(report.hold_reason, 'MISSING_LAUNCH_RECEIPT');
```

L111 — All five capacity-only states without receipt remain UNLAUNCHED, missing receipt, null next action.

```js
assert.equal(report.next_automatic_action, null);
```

L127 — S4 crash after spawn before running persistence; stale callback and three restarts preserve one child and AMBIGUOUS_LAUNCH.

```js
assert.equal(f.children.length, 1, 'RECOVERY_NOT_EXACTLY_ONCE: durable launch election must prevent duplicate spawn');
```

L128 — S4 crash after spawn before running persistence; stale callback and three restarts preserve one child and AMBIGUOUS_LAUNCH.

```js
assert.equal(supervisor.store.readRun(order.attempt_id).hold_code, 'AMBIGUOUS_LAUNCH');
```

L129 — S4 crash after spawn before running persistence; stale callback and three restarts preserve one child and AMBIGUOUS_LAUNCH.

```js
assert.equal(supervisor.store.announce(order).hold_code, 'AMBIGUOUS_LAUNCH');
```

L158 — Each of six source mutations has one anchor and must exit 1 with AssertionError and its exact named message.

```js
assert.equal(source.split(before).length, 2, `unique mutation anchor: ${name}`);
```

L164 — Each of six source mutations has one anchor and must exit 1 with AssertionError and its exact named message.

```js
assert.equal(result.status, 1, output);
```

L164 — Each of six source mutations has one anchor and must exit 1 with AssertionError and its exact named message.

```js
assert.match(output, /AssertionError/);
```

L164 — Each of six source mutations has one anchor and must exit 1 with AssertionError and its exact named message.

```js
assert.ok(output.includes(named), output);
```

### `HEAD:.github/coordinator/supervisor.mjs`

L196 — S0/S1 safe issue key, valid immutable order, correct intent filename, bound report and durable claim before announcement; preserve each runtime assertion.

```js
assert.match(order.issue_id, /^[A-Za-z0-9-]+$/, 'ANNOUNCE_WITHOUT_CLAIM: safe issue binding required');
```

L202 — S0/S1 safe issue key, valid immutable order, correct intent filename, bound report and durable claim before announcement; preserve each runtime assertion.

```js
assert.ok(validateBoundOrder(order).ok, 'ANNOUNCE_WITHOUT_CLAIM: a valid bound work order is required');
```

L206 — S0/S1 safe issue key, valid immutable order, correct intent filename, bound report and durable claim before announcement; preserve each runtime assertion.

```js
assert.equal(canonical(intent.order), canonical(order), 'ANNOUNCE_WITHOUT_CLAIM: intent binding is immutable');
```

L223 — S0/S1 safe issue key, valid immutable order, correct intent filename, bound report and durable claim before announcement; preserve each runtime assertion.

```js
assert.equal(this.intentPath(intent.order), join(this.intentsDir, name), 'ANNOUNCE_WITHOUT_CLAIM: intent key mismatch');
```

L233 — S0/S1 safe issue key, valid immutable order, correct intent filename, bound report and durable claim before announcement; preserve each runtime assertion.

```js
assert.equal(canonical(intent.order), canonical(order), 'ANNOUNCE_WITHOUT_CLAIM: report binding mismatch');
```

L240 — S0/S1 safe issue key, valid immutable order, correct intent filename, bound report and durable claim before announcement; preserve each runtime assertion.

```js
assert.ok(existsSync(this.intentPath(order)), 'ANNOUNCE_WITHOUT_CLAIM: durable intent required before announcement');
```

### `HEAD:.github/coordinator/intended-work.mjs`

L9 — Every pending intent code is enumerated; unchanged out-of-scope helper and exact named error.

```js
assert.ok(HOLD_CODES.includes(code), 'HOLD_CODE_REQUIRED: an enumerated HOLD code is required');
```

Ledger total: 93 executable assertion call sites (loop iterations and six mutation instantiations remain required). No assertion was edited or executed to produce this ledger.
