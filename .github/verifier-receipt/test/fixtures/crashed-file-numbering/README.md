# The one numbering anomaly `node --test --test-reporter=tap` writes itself

`capture.structure` used to refuse every capture in which a test file died before it could report
anything. On run 35843658922 - a real dispatch, a green `measure` job, a controller that established 41
of 53 terms - the emitter refused the capture with:

    REFUSING: capture.structure: the captured output is not a measurement a runner produced:
      - line 21875: point numbered 100 where the runner would have numbered it 3179

and no receipt was produced. This directory is the measurement that established what that point is, the
minimal reproduction that shows the runtime writing it, and the negatives that must still be refused.

Everything here was measured at **Node v22.22.3**, the runtime `capture-meta.json` records for that run
(`runner_node: v22.22.3`).

## What the point is

`/src/.github/coordinator/test/shu249-role-authority.test.mjs` runs `mkdir '/src/.shu249-tmp'` at module
scope. `/src` is the read-only source mount of the measurement sandbox, so the file dies at import with
`ENOENT`/`EROFS` before registering a single test. This is permanent and deliberate - granting a write to
`/src` is dependency D2 and is refused - so the anomaly is a permanent property of this measurement, not a
flake.

## Why the runner numbers it 100

Read out of the runtime's own sources (`process.binding('natives')['internal/test_runner/...']` at
v22.22.3) and reproduced against it:

1. `createTestFileList` **sorts** the expanded file list - `return ArrayPrototypeSort(results);`
   (`internal/test_runner/runner`). The run's argv was
   `.github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`; sorted, the 52
   `service/test/` files come first, so `test/shu249-role-authority.test.mjs` - 48th of the 70 in its own
   directory - is the **100th of 122** files. Computed at the candidate sha `7e7ac70e`:

       $ node -e "...git ls-tree at 7e7ac70e, both globs, map to /src/..., .sort()..."
       total 122
       ordinal 100
       100th /src/.github/coordinator/test/shu249-role-authority.test.mjs

2. `FileTest.start()` takes the file's number from that order:
   `this.testNumber = ++this.parent.outputSubtestCount;` (`internal/test_runner/test`).

3. Every point a file **reports** is renumbered into the run's global sequence on its way through the
   parent: `item.data.testNumber = isTopLevel ? (this.root.harness.counters.topLevel + 1) : ...`
   (`internal/test_runner/runner`, `#handleReportItem`). That is why the rest of the stream is one
   unbroken sequence.

4. A file's **own** point does not take that path. `Test.report()` emits it with the file's untouched
   `testNumber` - `this.reporter.fail(this.nesting, this.loc, this.testNumber, ...)` - and `FileTest`
   emits it only when `#skipReporting()` is false:

       #skipReporting() {
         return this.#reportedChildren > 0 && (!this.error || this.error.failureType === kSubtestsFailed);
       }

   A file that reported no children at all never satisfies the first clause, so its point is written.

5. `FileTest`'s location is not a call site. Its constructor sets
   `this.loc ??= { line: 1, column: 1, file: resolve(this.name) }`, so a file's own point **always**
   carries `location: '<resolved file>:1:1'`. That is the only thing in the stream that distinguishes a
   file's point from a test declared inside it, and the tolerance rests on it.

6. `Test.report()` calls `countCompletedTest(this)` before emitting, so the runner **counts** the point:
   it is inside the plan total, and every later point is numbered past it. In run 35843658922 the point
   printed `100`, the plan is `1..3652`, and the next point is `ok 3180`. Tolerating the number weakens no
   count - which is why the tolerance is given up the moment any count fails to reconcile.

7. `super.report()` emits a plan for the file only `if (this.outputSubtestCount > 0)`, which a crashed
   file's `FileTest` never satisfies. A file that reported some tests and *then* died does get its own
   buffered plan flushed - `report()` calls `this.drain()` first - and that plan lands at nesting 0,
   immediately before the file's point. That is the shape the earlier D1 capture carried (run 35838458874,
   `1..5` at line 741 followed by `# Subtest: .../closure-environment.test.mjs` and `not ok 5`), and it is
   the shape `negative-the-file-reported-its-own-plan.tap` holds. It is refused.

## The minimal reproduction

`repro/` is two files: one that reports three tests, one that dies at module scope the way shu249 does.

    $ cd .github/verifier-receipt/test/fixtures/crashed-file-numbering/repro
    $ node --test --test-reporter=tap --test-concurrency=1 ./1-reports.test.mjs ./2-crashes.test.mjs
    exit=1

The raw output is committed verbatim as `repro.tap`. Its decisive lines:

    ok 3 - the third point this run reports
    ...
    # Subtest: 2-crashes.test.mjs
    not ok 2 - 2-crashes.test.mjs
      ---
      type: 'test'
      location: '.../repro/2-crashes.test.mjs:1:1'
      ...
    1..4

`not ok 2` where the run's next number is `4`: **2 is the crashing file's position in the sorted list of
two files**, and the plan still counts it. The number is independent of how many points preceded it - a
20-file variant with the crash at sorted position 13 and 4 tests in every other file printed
`not ok 13` before `1..77`.

`emit-receipt.test.mjs` does not read `repro.tap` as gospel: it re-runs `repro/` through the installed
runtime and asserts the shape, so the tolerance stays tied to what the runner actually does.

## What is tolerated, and what is not

A point whose number is not the run's next number is tolerated **only** when all of these hold:

* it is at nesting 0;
* it is `not ok`, carries no TAP directive, and its block says `type: 'test'`;
* its `location:` is `<file>:1:1`, and the point's name names that same file (the runner names a file test
  by the argv path and resolves the location against the cwd, so `not ok 2 - a/b.test.mjs` beside
  `location: '/src/a/b.test.mjs:1:1'` is the same file and is accepted as such);
* the line immediately before it is `# Subtest: <that same name>`;
* no nesting-0 plan line appeared between the previous nesting-0 point and this one;
* it is the first such point for that file;
* and **nothing else in the stream failed**. If any other structural fact broke, every anomaly held aside
  is reported after all, with the same sentence and the same two numbers.

The `negative-*.tap` fixtures are one file per refusal, and each is asserted in `emit-receipt.test.mjs`.

## The real captures

`../captures/run-35843658922-measure.out` is the exact artifact of the refused run, trailer and all.
`../captures/local-in-container-7e7ac70e.out` is the same suite reproduced outside CI, in the same
container flags, from the committed code - it carries the anomaly at line 21860 with the same number, and
its last three lines (`suite_exit=`, `df_before:`, `df_after:`) are the measurement harness's, not the
runner's. Both are asserted to be accepted, and the first is asserted to report exactly
`numbered 100 / global_next 3179` at line 21875 - the numbers of the pre-fix refusal.
