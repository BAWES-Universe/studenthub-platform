# Two-fixture revision reader (Track 1)

Author lane: Codex/GPT. Base: `3bb2c9689a23bd582a7c8edd5e980c58f00e2c82`.

The two-fixture local `readRef` now resolves `dir` with `fs.realpathSync`, walks
up to the first `.git`, and supplies `-c safe.directory=${checkoutRoot}` inline to Git.
An unresolved root returns null before Git runs. Exceptions still return null.
The broker arguments/environment, 10-second timeout, encoding and stdio remain
intact. The other Git reader, `resolveCoordinatorRevision`, already had this
protection and needs no change. Execution binding checks are unchanged.
No wildcard trust or persistent Git trust configuration is introduced.

Tests use unsigned in-memory records with both gates false. Positive reader
controls reach `ACT_PARTIAL_ARMING`, the check immediately after execution
binding; they do not claim signed activation or dispatch success. No new test
creates signatures or accesses credentials.

| Required case | Exercise and result |
| --- | --- |
| Operator-owned checkout | **Not exercisable here:** UID 1000, no passwordless elevation to create a root-owned checkout. The explicit capability test is skipped. Its root-capable branch checks real Git as UID/GID 65534. Separately, Git's `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` hook rejects the untrusted read and the production status reader successfully passes binding with inline trust. This hook is not claimed as a real second-user test. |
| Missing trust | Existing directory without `.git` ancestors and nonexistent directory both refuse with `ACT_EXECUTION_REVISION_WRONG`; intercepted Git receives zero calls even when it would return a plausible SHA. |
| Wrong checkout | Two real temporary repositories with different commits; substituted repository refuses with `ACT_EXECUTION_REVISION_WRONG`. |
| Stale main | Real detached HEAD advances while main stays at the old commit; record names new HEAD and receives `ACT_EXECUTION_REVISION_WRONG`. |
| Checkout drift | Same real detached advance, record still names main; receives `ACT_CHECKOUT_DRIFT`. |
| Directory substitution | Different repository refuses; nested directory in the bound checkout passes binding. A symlink to a nested directory also proves realpath and root walk-up. |

Additional assertions pin the complete Git argument list and options, so trust
cannot come from ambient configuration, use a wildcard, or name the nested
subdirectory instead of its repository root. A thrown Git error refuses.

Every new test name:

- READER inline trust is exact and walks real nested checkout root
- READER missing root fails closed without invoking git
- READER git failure returns null and refuses
- READER ownership rejection hook requires inline trust
- READER operator-owned checkout read by non-root account
- READER wrong checkout and directory substitution retain binding
- READER stale main ref refuses execution revision
- READER checkout drift refuses observed revision
- READER mutation: drop inline exception
- READER mutation: wildcard trust
- READER mutation: permissive unresolved-root fallback
- READER mutation: skip root walk-up

Each mutation has a matched unmutated control with exactly **1 pass / 0 fail**,
exactly one unique textual replacement, and successful `node --check`. Each
mutant must have exactly one failure containing `name: 'AssertionError'`,
`code: 'ERR_ASSERTION'`, and `failureType: 'testCodeFailure'`. SyntaxError,
TypeError and ERR_MODULE_NOT_FOUND are rejected as kills.

| Mutation | Exact named AssertionError message |
| --- | --- |
| drop inline exception | `READER_OWNERSHIP: inline trust must resolve main under ownership rejection` |
| wildcard trust | `READER_EXACT_TRUST: inline exception must name only the real walked checkout root` |
| permissive unresolved-root fallback | `READER_NO_ROOT: unresolved root must refuse` |
| skip root walk-up | `READER_EXACT_TRUST: inline exception must name only the real walked checkout root` |

The unresolved-root mutant breaks the traversal at the filesystem root and
continues into Git; the injected successful read proves this fallback is caught
by the refusal assertion rather than an incidental Git error.

Verification (after `chmod -R go-w .github/coordinator`):

```sh
TMPDIR=/tmp node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
TMPDIR=/tmp SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs" npm run test:coordinator
```

No existing test file changes: the test-name multiset delta is precisely the
12 names above, each added once, with zero removed names. Removed lines matching
`assert|expect|throw` versus main: **0**. An initial run exposed an existing
mutation's unique textual anchor being duplicated; naming the new local
`checkoutRoot` preserves that original test and its unique anchor unchanged.

`.github/coordinator/config.json` blob before (main and working file):
`8a0317173d76f4c09811b9365e25b380b38dc93d`.
After: `8a0317173d76f4c09811b9365e25b380b38dc93d` (byte-identical).
Only the three reserved files are changed. No service or workflow file changes.

Final results for **each** invocation: **1275 tests / 1267 pass / 0 fail /
8 skipped**. Baseline: 1263 / 1256 / 0 / 7. The extra skip is the explicit
operator-owned checkout capability case described above; the other seven are
unchanged environment-capability skips. All four named mutation tests passed.
