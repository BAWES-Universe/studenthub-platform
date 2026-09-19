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

## First real target installation: 2026-09-19

The following is measured evidence supplied by ai-orchestrator, not a live run by this code lane. Root ran the canonical checkout at `a3e40ca225a4515102d6fee4f9350e5334803831`:

```sh
node .github/coordinator/service/provision-shu71-prerequisites.mjs install a3e40ca225a4515102d6fee4f9350e5334803831
```

It exited 2 with `{"ok":false,"code":"ACT_PREREQUISITE_LOCK_OR_EXECUTION"}`. The inner error was `ACT_PREREQUISITE_ROLLBACK_REQUIRED` at line 303; the original cause had been discarded. The write-ahead receipt remained INSTALLING with only the identity effect, UID 100 / GID 107 and 13 account-file before-states. The group existed but the user did not. No tree, sudoers, wrapper or unit effects had run.

The reviewed command failed with rc 3:

```text
/usr/sbin/useradd --system --no-create-home --no-log-init -K CREATE_MAIL_SPOOL=no --uid 100 --gid 107 --home-dir /nonexistent --shell /usr/sbin/nologin shu71-evidence
configuration error - unknown item 'CREATE_MAIL_SPOOL' (notify administrator)
```

Removing only the rejected override succeeded on that same host (rc 0):

```text
/usr/sbin/useradd --system --no-create-home --no-log-init --uid 100 --gid 107 --home-dir /nonexistent --shell /usr/sbin/nologin shu71-evidence
shu71-evidence:x:100:107::/nonexistent:/usr/sbin/nologin
```

`useradd -D` reports `CREATE_MAIL_SPOOL=no`, supplied by the host's `/etc/login.defs`. `LOG_INIT=yes` is overridden by `--no-log-init`. The fix checks that the effective `useradd -D` output contains exactly one `CREATE_MAIL_SPOOL=no` before creating the group; a missing, duplicate or different default refuses with `ACT_PREREQUISITE_MAIL_SPOOL_DEFAULT`. No `-K` argument is passed. `--no-create-home` suppresses home creation, `--no-log-init` suppresses login-log initialization, and explicit `--home-dir /nonexistent`, `--shell /usr/sbin/nologin` and the allocated named private primary group retain the reviewed account properties. No allocation policy changes: SYS_* declarations are comments (101/999), explicit system IDs in the allocator's range are accepted. The host's automatic top-down allocations (measured UID 993 / GID 978) do not change the explicit allocator.

The old `/usr/bin/find / -uid 100 -o -gid 107` exited **1**, with only these process-fd races:

```text
/usr/bin/find: '/proc/<pid>/task/<pid>/fd/6': No such file or directory
/usr/bin/find: '/proc/<pid>/task/<pid>/fdinfo/6': No such file or directory
```

The corrected file scan prunes `/proc`, `/sys` and `/dev` before testing ownership, retaining traversal of every other mounted tree. It still requires exit zero and empty matches. The separate `/proc/*/status` scan still refuses any UID/GID/Groups use. It tolerates only ENOENT process disappearance; other process-read errors still refuse. Any real file ownership match or enumeration failure outside the pruned trees prevents identity deletion.

Install failure now reports its original code and successful rollback outcome together. If rollback also fails, the top-level code remains `ACT_PREREQUISITE_ROLLBACK_REQUIRED`, `original` carries the original structured refusal, and `rollback` carries `ok:false` and its code. The locked CLI child catches and prints that JSON and exits 2; failed recovery retains the write-ahead evidence. Configuration refusals identify `ACT_PREREQUISITE_USERADD_CONFIGURATION`, command, rejected argument (if supplied), and the measured stderr.

After the diagnostic experiment, **the account was removed and the receipt restored afterwards to its original absent state**. The host is currently clean: no `shu71-evidence` user or group, `/etc/shu/shu71-prerequisites.json`, `/usr/local/lib/shu71`, `/etc/sudoers.d/shu-reviewer`, or `shu71-evidence.service`. The deployment checkout is pinned to `a3e40ca`; both fixture refs exist. `/srv/shu/state/shu71-evidence` is root:root 0700 with its three unchanged episode directories. All three reviewed units are installed inactive with `ENABLE_DISPATCH=false`.

