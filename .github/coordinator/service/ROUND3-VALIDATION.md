# Round-3 operational routing validation

The shell entrypoint now admits the nine reviewed lifecycle actions:
preflight, install, start, readiness, restart, host-rollback, pin, pin-restore,
and pin-retain. It dispatches those actions to the reviewed Phase-A driver with
an absolute **driver spec**, while the nine legacy actions still take exactly
an action and an absolute **window spec** and use host-window-bindings.mjs.
Lifecycle flags are parsed by the driver's existing closed flag parser.

An authorized lifecycle invocation is:

```sh
SHU251_HOST_MUTATION_APPROVED=true \
.github/coordinator/service/shu251-operational-bindings.sh install \
/absolute/driver-spec.json --execute --approved-host-mutation APPROVED_SHA
```

This command is documentation only; validation did not execute a host window.
The call path is shell lifecycle allowlist → phase-a-driver.main → drive →
approval → defaultIO.lifecycleProvider → defaultIO.pin →
createProductionLifecycle from the fixed ./production-lifecycle.mjs import →
executeLifecycle. There is no provider-selection flag or operator implementation.
The driver rejects --provider with SHU251_DRIVER_USAGE. Without --execute it
returns a plan after approval checks; the wrapper does not manufacture approval.

The existing typed contract, journal, lifecycle guards, error codes, fake-based
suite and enable_dispatch configuration are unchanged. The additional wrapper
test uses approved dry runs and early refusals, never the production host
boundary. Existing production-provider tests translate filesystem operations
into disposable storage and interpret commands with recorded responses.

Executed unknown-action check:

```sh
.github/coordinator/service/shu251-operational-bindings.sh untested-new-action "$PWD/node_modules/round3/unused-spec.json"
printf 'exit=%s\n' "$?"
```

```text
{"ok":false,"code":"SHU251_WINDOW_ACTION","reason":"unknown typed action"}
exit=64
```

The existing complete routing assertion checks disjoint reviewed sets, their
exact union with ACTIONS, the exact reviewed LIFECYCLE_ACTIONS map, and successful
routes and expected bindings for both sets. The legacy call-sequence assertion
also checks which binding runs. Named mutations remove a registered action,
introduce overlap, substitute either routing path, and introduce an untested
action into either exported registry. Each named mutation requires a passing
matched control, a clean syntax check and exactly one named assertion failure.
The lifecycle suite's registry-derived receipt-set assertion is preserved.

All temporary storage and scratch checkouts are under node_modules/round3.
Complete suites bind repository-backed storage onto /tmp in a private user/mount
namespace and drop capabilities. No real host window, service mutation, remote
Git push or PR operation was performed. chmod -R go-w .github/coordinator and
umask 0002 were applied before suites.

Focused tests include host-lifecycle.test.mjs, phase-a-driver.test.mjs,
production-lifecycle.test.mjs and host-window-bindings.test.mjs. The first run
exposed a missing dry-run approval in the new test; the fixture was corrected,
with no change to the approval guard. Final counts below supersede that run.

## Full-suite and registry-injection commands

The scratch checkout is a depth-1, single-branch local clone; changed executable
and test files are overlaid. Each registry starts from the same unmodified driver.
The following is the executed runner (the initial full run preceded the fixture
correction; the final full rerun is recorded below).

