# A12 corrected inventory derivation

The restored fixtures at `d09f50d6c597ca1d27ea237f2fb342981816b993` remain byte-identical. This correction declares their dependencies; it does not rewrite them. `correction-name-comparison.json` compares the starting committed inventory with the corrected derivation, including multiplicities for every changed file and the whole inventory.

The original `successful-run.jsonl`, `successful-run-summary.json` and `outcome-files.jsonl` are retained historical capture inputs, not measurements of this correction. `derive-inventory.mjs` checks their ordered name equality and uses the provenance solely for file attribution. It derives 85 files from `git ls-tree -r --name-only HEAD` and the exported literal `SUITE_ROOTS` rule. A fresh committed-revision run and admission are recorded separately in `authoritative-run-summary.json` and `admission-proof.txt`; the measured and admitted revision is `280a24901f76d77ece93fe9cb1ffd95f44ce982f`. The evidence is recorded by a subsequent evidence-only commit, not measured at that carrier.

All 85 files were re-audited; source hashes, command/fixture candidates and dispositions are in `head-dependency-audit.json`. Requirements are conservative file execution unions, including selected mutation children, not assertions that each callback executes every member. The existing three Option A overrides remain intact. Only authorized identity proofs receive their byte-identical absence reasons.

The three restored files gain shell_toolchain: push-broker-gitconfig (19 names), workspace-result (15), codex-contract (59). The remaining 82-file audit also declares workspace-result-mutations (13 names, selected restored controls) and episode-successor-dispatch (22 names, literal node resolved on PATH). No test names change. The inventory has 1,744 names and requirements; expected_tests is computed from names.length. shell_toolchain has 291 occurrences; 983 rows have empty requirements. Other capability counts are unchanged; `derivation-output.json` records all counts.

## Dependency disposition

The earlier blanket claim that all incidental touch calls were removed was false after d09f50d. The retained removals are cp in durable-handoff/merge-readiness, cleanup chmod/rm in attempt-workspace, chmod/grep in shu241-scoped-build, and touch/true in service lock controls. Their existing assertions, expected values, names and mutation lists remain unchanged.

| Dependency | Actual disposition |
|---|---|
| touch / cat in push-broker-gitconfig and workspace-result | Restored shell fixtures stay; shell_toolchain declares them and probes their --version argv |
| env node in codex-contract | Restored #!/usr/bin/env node stays; shell_toolchain probes node resolution on the service child's PATH |
| literal node in episode-successor-dispatch | Same child-PATH requirement; now declared shell_toolchain |
| sh / dirname / chmod / mktemp / rm | Retained wrapper, production permission and policy dependencies; existing six probe calls preserved |

## Probe contract and controls

The shell probe uses nodeProbe → asService, with absolute process.execPath and fixed `--input-type=module -e` source. Every launched command has an absolute literal path and fixed argv:

- `/bin/sh ['-c','exit 0']`
- `/usr/bin/dirname ['/suite/wrapper']`
- `/usr/bin/env ['/usr/bin/true']`
- `/usr/bin/chmod`, `/usr/bin/mktemp`, `/usr/bin/rm`, `/usr/bin/touch`, `/usr/bin/cat`: each `['--version']`
- `/usr/bin/env ['node','--version']`

The last call intentionally resolves node on the inherited child PATH; it does not assert a particular node pathname. Version output, pathname computation and exit-only execution use no scratch or filesystem writes. Probe success establishes these exact availability/exit claims, not correctness of every shell operation. No capability is added and no detection claim is weakened.

Existing named probe controls now exercise touch, cat and env-node failures inside the existing test name. Fixed-argv controls allow exactly the two env forms. `prove-restored-dependencies.mjs` removes each added invocation, substitutes absolute node, changes version argv, weakens detection prose and removes each corrected shell requirement; every mutant must die by ERR_ASSERTION and its named control. `prove-inert-mutations.mjs` preserves the existing filesystem-side-effect mutations. Positive cases run before mutations.

## Scope

PERMITTED_SKIPS, all eight reasons, ci.yml, the operational wrapper, and the three restored test files are unchanged from d09f50d. No production behavior outside the capability probe/detection changes. No host access, push, PR, merge or external comment. Local probe identity evidence concerns only the repository workstation uid, not deployment authorization.

## Committed-revision verification

Derivation input revision, measured revision and admitted revision: `280a24901f76d77ece93fe9cb1ffd95f44ce982f`. The derivation was rerun on that clean committed input and reproduced the inventory without a diff. Original capture artifacts remain historical; these fresh figures come from the two full runs of this revision:

| Run | Outcomes | Pass | Fail | Skip | Complete markers | Exit |
|---|---:|---:|---:|---:|---:|---:|
| Plain | 1744 | 1736 | 0 | 8 | 1, terminal | 0 |
| +31536000000 ms | 1744 | 1736 | 0 | 8 | 1, terminal | 0 |

Both stderr streams were empty. Both name multisets and orders equal the committed inventory; names.length = requirements.length = expected_tests = 1744. All eight skip reasons match PERMITTED_SKIPS byte-for-byte. Admission and the requested SHU251_SUITE_INVENTORY, SHU251_PREFLIGHT_REQUIREMENTS, SHU251_SUITE_FILE_DIGEST and SHU251_SUITE_NAMES refusals passed. The 15 correction mutants and four preserved inertness mutants died by named assertions with positive controls passing. The env-node real positive returned v22.22.3 as uid 1000; empty PATH caused SHU251_PREFLIGHT_SHELL_TOOLCHAIN. See CORRECTION-REPORT.md and the retained raw captures/proofs for details.
