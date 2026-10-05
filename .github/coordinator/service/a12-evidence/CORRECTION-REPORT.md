> Historical evidence for the pre-merge 85-file inventory. See DERIVATION.md for the current 98-file verification procedure; these old measurements do not attest the current head.

# A12 BLOCK correction report

Implementation and measured/admitted revision: `280a24901f76d77ece93fe9cb1ffd95f44ce982f`. Starting revision: `d09f50d6c597ca1d27ea237f2fb342981816b993`. The later evidence-only commit records these measurements; it is not their source revision. No full-suite figures below are claimed as new measurements of d09f50d or 52e5f01.

## Requirements and names

| File (coordinator/test) | Before | After | Before/after names | Multiset / order equal |
|---|---|---|---:|---|
| push-broker-gitconfig.test.mjs | git | git, shell_toolchain | 19 / 19 | true / true |
| workspace-result.test.mjs | git, linux_proc | git, linux_proc, shell_toolchain | 15 / 15 | true / true |
| codex-contract.test.mjs | linux_proc | linux_proc, shell_toolchain | 59 / 59 | true / true |
| workspace-result-mutations.test.mjs | git, linux_proc | git, linux_proc, shell_toolchain | 13 / 13 | true / true |
| episode-successor-dispatch.test.mjs | [] | shell_toolchain | 22 / 22 | true / true |
| Whole inventory | — | — | 1744 / 1744 | true / true |

All remaining 82 files were audited, not assumed unchanged. The two additional corrections cover selected restored filter/hook mutation children and literal node resolved on PATH. Other requirements stay unchanged. Bash execution remains declared as bash. Source-only shebangs, injected boundaries and inactive mutation source literals are distinguished from executed fixtures. The 85 source hashes and command candidates are retained in `head-dependency-audit.json`; all hashes were checked against 280a249. `correction-name-comparison.json` records the actual pre/post comparisons using retained file provenance. All inventory fields except requirements are identical. Exactly 128 requirement rows append shell_toolchain, including the 93 named in the verdict. shell_toolchain occurrences increase 163 → 291; empty lists decrease 1005 → 983. No names, expected values, assertions or mutation lists were removed, weakened or renamed.

## Probe and detection

The detection string now states fixed argv as the service identity and explicitly includes touch, cat and child-PATH node resolution. The existing six invocations are preserved; three are added:

| Absolute executable | Fixed argv | Change / filesystem effect |
|---|---|---|
| /bin/sh | ['-c','exit 0'] | Existing; exit-only shell builtin |
| /usr/bin/dirname | ['/suite/wrapper'] | Existing; computes a pathname |
| /usr/bin/env | ['/usr/bin/true'] | Existing; executes exit-only command |
| /usr/bin/chmod | ['--version'] | Existing; version output only |
| /usr/bin/mktemp | ['--version'] | Existing; version output only, no scratch allocation |
| /usr/bin/rm | ['--version'] | Existing; version output only, no removal |
| /usr/bin/touch | ['--version'] | Added; version output only, no creation/timestamp change |
| /usr/bin/cat | ['--version'] | Added; version output only, no file/stdin processing |
| /usr/bin/env | ['node','--version'] | Added; resolves node on child PATH and outputs its version |

All go through nodeProbe → asService with absolute process.execPath and fixed module argv/source. Real execution under local fixture service uid 1000 returned status 0 for all nine calls. `/usr/bin/env ['node','--version']` returned `v22.22.3`. A real empty-PATH negative control also returned false and preflight fired SHU251_PREFLIGHT_SHELL_TOOLCHAIN (`path-resolution-proof.txt`). This establishes the tested child's PATH resolution, not an absolute node pathname or a target host's capability. The exact execution records are in `restored-dependency-proof.txt`. No new capability or miscellaneous entry was introduced.

## Five stale prose corrections

| Baseline location | Before | After |
|---|---|---|
| DEPENDENCY-AUDIT.md:19 | env removed; codex fixture pins process.execPath | env-node shebang restored and retained; node PATH resolution probed; only service lock-release uses child Node |
| DEPENDENCY-AUDIT.md:24 | touch/cat removed in marker/filter fixtures | touch/cat retained in restored fixtures and declared; only service lock marker uses appendFileSync |
| DEPENDENCY-AUDIT.md:1583 | incidental chmod/rm/grep/touch all removed | cleanup chmod/rm and scan grep removals retained; restored touch/cat declared |
| DERIVATION.md:21 and rows 30–31 | no remaining incidental touch; marker/filter and env-node replacements claimed | 85-file re-audit documents restored fixtures and their declarations; distinguishes retained earlier replacements |
| file-requirements.json codex-contract | generated executable pins process.execPath | restored #!/usr/bin/env node requires child-PATH resolution plus procfs |

