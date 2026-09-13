# SHU-251 correction validation

Base HEAD was verified as `3ea21881c5aaa4714228f8b4eb13cc86610e5d1c` before edits,
on `feat/shu-251-host-service-plane`, in `/home/bawes/work/shu251`, with a clean tree.
The final commit SHA and exact base-to-commit diff stat accompany this report in
the delivery response (a commit cannot embed its own hash).

Both measurements ran from the repository root, following `chmod -R go-w .github/coordinator`:

```sh
node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
```

| Measurement | Tests | Passed | Failed | Skipped | Suites |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before | 776 | 770 | 0 | 6 | 0 |
| After | 798 | 792 | 0 | 6 | 0 |

All prior passing test names remain passing. The service suite grows from 18 to
40 tests. All 22 new tests pass. No tests were removed. `verify.mjs` also passes:
syntax valid, two disabled ticks, zero adapter calls, zero writes, empty fixture
state diff, and exact rollback. `git diff --check` passes. Required GitHub CI itself
was not remotely run: pushing and PR interaction are prohibited.

## All ten required items

1. **F1 completed:** standard command includes both globs; required fast-checks
   runs it without failure suppression and asserts systemd-analyze/flock prerequisites.
2. **F3 completed:** explicit workspace state environment and canonical lock equality
   in rendering and rendered policy; canonical acceptance and foreign refusal tested.
3. **F2 completed:** both-gates-enabled tick throws SHU251_ZERO_LAUNCH. Separate
   runtime-override control also throws. README narrows write/state discrimination.
4. **F5 completed:** nonexistent staging destination produces named SHU251_DESTINATION.
5. **F6 completed:** unresolved-template checks include the timer; mutation rejected.
6. **F4 completed:** README states config false is not an independent kill switch;
   the runtime override control demonstrates it without editing committed config.
7. **F8 completed:** document infinite-timeout one-writer trade-off, absent watchdog,
   blocked future wakes and operator quiescence/reconciliation action.
8. **F7 completed:** document the verifier's unit-cache marker mtime side effect.
9. **SHU-250 baseline completed:** identify non-root 752/6 versus root 758/0.
10. **Deferred integration completed in repository:** actual merged supervisor APIs
    supply recovery-before-readiness, authenticated local IPC tests, admission and
    queued-launch shutdown, worker preservation/explicit termination, process identity
    probing and authoritative durable inventory. Requires + After and Type=notify
    make the intended startup dependency explicit.

No required repository item remains incomplete. Host installation, credential
provisioning, service-manager activation, live crash/restart and running-system
kill-switch/rollback proof remain excluded because they require the expressly
forbidden host operations. Stale sockets after unclean crashes fail closed and
require documented operator inspection. No live-system acceptance is claimed.
No push, PR creation/comment, deployed checkout, coordinator/SHU-140 branch,
config.json gate change, production contact, or /srv access was performed.
Systemd syntax verification has the documented /run cache-marker side effect.

## Every new test (exact names)

1. `SHU251 canonical writer lock accepted and foreign parameter refused`
2. `SHU251 mutation: rendered foreign writer lock`
3. `SHU251 nonexistent destination has named refusal`
4. `SHU251 mutation: unresolved timer placeholder`
5. `SHU251 mutation: enabled tick trips real kill-switch harness`
6. `SHU251 mutation: supervisor dependency removed`
7. `SHU251 mutation: supervisor readiness bypassed`
8. `SHU251 required CI runs both globs with service prerequisites`
9. `SHU251 documentation scopes gates, timeout, verifier side effect and non-root baseline`
10. `SHU251 runtime override trips harness even with committed config gate false`
11. `SHU251 recovery precedes readiness and authenticated status is available`
12. `SHU251 mutation: recovery omitted before readiness`
13. `SHU251 routine shutdown preserves workers and refuses further admission`
14. `SHU251 terminating shutdown records HOLD and terminates owned child`
15. `SHU251 disabled startup neither resumes queued work nor admits submissions`
16. `SHU251 readiness failure closes admission and socket`
17. `SHU251 authoritative inventory includes all durable trees and orphan files without writes`
18. `SHU251 mutation: durable inventory directory missing or symlinked`
19. `SHU251 concrete merged service argv renders valid units`
20. `SHU251 process identity probe distinguishes current and stale process tokens`
21. `SHU251 shutdown cancels queued launches before spawn`
22. `SHU251 occupied socket refuses startup before recovery`

