# R8 bounded acceptance model

B1 remains BLOCKED. B2/B4 remain source-level only. No CI, host, live durability,
or independent verification claim is made here. R7 measurements in
`SHU71-L3-TESTS.json` are historical; R8 measurements are recorded separately.

The closing criterion is finite: every **demonstrated** shape dies by name.
W7, W13, W1b and W15 are fixed regression witnesses, not the acceptance domain.
Acceptance is `requiredTransition(state)` in `test/shu71-r8-state-model.mjs`,
asserted through the real production entry point for every reachable model row.
No claim is made about arbitrary future predicates or all possible input bytes.
The existing R6 reservation histories, R7 V12/V14 assertions, all 18 control
properties, unknown-vendor trap and Git-unavailable diagnostic remain unchanged.

## Domain and reachability

The requested axes are counter × journal × allowance. `valid-n` expands to every
integer 0..31, giving 36 counter values including absent, invalid, exhausted
(`attempts:32`), and settlement-started-set (`attempts:32, settlement_started:true`).
Invalid uses malformed JSON; the existing counter-fault tests retain their other
storage fault coverage. Journal values are absent, intact, truncated, recovered,
FORGED-ordered and FORGED-partial. Allowance consumption means a
`SETTLEMENT_STARTED` row in the **selected valid** journal, independently of the
counter boolean.

Those three axes alone omit physical safety and completed work, which affect the
outcome. Two explicit initial profiles make the function well-defined:

- **armed:** a real successful production run; both gates armed, credential present,
  own lease held, no completed teardown. Intact retains that real journal.
- **settlement-ready:** after the real run, 32 real automatic cleanup attempts fail
  only at timer retirement. Both gates are disarmed, credential absent, own lease
  held. Intact retains the genuine ordered reservations and DONE history.

Both profiles are expired, have valid custody, have no active injected fault at
the measured transition, and execute `expire` in a fresh production instance.
The ready profile is produced before changing any modeled journal/counter state.
Absent removes the journal; truncated appends a torn suffix and has no recovery
file yet. Recovered preserves the torn original and supplies a valid recovery
prefix with APPROVED, ARMED and one reservation. FORGED-ordered/partial rebuild a
valid main journal containing APPROVED, ARMED and respectively 32 ordered
reservations or one reservation, without teardown DONE rows. These are explicit
local-writer adversary states, not claims of authentic history. Consumed adds the
settlement row through the actual journal writer; the counter is then planted
independently. The recovered prefix exercises both W1b and W15 facts.

The domain has **864 rows** (36 × 6 × 2 × 2). **720** are executed. The **144**
absent/consumed and truncated/consumed rows (36 × 2 × 2 profiles) are explicitly
classified as unreachable: the selected journal is empty/newly recovered and
cannot also contain a settlement row. A settlement row in the damaged original
is not a consumed allowance in the selected recovery journal. Supplying an
existing valid recovery file instead changes the journal category to recovered.
There are no skipped tests for these rows. Domain size, unique row names and
classification are named assertions.

This is a bounded fixture-state proof. Mixed gate states, unrelated lease owners,
completed receipts, arbitrary corrupt bytes, ongoing I/O failures and races are
outside this domain; existing tests for those conditions are retained. It does
not prove an abstraction theorem for every concrete journal within a category.

## Total transition table

Rules below partition every reachable row. Both allowance values are covered
unless a row says otherwise. `X` means exhausted or settlement-started-set;
`N` means absent or valid-0..valid-31. `U` and `E` stand for
`ACT_RETRY_BUDGET_UNAVAILABLE` and `ACT_RETRY_BUDGET_EXHAUSTED`. Every output row
asserts **both exact gate file contents**, credential presence, effect count,
lease retention, result code and TEARDOWN_COMPLETE presence together.

| Profile | Counter | Journal | Allowance | Both gates | Credential | Lease | Effects | Code | Complete |
|---|---|---|---|---|---|---|---:|---|---|
| either | N | any | either reachable | disarmed | absent | released | cleanup table below | null | yes |
| either | invalid | absent/truncated | unconsumed | disarmed | absent | held | 8 | U | no |
| either | invalid | all others | either | disarmed | absent | held | 7 | U | no |
| either | X | absent | unconsumed | disarmed | absent | held | 8 | U | no |
| either | X | truncated | unconsumed | disarmed | absent | held | 8 | E | no |
| either | X | recovered | either | disarmed | absent | held | 7 | E | no |
| either | X | FORGED-partial | either | disarmed | absent | held | 7 | U | no |
| armed | X | intact | either | disarmed | absent | held | 7 | U | no |
| ready | X | intact | unconsumed | disarmed | absent | released | 21 | null | yes |
| ready | X | intact | consumed | disarmed | absent | held | 0 | E | no |
| armed | X | FORGED-ordered | either | **armed** | **present** | held | 0 | E | no |
| ready | X | FORGED-ordered | either | disarmed | absent | held | 0 | E | no |

The armed FORGED-ordered row is the unchanged R5-B residual, independently pinned
by `B4_R6_ORDERED_ZERO_EFFECTS_RESIDUAL`. It is recorded as a known unsafe residual,
not described as a safe refusal. All other refusal rows assert their safe state.

