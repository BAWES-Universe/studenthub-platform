# B3: receipt-bound two-fixture progression

Scope: repository-only correction on `fix/shu71-two-fixture-progression`, based on
local `main` / HEAD `00eb979800b5ef6dfb918b57002d167802238612`. No fetch was used
to infer a newer remote main. No operational host, GitHub or Linear was accessed.
No activation was installed, gate changed, real signing key used, or remote pushed.
Test pushes use disposable local bare Git repositories only.

## Independent reproduction before implementation

The production validator was unchanged when `B3_REPRO_CURRENT_MAIN` ran. A fresh
Git repository produced seed `0ce4e524314aa9af69eb3c2f669a038ad4fa80e7` and child
`f6823e31ef8248e9057b2da7d2806bbf3f82fc3f`. `git merge-base --is-ancestor` exited
zero. The signed seed evaluation returned `armed`; changing only the observed
branch head to the child returned `ACT_STALE_SEED_HEAD`. Reproduction: 1 test,
1 pass, no skips. This isolated the equality-only defect without choosing a fix
or relying on the earlier reconciliation's reproduction. The retained test now
also proves that a descendant **without progression evidence** still refuses.

## Production path and authority

`main` -> `singleRunActivationStatus` -> `validateTwoFixtureActivation` retains
the signature, exact lane/configuration, revision, expiry, capacity, gate and
initial seed checks. At initial arming both heads must equal their signed seeds.
The coordinator stamps a SHA-256 digest of the complete signed payload into the
RESERVED receipt before launch. It is an immutable receipt field. The original
activation, signature and seed SHAs are never rewritten.

On later ticks `progressionHeads` reconstructs each lane independently from its
seed. Each edge requires an authenticated Linear receipt actor (transport
metadata, never a JSON actor claim), exact activation ID and payload digest,
valid build/revise role, issue/branch/repository/authorization binding, and the
broker's private journal for the same attempt, target and result. The broker now
records its bound target and fast-forward update mode before pushing. The reader
requires same-UID private directory/file custody and rejects symlinks. PENDING
journals allow the existing crash-after-push/read-back case only when the live
head matches the exact authorized result; a callback alone cannot supply an edge.

Every edge additionally requires ancestry. Production reads the configured
repository's exact GitHub comparison and requires `ahead` with the exact bound
merge base; unavailable evidence refuses. Tests use real local Git ancestry and
exercise the real API helper with a replaced fetch boundary. Forks, disconnected
chains, cross-lane journals, unrelated rewrites, unreceipted descendants, stale
episodes, wrong actors, forged digests and rewinds to the seed refuse with the
existing `ACT_STALE_SEED_HEAD`. The broker retains its non-force push command.

Authenticated actor metadata survives coordinator receipt transitions without
being serialized. The signed, configuration-bound lane now names its first
reviewer (`claude-verifier`), which is projected into the existing independent
review routing. This is needed for a fresh pair to progress into its first review;
role/family independence checks remain in the existing router. Previously signed
lane definitions are not silently upgraded to this definition.

## Composition and mutations

`B3_SEQUENCE` runs the real broker against disposable local remotes and drives
activation status through seed -> authorized build -> pushed descendant -> review
-> BLOCK -> revision push -> re-review. It checks immutable seed provenance,
exact re-review head, and one lane advancing while the other remains at its seed.
`B3_MAIN_SEQUENCE` additionally drives real coordinator ticks and receipt folding
through that sequence. Linear/GitHub, model execution and workspace preparation
are test boundaries; the broker, validator, receipt parser/factory and routing
are production modules. These tests do not claim real model or sandbox execution.
`B3_DISPATCH_STAMP` proves main persists the digest before launching.

Twelve B3 source mutations each must exit through a named AssertionError:

| Mutation | Required killing assertion |
| --- | --- |
| Equality-only regression | `B3_PUSH_BEFORE_TERMINAL` |
| Missing ancestry | `B3_MISSING_ANCESTRY_REFUSED` |
| Forged receipt digest admitted | `B3_FORGED_RECEIPT_REFUSED` |
| Wrong actor admitted | `B3_WRONG_ACTOR_REFUSED` |
| Wrong lane admitted | `B3_WRONG_LANE_REFUSED` |
| Force journal admitted | `B3_FORCE_UPDATE_REFUSED` |
| Broker uses `--force` | `B3_BROKER_NO_FORCE` |
| Stale episode admitted | `B3_STALE_EPISODE_REFUSED` |
| Both lanes required to advance together | `B3_PUSH_BEFORE_TERMINAL` |
| Seed rewind admitted | `B3_REWIND_REFUSED` |
| Dispatch digest omitted | `B3_DISPATCH_DIGEST` |
| Transport actor lost during transition | `B3_TRANSITION_ACTOR` |

The harness rejects syntax/import/type errors as mutation kills. Existing tests,
assertions, refusal codes and skip allowances were not weakened.

## Verification and limits

Final results (see `B3-VERIFICATION.json` for log digests and exact skip names):

| Run | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Focused, including 26 named mutation tests (12 B3 + 14 existing activation) | 94 | 94 | 0 | 0 |
| Complete coordinator + service, including nested tests | 1418 | 1410 | 0 | 8 |
| Default platform: TAP + Vitest | 486 | 486 | 0 | 0 |

The default platform command also killed 85 standalone mutations: profile 10,
idempotency 3, web 6, documents 17, document hardening 10, observability 17,
and document lifecycle 22. Mutations embedded in TAP suites are already included
in their test counts. The separately run service suite passed 247/247 without skips.
No mutation kill is being inferred from a timeout, import failure or skipped test.
The final combined suite exited 0. The eight existing skips concern distinct-UID
execution (seven) and an undeclared runtime/role capability (one); they do not
establish live acceptance. No new skips or allowance changes were made.

Commands:

- Focused: `node --test --test-concurrency=1 .github/coordinator/test/two-fixture-activation.test.mjs .github/coordinator/test/two-fixture-progression.test.mjs .github/coordinator/test/push-broker.test.mjs .github/coordinator/test/workspace-result.test.mjs`
- Complete coordinator and service suites: `node --test --test-concurrency=2 .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`
- Complete default platform suite, build and chained mutation scripts: `npm test`

The first full coordinator run exposed ten existing reviewer-boundary failures.
All ten reproduced in a pristine archive of main: that bounded baseline run was
95 tests, 85 pass, 10 fail, zero skips. The checkout's unmodified
`review-execution-child.mjs` had mode 0664, which the existing custody check
correctly rejects. Only that repository file's local mode was normalized to 0644
before final verification. No guard, owner, installed file or host policy changed.
Git records this file as 100644; its contents and tracked mode are unchanged.
An intermediate new composition test also failed due to its test API fixture;
the final test routes comments per issue and supplies the existing API shapes.

This closes the B3 source-level defect only. B1/B2/B4 production composition,
credential delivery and lifecycle recovery are separate findings. No live Phase-B
acceptance or independent-family exact-head approval is claimed. External-service
Postgres/Typesense integration suites and live privilege/kernel/model behavior
are not established by these repository tests. An unobserved external ref change
that returns to exactly the same authorized SHA between reads cannot be detected
from head/ancestry evidence; this is not a branch-event audit. Observed rewrites,
unauthorized heads and force-enabled broker commands are covered.