`prose-corrections.json` records the before/after text. The current mapping table was refreshed and the source-only shu237-portability shebang claim was corrected.

## Revision and evidence binding

`derive-inventory.mjs` was rerun at committed 280a249, with no inventory diff afterward. Its tracked-file and mapping input revision is 280a249. Original successful-run/provenance capture artifacts remain historical inputs for names/file attribution; they are not relabeled as measurements of 280a249. Fresh plain and offset runs independently check that attribution's names against the committed inventory.

DERIVATION.md, admission-proof.txt and authoritative-run-summary.json now identify 280a249 as the admitted revision instead of 52e5f01. The summary distinguishes derivation input revision, admitted revision and measured run revision. Names and requirements lengths are both 1744; bindSuite computes expected_tests = names.length = 1744. Duplicate names are retained, not deduplicated.

## Full suite and admission

| Run at 280a249 | Outcomes | Pass | Fail | Skip | Complete markers | Exit | Stderr bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| Plain | 1744 | 1736 | 0 | 8 | 1, terminal | 0 | 0 |
| Clock +31536000000 ms | 1744 | 1736 | 0 | 8 | 1, terminal | 0 | 0 |

Both runs have inventory-equal name multisets and ordered names (1742 distinct names).

Both runs must have exact byte-identical PERMITTED_SKIPS name/reason pairs, no additional skip, one terminal complete marker and no failures. The run verifier checks event types, process exit, counts, multiplicities and requirement/name alignment. Raw events and summary are retained separately for plain and clock-offset runs. The offset environment is `SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs"`.

`A12_COMMITTED_INVENTORY_ADMITTED`: 280a249, 85 files, 1744 outcomes. Admission reads the committed Git object. The proof exercises these named refusals:

- SHU251_SUITE_INVENTORY: missing inventory, missing/partial/extra files, version mismatch.
- SHU251_PREFLIGHT_REQUIREMENTS: missing name requirement and capability outside the closed vocabulary.
- SHU251_SUITE_FILE_DIGEST: real byte tampering hidden from git status by assume-unchanged, in a disposable clone.
- SHU251_SUITE_NAMES: name drift.
- SHU251_PREFLIGHT_SKIP_BINDING: unauthorized skip reason.

## Mutation kills

The focused capability suite remains 28 pass, 0 fail, 0 skip. Positive probe and mapping controls pass before mutation. The new evidence battery kills 15 mutants by named ERR_ASSERTION:

| Mutation | Named assertion |
|---|---|
| Delete shell capability entry | A12_DEPENDENCY_ENTRY |
| Omit service-identity, tool or PATH detection claim (3) | A12_SHELL_DETECTION |
| Omit touch invocation | A12_DEPENDENCY_PROBE: shell_toolchain /usr/bin/touch |
| Omit cat invocation | A12_DEPENDENCY_PROBE: shell_toolchain /usr/bin/cat |
| Omit env node invocation | A12_DEPENDENCY_PROBE: shell_toolchain env node |
| Replace env node with absolute node | A12_DEPENDENCY_PROBE: shell_toolchain positive |
| Replace touch version argv with file mutation | A12_DEPENDENCY_PROBE: shell_toolchain positive |
| Replace cat version argv with file read | A12_DEPENDENCY_PROBE: shell_toolchain positive |
| Remove shell_toolchain from each of the five corrected files (5) | A12_RESTORED_SHELL_REQUIREMENT: <file stem> |

The four existing inertness mutants (scratch directory, file write, file removal, mutating mktemp argv) still die by A12_DEPENDENCY_PROBE: shell_toolchain positive / ERR_ASSERTION. Existing bypass, tool-exit/spawn-error, proc-content/descriptor and inventory/name/digest mutation tests remain in the unchanged name set and pass in both full runs. No production admission guard was changed.

## Preservation

PERMITTED_SKIPS is byte-identical, eight entries, sha256 `9d6eebfd832d8e76650aefd725c11059af1b0ab5a05c1d2adfee3269c456607f`. ci.yml remains `138f92481b2a0f51c04714d9dc144735c7662394d300befb46a23bfa851e8e46`; the operational wrapper remains `a32082aefc94836cf2235804d204837d354f2c36005ef1702437f3ac7bc8009d`. All three restored test files are byte-identical to d09f50d and origin/main. `correction-preservation.json` records the checks. Only probe/detection production behavior changed; all other edits are test controls, inventory or evidence. No host access, push, PR/merge or external comment occurred.
