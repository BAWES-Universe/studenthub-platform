# A12 inventory derivation and inertness

This record supersedes the historical refusal at `d26db39`. The rejected capture remains retained as rejected evidence. Inventory names come only from this pass's `successful-run.jsonl`; the provenance run supplies only file attribution and must have the identical ordered names.

## Capture and derivation

```sh
node --test --test-reporter=./.github/coordinator/service/host-suite-contract.mjs .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs > /tmp/a12-inert-post-change.jsonl 2> /tmp/a12-inert-post-change.stderr
node --test --test-reporter=/tmp/a12-provenance-reporter.mjs .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs > /tmp/a12-provenance-run.jsonl 2> /tmp/a12-provenance-run.stderr
node .github/coordinator/service/a12-evidence/derive-inventory.mjs
```

Both runs exited 0 with **1,736 pass / 0 fail / 8 skip**, **1,744 outcomes**, **1,742 distinct names**, exactly one terminal `{"type":"complete"}`, and empty stderr. Node v22.22.3. The temporary provenance reporter delegates unchanged to the contract reporter and records event file/line metadata; its portable equivalent is `provenance-reporter.mjs`. `outcome-files.jsonl` stores checkout-relative file paths. The derivation asserts exact ordered name equality before using that attribution. No name is derived from a source regex or deduplicated.

The file derivation command is `git ls-tree -r --name-only HEAD`, filtered using imported `SUITE_ROOTS` with the literal filter/sort from `suite-runner-spec.mjs`. Executable derivation: `derive-inventory.mjs`; file output: `required-files.json`; count output: `derivation-output.json`. **files=85, names=1744, expected_tests=1744**. Duplicate names retained twice each: `activation fails closed when codex_sandbox_network is missing`, `activation fails closed when worker_identity_split is missing`.

`file-requirements.json` is the reviewed per-file mapping and call-site record; the full table is in `DEPENDENCY-AUDIT.md`. File-level execution unions include selected mutation subprocess dependencies. Pure Node files map to `[]`; the three previously reviewed Option A proofs keep their individual overrides. The seven optional identity proofs alone receive `privilege` and `worker_uid` with the exact existing permitted reason. The restricted-runtime skip needs no missing host capability. These are conservative file requirements, not claims of per-callback execution tracing.

## Dependency disposition and preserved assertions

The 85-file re-audit found no remaining incidental external chmod/rm/touch/grep/cp call. Source literals, mutation replacements, command doubles and shipped production commands are distinguished from actual fixture helpers.

| Removed convenience | Native implementation | Assertions retained |
|---|---|---|
| cp (earlier fix) | fs.cpSync in durable-handoff and merge-readiness | Existing named mutation assertions, positive cases and mutation lists unchanged |
| chmod / rm (earlier fix) | attempt-workspace worker-identity child Node fs.chmodSync/fs.rmSync; same switchCommand and worker identity | Ownership, metadata protection, recovery and real-adapter assertions unchanged |
| chmod (earlier fix) | shu241-scoped-build recursive owner-write via fs.chmodSync | Scoped-workspace, base transport and handoff assertions unchanged |
| grep (earlier fix) | shu241-scoped-build recursive Buffer matching | `assert.equal(grep.status, 1, sentinel bytes reached worker metadata…)`, expected 1, unchanged |
| touch (earlier fix) | service lock second writer uses fs.appendFileSync | SHU251_LOCK exclusion assertions unchanged |
| touch / cat (earlier fix) | push-broker-gitconfig marker appendFileSync and stdin.pipe(stdout); workspace-result marker scripts | Sentinel nonexistence, clean-filter pass-through and publication assertions unchanged; failing marker still exits 1 |
| env node (this pass) | codex-contract fixture shebang pins process.execPath | Real orphan-process lifecycle assertions unchanged |
| /usr/bin/true (this pass) | service lock-release executes process.execPath -e '' | `SHU251_LOCK_RELEASE: writer exit must release the lock`, expected status 0, unchanged |

Git and its local transports, shipped Bash policy/wrappers, production chmod, policy mktemp/rm, systemd-analyze verification, flock, optional distinct identity commands, parser execution, procfs and Unix sockets retain the dispositions in the audit. Fixture network and privileged command doubles are not evidence for installed host capabilities. Generated shell wrapper fixtures that actually execute remain covered by shell_toolchain; source-only shell bytes create no requirement.

## Capability entries and inertness

No vocabulary entry was added relative to `1fe68f8`; the predecessor's three entries were repaired without deleting their tests. There is **one grouped shell entry**, not separate entries for each executable. Removing inherited probe tests or their named refusal cases to reduce the vocabulary would discard existing coverage. `/bin/sh` and `dirname` in the shipped operational wrapper remain unchanged. No production wrapper edit was made or is needed.

