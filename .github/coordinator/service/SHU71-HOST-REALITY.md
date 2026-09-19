# SHU71 host reality correction

Base: 3761fc4ed83429d56a43592b125fa52564b94cc0. Repository-only model verification; no target access or live installation.

`provision-host-reality.test.mjs` loads a byte-identical retained copy of the merged entrypoint (also usable in shallow clones) and reproduces the five reported failures with a filesystem-backed, NSS-model boundary. Before the fix, its four initial controls reported 1 pass / 3 fail: the historical refusal assertion passed, while the desired allocation, green gate and CLI exit-zero controls failed.

The new prepared model uses the existing provisioning installer and fixture Git object map, actual filesystem symlinks, a relative `/usr/bin/env -> ../lib/cargo/bin/coreutils/env`, 999:982 0700 state directories, the three pre-existing units and both fixture refs. It omits arm-time outputs and runtime sockets. This is a repository host model, not proof of target kernel/systemd behavior. The production launcher uses `/usr/bin/env` through flock to clear the launch environment.

System range resolution follows shadow login.defs defaults: SYS_UID_MIN and SYS_GID_MIN default to 100; system maxima default to their regular minima minus one (regular minima default to 1000). Declarations are parsed before fallback, rejecting duplicates, malformed numbers, reversed/overlapping ranges and overflow. Occupied IDs, 996, messagebus and collision checks remain intact.

Executable symlinks are admitted only for the measured env path and exact target. Both link and target must be root-owned; all target ancestors must be root-controlled directories without symlinks or group/world write. The target retains the existing regular-file, single-link, 0755, nonempty requirements. Other executable symlinks remain refused.

State custody requires root ownership through /srv/shu and the resolved coordinator UID/GID with 0700 on every state directory. No symlinks or group/world writes are admitted. Existing fixtures now model these custody facts; the service-identity variation updates every state ancestor too, preserving its original assertion.

Absent gate directories/drop-ins carry `window: DEFERRED_UNTIL_ARM`; existing ones retain all previous exact custody/content checks. Activation state must still be absent, with its original refusal code if present, and now carries the same deferred token. The three units remain hard prerequisites with unchanged binding assertions. Runtime deferrals retain their exact token and static prerequisite dependency.

Named assertions and killing mutants are executable in the new test file: HOST_RANGE_DEFAULT, HOST_MAX_DEFAULT, HOST_DUPLICATE, HOST_MALFORMED, HOST_OCCUPIED_UID; HOST_ENV_SYMLINK/FOREIGN_TARGET/FOREIGN_OWNER/WRITABLE; HOST_STATE_ROOT_ONLY/SYMLINK and HOST_NO_WORLD_WRITE; HOST_WINDOW_HARD_REQUIREMENT and HOST_ACTIVATION_HARD_REQUIREMENT; HOST_GREEN_ALWAYS_REFUSE. HOST_GREEN asserts the exact five arm-time deferred rows and the two service-start deferred rows, plus read-only behavior; HOST_CLI_GREEN proves exit zero. Additional negative controls cover every state directory, root ancestors, executable link ownership and parent writes, malformed ranges, activation presence and missing hard units. The historical regression remains executable against the immutable base source.

Inventories are additive. D1, named broker/shared-group bindings, runtime schema and PERMITTED_SKIPS are unchanged.

Validation commands use the existing `service/test/fixture/shu71-ci-like.sh` namespace harness. It asserts UID 1000, umask 0022, target accounts absent, runtime absent and reviewer sudoers absent. Focused selection:

```sh
node --test .github/coordinator/service/test/provision*.test.mjs .github/coordinator/service/test/shu71-owner-decisions.test.mjs .github/coordinator/service/test/shu71-production.test.mjs .github/coordinator/service/test/shu71-trust*.test.mjs
```

Full selection is `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`, with TAP and the unchanged `host-suite-contract.mjs` reporter writing separate outputs. Runs are sequential. Plain unsets NODE_OPTIONS and SHU_TEST_CLOCK_OFFSET_MS; clock sets `SHU_TEST_CLOCK_OFFSET_MS=31536000000` and `NODE_OPTIONS=--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs`.

The complete-tree CLI green control intercepts only repository reads to serve actual `git ls-tree` modes and `git cat-file` bytes for all tracked coordinator production files; it still runs the reviewed installer, verifier and CLI gate against the filesystem-backed host model. Git/NSS/process execution remain explicit test boundaries.

