# Ledger concurrency flake validation — 2026-09-14

Clone: `/home/bawes/work/flakefix`; branch: `fix/ledger-flake-future-clock`.
Base HEAD and local `main`: `43c6d923f2f66b303f4851c2f01fa43a86566c75`.
Node: v22.22.3. No production ledger or dispatch configuration changes.

## Root cause

The old test exhausted 100 retries separated by 2 ms while a competing process could still own the ledger lock during durable filesystem writes, so the exact two-reservation/two-capacity-refusal assertion depended on process scheduling even with the shared clock advanced 365 days. That early assertion also masked the split-clock mutant's intended expiry failure, causing its harness to reject the missing named assertion instead.

## Deterministic replacement

Four real child processes acknowledge readiness over IPC. For each transaction,
the test wraps the real `withLock` callback to pause after evaluation but before
the durable write; all remaining claimants must return `SCHEDULER_BUSY` before
the parent releases the owner through stdin. The parent checks the exact ledger
identities after every commit, then requires exactly two reservations and two
`GLOBAL_CAPACITY` refusals. No retry count, startup sleep, or polling interval
selects these outcomes. The test timeout only guards a broken protocol/deadlock.
All ledger readers/writers retain the same injected time and the original named
expiry assertion remains unchanged, as does the SHU-230 mutation harness.

## Commands and results

Prerequisites: `umask 0002`, `chmod -R go-w .github/coordinator`;
`systemd-analyze --version` and executable `/usr/bin/flock` verified.
Dependencies installed with `npm ci --ignore-scripts` (exit 0).
The full coordinator command always included both globs:

```sh
SHU_TEST_CLOCK_OFFSET_MS=31536000000 \
NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs" \
node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
```

This uses the same offset and preload as `coordinator-future-clock` in CI.
Every row is a separate full-suite invocation; counts are not combined.

| Run | Tests | Passed | Failed | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unchanged future clock 1 | 897 | 890 | 0 | 7 | 0 |
| Unchanged future clock 2 | 897 | 890 | 0 | 7 | 0 |
| Unchanged future clock 3 | 897 | 890 | 0 | 7 | 0 |
| Unchanged future clock 4 | 897 | 890 | 0 | 7 | 0 |
| Unchanged future clock 5 | 897 | 890 | 0 | 7 | 0 |
| Fixed future clock 1 | 897 | 890 | 0 | 7 | 0 |
| Fixed future clock 2 | 897 | 890 | 0 | 7 | 0 |
| Fixed future clock 3 | 897 | 890 | 0 | 7 | 0 |
| Fixed normal clock | 897 | 890 | 0 | 7 | 0 |

The three fixed future-clock runs were consecutive and all passed; the normal
run followed them using the same `node --test` command without the two clock
environment variables. Both named SHU-230 mutation checks passed in each run.

The spontaneous baseline failure rate was **0/5**; these local runs did not
reproduce the intermittent CI failure without an induced scheduling pause.
To reproduce its mechanism, a temporary copy of the original test inserted
this wrapper in its child script, immediately before scheduler construction:

```js
const withLock = CapacityScheduler.prototype.withLock;
CapacityScheduler.prototype.withLock = function (operation) {
  return withLock.call(this, (state) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    return operation(state);
  });
};
```

This only models a process suspended inside the real lock; it does not change
ledger decisions, capacity, or clocks. Three separate future-clock runs of the
original test and its split-clock mutation harness, selected with
`--test-name-pattern='four concurrent processes|split process clocks'`, each
reported **2 tests, 0 passed, 2 failed, exit 1** (induced reproduction **3/3**).
The concurrency failure was `AssertionError`, expected `2`, actual `1`.
The mutation harness then failed its assertion-text check, expected `true`,
actual `false`, because the nested test failed with `1 !== 2` before reaching
`shared clock must preserve both reservations`.

An additional full-suite induced reproduction initially used only a copied
coordinator directory: 897 tests, 882 passed, 8 failed, 7 skipped, exit 1.
It reproduced tests 153 and 316 with the same assertions above, plus six
fixture-layout failures: missing root package/contract/workflow files (tests
26, 34, 330, 331, 332) and missing Git revision context (test 769). This is
not counted as an unchanged baseline or a stability run.

Repeating that induced full-suite run in a complete local fixture cloned from
the baseline commit, with umask 0002 and the same chmod, offset, preload, and
both globs, reported **897 tests, 888 passed, 2 failed, 7 skipped, exit 1**.
Only tests **153** and **316** failed, reproducing exactly the reported pair
and assertions; the six fixture-layout failures disappeared.

Root `npm test` was run separately with the normal clock and umask 0002: exit 0.
Its Node test stages passed: main 258, deployment 58, web 15, documents 19,
hardening 10, observability 15, lifecycle 25, and R2 7 (407 total); Vitest
reported 27 passes. Its standalone
mutation stages killed 10/10, 3/3, 17/17, 10/10, 17/17, and 22/22 mutants,
respectively, and its synthetic observability exercise completed successfully.
These counts are separate from every coordinator invocation.

## Mutation evidence

The existing future-clock mutation harness passed in the candidate copy:
3 tests, 3 passed, 0 failed. A direct run of the split-clock mutant with the
new deterministic test exited 1 with 1 test and 1 failure:

```text
error: shared clock must preserve both reservations
       0 !== 2
code: 'ERR_ASSERTION'
name: 'AssertionError'
expected: 2
actual: 0
```

Additional temporary negative controls each ran the focused deterministic test
and exited 1 with 1 test and 1 failure:

- Removing lock acquisition/release died at
  `concurrent claimants must not enter an uncommitted ledger transaction`.
- Removing only the global-capacity check died at the exact two
  `GLOBAL_CAPACITY` outcomes assertion (0 instead of 2).
- Removing both global-capacity and writer-reserve bounds died at
  `each committed transaction must preserve its predecessors without oversubscribing two slots`.

Temporary mutations were never applied to this clone. Raw logs and temporary
reproductions are under `/tmp/ledger-flake-results` (local, not committed).

## Limits and boundaries

Six coordinator tests skipped because this account cannot perform the distinct
worker-UID proofs; one skipped because production vocabulary has no undeclared
runtime/role pair. No attempt was made to obtain additional privileges.
No push, PR, deployment, Coolify action, remote host or `/srv` access was
performed; neither `enable_dispatch` nor `dispatch_scope` was changed.
The base comparison uses local `main`; no remote fetch was performed.