All three probes use `nodeProbe` → `asService`, absolute process.execPath, fixed `--input-type=module -e` source, and absolute child paths with literal argv. No source interpolation, shell path interpolation, scratch allocation, filesystem creation/write/removal, or watched-root access is used. Existing infrastructure temporary probes retain their documented behavior and five-directory fixture count.

| Entry | Inert detection | Named refusal |
|---|---|---|
| shell_toolchain | /bin/sh -c 'exit 0'; /usr/bin/dirname /suite/wrapper; /usr/bin/env /usr/bin/true; /usr/bin/chmod, mktemp, rm each with --version | SHU251_PREFLIGHT_SHELL_TOOLCHAIN |
| linux_proc | Read nonempty /proc/self/stat, cmdline, environ; open /proc/version read-only and compare through /proc/self/fd/N; close descriptor | SHU251_PREFLIGHT_LINUX_PROC |
| loopback_socket | Bind and close 127.0.0.1 ephemeral TCP socket; no Unix-socket pathname | SHU251_PREFLIGHT_LOOPBACK_SOCKET |

Version/exit checks establish executable availability, not correctness of every operation. The inherited env/true positive and fault controls remain preserved even though the two incidental fixtures now use Node. The TCP capability is exercised by its preserved real positive control; reviewer tests otherwise inject their TCP listener. No new capability is inferred solely from an unused default import.

Before: **1,732 pass / 4 fail / 8 skip**, 1,744 outcomes. After: **1,736 pass / 0 fail / 8 skip**, 1,744 outcomes. Name multisets are identical. Focused lifecycle/probe suites: **134 pass / 0 fail / 0 skip** (`inertness.tap`). All four original failures pass:

- J1 prerequisite scratch permits a clean gate-off receipt
- J1 prerequisite scratch preserves all 18 H1 interleavings
- PROVIDER named mutation J1 scratch restored to watched root
- CLOSURE split ownership and fresh service readiness require no acceptance worker

The original scratch-count assertions are unchanged. Probe controls disable filesystem mutation APIs and permit only fixed child argv before running real probe bodies. `prove-inert-mutations.mjs` restores directory creation, file writes, removal, and mutating child argv separately: each is killed by `A12_DEPENDENCY_PROBE: shell_toolchain positive` / ERR_ASSERTION; positive passes (`inert-mutation-proof.txt`). These controls cover the implemented APIs and child-command boundary, not every possible future JavaScript side-effect mechanism.

The seven preserved probe mutations also pass: bypass shell_toolchain/linux_proc/loopback_socket → `A12_DEPENDENCY_FAILURE`; ignore tool exit/spawn error or proc content/descriptor mismatch → `A12_DEPENDENCY_GUARD`. Existing inventory/name/digest/requirements mutation suites remain in the full capture. No production admission guard was relaxed or newly introduced.

## Requirement counts

Counts are name occurrences, including duplicates; a name may require more than one capability.

| Capability | Occurrences |
|---|---:|
| privilege | 7 |
| worker_uid | 7 |
| cvtsudoers | 135 |
| systemd_analyze | 60 |
| flock | 64 |
| git | 337 |
| bash | 129 |
| shell_toolchain | 163 |
| linux_proc | 410 |
| loopback_socket | 28 |
| unix_socket | 50 |

1005 rows have an explicit empty capability list. Other vocabulary entries have zero mapped occurrences and remain existing infrastructure preconditions.

## Scope and preservation

This inventory binds required files, captured names with multiplicities, and reviewed dependency declarations. It does not prove deployment, systemd activation, host service authorization, arbitrary sudo worker commands, namespace isolation, ACL enforcement, remote credentials, CI, a settled upstream revision, an independent verdict, or universal filesystem/socket semantics. Passing absence controls are not proof that an optional identity operation ran.

PERMITTED_SKIPS is byte-identical to starting revision 1fe68f8, all eight entries retained. No new skip was introduced. `.github/workflows/ci.yml`, operational wrapper and all production behavior outside the declared capability probes are unchanged. No host window, network publication, push, PR, merge or external comment occurred.

Admission, explicit named refusals and authoritative repeat-run evidence are recorded in `admission-proof.txt` and `authoritative-run-summary.json` when completed. `prove-inventory.mjs` uses real committed Git objects for admission and a disposable local clone for hidden byte tampering; inventory-content faults use an explicit test-only Git boundary. It does not run preflight host/lifecycle commands.
