# PR #140 refined delta response — 2026-09-17

This is a test/documentation change against `ef8729347f9a869c705de03defec7bf4d8350886`.
Production and `.github/workflows/ci.yml` are unchanged. The previous stop was correct:
`TEARDOWN_COMPLETE` is a terminal signal, so universal irrelevance over all twelve
non-reservation classes was an unsatisfiable prescription. Completion is a recorded
journal fact; it does **not** certify physical safety when the result is `ACT_TEARDOWN_DRIFT`.

## Source-derived inventory

Every payload below is the exact object passed to `journal.append`, before the real
writer adds `seq`, `previous`, and `sha256`. P denotes `shu71-production.mjs`; J denotes
`shu71-journal.mjs`. The guard inventories 11 append call sites, resolving both dynamic
expressions to obtain 13 event classes: 11 non-terminal non-reservation classes,
one non-terminal reservation class, and one terminal class. It compares the complete append argument text,
including payload fields, and pins J85's dynamic selection. A new call site or changed
payload fails `SHU71_CONTROL_PROPERTY_JOURNAL_APPEND_INVENTORY`; a changed dynamic
selection fails `SHU71_CONTROL_PROPERTY_JOURNAL_DYNAMIC_CLASSES`; an omitted enumerated
class fails `SHU71_CONTROL_PROPERTY_JOURNAL_CLASS_COVERAGE`.

| Class | Exact production payload | Classification and consuming control flow |
| --- | --- | --- |
| APPROVED | `{ event: 'APPROVED', spec }` (P206) | Non-terminal: P205 initial approval lookup; no completion return. |
| SIGNING_STARTED | `{ event: 'SIGNING_STARTED' }` (P245) | Non-terminal: P244 ambiguous-signing refusal. |
| ARMED | `{ event: 'ARMED', authorization_expires_at: pkg.expires_at, teardown_complete: false }` (P295) | Non-terminal: resume routes to cleanup at P228. |
| HALTED | `{ event: 'HALTED', code }` (P302) | Non-terminal: diagnostic; no event predicate grants completion. |
| FIXTURE_REMOVE_INTENT | `{ event: 'FIXTURE_REMOVE_INTENT', attempt_id: record.attempt_id, dev: st.dev, ino: st.ino, uid: st.uid }` (P336) | Non-terminal: P334–335 inode identity check before workspace removal. |
| AUTOMATIC_TEARDOWN_RESERVED | `{ event: 'AUTOMATIC_TEARDOWN_RESERVED', attempts: attempts + 1 }` (P389) | Non-terminal **reservation evidence**: P387–388 filters these rows and checks ordered 1–32 attempts. |
| SETTLEMENT_STARTED | `{ event: 'SETTLEMENT_STARTED' }` (P451) | Non-terminal: P447 consumes the settlement allowance by returning refusal. |
| INTENT | `{ event: 'INTENT', step }` (J55) | Non-terminal: intent deduplication (J55), restore routing (P418), retirement prerequisites (P431). |
| DONE | `{ event: 'DONE', step }` (J57) | Non-terminal: effect deduplication (J54), worker-cleanup prerequisite and exhausted settlement prerequisites (P444–445). |
| AUTHORIZATION_EXPIRED | `{ event: reason === 'expiry' ? 'AUTHORIZATION_EXPIRED' : 'REVOKE_REQUESTED' }` (J63), expiry arm | Non-terminal: P226–228 routes to cleanup. |
| REVOKE_REQUESTED | Same J63 payload, non-expiry arm | Non-terminal: P226–228 routes to cleanup. |
| TEARDOWN_INCOMPLETE | `{ event, failures }` (J86), J85 selects this when failures is nonempty | Non-terminal: P226–228 routes to cleanup. |
| TEARDOWN_COMPLETE | `{ event, failures }` (J86), J85 selects this when failures is empty | **Terminal/completion**: P209–216 observes teardown or returns drift/historical receipt, before any cleanup/budget branch. |

Values in the full-payload plants are executable in `journalInventory`: the fixture's
actual `spec` and expiry, `ACT_PRODUCTION_FAILED`, a UUID plus numeric dev/ino/uid,
`attempts:2`, `step:'teardown:gate'`, and either `['ACT_TEARDOWN_GATE']` or `[]` failures.
They represent payload shapes, not an exhaustive proof over all possible payload values.
The pre-existing bare HALTED/FIXTURE_REMOVE_INTENT witnesses remain unchanged.

## Assertions and scope