```sh
#!/bin/bash
set -u
cd /home/bawes/work/shu251-executor
umask 0002
run_suite() {
  local label="$1" checkout="$2"
  mkdir -p "$PWD/node_modules/round3/tmp-$label"
  chmod 700 "$PWD/node_modules/round3/tmp-$label"
  chmod -R go-w "$checkout/.github/coordinator"
  unshare --user --map-current-user --mount --keep-caps /bin/sh -c '
    mount --bind "$1" /tmp && cd "$2" &&
    TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
  ' round3 "$PWD/node_modules/round3/tmp-$label" "$checkout" > "node_modules/round3/logs/$label.log" 2>&1
  echo "$label exit=$?"
  tail -9 "node_modules/round3/logs/$label.log"
}
run_suite full "$PWD"
git clone --quiet --no-hardlinks . node_modules/round3/base
git -C node_modules/round3/base checkout --quiet 00eb979
run_suite base "$PWD/node_modules/round3/base"
git clone --quiet --depth 1 --single-branch --branch fix/shu251-typed-host-lifecycle-executor "file://$PWD" node_modules/round3/scratch
cp .github/coordinator/service/shu251-operational-bindings.sh node_modules/round3/scratch/.github/coordinator/service/
cp .github/coordinator/service/test/{host-window-bindings,phase-a-driver}.test.mjs node_modules/round3/scratch/.github/coordinator/service/test/
run_suite shallow "$PWD/node_modules/round3/scratch"
export SHU_TEST_CLOCK_OFFSET_MS=31536000000
export NODE_OPTIONS="--import=$PWD/node_modules/round3/scratch/.github/coordinator/test/fixture/shift-wall-clock.mjs"
run_suite future "$PWD/node_modules/round3/scratch"
unset SHU_TEST_CLOCK_OFFSET_MS NODE_OPTIONS
cp node_modules/round3/scratch/.github/coordinator/service/phase-a-driver.mjs node_modules/round3/driver-original.mjs
for registry in ACTIONS LIFECYCLE_ACTIONS; do
  cp node_modules/round3/driver-original.mjs node_modules/round3/scratch/.github/coordinator/service/phase-a-driver.mjs
  REGISTRY="$registry" python3 - <<'PY'
import os
from pathlib import Path
p = Path('node_modules/round3/scratch/.github/coordinator/service/phase-a-driver.mjs')
s = p.read_text()
needle = 'export const ' + os.environ['REGISTRY'] + ' = Object.freeze({'
assert s.count(needle) == 1
p.write_text(s.replace(needle, needle + " 'untested-new-action': 'untested_new_action',"))
PY
  node --check node_modules/round3/scratch/.github/coordinator/service/phase-a-driver.mjs
  echo "$registry node --check exit=$?"
  run_suite "injection-$registry" "$PWD/node_modules/round3/scratch"
done
```

Final corrected full-suite rerun:

```sh
umask 0002
chmod -R go-w .github/coordinator
mkdir -p node_modules/round3/tmp-final
chmod 700 node_modules/round3/tmp-final
unshare --user --map-current-user --mount --keep-caps /bin/sh -c 'mount --bind "$1" /tmp && TMPDIR=/tmp setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs' round3 "$PWD/node_modules/round3/tmp-final" > node_modules/round3/logs/final-full.log 2>&1
```

Corrected focused rerun:

```sh
chmod -R go-w .github/coordinator
umask 0002
TMPDIR="$PWD/node_modules/round3/tmp" node --test .github/coordinator/service/test/host-lifecycle.test.mjs .github/coordinator/service/test/phase-a-driver.test.mjs .github/coordinator/service/test/production-lifecycle.test.mjs .github/coordinator/service/test/host-window-bindings.test.mjs > node_modules/round3/logs/focused.log 2>&1
```

The focused run passes all 75 named mutations: lifecycle 37, provider 20,
routing 6 and existing Phase-A 12. All mutation test files are also included
in each complete coordinator/service suite; no test-name filter is applied.
Scratch clones use only local Git objects and the branch under review.
The normal shallow checkout matched all three changed code/test files byte for
byte before registry injections. No main branch is present in that clone.

## Executed results

| Run | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Focused | 196 | 196 | 0 | 0 |
| Base 00eb979 full | 1388 | 1380 | 0 | 8 |
| Final full | 1538 | 1530 | 0 | 8 |
| Shallow full | 1538 | 1530 | 0 | 8 |
| Shallow future-clock full | 1538 | 1530 | 0 | 8 |
| ACTIONS injection full | 1538 | 1523 | 7 | 8 |
| LIFECYCLE_ACTIONS injection full | 1538 | 1522 | 8 | 8 |