PERMITTED_SKIPS (including trailing newline): 1,093 bytes; SHA-256 `03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`. Direct byte comparison against 3761fc4 passes, as does byte comparison of its entire source file. The inventory grows from 109 files / 2,991 names and requirements to 110 files / 3,040 names and requirements; every prior row remains present unchanged.

| Host finding | Pre-fix assertion | Corrected assertion(s) | Named killing mutant(s) |
| --- | --- | --- | --- |
| Missing SYS declarations | `HOST_RANGE_PRE_FIX`: ACT_IDENTITY_SYSTEM_RANGE on well-formed regular ranges | `HOST_RANGE_DEFAULT`, `HOST_RANGE_BOUNDARIES_OCCUPANCY`, range malformed/refusal controls | `HOST_KILL_RANGE_DEFAULT`, `HOST_KILL_MAX_DEFAULT`, `HOST_KILL_DUPLICATE`, `HOST_KILL_MALFORMED`, `HOST_KILL_OCCUPIED_UID` |
| Trusted env symlink | `HOST_PRE_FIX_/usr/bin/env`: row refused | `HOST_GREEN`, `HOST_ENV_FOREIGN_TARGET`, `HOST_ENV_FOREIGN_OWNER`, `HOST_ENV_LINK_OWNER`, `HOST_ENV_WRITABLE`, `HOST_ENV_PARENT_WRITABLE` | `HOST_KILL_ENV_SYMLINK`, `HOST_KILL_ENV_FOREIGN_TARGET`, `HOST_KILL_ENV_FOREIGN_OWNER`, `HOST_KILL_ENV_WRITABLE` |
| Service-owned state ancestry | `HOST_PRE_FIX_` assertions for evidence/workspaces/supervisor: rows refused | `HOST_GREEN`, every `HOST_STATE_OWNER_`, `HOST_STATE_WRITE_`, `HOST_STATE_LINK_`, `HOST_ROOT_ANCESTOR` | `HOST_KILL_STATE_ROOT_ONLY`, `HOST_KILL_STATE_SYMLINK`, `HOST_KILL_NO_WORLD_WRITE` |
| Window artifacts absent | `HOST_PRE_FIX_` assertions for both drop-in directories, both drop-ins and activation path: rows refused | `HOST_WINDOW_DEFERRED`, `HOST_RUNTIME_DEFERRED`, `HOST_ACTIVATION_PRESENT`, three `HOST_HARD_UNIT_` assertions | `HOST_KILL_WINDOW_HARD_REQUIREMENT`, `HOST_KILL_ACTIVATION_HARD_REQUIREMENT` |
| Prepared gate cannot turn green | `HOST_GREEN_PRE_FIX`: ok:false | `HOST_GREEN`, `HOST_READ_ONLY`, `HOST_CLI_GREEN` (complete production tree, exit 0) | `HOST_KILL_GREEN_ALWAYS_REFUSE` |

Initial full validation detected two stale documentation line anchors via `V8_DOCUMENTATION_LINK_TARGETS`; its recursive inventory child failed for the same assertion. The two links were corrected without changing the assertion. That initial run reported 3,040 tests / 3,030 pass / 2 fail / 8 skip. Final results below supersede it.

Final validation of implementation commit `ddb53c2`:

| Run | Tests | Pass | Fail | Skip | Terminal TAP markers |
| --- | ---: | ---: | ---: | ---: | ---: |
| Focused plain | 1056 | 1056 | 0 | 0 | 1 |
| Focused clock | 1056 | 1056 | 0 | 0 | 1 |
| Full plain | 3040 | 3032 | 0 | 8 | 1 |
| Full clock | 3040 | 3032 | 0 | 8 | 1 |

Both full reports also contain exactly one terminal JSON `complete` event and pass the unchanged `evaluateSuite` validator, including exact permitted skip names/reasons. The full TAP plans are `1..3035`; five nested test outcomes bring each total to 3040. Focused plans are `1..1056`. All four commands exited zero under the CI-like harness. All 49 new tests, including the 15 named killing mutants, pass in each relevant run.

[Machine-readable validation and hashes](test/fixtures/host-reality-evidence/validation.json) records the tested revision/tree, constraints, counts, terminal markers, additive inventory proof and byte-identity hashes. Compressed TAP and full reporter outcomes are retained alongside it. The final commit adds only documentation and this validation evidence after the tested implementation.

No target-host access, provisioning, service start, mint, push, PR, merge, GitHub or Linear actions were performed. Real target filesystem/NSS facts and live systemd/kernel behavior cannot be independently closed under the repository-only constraint; the given facts are reproduced in explicit host models. No repository test failure remains open.
