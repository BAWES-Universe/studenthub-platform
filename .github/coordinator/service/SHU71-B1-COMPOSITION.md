# B1 repository composition evidence

This pass supplies repository evidence for M2, not an M2 or launch verdict.
Refresh: fetched and merged `origin/main` at
`993ed802129963138f55e015d56cb8be076360de` before implementation. The merge
commit is `f32777f7ffd74c14a5f36248cd82b69764908725`; its first parent is the
accepted L3 head `4877bb8ea7f53ba2eec2e27d3e4fcf2c60251807`. No force-push,
push, PR action, external comment, host deployment, or #138 convergence is
part of this pass. The final local commit is reported with the handoff.

## Composition and limits

`test/shu71-composition.test.mjs` calls
`createShu71Production(id, boundary).execute(action)` using the existing
`productionFixture`. Its emitted activation credential is copied byte-for-byte
into the existing `createEpisodeHarness`, which executes the real coordinator
`main()`. No test calls the reconciliation-side progression helpers or replaces
their transition logic. The approval uses the committed fixture lane definitions
(including their reviewer lanes), signed by the existing ephemeral test key.
The production fixture's original minimal lane definitions omit reviewer lanes;
using them unchanged correctly refuses first-review bootstrap.

The single-lane case makes SHU-254 ineligible (Backlog) in the coordinator API
double, retaining both identities in the signed production package. SHU-140
completes build → BUILD_READY → review → BLOCKED/HOLD → revise →
REVISION_READY → a distinct re-review → PASS/COMPLETED. Its four launches bind
seed, built head, built head, revised head respectively. Every reservation binds
the activation id, signature-covered digest, branch and exact head; every launch
and terminal result is also head-checked. SHU-254's head stays at its seed.

The two-lane case has this **actual adapter launch order**, separately compared
with the expected order:

1. SHU-140 build
2. SHU-140 review (BLOCK)
3. SHU-140 revision, left RUNNING
4. SHU-254 build
5. SHU-254 review (BLOCK)
6. SHU-254 revision
7. SHU-254 re-review (PASS)
8. SHU-140 re-review (PASS), after its revision completes

After SHU-254's PASS, SHU-140's revision receipt is still RUNNING. This is actual
interleaving of modeled worker lifetimes across sequential coordinator ticks,
not simultaneous JavaScript execution or real OS workers.

The production entrypoint controls an **activation episode containing both
fixtures**. `run` arms; an unexpired `expire` observes NOT_EXPIRED; `resume`
after ARMED performs revocation, not a worker-step resume; `revoke` tears down;
an expired `expire` tears down. It cannot drive build/review transitions by
itself. Real coordinator ticks provide that half of the composition. There are
no lane-owned gate files, activation credentials or activation leases: these
are shared by the episode. The tests assert shared state at every tick, plus
lane-specific receipts/heads/launches, rather than inventing per-lane resources.

Separate activation episodes cannot run concurrently: both attempted successor
starts return ACT_ACTIVATION_CONFLICT while the predecessor owns the lease.
The cross-teardown test uses one boundary/filesystem, authenticates each new
approval, retires A, actually arms B, and exercises A's periodic wake. It then
retires B, actually arms a fresh A episode, and exercises B's periodic wake.
In **both directions** the successor's two gate files, credential bytes and lease
bytes are unchanged; the retired wake has zero effects and explicitly does not
claim a physical teardown observation. These are activation-episode directions,
not independent ownership by SHU-140 and SHU-254.

## Pinned bounded state table

Effect counting matches R8: writes, renames, unlink attempts, recursive removals,
commands and API calls; reads, mkdir, chmod/chown and fsync are excluded. It is
not a host syscall count. Coordinator worker launches are counted separately.

| Transition | Gates | Credential | Lease | Effects | TEARDOWN_COMPLETE |
| --- | --- | --- | --- | ---: | ---: |
| production run → ARMED | both true | exact signed bytes | own episode | 116 | 0 |
| every coordinator tick + unexpired expire | both true | unchanged | unchanged | 0 | 0 |
| armed resume → REVOKED | both false | absent | absent | 68 | 1 |
| repeated revoke after completion | both false | absent | absent | 4 (service observations) | retained |
| expired expire → REVOKED | both false | absent | absent | 72 | 1 |
| retired expire while successor armed, either direction | successor unchanged | successor unchanged | successor unchanged | 0 | predecessor retained |

This additional progression table does not replace or weaken
`SHU71-R8-STATE-MODEL.md`: its 720 executed rows and 144 unreachable combinations
with reasons remain intact, as do W7/W13/W1b/W15, V12/V14, the 18 individually
pinned control properties, FORGED-ordered residual disclosure, R5-A credential
revocation, R5-C ownership retention and Q3 scope-choice wording. Their files
are unchanged by this pass.

## Supervisor environment-file contract