## Mutation and negative-control AssertionErrors

Every entry below checks `error.name === "AssertionError"` (or its strict
assertion matcher equivalent) and the named message. Equality/deep-equality
assertions may append Node actual/expected diagnostics after this text.
These are executed controls, including the pre-existing service mutations;
synthetic write/state evidence is not claimed as a real positive write scenario.

| Mutation / negative control | Named AssertionError text |
| --- | --- |
| supervisor restart removed | `SHU251_RESTART: supervisor must restart on failure` |
| writer restart removed | `SHU251_RESTART: writer must restart on failure` |
| worker preservation removed | `SHU251_CHILDREN: routine restart must preserve workers` |
| writer lock bypassed | `SHU251_WRITER: tick must hold the common flock` |
| timer misdirected | `SHU251_WAKE: timer must target the single writer` |
| dispatch gate enabled | `SHU251_GATE: staged dispatch must be off` |
| unexpected adapter call | `SHU251_ZERO_LAUNCH: disabled tick must make zero adapter calls` |
| remote mutation (synthetic evidence) | `SHU251_ZERO_WRITE: disabled tick must make zero remote mutations` |
| durable state changed (synthetic evidence) | `SHU251_STATE_DIFF: disabled tick must preserve all fixture state` |
| rollback restore omitted (temporary source copy) | `SHU251_ROLLBACK: prior bytes, modes and absence must be restored` |
| foreign writer parameter / rendered foreign writer lock | `SHU251_WRITER_LOCK: writer lock must equal SHU_WORKSPACE_STATE_DIR/host-tick.lock` |
| nonexistent destination | `SHU251_DESTINATION: existing real temporary staging directory required` |
| unresolved timer placeholder | `SHU251_PARAMETER: unresolved template` |
| both fixture gates enabled / runtime override with config false | `SHU251_ZERO_LAUNCH: disabled tick must make zero adapter calls` |
| supervisor dependency removed | `SHU251_DEPENDENCY: coordinator must require supervisor` |
| supervisor readiness bypassed | `SHU251_READINESS: supervisor must notify after recovery and listen` |
| recovery omitted (temporary source copy) | `SHU251_RECOVERY: ambiguous launch must be held before readiness` |
| notifier failure injection | `SHU251_READINESS: injected notifier failure` |
| supervisor branch claim changed | `SHU251_STATE_DIFF: supervisor durable state must be unchanged` |
| durable launches directory removed | `SHU251_SUPERVISOR_STATE: missing durable launches directory` |
| durable launches directory symlinked | `SHU251_SUPERVISOR_STATE: only real directories and regular durable files allowed` |
| occupied socket startup | `SHU251_SUPERVISOR_SOCKET: occupied or stale socket requires operator inspection` |

## Every changed file and reason

- `.github/coordinator/SHU-250-VALIDATION.md` — Label the non-root measurement and explain the root result.
- `.github/coordinator/service/README.md` — Correct operational claims and document concrete lifecycle, inventory, and host-only limits.
- `.github/coordinator/service/SHU-251-VALIDATION.md` — Record correction coverage, exact new test names, and named negative controls.
- `.github/coordinator/service/install.mjs` — Convert a missing destination into SHU251_DESTINATION.
- `.github/coordinator/service/shu-coordinator.service.in` — Require supervisor readiness and supply canonical workspace/socket environment.
- `.github/coordinator/service/shu-supervisor.service.in` — Use notify readiness and provide supervisor state/socket environment.
- `.github/coordinator/service/supervisor-service.mjs` — Compose merged supervisor startup, readiness, shutdown and read-only durable-state enumeration.
- `.github/coordinator/service/test/service.test.mjs` — Add CI, lock, gate, timer, destination, dependency/readiness and documentation controls.
- `.github/coordinator/service/test/supervisor-service.test.mjs` — Test real local IPC lifecycle, recovery, shutdown, inventory and source/evidence mutations.
- `.github/coordinator/service/units.mjs` — Enforce lock equality, timer placeholder coverage and lifecycle policy; build concrete merged argv.
- `.github/coordinator/service/verify.mjs` — Allow enabled positive controls and explicit canonical workspace state parameters.
- `.github/workflows/ci.yml` — Check prerequisites before required and future-clock service verification.
- `package.json` — Include both coordinator and service globs in the standard coordinator test command.