All runs have zero cancelled and zero todo tests. The final suite adds two tests
to round-2 HEAD (1536 → 1538): the wrapper test and lifecycle-registry mutation.
The eight skip names and reasons compare exactly equal against freshly executed
base 00eb979 in every complete run, including both injected copies:

```text
READER operator-owned checkout read by non-root account # SKIP Not exercisable: non-root account, no passwordless elevation to create root-owned checkout
SHU-227: empty-root main drives real Git, both real adapters and real broker through four launches # SKIP requires distinct-uid execution
SHU-227: non-owner service account resolves revision with no global Git trust # SKIP requires distinct-uid execution
SHU-227: worker owns its checkout and recovery preserves descendant commits # SKIP requires root or passwordless sudo for distinct-uid proof
SHU-228: empty-root main drives real Git, both real adapters and real broker through four launches # SKIP requires distinct-uid execution
SHU-241 A2 host: R1 uses the existing bundle transport through the distinct worker identity # SKIP host cannot switch to the fixture worker uid
SHU-244 A10: distinct-root scoped handoff production workspace # SKIP host cannot switch worker uid
SHU-71 restricted capability refusal # SKIP production vocabulary has no undeclared runtime/role pair
```

Property-4 injection command output (from run-summary.log):

```text
ACTIONS node --check exit=0
injection-ACTIONS exit=1
1..1533
# tests 1538
# suites 0
# pass 1523
# fail 7
# cancelled 0
# skipped 8
# todo 0
# duration_ms 57277.552817
LIFECYCLE_ACTIONS node --check exit=0
injection-LIFECYCLE_ACTIONS exit=1
1..1533
# tests 1538
# suites 0
# pass 1522
# fail 8
# cancelled 0
# skipped 8
# todo 0
# duration_ms 56382.917675
```

Direct ACTIONS assertion output:

```text
not ok 279 - ROUTING complete disjoint registry and intended routes
  ---
  duration_ms: 1.894132
  type: 'test'
  location: '/home/bawes/work/shu251-executor/node_modules/round3/scratch/.github/coordinator/service/test/phase-a-driver.test.mjs:309:1'
  failureType: 'testCodeFailure'
  error: |-
    ROUTING_COMPLETE_REQUIRED
    + actual - expected
    ... Skipped lines
    
      [
        'capture-prior',
        'cleanup',
        'host-rollback',
        'install',
    ...
        'transport',
    -   'untested-new-action',
        'worker'
      ]
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
```

The ACTIONS run has one direct routing failure plus six routing mutation tests
whose matched controls correctly fail in the already-corrupted copy. Those six
are not independent mutant kills. The permanent named mutations pass on the
unmodified source and each kill their own syntax-clean mutation.

The lifecycle injection additionally fails the preserved registry-derived
receipt-set assertion:

```text
not ok 53 - LIFECYCLE complete fake-only typed action control
  ---
  duration_ms: 58.573795
  type: 'test'
  location: '/home/bawes/work/shu251-executor/node_modules/round3/scratch/.github/coordinator/service/test/host-lifecycle.test.mjs:18:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    ... Skipped lines
    
    + Set(9) {
    - Set(10) {
        'host-rollback',
        'install',
        'pin',
        'pin-restore',
        'pin-retain',
    ...
        'start',
    -   'untested-new-action'
      }
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
```

## Evidence limits

These results establish repository routing, guards and fake-boundary behavior.
They do not establish successful deployment or acceptance on a real host; no
such window was attempted. The eight pre-existing skips remain unexercised for
the exact reasons above. No claim is made to have rerun unrelated application
npm suites; the complete suites here are the coordinator and service suites
specified by the lane briefs. Raw logs and scratch experiments remain locally
under node_modules/round3, and are not committed.
