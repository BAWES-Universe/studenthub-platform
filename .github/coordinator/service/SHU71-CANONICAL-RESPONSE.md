# PR #140 canonical counter read response

This repository-only response to FINAL-2 §6(e) items 1 and 5 binds the filename,
not the adjacency of `JSON.parse(privateRead(`. The starting revision is
`de5b4a260ad8c00f72b024dbe072bacdc2713b85`.

Before, `exhaustedControl` collected only the exact parse idiom and required its
suffixes to equal `['.attempts']`. X1/X3/X5/X6/X7 evaded that collection. After,
`SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_CANONICAL_READ_ATTEMPTS_ONLY` counts
literal `automatic-teardown.json` occurrences in any expression form and pins
the sole read line to the canonical `.attempts` projection.

One correction to the prescription is necessary on unchanged production: the
cleanup prefix contains **two** filename occurrences, the read and the reservation
write. The guard first requires exactly one occurrence of the exact existing
``else atomic(`${dir}/automatic-teardown.json`, JSON.stringify({ attempts: attempts + 1 }));``
statement, excludes only that pinned statement, and requires exactly one filename
occurrence in the remainder. Nothing else is excluded. Changing or duplicating
the write fails the same named guard. Requiring one filename in the unmodified
prefix would reject the positive case. This remains a reviewed source contract,
not a proof against aliases, constructed filenames or arbitrary JavaScript rewrites.

The five X witnesses are retained in the existing DELTA mutation tests; each uses
its exact verdict bypass and counter plant. The standalone reproduction command is:

```sh
SHU251_NO_SYSTEMD=1 node .github/coordinator/service/test/shu71-canonical-differential.mjs
```

It copies the coordinator into a fresh temporary directory for every transplant,
scrubs `GIT_*`, runs the actual trust suite, and records the whole-system snapshot
from that transplanted production module. CONTROL uses a non-noop `false ||`
transplant and drives all five plants. Two additional copies delete the counter
guard or restore the old idiom guard (using the new assertion name). Both must
fail the five `X*_MUST_DIE_BY_NAME` assertions in the genuine DELTA tests. The
standalone runner is not itself a `*.test.mjs` CI test; the five added DELTA rows
are included in the unfiltered coordinator suite.

Local measured totals (tests / pass / fail / skip):

| Run | Counts |
| --- | --- |
| Full coordinator | 2745 / 2727 / 0 / 18 |
| Full coordinator, +365 days | 2745 / 2727 / 0 / 18 |
| Trust, unchanged production | 866 / 866 / 0 / 0 |
| DELTA mutations, positive guard | 23 / 23 / 0 / 0 |
| Disposable CONTROL | 866 / 866 / 0 / 0 |
| X1 | 866 / 865 / 1 / 0 |
| X3 | 866 / 865 / 1 / 0 |
| X5 | 866 / 865 / 1 / 0 |
| X6 | 866 / 865 / 1 / 0 |
| X7 | 866 / 865 / 1 / 0 |
| Guard deleted, DELTA suite | 23 / 13 / 10 / 0 |
| Guard weakened to old idiom, DELTA suite | 23 / 18 / 5 / 0 |

All five X trust failures are the named canonical-read assertion. Both guard
defeats fail all five `X1/X3/X5/X6/X7_MUST_DIE_BY_NAME` assertions; deletion also
fails the retained N3 and B1–B4 witnesses. These negative-control failures are
expected. The positive guard and all unmodified suites have zero failures.
Direct source probes also reject `.frozen`, `.attempts || true`, and a duplicate
reservation write under the new assertion name, with the positive source passing.

Measured counts and raw snapshots are recorded in `SHU71-CANONICAL-VALIDATION.json`.
The tuple fields are gates, credential, lease, effects, code and completion. Each
X mutant remains a genuine fail-open: `(true, true, PRESENT, HELD, 0,
ACT_RETRY_BUDGET_EXHAUSTED, false)`. Each CONTROL plant instead takes the unchanged
fallback: `(false, false, removed, HELD, 7, ACT_RETRY_BUDGET_UNAVAILABLE, false)`.
The acceptance is the named rejection by the whole trust suite, not merely the
mutation harness detecting its own edit.

X4 remains disclosed and is not chased or claimed closed: it reads a new
`operator-override` file under the evidence directory, outside the four-axis
state model. Planting it requires the same root write into the `0700`/uid-0
evidence directory as the W13/B-family residual. All prior residuals remain:
root-forgeable unkeyed journal/counter, ORDERED root forgery, R5-A containment,
writer custody, and the B1 host/live remainder. B1 stays BLOCKED; B2/B4 stay
source-level only. The terminal-positive assertion still pins unchanged production
returning `ACT_TEARDOWN_DRIFT` with completion true, gates armed and credential
present; completion is a recorded journal fact, not proof of physical safety.

D7: `constraints.new_head_ci_status` now says “This file makes no CI claim for its
containing revision. CI status is recorded separately at publication.” The
`limitations` entry likewise records CI separately at publication. These statements
remain true before and after publication and claim no unpushed commit is green.

`git fetch origin main` left `origin/main` at
`8a613c42d166fcab5497060ead168d7941542b60`, already an ancestor of the starting
revision. No merge was needed; no per-file merge disposition applies. Production,
`.github/workflows/ci.yml` and `PERMITTED_SKIPS` are untouched. No other assertion
is removed, renamed or weakened; only the counter assertion and its references
are renamed. No skip was added. The pre-existing untracked `.local-test-results/`
is left untouched.

This is local repository validation only: no host access, push, PR/merge action,
or GitHub/Linear comment. Publication, CI on the published commit, the settled
revision and the independent verdict are the orchestrator's subsequent steps.
