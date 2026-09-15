# SHU-251 correction validation

Earlier correction measurements below are historical; the host-acceptance
correction and current-main measurements are recorded first.


## Host-acceptance correction — 2026-09-14

Clone: `/home/bawes/work/shu251units`; branch:
`fix/shu251-service-user-and-secret`. Clean starting HEAD and local current main
both resolved to `0bb9b7b1c25dbe9aa2d2263fd262673a70bc4c2b`.

The coordinator-reported approved host window **failed startup**. With no
`User=`/`Group=`, systemd ran the supervisor as root against the canonical
`/srv/shu/state/workspaces` owned by shu-coordinator, mode 0700. It refused with
`AssertionError: SHU251_SUPERVISOR_PATH: private owned socket parent required`.
An ownership-bypassed diagnostic attempt then refused with
`Error: supervisor secret must be at least 32 bytes`. This is a reported host
finding, not a host operation performed or reproduced in this correction.

Both service templates now render `User=` and `Group=` from `serviceUser` and
`serviceGroup`, defaulting to shu-coordinator and the selected user respectively.
The existing socket-parent assertion is unchanged. Policy checks require exactly
one matching identity directive on each service and reject root configuration.

The templates require separate external `EnvironmentFile=` bindings:
`supervisorEnvironmentFile` defaults to `/etc/shu/supervisor.env` (root:root 0600,
only `SHU_SUPERVISOR_SECRET`); `coordinatorEnvironmentFile` defaults to
`/srv/shu/service.env` (as provisioned, GitHub / Linear credentials). Rendering
and policy validation inspect existing files without emitting values: missing,
identical, crossed or incomplete bindings fail by named assertions. Neither
reference is optional, and no secret value is embedded in a unit.

Systemd loads each file only into its corresponding process. The supervisor entry point passes
`process.env.SHU_SUPERVISOR_SECRET` to `startSupervisor`, then `DurableSupervisor`.
The new service assertion requires a string/Buffer containing at least 32 bytes
before durable state, recovery, socket creation or readiness. Existing
`supervisor.mjs` validation still converts strings with `Buffer.from(secret ?? "")`
and checks 32 bytes; HMAC-SHA256 uses those bytes without trimming/hex decoding.
The coordinator signer reads `env.SHU_SUPERVISOR_SECRET` in
`supervisor-dispatch.mjs`; the separate coordinator credential file does not
supply that transport secret. Its delivery remains outside this renderer and
requires the separately reviewed transport provisioning. A missing environment file is a systemd startup failure;
a missing/short variable gets the named service AssertionError below.

Both full measurements ran from the repo root under `umask 0002` after
`chmod -R go-w .github/coordinator`, using both globs:

```sh
node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
```

| Measurement | Tests | Passed | Failed | Skipped | Suites |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current main / before host-acceptance fix | 851 | 844 | 0 | 7 | 0 |
| After host-acceptance fix | 862 | 855 | 0 | 7 | 0 |

All prior tests are retained. Service tests increased from 49 to 60, all passing.
Seven full-suite skips are unchanged: six require distinct-UID execution and one
has no undeclared runtime/role pair in the production vocabulary. No root run was
performed. The standalone `service/verify.mjs` also passed syntax, exact rollback,
and two disabled ticks with zero launches, zero writes and empty state diff.
`git diff --check` passed.

### Every new test (exact names)

1. `SHU251 configured identity and external secret file survive staging`
2. `SHU251 mutation: shu-supervisor.service User removed`
3. `SHU251 mutation: shu-supervisor.service Group removed`
4. `SHU251 mutation: shu-supervisor.service secret file removed or optional`
5. `SHU251 mutation: shu-coordinator.service User removed`
6. `SHU251 mutation: shu-coordinator.service Group removed`
7. `SHU251 mutation: shu-coordinator.service secret file removed or optional`
8. `SHU251 mutation: embedded secret in any unit refused`
9. `SHU251 unsafe identity and secret file parameters fail before staging`
10. `SHU251 mutation: missing or short secret refuses startup before state and readiness`
11. `SHU251 service entry point fails closed when secret environment is missing`

### New mutation and negative-control AssertionErrors

Each mutation checks AssertionError identity and the following named text.
Deep equality assertions may append Node actual/expected diagnostics.

| Mutation / negative control | Named AssertionError text |
| --- | --- |
| supervisor User removed | `SHU251_IDENTITY: shu-supervisor.service must run with configured User` |
| supervisor Group removed | `SHU251_IDENTITY: shu-supervisor.service must run with configured Group` |
| coordinator User removed | `SHU251_IDENTITY: shu-coordinator.service must run with configured User` |
| coordinator Group removed | `SHU251_IDENTITY: shu-coordinator.service must run with configured Group` |
| secret file removed or made optional, either service | `SHU251_SECRET_FILE: services must require the shared secret environment file` |
| secret literal added, any of the three units | `SHU251_SECRET_LITERAL: units must not embed supervisor secrets` |
| invalid/root identity parameter | `SHU251_IDENTITY: non-root service user and group names required` |
| invalid secret file parameter | `SHU251_SECRET_FILE: plain absolute environment file path required` |
| missing/short secret, including missing environment in real entry point | `SHU251_SUPERVISOR_SECRET: SHU_SUPERVISOR_SECRET must contain at least 32 bytes` |