The exact per-unit `EnvironmentFile=` binding remains pinned by
`SHU251_SECRET_FILE`. Defaults are supervisor `/etc/shu/supervisor.env` and
coordinator `/srv/shu/coordinator.env`. The file supplements the supervisor's
inline `Environment=` entries; the coordinator environment is not inherited.
Tests assert effective parsed values, their transfer through
`supervisorChildEnvironment`, and exclusion of the supervisor transport secret.

| Required file key | Existing semantic refusal (retained) | New assertion |
| --- | --- | --- |
| SHU_WORKER_UID | activation.mjs worker_identity_split: unset, zero, coordinator uid | required in supervisor file |
| SHU_WORKER_LAUNCH_WRAPPER | activation.mjs worker_identity_split: unset | required in supervisor file |
| SHU_WORKTREE_ROOT | activation.mjs host_push_broker | required in supervisor file |
| SHU_PUSH_REMOTE_URL | activation.mjs host_push_broker | required in supervisor file |
| SHU_REVIEW_EVIDENCE_DIR | review-execution.mjs privateDirectory → REVIEW_EXECUTION_UNAVAILABLE | required in supervisor file |
| SHU_REVIEW_EXEC_UID | review-execution.mjs distinct non-root uid → REVIEW_EXECUTION_UNAVAILABLE | required in supervisor file |
| SHU_REVIEW_EXEC_WRAPPER_JSON | reviewWrapper/validateReviewWrapper → REVIEW_EXECUTION_UNAVAILABLE | required in supervisor file |
| SHU_REVIEW_MODEL_WRAPPER_JSON | reviewWrapper/validateReviewWrapper → REVIEW_EXECUTION_UNAVAILABLE | required in supervisor file |
| SHU_REVIEW_TEST_FILES_JSON | reviewTestFiles → REVIEW_EXECUTION_UNAVAILABLE | required in supervisor file |

See `activation.mjs`'s `worker_identity_split` block and `host_push_broker`
block, and `review-execution.mjs`'s `runReviewEvidence`, `privateDirectory`,
`reviewWrapper`, and `reviewTestFiles`. The new tests invoke existing refusals;
no duplicate identity validator was added. Every individual missing key is
removed from a complete file, refused by name, and exercised through production
`execute('run')`. The named error is `SHU71_SUPERVISOR_ENV_REQUIRED`; signing,
fixture mutations and credential installation do not occur. Empty/malformed
assignments retain `SHU251_ENV_CONTENT` at the content parser.

Necessary production changes are confined to two modules:

- `units.mjs`: reuse its existing conservative EnvironmentFile parser; permit
  the closed set of nine adapter settings with the transport secret; require
  the full set if any adapter setting is provided; export the launch assertion.
  Secret-only gate-off staging remains accepted. Arbitrary settings and foreign
  credentials remain refused. This replaces the former secret-only content
  restriction, which made supplying the requested adapter settings impossible.
- `shu71-production.mjs`: apply that assertion before installation validation,
  signing and fixture mutation on the arming path; retain the named missing-key
  error. Read the fixed deployed supervisor file via the existing no-follow
  opened-file custody check, strengthened for this file to root:root exactly
  0600. Teardown and historical periodic wakes do not depend on valid launch
  configuration. Production teardown/progression semantics are unchanged.

`productionFixture` now supplies synthetic file content. No real credentials,
UID switches, wrappers, systemd services or external APIs are used by the new
tests. File ownership is modeled, not changed on a host.

## New named assertions

Literal assertion names and explicitly bounded expansions are listed here.
`id` is SHU-140 or SHU-254; `role` is build/review/revise; `verdict` is
BUILD_READY/BLOCKED/REVISION_READY/PASS; `direction` is A_TO_B/B_TO_A;
`key` is exactly one of the nine rows above.

- Composition admission/state: B1_PRODUCTION_ARM, B1_ARM_EFFECT_COUNT,
  B1_LIVE_WAKE, B1_COORDINATOR_TICK, B1_ARMED_STATE_TABLE,
  B1_LIVE_WAKE_ZERO_EFFECTS.
- Lane progression: B1_RECEIPT_PRESENT, B1_SEQUENCE_{id}_{role}, B1_WORKER_ROLE,
  B1_RUNNING, B1_EXACT_HEAD, B1_SIGNED_DIGEST, B1_EXACT_EPISODE, B1_EXACT_BRANCH,
  B1_LAUNCH_EXACT_HEAD, B1_CALLBACK_FOLDED_{verdict}, B1_TERMINAL_STATE_{verdict},
  B1_RESULT_EXACT_HEAD, B1_NEW_REVIEW_ATTEMPT.
