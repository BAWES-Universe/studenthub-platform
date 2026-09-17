# B3 recovery amendment to the exact-head BLOCK

This addresses F1 in `/home/bawes/work/verdict-138.md` and `.json`, anchored at
`ef34d837b098652d51bac46eac6972c713709318`. The verifier's base reproduction,
accepted build/BLOCK/revise/re-review sequence and nine refused attacks are
accepted as findings, not re-derived. This is repository evidence, not a new
independent verdict or host acceptance.

## Recovery contract

The explicit trusted-coordinator API is `recoverTwoFixturePush` in
`two-fixture-recovery.mjs`. Supply the same broker options used for the interrupted
attempt and `readAuthorization()`, a fresh evidence provider returning the inputs
to `validateTwoFixtureActivation`: signed record, committed config, exact running
and main revisions, current gates/time, both observed heads, resolved issues,
transport-authenticated receipts, private journal reader and ancestry resolver.
The provider must use coordinator-owned sources, never worker JSON. No new secret,
activation file, journal deletion, manual journal edit or head override is needed.

The recovery authorizer validates the full signed activation and receipt chain
against the selected edge's expected result. It projects only that lane's expected
post-recovery head, retaining all other observed heads. The selected unpushed
commit cannot be compared on GitHub yet; its exact ancestry obligation is discharged
by the real broker over reconstructed objects before any success or remote write.
Every other edge retains the normal ancestry resolver. Signature, expiry, gates,
revision, actor, issue, role, episode, digest, branch, authorization and fork checks
still run. The normal activation validator is unchanged. This authorizer grants
only an exact-attempt recovery, never general dispatch permission.

`recoverExactSha` is the lower-level broker API; it requires a fresh authorization
callback. It repeats snapshot, ancestry, worktree, cleanliness, path, repository,
branch and trusted-Git validation. It then checks private same-UID non-symlink
journal custody and exact version/stage/attempt/target/result/branch/repo/worktree/
update-mode binding. A journal cannot redirect the requested recovery.

| Actual remote and durable journal | Decision |
| --- | --- |
| Exact result, PENDING or PUSHED | Atomically confirm PUSHED; no push |
| Exact target, PENDING | Resume the same exact result with the existing non-force SHA refspec, confirm the remote, atomically mark PUSHED |
| Exact target, PUSHED | Refuse rewind |
| Other head, deleted ref, malformed or mismatched journal | Refuse; retain evidence |
| Unavailable remote, revoked authorization, invalid local result | HOLD; retain evidence |
| Durable confirmation fails | HOLD; next recovery reconciles against the remote again |

Recovery marks use a private temporary file, file flush, atomic rename and directory
fsync. Repeating successful recovery preserves the journal bytes and never pushes
again. Ordinary `pushExactSha` HOLD behavior is unchanged. No progression edge is
dropped, skipped, marked FAILED or inferred solely from a callback. During an
unresolved interruption the whole activation still refuses; explicit recovery
restores both lanes. Automatic recovery from the normal refused dispatch tick is
not introduced. The trusted recovery caller invokes this API outside dispatch;
normal validation then admits subsequent ticks without any exemption.

## Proof and named codes

Tests use ephemeral keys, disposable worktrees and local bare remotes only.
`B3_RECOVERY_INTERRUPTED` and `B3_RECOVERY_AMBIGUOUS` start after an authorized
build and BLOCK review, interrupt the revision push, recover, reach exact-head
re-review and advance the sibling lane without changing signed activation bytes.
`B3_RECOVERY_DEATH_BEFORE` and `B3_RECOVERY_DEATH_AFTER` SIGKILL a separate broker
process after journal persistence and after actual local push respectively; a new
process recovers from disk. `B3_RECOVERY_IDEMPOTENT` counts exactly one push across
two recovery calls. `B3_RECOVERY_ANCESTRY` proves that projected authorization cannot
admit a real orphan, including when a tampered journal and remote agree on it.

All existing error codes and assertions remain. The five added reason codes are:

| Code | Killing mutation | Named assertion |
| --- | --- | --- |
| `B3_RECOVERY_AUTHORIZATION` | `RECOVERY_AUTH` | `B3_RECOVERY_AUTH_REQUIRED` |
| `B3_RECOVERY_JOURNAL` | `RECOVERY_CUSTODY` | `B3_RECOVERY_CUSTODY_REFUSED` |
| `B3_RECOVERY_BINDING` | `RECOVERY_BINDING` | `B3_RECOVERY_BINDING_REFUSED` |
| `B3_RECOVERY_REMOTE` | `RECOVERY_REWRITE` | `B3_RECOVERY_REWRITE_REFUSED` |
| `B3_RECOVERY_DURABILITY` | `RECOVERY_MARK_FAILURE` | `B3_RECOVERY_MARK_FAILURE_HELD` |

Additional new mutations and required assertions:

| Mutation | Killing assertion |
| --- | --- |
| `RECOVERY_INTERRUPTED` | `B3_RECOVERY_INTERRUPTED_RESUMED` |
| `RECOVERY_AMBIGUOUS` | `B3_RECOVERY_AMBIGUOUS_RESUMED` |
| `RECOVERY_IDEMPOTENT` | `B3_RECOVERY_STABLE_JOURNAL` |
| `RECOVERY_DEATH` | `B3_RECOVERY_PROCESS_DEATH_RESUMED` |
| `RECOVERY_DURABILITY` | `B3_RECOVERY_DURABLE` |
| `RECOVERY_ACTIVATION` | `B3_RECOVERY_ACTIVATION_REFUSED` |
| `RECOVERY_ANCESTRY` | `B3_RECOVERY_REAL_ANCESTRY_REFUSED` |
| `DANGLING_IGNORED` (verifier M7) | `B3_DANGLING_REFUSED` |
| `ATTEMPT_UNBOUND` (verifier M5) | `B3_ATTEMPT_REFUSED` |
| `ANCESTRY_REVERSED` (verifier M2) | `B3_PUSH_BEFORE_TERMINAL` |
| `JOURNAL_PERMS` (verifier M4) | `B3_PUBLIC_JOURNAL_REFUSED` |
| `DIGEST_IMMUTABILITY` (verifier M6) | `B3_DIGEST_IMMUTABLE` |

The original twelve B3 mutations and fourteen activation mutations remain.
Verifier M1's equality-only regression is covered by the original EQUALITY_ONLY
mutation. Verifier M3 (`next.length < 1`) remains a survivor: consuming one fork
edge leaves another disconnected edge, which still refuses. It was explicitly
rerun against fork, dangling and verifier-attack tests; this is not claimed as a
kill. The non-equivalent M7 now dies. Fork, missing-first-edge, review-role push,
sibling tampering and JSON actor spoofing have explicit regression assertions.

## Refusals preserved and limits

All nine previously refused attack classes remain refused: A1 unreceipted
advance; A2 forged receipt without broker evidence; A4 cross-activation replay;
A5 review-role push; A6 missing chain edge; A7 rewind to seed; A8 unauthorized
sibling head; A9 JSON actor spoofing; A10 fork. The original missing-ancestry,
wrong-lane, forged-digest, wrong-actor and force-command mutations also remain.

F2's untrusted-comment denial of service is not relaxed by this amendment: the
user required existing guards to remain. The explicit recovery only works with
valid receipt evidence. F4 is clarified: `update_mode` is a declared policy field,
not measured evidence; the actual non-force argv, Git's fast-forward enforcement
and independently checked ancestry provide the protection. F5's retained test
name and assertions are unchanged, but its output now truthfully labels itself
as current-checkout unreceipted-descendant refusal, not a base run. The independent
verdict supplies the base reproduction. F9's file set is recorded in the new
verification JSON. F8 needs no change.

The same-UID journal trust boundary (F6) remains; this does not defend against a
compromised coordinator UID. An unobserved remote ref change that returns to the
exact bound target while the journal is PENDING is indistinguishable from an
unlanded push using head observations alone. No remote event-log/ABA detection is
claimed. Observed unauthorized heads and PUSHED rewinds refuse. Compare outages
on other edges still refuse and recover on a later read (F7). Concurrency between
multiple recovery callers, machine power loss, real GitHub comparisons, production
state-directory configuration and host/adapter recovery orchestration have not
been exercised. SIGKILL tests establish process-death recovery, not power-loss
simulation. No live host, systemd operation, remote push, PR operation or comment
was authorized or performed. SHU251_NO_SYSTEMD stays enabled for the full suites;
no skip allowance is added or widened.
