# A12 capture refused

The post-change capture at revision `d26db39e4bed664827633caf912950bbbff2e2ce` failed. No inventory was authored; admission, the authoritative inventory name check, inventory requirement counts and `expected_tests` are **not established**. The old capture was not used.

Command:

```sh
node --test --test-reporter=./.github/coordinator/service/host-suite-contract.mjs .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs > /tmp/a12-post-change-run.jsonl 2> /tmp/a12-post-change-run.stderr
```

Exit status **1**. **1744 outcomes**, **1742 distinct names**, **1732 pass / 4 fail / 8 skip**. Exactly one terminal `{"type":"complete"}` marker. Duplicate multiplicities are retained in `rejected-run.jsonl`; this rejected capture is not an inventory. Stderr was empty. The contract reporter records outcome names/statuses, not assertion diagnostics.

Exact failed outcome names:

- `J1 prerequisite scratch permits a clean gate-off receipt`
- `J1 prerequisite scratch preserves all 18 H1 interleavings`
- `PROVIDER named mutation J1 scratch restored to watched root`
- `CLOSURE split ownership and fresh service readiness require no acceptance worker`

Source inspection identifies a regression from the added temporary probes: production-fixture.mjs:124-137 models every generated scratch directory. The unchanged J1 assertions at production-lifecycle.test.mjs:139 and :159 require ten directories across two preflights (five each); three additional temporary probes now contribute to that count. The CLOSURE assertion at :534 similarly requires twenty across four preflights. The J1 mutation test requires its unchanged positive control to pass first. These are source-derived explanations, not captured assertion stacks. Per the explicit stop rule, no corrective rerun or assertion adjustment followed the failed capture.

Changes and preserved controls:

- Earlier fs.cpSync replacements retained in durable-handoff and merge-readiness.
- attempt-workspace: worker-identity cleanup/protection uses child Node fs.chmodSync/fs.rmSync; same identity, permission intent, assertions and mutation list.
- shu241-scoped-build: recursive chmod and byte sentinel search use Node; existing `grep.status === 1` assertion, expected value and diagnostic retained.
- service.test: rejected lock writer uses child Node appendFileSync; both SHU251_LOCK assertions and SHU251_LOCK_RELEASE unchanged.
- push-broker-gitconfig: marker scripts use Node appendFileSync, failure exit 1 retained; clean-filter passthrough uses stdin.pipe(stdout). Every existing assertion unchanged.
- workspace-result: filter and hook marker use Node appendFileSync; every existing assertion unchanged.
- capability-requirements: appended positive/refusal/fault controls and mutations; all prior tests and mutation lists retained. Focused run: 28 pass, zero failures/skips. All these controls also pass in the rejected full capture.

New entries (all probes run as service identity with absolute executable paths and fixed argv):

| Capability | Probe | Named refusal |
|---|---|---|
| shell_toolchain | private temporary Node probe executes /bin/sh -c 'exit 0', /usr/bin/dirname /suite/wrapper, /usr/bin/env /usr/bin/true, chmod 0750 mode, mktemp probe.XXXXXX, rm -f mode; each exit/error checked | SHU251_PREFLIGHT_SHELL_TOOLCHAIN |
| linux_proc | private temporary Node probe reads self stat/cmdline/environ and reads a file through /proc/self/fd | SHU251_PREFLIGHT_LINUX_PROC |
| loopback_socket | private temporary Node probe binds/closes 127.0.0.1 ephemeral TCP socket | SHU251_PREFLIGHT_LOOPBACK_SOCKET |

Seven added mutations passed their kill assertions: bypass each of the three capabilities dies by A12_DEPENDENCY_FAILURE; suppress subprocess exit/error rejection and suppress proc content/descriptor rejection die by A12_DEPENDENCY_GUARD. Positive cases pass. Each tool fault has a positive/failure control. This does not establish successful inventory admission or the requested full set of inventory refusal proofs; those subsequent steps were stopped.

PERMITTED_SKIPS is byte-identical to the starting revision, all eight entries retained. ci.yml is untouched. Existing assertion lines in every convenience-edited test were compared against the starting revision and remain identical. No new skip was introduced. The only production edit is the capability definitions/probes and semantic documentation; the full run exposes its scratch-count impact, so it is not claimed regression-free.

The dependency call-site audit and derived 85-file list are adjacent. The per-name requirement mapping, per-capability name counts, committed inventory admission, and authoritative second name check remain unfinished. CI, the settled revision and the independent verdict are the orchestrator's subsequent steps.