All changes are within `.github/coordinator/service`: units, renderer, lifecycle
entry point, tests and documentation. No assertion was weakened; config.json and
production code outside the service plane were untouched. No push, PR interaction,
host service action or /srv access occurred. No repository defect remains unfixed.
Actual host provisioning, account/ownership verification and systemd startup
acceptance remain for the later coordinator-controlled host window. Local syntax
verification carries the already documented /run cache-marker side effect.
The delivery response records the commit SHA and exact diff stat against base.

## Historical focused correction

Focused-fix base HEAD was verified as `aa9892f9c0fd661aefc8b17888c68b88455f8b47` before edits,
on `feat/shu-251-host-service-plane`, in `/home/bawes/work/shu251`, with a clean tree.
The final commit SHA and exact base-to-commit diff stat accompany this report in
the delivery response (a commit cannot embed its own hash).

Both focused-fix measurements ran from the repository root with `umask 0002`,
following `chmod -R go-w .github/coordinator`:

```sh
node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
```

| Measurement | Tests | Passed | Failed | Skipped | Suites |
| --- | ---: | ---: | ---: | ---: | ---: |
| Delivered head aa9892f9 / before focused fix | 803 | 797 | 0 | 6 | 0 |
| After focused fix | 807 | 801 | 0 | 6 | 0 |

The table records a **non-root** run (801 pass / 6 skipped at final).
The equivalent root run would be 807 pass / 0 skipped; the six tests require root.
Root execution was not performed in this round.

All 803 prior tests are retained. The service suite grows from 45 to 49 tests in
this round (18 before the earlier corrections): 27 earlier additions plus four
focused-fix additions, all passing. `git diff --check` passes. Required GitHub CI
itself was not remotely run: pushing and PR interaction are prohibited.

## Focused verification gaps

- **G-1 closed:** readiness requires `ok === true`, a string server `version`, and
  HOLD. Moving notification before listen in a temporary source copy fails the
  named success assertion rather than accepting a connection-failure HOLD.
- **G-2 closed:** the workspace constant is pinned to its literal deployed value
  and compared with the declaration parsed from `docs/SHU-63-activation-contract.md`.
  A temporary source mutant repointing it to `/tmp/elsewhere` fails the literal pin.
- **G-3 closed:** counts reflect the delivered 803-test head and this fix; the five
  earlier F3 tests are listed below, with the non-root qualification above.
- **G-5 closed:** both service test files apply a default 10-second per-test timeout
  (the existing flock test retains its 5-second bound). Lifecycle tests register
  service cleanup before subsequent assertions so failures release listening sockets.
  A separate temporary coordinator copy with recovery removed exited 1 in 305 ms
  (13 tests: 9 pass, 4 fail, 0 cancelled), including the named SHU251_RECOVERY
  AssertionError; a 30-second outer guard did not fire.
- **G-6 closed:** render derives default paths only after workspace validation;
  serviceParameters validates before joining. Null, numeric and coercible object
  inputs receive named refusals, without coercion or staging writes, even with override.

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

## Every new test since the original correction base (exact names)

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

23. `SHU251 deployed workspace state directory accepted by installer`
24. `SHU251 foreign workspace state directory refused before staging`
25. `SHU251 explicit workspace override stages a visible two-writer hazard`
26. `SHU251 mutation: matching foreign environment and writer lock`
27. `SHU251 mutation: explicit override warning removed`
28. `SHU251 mutation: notification before listen`
29. `SHU251 canonical workspace constant matches literal deployment and activation contract`
30. `SHU251 mutation: canonical workspace constant repointed`
31. `SHU251 non-string workspace state directory has named fail-closed refusal`

Tests 23–27 are the five F3 tests delivered at aa9892f9 that the prior report omitted.
Tests 28–31 are new in this round. The existing
`SHU251 recovery precedes readiness and authenticated status is available` test
now requires a genuine server response; its recovery-omission mutation shares
those assertions. All service tests gain a default timeout, and lifecycle tests
that retain a started service gain cleanup hooks.

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
| notification before listen (temporary source copy) | `SHU251_READINESS: authenticated status must succeed before notification` |
| canonical workspace constant repointed (temporary source copy) | `SHU251_WRITER_LOCK: WORKSPACE_STATE_DIR must equal literal deployed /srv/shu/state/workspaces` |
| non-string workspace state directory | `SHU251_WRITER_LOCK: canonical workspace state directory required` |

## Files changed in this focused round

- `service/units.mjs` — Validate workspace input before deriving paths.
- `service/test/service.test.mjs` — Pin deployment and contract, reject non-string inputs, add constant mutation and default timeout.
- `service/test/supervisor-service.test.mjs` — Require a real readiness response, add ordering mutation, timeout and failure cleanup.
- `service/SHU-251-VALIDATION.md` — Update counts, omitted F3 tests and focused-fix evidence.

Paths above are relative to `.github/coordinator`.

## Earlier correction files and reasons (historical)

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
