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