- Single lane/teardown: B1_SINGLE_ORDER, B1_SINGLE_FOUR_LAUNCHES,
  B1_SINGLE_OTHER_HEAD_UNTOUCHED, B1_RESUME_REVOKES_ARMED, B1_RESUME_EFFECT_COUNT,
  B1_RETIRED_STATE_TABLE, B1_ONE_COMPLETION_RECORD, B1_REVOKE_IDEMPOTENT,
  B1_REVOKE_OBSERVATION_ONLY.
- Two lanes: B1_REAL_OVERLAP_A_REVISION_RUNNING_AFTER_B_PASS,
  B1_REAL_OVERLAP_B_FINISHED, B1_INTERLEAVED_NEW_REVIEW, B1_INTERLEAVED_ORDER,
  B1_TWO_EIGHT_LAUNCHES, B1_ACTUAL_LAUNCH_ORDER, B1_EXPIRED_TEARDOWN,
  B1_EXPIRY_EFFECT_COUNT, B1_EXPIRED_GATES, B1_EXPIRED_ONE_COMPLETION,
  B1_EXPIRED_CREDENTIAL_REVOKED, B1_EXPIRED_LEASE_RELEASED.
- Cross-teardown: B1_CROSS_INITIAL_ARM, B1_SERIAL_EPISODES_{direction},
  B1_CONFLICT_UNTOUCHED_{direction}, B1_RETIRE_{direction},
  B1_SUCCESSOR_ARM_{direction}, B1_RETIRED_WAKE_{direction},
  B1_NO_FALSE_OBSERVATION_{direction},
  B1_SUCCESSOR_GATES_CREDENTIAL_LEASE_UNTOUCHED_{direction},
  B1_RETIRED_ZERO_EFFECTS_{direction}, B1_CROSS_FINAL_CLEANUP.
- Environment binding: B1_ENV_DEFAULT_SUPERVISOR, B1_ENV_DEFAULT_COORDINATOR,
  SHU251_SECRET_FILE, B1_ENV_NINE_KEYS, B1_ENV_EFFECTIVE_VALUES,
  B1_ENV_CHILD_{key}, B1_ENV_NO_TRANSPORT_SECRET_IN_CHILD, B1_ENV_MODELED_CUSTODY.
- Each missing key: B1_ENV_NAMED_ABSENCE_{key}, B1_ENV_PRODUCTION_REFUSAL_{key},
  B1_ENV_BEFORE_SIGN_{key}, B1_ENV_NO_CREDENTIAL_{key},
  B1_ENV_NO_FIXTURE_MUTATION_{key}.
- Existing guards: B1_EXISTING_GUARDS_POSITIVE, B1_EXISTING_UID_{unset,0,999},
  B1_EXISTING_SHU_WORKER_LAUNCH_WRAPPER, B1_EXISTING_SHU_WORKTREE_ROOT,
  B1_EXISTING_SHU_PUSH_REMOTE_URL, B1_EXISTING_SHU_REVIEW_EXEC_WRAPPER_JSON,
  B1_EXISTING_SHU_REVIEW_MODEL_WRAPPER_JSON, B1_EXISTING_REVIEW_TEST_FILES,
  B1_EXISTING_REVIEW_UID_REFUSAL, B1_EXISTING_REVIEW_UID_DETAIL,
  B1_EXISTING_EVIDENCE_DIR_REFUSAL, B1_EXISTING_EVIDENCE_DIR_DETAIL.
- Custody: B1_ENV_CUSTODY_{OWNER,GROUP,PUBLIC,MODE},
  B1_ENV_CUSTODY_BEFORE_SIGN_{OWNER,GROUP,PUBLIC,MODE}.

## Verification and unproved properties

The new `*.test.mjs` files are included by the existing `test:coordinator` glob,
which Platform CI executes. No new skip, name filter, permitted-skip entry,
assertion weakening in existing tests, or workflow exemption was added.
Final exact counts and commit identity accompany the handoff. The refreshed
baseline had 2,627 tests: 2,619 passed, zero failed, eight pre-existing skips.
Those existing skips are six distinct-UID/host integration tests, one restricted
capability case with no production vocabulary pair, and one operator-owned
checkout reader test. They are not counted as new B1 evidence.

The composition doubles Git/head/ancestry/broker-journal responses, API stores,
worker execution and systemd effects. The existing episode harness bypasses
host activation preflight; the separate environment tests exercise its existing
configuration refusals. This does not establish actual Git publication, trusted
API actors, real worker output, real model review quality, installed code hashes,
real UIDs, systemd environment loading, wrapper execution, AppArmor enforcement,
cgroup kill or reboot/power-loss durability. Copying the credential is a modeled
transport, not proof of systemd credential delivery. The nine-key contract is a
necessary file-content check, not proof of complete live adapter readiness.
Real host properties remain M3 work. The model proves bounded fixture states,
not host behaviour. CI greenness is for the orchestrator to verify after its
push; this pass neither pushes nor claims that verification.
