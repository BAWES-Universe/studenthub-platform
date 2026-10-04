# SHU71 conditional approval: production artifact read-back

Base: `6e91a6c135311ffdaf129c10cd8c1d2a9455272f`. Repository-only boundary models; no target access or external mutations.

The production order is now activation write → `activation-readback` → both drop-in writes (`gate-install`) → `dropin-readback` → daemon-reload / supervisor restart / timer start (`gate`) → `ARMED`. Both read-back steps repeat after process replacement even if an earlier DONE row exists. Existing failure handling journals HALTED and invokes the reviewed cleanup.

Activation is compared byte-for-byte with `JSON.stringify(pkg.activation)` from the validated signed package, including its signature. It requires a regular single-link file, uid 0, gid 999 and exactly 0640. Each drop-in must match the exact written `[Service]\nEnvironment=ENABLE_DISPATCH=true\n` bytes, be a regular single-link root:root file with exactly 0644, and have a non-symlink root:root containing directory with exactly 0755. Descriptor reads use O_NOFOLLOW and O_NONBLOCK. Mode comparisons include special bits. Missing artifacts, different bytes, wrong custody, wrong modes and wrong directory custody produce named refusals; unexpected read failures also halt.

| Failure | Named HALT code suffix (under `ACT_ACTIVATION_READBACK_` or `ACT_DROPIN_READBACK_`) | Assertions and killing mutants |
| --- | --- | --- |
| Missing artifact | `MISSING` | `PHASE_REQUIRE_*_MISSING`, `PHASE_KILL_*_MISSING` |
| Different bytes, including equal-length corruption | `BYTES` | `PHASE_REQUIRE_*_BYTES`, `PHASE_KILL_*_BYTES` |
| Changed activation signature | `BYTES` | `PHASE_REQUIRE_ACTIVATION_SIGNATURE`, `PHASE_KILL_ACTIVATION_SIGNATURE` |
| Foreign uid/gid or symlink | `CUSTODY` | `PHASE_REQUIRE_*_UID/GID/SYMLINK`, corresponding `PHASE_KILL_*` |
| Widened, narrowed or special-bit mode | `MODE` | `PHASE_REQUIRE_*_WIDE_MODE/NARROW_MODE/SPECIAL_MODE`, corresponding `PHASE_KILL_*` |
| Drop-in directory uid/gid or widened/narrowed mode | `DIRECTORY` | `PHASE_REQUIRE_DROPIN_*_DIRECTORY_*`, corresponding `PHASE_KILL_*` |

`*` expands separately for DROPIN_COORDINATOR, DROPIN_SUPERVISOR and ACTIVATION in [the executable controls](test/shu71-phase-readback.test.mjs). Each refusal asserts its exact code, no restart/timer/ARMED, activation removal, worker kill, stopped services and fixture restoration. Activation refusals additionally assert no dispatch-gate installation. Directory damage that prevents safe gate teardown remains an explicit cleanup failure; other cleanup effects still execute.

Six `PHASE_PRE_FIX_*_MISSING/BYTES_ACCEPTED` controls load the SHA-256-pinned byte-identical production module from the base commit: both drop-ins and activation individually remain missing or mismatched while the old code reaches ARMED and restarts the supervisor. The corresponding new controls require HALT and teardown.

`PHASE_GREEN_ORDER_AND_EXACT_BYTES` proves both writes complete before drop-in measurement, activation measurement completes before either gate write, and measurement precedes reload/restart/timer and ARMED. `PHASE_KILL_ACTIVATION_LATE_ORDER` and `PHASE_KILL_DROPIN_LATE_ORDER` move measurement after restart and die specifically at `PHASE_*_BYTES_BEFORE_RESTART`. `PHASE_KILL_ACTIVATION_PAST_DISPATCH_GATE` moves activation measurement just past gate installation and dies at `PHASE_ACTIVATION_BYTES_BEFORE_DISPATCH_GATE`. Both `PHASE_REQUIRE_*_RESUME_REMEASURES` and `PHASE_KILL_*_RESUME_SKIP` exercise process replacement after the durable read-back DONE row followed by artifact corruption.