The full-payload irrelevance loop runs all 12 non-terminal classes on both
`armed | exhausted | intact | unconsumed` and
`armed | exhausted | recovered | unconsumed`: **24 cases**. Including a reservation row
is an additional bounded check: one added reservation cannot complete the missing
32-entry proof on these rows. This does not claim reservation evidence is globally irrelevant.
Every case compares both entire gate-file strings, credential, lease, effect count,
code and completion to an independently executed baseline and the existing state oracle.
The existing assertion name is retained:

> `B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS`

Terminal coverage has separate named positive assertions:

> `B4_TEARDOWN_COMPLETE_LEGITIMATE_TERMINAL_INTACT`
>
> `B4_TEARDOWN_COMPLETE_LEGITIMATE_TERMINAL_RECOVERED`

Both require `(true, true, present, held, 0, ACT_TEARDOWN_DRIFT, true)`.
The unchanged state driver first proves its original unconsumed precondition. A wrapper
then appends the terminal signal through the real writer immediately before executing
the expiry wake. The single append write is asserted by `B4_TERMINAL_REAL_WRITER` and
excluded from the production-wake effect count; no production-wake effects are omitted.

The source-order assertion is:

> `SHU71_CONTROL_PROPERTY_COMPLETION_BEFORE_EXHAUSTED`

It pins the completion predicate and unconditional return before recovery/cleanup and
the exhausted-counter check. Moving that block behind cleanup routing fails by this name.

The two structural assertions are:

> `SHU71_CONTROL_PROPERTY_EXHAUSTED_NO_CLOCK`
>
> `SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_ATTEMPTS_ONLY`

The inspected cleanup prefix runs from entry into cleanup through the counter read,
reservation predicate and fault fallback, ending before ordinary effects. It contains
no `b.now()` call and exactly one counter parse with the sole projection `.attempts`.
The separate later exhausted-settlement branch's bare JSON parse remains unchanged;
it validates the file and grants no counter-field authority. These are source-content
contracts in the style of the existing eighteen historical checks, not general proofs
against aliases, arbitrary JavaScript rewrites or maliciously rewritten tests.

The behavioural clock backstop executes **1 day + 1 ms, 2 days, 7 days, 29 days,
365 days, 400 days, 3650 days (10 × 365 days)**. All seven preserve the whole tuple.
The existing +365-day witness also remains. `Object.keys(counter).length > 1` is
reproduced in a disposable mutant and killed by the existing
`B4_EXHAUSTED_IRRELEVANT_EXTRA_COUNTER_FIELDS` assertion.

## Fourteen reproduced shapes

Tuple order is `(gate 1, gate 2, credential, lease, effects, code, completion)`.
Each gate boolean denotes the **entire** string
`[Service]\nEnvironment=ENABLE_DISPATCH=<boolean>\n`, compared byte-for-byte.
Each of the fourteen mutants independently reproduces
`(true,true,present,held,0,ACT_RETRY_BUDGET_EXHAUSTED,false)` with its triggering plant.
The post-fix production snapshots and named kills below are executable in
`shu71-delta-mutations.test.mjs`; the full genuine trust-suite differential is executable
in `shu71-delta-differential.mjs`. No production mutation is written to the checkout.

| Shape | Triggering plant | Post-fix whole-system snapshot | Killing assertion |
| --- | --- | --- | --- |
| N1 | Bare HALTED | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS` |
| N2 | +365 days | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `SHU71_CONTROL_PROPERTY_EXHAUSTED_NO_CLOCK` (also clock invariant) |
| N3 | settled:true + arbitrary_metadata | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_ATTEMPTS_ONLY` (also extra-fields invariant) |
| N6 | Bare FIXTURE_REMOVE_INTENT | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS` |
| A1 | HALTED with string code | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS` |
| A2 | FIXTURE_REMOVE_INTENT with attempt_id/dev/ino/uid | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS` |
| A5 | REVOKE_REQUESTED | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS` |
| A6 | Full HALTED in recovered journal | `(false,false,removed,held,7,ACT_RETRY_BUDGET_EXHAUSTED,false)` | `B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS` |
| B1 | note:'operator-touched' | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_ATTEMPTS_ONLY` |
| B2 | frozen:true | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_ATTEMPTS_ONLY` |
| B3 | provenance:{writer:'ops'} | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_ATTEMPTS_ONLY` |
| B4 | settlement_started:'yes' | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_ATTEMPTS_ONLY` |
| C1 | +2 days within 1–30-day window | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `SHU71_CONTROL_PROPERTY_EXHAUSTED_NO_CLOCK` (also clock sweep) |
| C2 | +3650 days, beyond 400 days | `(false,false,removed,held,7,ACT_RETRY_BUDGET_UNAVAILABLE,false)` | `SHU71_CONTROL_PROPERTY_EXHAUSTED_NO_CLOCK` (also clock sweep) |

