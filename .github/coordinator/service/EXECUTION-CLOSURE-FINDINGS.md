# Execution-closure verdict findings

Repository-only follow-up to `0a6161640f737d778cc1dc4440359377f413f671`, on
`fix/shu251-execution-closure`. The supplied independent verdict was read in full.
No host access, push, PR, integration merge, external comment, AppArmor or sysctl
change was performed. The requested branch was fast-forwarded locally from its
older base to the supplied head before editing; no merge commit was created.

## F1 — distinct numeric ownership

`privateRead` now takes a separate expected gid. Exact mode 0600, single-link
regular-file checks, NOFOLLOW, NONBLOCK, size bounds, and the existing prohibition
on group/other mode bits remain intact. Root custody still requires 0:0.
`readAdapterLaunchEnvironment` checks process uid and primary gid separately.

The Phase-B signed payload has no `lifecycle` member. Arming therefore resolves
the installed supervisor's User/Group through systemctl and id. These are the
fields rendered from `spec.lifecycle.identity`, whose numeric account and primary
group lifecycle independently verifies. Names, positive integer IDs and agreement
with the primary group are required. No new identity artifact or caller-selected
identity override was introduced. The child inherits that systemd identity.

The production fixture's `write(path, bytes, mode, uid, gid)` now records uid and
gid independently. Its configurable identity models the installed User/Group and
id command results independently of file ownership. Existing callers retain their
original defaults. The new positive control sets identity 999:982 and writes the
file as 999:982 mode 0600; wrong gid 981 and mode 0400 refuse before signing.

The exact original `shu71-production.mjs` and `units.mjs` from `0a61616` were
transiently restored against the new fixture. Both selected controls failed:
`CLOSURE_ARM_PAIR_PASSES` and `CLOSURE_WIRING_EXIT: SHU251_ENV_CUSTODY`.
The corrected files were restored, and the same controls pass. This is execution
against original bytes, in addition to the permanent source mutants below.

| Exact mutation name (prefix `CLOSURE_CUSTODY mutation `) | Killing assertion |
| --- | --- |
| arming invalid identity name accepted | CLOSURE_ARM_IDENTITY_NAME_REFUSED |
| arming invalid identity gid accepted | CLOSURE_ARM_IDENTITY_GROUP_REFUSED |
| arming conflates gid with uid | CLOSURE_ARM_PAIR_PASSES |
| arming wrong gid accepted | CLOSURE_ARM_GID_REFUSED |
| arming non0600 accepted | CLOSURE_ARM_MODE_REFUSED |
| arming configured identity ignored | CLOSURE_ARM_PAIR_PASSES |
| child conflates gid with uid | CLOSURE_CHILD_PAIR_PASSES |
| child wrong gid accepted | CLOSURE_CHILD_GID_REFUSED |
| child non0600 accepted | CLOSURE_CHILD_MODE_REFUSED |

## F2 and F3 — actual child entrypoint delivery

The worker change is necessary: the supervisor's source contains only its secret,
so the child must acquire the nine adapter bindings from the coordinator source.
The new control uses the production spawner and forks a source copy of the actual
worker entrypoint. Only static import/asset URLs are rebased. A test preload
supplies filesystem metadata/content and process IDs; a disposable authorization
module and adapter observe delivery. No service file or host pathname is touched.
The adapter receives all nine exact values and none of the supervisor secret,
GitHub token or Linear token. This proves wiring through the child message handler,
including the broker gate, filesystem reader and adapter launch options; it does
not establish live systemd execution or adapter completion.

Custody drift exits 1 before adapter launch and emits only `SHU251_ENV_CUSTODY`.
Known environment refusal codes are allowlisted; other failures emit only
`SHU251_CHILD_FAILED`. Error text and credentials are not printed.

| Exact mutation name (prefix `CLOSURE_WIRING mutation `) | Killing assertion |
| --- | --- |
| worker child delivery omitted | CLOSURE_WIRING_NINE_KEYS |
| worker process gid ignored | CLOSURE_WIRING_EXIT |
| worker custody diagnostic swallowed | CLOSURE_WIRING_NAMED_REFUSAL |

The dependency disclosure now enumerates all six omitted suite probes: temp,
user_namespaces, checkout, systemd, systemd_notify and node. It states residual
coverage and the Node/notify admission gap. The lifecycle capability vocabulary is
also independently pinned by `CLOSURE_LIFECYCLE independently pinned capability
vocabulary`, closing the verdict's additional shared-constant test caveat.

## F4 — window prerequisites

Items 3 and 6 of `EXECUTION-CLOSURE.md` now explicitly require configured numeric
uid AND gid ownership and exactly 0600, with the supplied host example 999:982,
and prohibit any `ENABLE_DISPATCH=` line in the coordinator environment file,
even one setting it to false (`SHU251_ENV_GATE_OVERRIDE`). These are documentation
corrections, with no new production behavior and no invented mutation claim.
The host values are supplied measurements, not measurements from this lane.

## Validation and limits

The inventory retains all 2,785 prior names and every prior requirement row,
adding 15 names in the existing closure test file: 2,800 total, 101 files.
`PERMITTED_SKIPS` is byte-identical to the supplied head: eight entries, 1,093
bytes including trailing newline, SHA-256
`03cf773e89a89a408d84b707895cae5457cb71094bcc3ba1fe18ad9b9eb2e11e`.
`.github/workflows/ci.yml` is untouched. No assertion is weakened or renamed; existing test names and mutation lists
remain. `B1_ARM_EFFECT_COUNT` remains exact, updated from 116 to `116 + 5` for
the five new read-only identity commands; `CLOSURE_ARM_IDENTITY_READ_ARGV`
independently pins their exact argv. The first full run exposed this count change
in both lane integration tests and their nested inventory run. Two existing
reader calls now pass their expected gid explicitly alongside unchanged uid
expectations.

Evidence is retained in `execution-closure-evidence/findings/`: original-file
regression TAP, all 20 corrected control/mutation outcomes, and the two full-suite
summaries. The full suite uses the inventory's 101 files and
`--test-reporter=./.github/coordinator/service/host-suite-contract.mjs`.
The future run additionally sets `SHU_TEST_CLOCK_OFFSET_MS=31536000000` and
`NODE_OPTIONS=--import=<checkout>/.github/coordinator/test/fixture/shift-wall-clock.mjs`;
the preload propagates into nested inventory and mutation processes. Each run is
checked with `evaluateSuite`, `suiteNames`, the exact skip reasons and the
inventory guard's own passing outcome.
The original proof table's live signing, service-plane execution and prerequisite
verification limits remain OPEN/PARTIAL. No live readiness or host acceptance is
claimed. F1–F4 are closed within the requested repository scope.
