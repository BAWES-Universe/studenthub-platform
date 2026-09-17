# Current 98-file inventory verification

The current correction merges main `8a95330a9a040f239e7202f4bfb2691300e89542` at merge commit `24dd36b1f8a2aa595a80ecf9e130476f50c09fce`. The original JSONL captures and correction reports in this directory are historical 85-file evidence, not measurements of this correction.

The merged baseline was complete: 2,761 outcomes, 2,753 pass, zero fail, eight authorized skips, one terminal complete marker. The new inventory guard adds one test in the existing suite-runner-spec file, leaving 98 suite files. Its final inventory must be reproduced from an unfiltered successful run at the committed revision, using:

```sh
A12_PROVENANCE_PATH=/tmp/a12-current/plain/outcome-files.jsonl node --test \
  --test-reporter=./.github/coordinator/service/a12-evidence/provenance-reporter.mjs \
  .github/coordinator/service/test/*.test.mjs .github/coordinator/test/*.test.mjs \
  > /tmp/a12-current/plain/successful-run.jsonl
node .github/coordinator/service/a12-evidence/derive-inventory.mjs /tmp/a12-current/plain
node .github/coordinator/service/a12-evidence/prove-inventory.mjs /tmp/a12-current/plain/successful-run.jsonl
```

The capture directory also contains successful-run-summary.json with the exact measured revision and actual process exit code. Derivation checks that revision against HEAD, the complete marker, outcome success, attribution order, exact audited file set, and name multiplicities. It reports files, names, requirements and expected_tests. It must reproduce the committed inventory without a diff. The clock run uses `SHU_TEST_CLOCK_OFFSET_MS=31536000000` and `NODE_OPTIONS=--import=<checkout>/.github/coordinator/test/fixture/shift-wall-clock.mjs`. Final raw captures, revision-specific summaries and admission output are kept in `/tmp/a12-current/` so evidence capture does not dirty the checkout being admitted. The final author report names their exact revision; this document makes no claim that a bootstrap or rejected run is authoritative.

## Requirements and execution evidence

F1 adds shell_toolchain to all 18 shu261-cleanup-network rows: bash, shell_toolchain. F3 adds git to all 22 single-run-activation rows. F4 adds git to all 15 shu239-mutations rows: bash, git. F6 adds shell_toolchain to all shu237-mutations rows. The reviewed file-union policy and three Option A overrides are retained; identity capabilities retain only their exact permitted reasons.

Each of the 13 new SHU-71 files has its own row and evidence in file-requirements.json. History and trust require Git through historicalSource (including synthetic repository custody and historical differentials). Composition injects revision/workspace/launch boundaries. Delivery injects read/run/fork boundaries. Production and its in-process mutation tests use productionFixture, which interprets every command and API call on disposable Node filesystem/crypto boundaries. Supervisor-environment checks rendering and refusals before real execution. No dependency is inferred merely from an executable name in a fixture or source string.

## Probe and regression guards

shell_toolchain adds precisely `/usr/bin/basename ['--version']`, `/usr/bin/env ['basename','--version']`, and `/usr/bin/node ['--version']`. The existing env-node check remains. Detection and comments name the dependencies. The fixed-argv and named negative controls exercise each addition; the no-filesystem-mutation claim has an explicit assertion. prove-current-probes.mjs kills the seven new probe/detection mutants, including M16, by named assertions.

The in-suite test `A12 committed inventory requirements match real outcomes` reads inventory bytes from HEAD, runs the suite with fresh file attribution, and compares each name occurrence's requirements to its audited file union. Its internal runner excludes only this recursive callback; Node emits no skip for that filter. The outer full run executes the callback normally. The guard additionally proves the verdict's F1/F3/F4 witnesses by removing just basename or git from a private PATH, and requires the resulting named failures and declarations across the affected files. Missing F1/F3/F4/F6 capabilities and an unused Git grant are mutated against the same live outcomes and must die by A12_INVENTORY_REQUIREMENTS. This is a regression guard with an explicit reviewed audit map, not a claim of automatically discovering every future external dependency.

Because suite-runner-spec now executes the other proofs, its file union includes their nine non-identity capabilities. Child identity absences remain the eight exact authorized outcomes, not new outer skips.

PERMITTED_SKIPS, ci.yml, the operational wrapper and the restored shell fixtures are unchanged. No host deployment or external action is part of these proofs.

## Successful derivation checkpoint

`merged-derivation/` records the complete unfiltered plain run, derivation and admission at `ca77fc8a251b5e62594393c5eb0f974e195e9271`: 98 files; 2,762 outcomes/names/requirements/expected_tests; 2,754 pass; zero fail; eight skips with byte-identical reasons; one terminal complete marker. There are 2,760 distinct names, with duplicate occurrences retained. F8 passes in that run. Five inventory row mutants, seven current probe/detection mutants (including M16) and four preserved filesystem-side-effect mutants die by named assertions.

That successful run re-derived the inventory; the only byte difference was JSON serialization of Unicode test names (no decoded names or capabilities changed). Those canonical bytes are committed with this checkpoint. These checkpoint numbers belong to `ca77fc8`, not to their evidence carrier. Final plain and clock runs, derivation reproduction and admission must be repeated at the carrier's actual HEAD and reported with that exact revision.
