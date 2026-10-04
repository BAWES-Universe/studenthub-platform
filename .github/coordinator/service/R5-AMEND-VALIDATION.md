# R5 J1/J2 amendment — repository-only writer evidence

Starting head: `7b3cdc30d32df85316cecb578a8050007b0499a1` (PR #135).
Both full R5 verdict files at `/home/bawes/work/verdict-135-r5.{md,json}`
were read before changes. R5 independently closed H1 and reconfirmed G1/F1/F4.
This amendment addresses only J1 scratch placement and J2 documentation.
It is writer evidence, not independent exact-head PASS or live acceptance.

A2 remains CLOSED at repository scope / OPEN at host scope; A3/A4/A5/A7
remain PARTIAL; A6 remains OPEN. The A2–A7 table and operational wrapper
are byte-identical to the starting head.

## J1 differential proof

The only production change is `temp_dir: w.workspace_state_dir` →
`temp_dir: '/tmp'` in the capability-preflight spec. All five probes still run
as the service identity with their original checks. No observation, baseline,
custody, guard, refusal code, or skip allowance changes. Scratch creation is
still within the observed action; no watched write is exempted. A spec whose
watched root contains `/tmp` still refuses these writes; no universal-spec or
live-host success claim is made.

The opt-in fixture model reads the destination from each actual generated
service-identity probe script. It physically creates a private directory,
writes and reads back a file, then removes the directory in translated disposable
storage, for each of the five probes. It models their filesystem effects, not
execution of cvtsudoers, systemd-analyze, flock or the socket probe on a host.
It is enabled before install/start as well as during gate-off, so the recorded
start baseline is exercised with the prerequisite effects present throughout.

| Same clean-receipt regression | Real scratch directories during gate-off | Outcome |
| --- | ---: | --- |
| Original production source at starting head | 5 | SHU251_PROVIDER_GATE_OFF |
| Amended source | 5 | ok=true, ticks=3, writes=0, before==after |
| Named mutation restoring original scratch placement | 5 | SHU251_PROVIDER_GATE_OFF; killed by J1_PREREQUISITE_RECEIPT_REQUIRED |

The pre-change run reproduced the refusal before production was edited. The
shipped reversal mutation also runs the identical positive test in an isolated
copy, requires a passing control, one exact replacement, syntax success, exactly
one assertion failure, and the five-directory named-refusal diagnostic. Thus a
syntax error or unrelated refusal cannot count as the mutation kill.

The new H1 regression injects nine positions into each of the two watched roots:
pre-action, pre-action transient create/delete, git preflight, gh preflight,
first readiness, watcher registration, baseline scan, poll, final readiness.
All **18** physically land one scheduled write, read its bytes back, encounter
**zero conflicts**, and refuse **SHU251_PROVIDER_GATE_OFF**. Eight cases refuse
at the recorded-baseline comparison before capability preflight; the other ten
also complete all five scratch create/remove effects during gate-off. Each
case already completed ten prerequisite scratch directories during install/start.
Existing H1 regressions and all four H1 mutations remain intact.

The existing scratch-destination assertion now requires exactly 20 generated
probes across its four steps (previously merely nonempty), all pointing to `/tmp`,
none to workspace state or root-only evidence. This updates the expected path
and strengthens the count; it does not remove the service-writable-storage check.

## J2 wording

R4-AMEND-VALIDATION and HOST-LIFECYCLE now qualify the pre-resumption baseline
comparison: **when a start receipt exists**. The R4 residual paragraph also
states that if it is absent, resumption returns before the later order check.
No unconditional comparison is claimed and no runtime behavior changes for J2.
The older R4 validation record is explicitly historical, with a pointer here.

## Verification

Node v22.22.3. Commands match the R4 record, using
`node_modules/.cache/shu251-r5-amend` for logs and disposable storage:

```sh
chmod -R go-w .github/coordinator
umask 0002
export SHU251_NO_SYSTEMD=1
export TMPDIR="$PWD/node_modules/.cache/shu251-r5-amend/tmp"
node --test .github/coordinator/service/test/{host-lifecycle,production-lifecycle,phase-a-driver,host-window-bindings}.test.mjs
node --test --test-name-pattern=mutation .github/coordinator/service/test/{host-lifecycle,production-lifecycle,phase-a-driver,host-window-bindings}.test.mjs
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/.cache/shu251-r5-amend/full-tmp"
unshare --user --map-current-user --mount --keep-caps /bin/sh -c \
  'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' \
  shu251-suite "$PWD/node_modules/.cache/shu251-r5-amend/combined-tmp"
```

| Final run | Tests | Pass | Fail | Skip | Cancelled | Todo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Focused four files | 274 | 274 | 0 | 0 | 0 | 0 |
| Explicit mutations, four files | 118 | 118 | 0 | 0 | 0 | 0 |
| Full service | 475 | 464 | 0 | 11 | 0 | 0 |
| Full coordinator + service | 1616 | 1597 | 0 | 19 | 0 | 0 |

All four commands exited 0. Relative to the starting head: +3 tests/passes
(two regressions and one named mutation); +1 explicit mutation; zero new skips.
Initial test-authoring runs corrected the new test's proof field access and
its expectation that baseline-scan refusal would reach capability preflight;
no existing assertion or skip was weakened to make those runs pass.

G1 remains 853 before + 849 after = **1,702** injections, zero conflicts.
F1 remains **3,098** readiness/restart injections, zero conflicts. The four
G1 mutations reproduce 392/286, 392/286, 702/101, 1/1 ticks/conflicts.
All four H1 mutations still require actualWrites=1, conflicts=0 and a false
successful receipt before crediting the assertion kill. Existing H1 ordinary
regressions still land 22 writes across the two roots and refuse all 22.

The 19 sorted skip lines have unchanged SHA-256
`da2dad94fbc8f6246141f5cdbf2a57525c19831f023e0aeb2b0ff64f82aa6cbe`.
The wrapper blob remains `ed905d66e188af5ee0bf50cc5a212c57bf51553f`.
`host-suite-contract.mjs`, including PERMITTED_SKIPS, remains byte-identical
with SHA-256 `37e8824a22c5bf5c7313305dcb3ca551dd917212f8dff00503dd092e70a3971f`.
The A2–A7 table remains byte-identical. No guard or refusal code was changed;
`git diff --check` passes.

| Retained TAP log (gitignored cache above) | SHA-256 |
| --- | --- |
| focused.tap | 941a0205245a0c6ba52c3a9fa081802484fc00404edf26dc6ae5787fa015abe4 |
| mutations.tap | 9bab1e8fe68fa845d13bcb7940778b9ddc4c46c55b076ea4c5ec8087955148a8 |
| service.tap | 95b25caf9c73b1b1c00dd6f605ec298b786a314d95ea1ff92acff148b19ba1aa |
| full.tap | c1b410ee90499ef6978f7132d6a84535db016c35d789df54881d765d38f8729a |

## Unclosed findings and limits

- F2: executed preflight persists evidence while exempt from the driver's
  mutation-approval flag gate; owner authentication still applies.
- F3: D1/D3/D6/D8/D9/D10 remain historical survivors; pin-only,
  inventory-equality, crossed-environment, strictly-newer-timestamp and redundant
  post-rollback clause coverage gaps are not claimed closed.
- G2: neither observer nor recorded baseline inventories `repo_dir`; concurrent
  external Git writers remain outside this proof.
- G3: M5 and M10 remain disclosed historical survivors. Passing all shipped
  mutations is not exhaustive mutation coverage.
- F5's literal launches count, H2/H3, and R5's informational J3–J6 remain
  unclosed. Distant/common-root recursive watches may be costly or unavailable;
  setup and watcher errors still fail closed.
- No live-host acceptance, real timer timing, actual dispatch-off coordinator
  no-write premise, supervisor-restart filesystem behavior, kernel watch-delivery
  completeness, privileged timestamp manipulation resistance, or evidence/archive
  syscall-level recovery is established. The 11 real-systemd tests remain
  prohibited and skipped. No base-suite rerun or application npm suite is claimed.
- A3 credential isolation; A4 bootstrap/transitional/live systemd behavior;
  A6 unconditional teardown and full recovery/inventory; A7 expiry teardown,
  continuous approval, key provisioning and executing-tool tree binding remain
  unsupported. The conservative since-start baseline is unchanged.

All production-boundary commands are recorded/interpreted; test writes remain
in disposable repository storage. Full suites use a private user/mount namespace
with repository-backed `/tmp` and dropped capabilities. No host access, push,
PR creation/modification, merge, GitHub/Linear comment, activation or deployment
occurred. Final commit SHA is reported in the delivery response.