`provision-target-host-fixture.mjs` reproduces the shadow rc 3/stderr, commented ranges with accepted explicit IDs, and the unpruned find rc 1/stderr. The existing forward and rollback crash matrices now run on this shape. Named `TARGET_*` controls and `TARGET_KILL_*` mutants in `provision-target-host.test.mjs` mutate shipped source; a kill requires the corresponding named assertion, never an import or syntax failure. No existing assertion or refusal is removed or renamed. The old partial-installation mutant's source anchor is updated to the new catch signature while retaining its exact assertion.

### Final validation of the target-host correction

The tested implementation is `6a0cd80b22b4d194aeb0a592016405e30e402ff5`, tree `92eb74b850a1219d9423ffc16f20551068910949`. All four final commands began at that commit. The follow-up test commit makes the system-flag mutant target `useradd` specifically and uses adjacent positive IDs for ownership mutants, avoiding `find`'s special negative-number syntax. Production bytes remain those of `7a0a6c7`.

The unchanged namespace harness verifies UID 1000, umask 0022, and absent target accounts/runtime/reviewer sudoers for every run. The focused selection is the prior phase-readback/host-contract selection, including all `provision*.test.mjs`. Full commands use `taskset -c 0-3 node --test --test-concurrency=2` with both coordinator and service test globs. This limits concurrent pressure on the existing one-second controls; it changes no assertion. The nested inventory run inherits the CPU affinity. Plain clears NODE_OPTIONS and SHU_TEST_CLOCK_OFFSET_MS; clock sets the reviewed +31536000000 ms offset and preload. Exact commands and environment are in the validation metadata.

| Run | Tests | Pass | Fail | Skip | Terminal TAP / JSON markers |
| --- | ---: | ---: | ---: | ---: | ---: |
| Focused plain | 1210 | 1210 | 0 | 0 | 1 / 1 |
| Focused clock | 1210 | 1210 | 0 | 0 | 1 / 1 |
| Full plain | 3183 | 3175 | 0 | 8 | 1 / 1 |
| Full clock | 3183 | 3175 | 0 | 8 | 1 / 1 |

Every final command exits zero with no cancelled/todo outcomes. Focused TAP plans are `1..1210`; full plans are `1..3178`, with five nested outcomes. All four structured reports pass unchanged `evaluateSuite`; both full name lists match the committed inventory. The original provisioning matrices retain 296 forward and 92 rollback process-death injections, now against the target-shaped shadow/proc fixture. Each relevant run passes all 11 new controls and 21 named killing mutants.

Exact behavioral assertion names: `TARGET_ARGV`, `TARGET_PROPERTIES`, `TARGET_MAIL_DEFAULT`, `TARGET_CONFIGURATION`, `TARGET_FILE`, `TARGET_PROCESS`, `TARGET_PROC_RACE`, `TARGET_ENUMERATION`, `TARGET_RECOVERY`, `TARGET_IDENTITY_CRASH`, `TARGET_CLI`. The [complete named control and mutant manifest](test/fixtures/target-host-evidence/named-controls.json) also enumerates every mutation-applied and named-kill assertion.

The initial full run with default concurrency reported two failures: the inventory child reported SHU-249 A1 codex-cli/build, and the SHU-250 pre-spawn-marker mutant hit its one-second responsiveness check instead of its intended assertion. The isolated 43-test rerun passed. Final full runs use the constrained scheduling above. No production or existing assertion changes were made to address those timing-sensitive results. An in-progress retry was stopped when the new mutants were tightened; all four final runs were then restarted at the same test commit. The earlier provisioning discovery failure was solely the stale partial-installation mutant anchor, corrected with its name and assertion intact.

[Machine-readable validation](test/fixtures/target-host-evidence/validation.json) records counts, terminal markers, hashes, commands, exact names, the initial failures and scope. Compressed TAP, structured outcomes and harness constraints are retained beside it, including the initial failed full run and isolated timing controls. This completion note and evidence are added after validation; tested production, test and inventory bytes are unchanged.

Inventories are strictly additive: 112 to 113 test files and 3151 to 3183 names/requirements, with every prior row unchanged. PERMITTED_SKIPS is byte-identical to `a3e40ca`: **1093 bytes**, SHA-256 **03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e**; its entire source file is also unchanged. No fixed broker GID, numeric rendered identity, extra effect, or unrelated-file deletion was introduced. All prior findings and the joint evidence-root control remain covered by the passing full suites.

Remaining code or test inconsistencies: **none**. A fresh installation on the real target host has not been performed by this lane; the supplied measurements are reproduced by explicit doubles. Only `.github/coordinator/**` repository files changed. No push was performed.
