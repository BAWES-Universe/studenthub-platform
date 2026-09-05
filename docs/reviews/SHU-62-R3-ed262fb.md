# SHU-62 exact-head adversarial review

Verdict: **BLOCK**, not PASS.

Reviewed PR #22 at `ed262fbb05789f8c6d429129c13adcf2a1aa949b`.
This reviewer authored the corrections below and is ineligible to approve their resulting head.

## Reproduced defects and corrections

- **Duplicate spawn after claim release.** Coordinator A reads queued and pauses before exclusive claim creation. A real second coordinator process B completes launch and releases its claim. A then acquires the claim using its stale queued snapshot and launches again. Re-read and validate the reservation under the acquired claim before any state write or spawn.
- **Lost worker completion.** A worker writes done between the parent's lease read and write; the parent restores running and loses the worker's heartbeat. Parent spawn metadata now occupies a separate immutable `.json.spawn` record. `readLease` combines that record with worker state; the parent never overwrites worker state after spawn.
- **Untrusted recovery authority.** A fabricated Linear receipt could create a new host-local reservation and spawn a worker. Hermes recovery now requires an existing local reservation with matching attempt, issue, authorization reference, head, repository and branch. Missing local state holds the slot for reconciliation; a comment alone cannot recreate it. This is a host-local recovery gate, not a general cryptographic authentication system for Linear receipts or callbacks.
- **Lifecycle guard bypass.** Durable conflicts/read failures and persisted adapter pauses prevented new dispatch but did not prevent recovery launches. Apply those guards before recovery.
- **Repository policy bypass.** A committed absolute symlink with a newline-bearing path evades the old quoted-path parsing. Parse NUL-delimited index records and resolve symlink content by blob ID, propagating lookup failures.
- Invalid lease structures and claim ownership bindings fail closed instead of being interpreted as valid ownership.

## Evidence

- Exact original baseline: 135/135 coordinator tests.
- Four adapter regressions fail on the original SHA: duplicate spawn, lost completion, fabricated recovery, mismatched reservation. The repository-policy regression also fails on the original workflow.
- Corrected tree: 152/152 coordinator tests, typecheck succeeds, 101/101 platform tests and 27/27 assertion tests.
- Six targeted mutations killed: stale-reader recheck, local recovery authority, binding checks, durable-conflict gate, adapter-pause gate, and main-to-adapter recovery wiring.
- Actual Node coordinator fixture processes exit before and after a mocked worker spawn; recovery pauses and never starts another worker. Hermes itself is never launched.
- Alive/reused PID, foreign host, corrupt/null ownership records, invalid PID, mismatched claim attempt, and post-spawn persistence failure all prevent another launch.
- Original SHA's Sentry Seer check completed successfully with “No issues found”. GitHub returned no PR-triggered Actions runs at that SHA. CodeRabbit's success status is not an independent approval; three inline review threads remained unresolved.
- `git diff --check` clean. Offline dry run reports dispatch disabled and no writes. Tracked config retains `enable_dispatch: false`.

## Integration and independent verification

During this review, Opus advanced PR #22 to `9776af67a140d26077082cb68858403f71caafef`. This fix-up is deliberately based on the explicitly requested original SHA and does not overwrite that concurrent work. Its adapter/test changes require integration with the new claim protocol before final verification. The new head's claim that the original mutex could not double-spawn is contradicted by the deterministic stale-reader regression here.

The foreign-host timeout takeover added in the concurrent commit is not covered by this verdict. In particular, elapsed time is not proof a foreign coordinator died, and an ordinary overwrite is not an exclusive takeover. The next verifier must adversarially test concurrent takeover and a delayed original owner resuming after takeover.

PID reuse remains conservative: a reused live PID holds the claim. No timeout grants launch authority in this fix-up. Loss of host-local reservation state also requires reconciliation rather than automatic reconstruction from a comment.

Final handoff: a fresh non-author R3 verifier must inspect the integrated exact head, execute the adversarial cases (including both sides of the concurrent changes), check CI/Sentry and unresolved threads, and post its own verdict to PR #22 and SHU-62. Hermes, Opus, prior GPT authors, and this correcting reviewer are ineligible to approve the resulting patch. Dispatch must remain disabled. No merge or production action is authorized by this report.