| Cleanup profile | absent | intact | truncated | recovered | FORGED-ordered | FORGED-partial |
|---|---:|---:|---:|---:|---:|---:|
| armed | 67 | 72 | 73 | 72 | 66 | 66 |
| ready | 67 | 41 | 69 | 68 | 66 | 66 |

Effects count attempted fixture events matching write/rename/unlink/remove/
command/api, including observation commands, missing-file unlink attempts and
journal writes. Reads, mkdir, metadata operations and fsync are excluded, matching
the R7 measurement convention. Seven fallback events are three per atomic gate
replacement (pending unlink, write, rename), plus credential unlink. A fresh
journal adds one APPROVED write. Counts are literal reviewed expectations, not
computed by executing production to construct an oracle. Test diagnostics emit
every input and its measured before/after state for audit.

## Demonstrated witnesses

Before adding the table, each mutant passed **105/105** unchanged genuine trust
tests at the rebased production source. Each produced the same initial and final
unsafe tuple: gates armed/armed, credential present, lease held, zero effects,
code E, no TEARDOWN_COMPLETE. The unchanged production witness instead ended
with gates disarmed/disarmed, credential absent, lease held, seven effects,
no TEARDOWN_COMPLETE; its code was U for W7/W13 and E for W1b/W15.

| Mutant | Named whole-state assertion |
|---|---|
| W7 | `B4_R8_STATE_EXHAUSTED_INTACT_CONSUMED` |
| W13 | `B4_R8_STATE_SETTLEMENT_STARTED_SET_INTACT_UNCONSUMED` |
| W1b | `B4_R8_STATE_EXHAUSTED_RECOVERED_UNCONSUMED` |
| W15 | `B4_R8_STATE_EXHAUSTED_RECOVERED_UNCONSUMED` |

W1b and W15 are individually installed and individually killed; sharing a state
assertion does not combine their mutation runs. Production is unchanged, so the
mutant snapshots remain unsafe after adding tests: **the new assertions detect
them**. This work does not describe a test-only change as a production repair.

Reproduce the old-suite survivors with:

```sh
SHU251_NO_SYSTEMD=1 node .github/coordinator/service/test/shu71-r8-differential.mjs 33f0436
```

Omit the revision to run the current genuine trust suite against all four
mutants. The runner emits counts, named failures and whole-system snapshots. It
copies only repository source into disposable directories; all production
commands, filesystem ownership and APIs are fixture doubles. The regular focused
suite includes `shu71-state-mutations.test.mjs` for four mandatory named kills.

## Local validation record

The first local pass is recorded in `SHU71-R8-VALIDATION.json`: focused 1,056/1,056,
genuine 995/995, coordinator 2,580 total / 2,562 passed / zero failed / 18 unchanged
skips, rollback 1/1. The focused suite kills 61 targeted mutants (the previous 57
plus these four) and runs 512 process-death injections (240 forward, 272 teardown).
The full genuine trust differential is 826 tests: W7 fails 10, W13 fails 14,
W1b and W15 each fail eight. These numbers do not count failures as passing tests.

The requested rebase used `git rebase --onto origin/main 5a3c956
chore/shu71-production-composition`, with origin/main at the requested
`dc01f84a57d50781ae726959f2962dfd6403726a`. The rebased head was
`68fa34d49bcf2c27719c011fac465e0b8bf57e7d`. An initial plain `git rebase origin/main`
was aborted because it replayed already-squashed L1 commits. No merge or remote
write was performed. Later movement of the shared origin/main ref was not chased.

The preceding rebase and unchanged-source statements describe the historical R9
pass only. As of 2026-09-17, B1 commit `007b1a8` changed `units.mjs` and
`shu71-production.mjs`, and #138 was integrated at `a1de27b`. The FINAL response
merges main at `8a613c42d166`, including #139's host-suite receipt binding.
The complete host-suite-contract and ci.yml are byte-identical to that main.

The executable `stateSpace` and `unreachable` definitions enumerate all 720
reachable and 144 unreachable rows; trust-test diagnostics emit each measured
whole-system row. No untracked local evidence files are required for this claim.

## FINAL response: irrelevant-input invariants (2026-09-17)

The exhausted/armed/intact/unconsumed row now asserts three negative invariants:
`B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS` (real-writer HALTED and
FIXTURE_REMOVE_INTENT, separately), `B4_EXHAUSTED_IRRELEVANT_EXTRA_COUNTER_FIELDS`
(extra settled and arbitrary_metadata fields), and
`B4_EXHAUSTED_IRRELEVANT_CLOCK_PAST_EXPIRY` (+365 days relative to expiry).
Each compares the whole-system tuple with an untransformed execution and pins
that baseline to the existing transition oracle. Expected: both gate files exactly
`[Service]\nEnvironment=ENABLE_DISPATCH=false\n`, credential absent, lease held,
7 effects, ACT_RETRY_BUDGET_UNAVAILABLE, completion false.

These are representatives of irrelevant-input classes, not a proof over every
possible event, field, value or clock offset. Imagined predicates selecting other
representatives or combinations remain outside the finite proof. Every demonstrated
shape must die by name; the fixed N1/N2/N3/N6 witnesses check that requirement.
Their unsafe snapshots remain unsafe: test changes detect them, not repair production.
See `SHU71-FINAL-VALIDATION.json` for current counts and individual snapshots.
All prior residuals, composition range/depth limits and the
`skipActivationPreflight: true` scope note remain in force unchanged.