No pre-mint verifier or provisioning behavior changes. System range defaults, collision refusal and system-account creation, env symlink-chain custody, state ancestry, D1, named broker/shared-group rules, DEFERRED_UNTIL_ARM and DEFERRED_UNTIL_SERVICE_START, and the green-gate control remain intact. Inventories add only the new test file and its 81 names/requirements. The composition test retains its original 132-operation expected value, separately requiring the exact six added journal rows before accounting for them. Existing documentation changes only repair line anchors shifted by this addition. PERMITTED_SKIPS and its entire source file remain byte-identical to the base.

Validation uses `test/fixture/shu71-ci-like.sh`: UID 1000, umask 0022, target accounts absent, runtime absent, reviewer sudoers absent. Focused selection extends the previous lane selection with the new controls and existing production mutants:

```sh
node --test .github/coordinator/service/test/provision*.test.mjs .github/coordinator/service/test/shu71-owner-decisions.test.mjs .github/coordinator/service/test/shu71-production*.test.mjs .github/coordinator/service/test/shu71-phase-readback.test.mjs .github/coordinator/service/test/shu71-trust*.test.mjs
```

Full selection: `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`. Plain unsets NODE_OPTIONS and SHU_TEST_CLOCK_OFFSET_MS. Clock sets `SHU_TEST_CLOCK_OFFSET_MS=31536000000` and `NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`. The checkout is normalized with `chmod -R go-w .github/coordinator` before running. Runs are sequential, with TAP plus the unchanged host-suite-contract reporter for full runs. A detached local snapshot permits the existing committed-inventory guard to validate all new rows before the final branch commit; it does not change the lane branch.

The first full run exposed two composition failures from the six additive journal writes, two mutation-anchor collisions, ten wrapper/custody failures from the detached checkout's group-writable source modes, and the recursive inventory failure. It recorded 3,116 tests / 3,093 pass / 15 fail / 8 skip; the early composition failures prevented five nested outcomes. The ensuing clock attempt was interrupted to fix those causes. The 142-test correction run passed with zero failures/skips. No earlier expected value, refusal code, assertion requirement or skip allowance was relaxed.

Final results for the corrected implementation snapshot:

| Run | Tests | Pass | Fail | Skip | Terminal TAP markers |
| --- | ---: | ---: | ---: | ---: | ---: |
| Focused plain | 1148 | 1148 | 0 | 0 | 1 |
| Focused clock | 1148 | 1148 | 0 | 0 | 1 |
| Full plain | 3121 | 3113 | 0 | 8 | 1 |
| Full clock | 3121 | 3113 | 0 | 8 | 1 |

All runs exited zero; cancelled/todo counts are zero. The full TAP plans are `1..3116` with five nested outcomes; focused plans are `1..1148`. Both full JSON reporters have exactly one terminal `complete` event and pass the unchanged `evaluateSuite` validator. The 81 added tests include six pre-fix acceptance witnesses, 35 corrected refusal/resume controls, 38 named killing mutants, a green ordering/byte control and the historical source hash pin.

[Machine-readable evidence](test/fixtures/phase-readback-evidence/validation.json) records snapshot revision/tree, exact counts, names, constraints and hashes. Compressed TAP and JSON outcome transcripts accompany it, including the initial failure and correction controls. The final branch commit adds only this completion documentation and evidence beyond the tested snapshot; production/test/inventory bytes match that snapshot.

PERMITTED_SKIPS remains byte-identical to `6e91a6c135311ffdaf129c10cd8c1d2a9455272f`: 1,093 bytes including the trailing newline, SHA-256 `03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`. Its entire source file is also identical. All three inventories preserve every prior row and add one file; the suite inventory grows from 3,040 to 3,121 names/requirements.