## D6, main and retained limits

D6 is corrected in `SHU71-L3-TESTS.json`: CI at **ef87293** is green according to the
accepted delta verdict (four successful workflow runs, eleven checks, zero failures).
This is not a CI claim for these unpushed edits. No workflow changed.
Remote read-only `git ls-remote origin refs/heads/main` still reports
`8a613c42d166fcab5497060ead168d7941542b60`; the local origin/main is identical and is an
ancestor of HEAD. No merge is necessary. The repeated per-file audit of the existing
`ce564a2` merge confirms **59/59 branch-side changed paths retained**, **0 reverted**;
`SHU71-DELTA-MERGE-AUDIT.json` records each disposition. No host access, push, PR action or comment occurred.

All earlier disclosures and residuals remain: B1 host/live remainder stays blocked;
B2/B4 are source-level only; unkeyed journal chains, root writer custody and
FORGED-ordered acceptance are not closed. The finite state model is still 720 reachable
and 144 explicitly unreachable rows. The pre-existing representative-value disclaimer
remains true; this addition closes class enumeration and pins the specified source
properties, not all payload combinations or all equivalent program rewrites.

The original four `FINAL N… dies by invariant name` tests are retained. Their standalone
differential runner still requires **exact** failure counts; the expected counts are
now N1=3, N2=9, N3=2, N6=3 because the new independent cases also kill those mutants.
It still requires each original invariant name. The new fourteen-shape runner checks
named kills against the entire genuine trust suite, while the executed delta mutation
tests measure and assert each mutant's whole-system fail-open signature and production's
post-fix tuple independently. No previous assertion name or skip list entry changed.

## Full genuine trust differential

Each run executes all 866 genuine trust tests. Mutant failures below are the intended
negative result; the acceptance suites themselves have zero failures.

| Shape | Tests | Pass | Fail | Named kill |
| --- | ---: | ---: | ---: | --- |
| CONTROL | 866 | 866 | 0 | Equivalent control; zero failures |
| N1 | 866 | 863 | 3 | B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS |
| N2 | 866 | 857 | 9 | SHU71_CONTROL_PROPERTY_EXHAUSTED_NO_CLOCK |
| N3 | 866 | 864 | 2 | SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_ATTEMPTS_ONLY |
| N6 | 866 | 863 | 3 | B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS |
| A1 | 866 | 864 | 2 | B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS |
| A2 | 866 | 864 | 2 | B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS |
| A5 | 866 | 864 | 2 | B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS |
| A6 | 866 | 865 | 1 | B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS |
| B1 | 866 | 865 | 1 | SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_ATTEMPTS_ONLY |
| B2 | 866 | 865 | 1 | SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_ATTEMPTS_ONLY |
| B3 | 866 | 865 | 1 | SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_ATTEMPTS_ONLY |
| B4 | 866 | 865 | 1 | SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_ATTEMPTS_ONLY |
| C1 | 866 | 861 | 5 | SHU71_CONTROL_PROPERTY_EXHAUSTED_NO_CLOCK |
| C2 | 866 | 864 | 2 | SHU71_CONTROL_PROPERTY_EXHAUSTED_NO_CLOCK |

## Final validation counts

All acceptance suites below have **zero failures**. Both coordinator runs execute all
720 state rows, all 24 real-payload invariants, all seven sweep offsets and both terminal
positive cases. The 18 existing local skips have the same names in both runs; no skip
was added. The final total is 2686 + 36 trust cases + 18 delta mutation checks = 2740.

| Suite | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| coordinator | 2740 | 2722 | 0 | 18 |
| trust | 866 | 866 | 0 | 0 |
| delta_mutations | 18 | 18 | 0 | 0 |
| final_and_delta_mutations | 22 | 22 | 0 | 0 |
| policy | 78 | 78 | 0 | 0 |
| history | 29 | 29 | 0 | 0 |
| composition | 3 | 3 | 0 | 0 |
| environment | 13 | 13 | 0 | 0 |
| coordinator_plus_365_days | 2740 | 2722 | 0 | 18 |

`SHU71-DELTA-VALIDATION.json` records all fourteen measured whole-system snapshots,
all fifteen trust differential counts (control + fourteen mutants), final suite counts,
and unchanged-source hashes. `SHU71-DELTA-MERGE-AUDIT.json` records the per-file dispositions.
The full coordinator commands use `SHU251_NO_SYSTEMD=1 npm run test:coordinator`, adding
`SHU_TEST_CLOCK_OFFSET_MS=31536000000` for the future-clock run. `git diff --check` passes.
