# Test runner

Run commands from the repository root with Node 22 or newer (the engine in
[root package.json](../../package.json)). That file defines both entry points:

| Command | Script |
| --- | --- |
| `npm test` | `npm run build && node tools/test-runner/run.mjs` |
| `npm run test:db` | `npm run build && node tools/test-runner/run.mjs --db` |

Both build before discovery. [CI's application-checks job](../../.github/workflows/ci.yml)
calls both scripts, after installation and typecheck, and supplies PostgreSQL 17
and `DATABASE_URL` for the database suite. Use a disposable database for that
suite; see the [running-tests guide](../../docs/runbooks/running-tests.md).

## Discovery and baseline

[discover.mjs](discover.mjs) exports `discover(root = process.cwd())`. It parses
the root package metadata and requires `dist` to exist, then recursively scans
`dist`, `apps`, `packages`, `tools` and `deploy/coolify/test`. Missing optional
directories contribute no files; other read errors propagate. Paths use forward
slashes and each group is sorted with `localeCompare`.

The groups below are defined by the filters in [discover.mjs](discover.mjs).
Patterns describe conventions, rather than shell commands to run:

| Group | Files selected |
| --- | --- |
| `runnerTests` | `tools/test-runner/test/**/*.test.mjs` |
| `runnerMutationTests` | `tools/test-runner/test/**/*-mutations.mjs` |
| `assertionTests` | TypeScript `.test.ts` files under `packages/actor-assertion/test` |
| `exerciseTests` | `tools/observability/synthetic-exercise.mjs`, when present |
| `nodeTests` | Compiled `.test.js` under `dist/{apps,packages,tools}/…/test/…`, plus source `.test.mjs` under apps/packages test directories; exceptions below |
| `mutationTests` | Apps/packages test scripts whose basename contains `mutations` and ends in `.mjs`, excluding `.test.mjs` and the database package |
| `documentTests` | Private-document source `.test.mjs` files, excluding `r2-postgres.test.mjs` |
| `deploymentTests` | `.test.mjs` files below `deploy/coolify/test` |
| `dbTests` | Compiled database tests whose path starts `dist/packages/db/test/postgres-` |
| `dbNodeTests` | Other compiled database tests and source database `.test.mjs` files |
| `dbMutationTests` | Database mutation scripts using the basename convention above |
| `dbDocumentTests` | `packages/private-documents/test/r2-postgres.test.mjs`, when present |

`nodeTests` excludes all compiled database tests, the compiled actor-assertion
test and the compiled Typesense integration test. Its source selection excludes
database and private-document tests; general source `.mjs` tests under `tools`
are not included. The separate search command is `npm run test:search-integration`
in [root package.json](../../package.json).

[discover.mjs](discover.mjs) rejects empty overall discovery and paths appearing
in multiple groups through `assertRunnableDiscovery`. Within the runner's own
test directory it also rejects unclassified filenames with test/spec/mutation
tokens, case-insensitively; ordinary helper filenames remain allowed. These
behaviors are exercised in [test/discover.test.mjs](test/discover.test.mjs).

[baseline.json](baseline.json) records required paths by discovery group.
`loadBaseline` reads it and `assertBaseline` checks that each listed group exists
and every required path is still discovered in that group. This prevents tracked
coverage from silently disappearing after moves, deletions or naming changes.
It is a minimum inventory, **not an exact allowlist**: additional conventional
tests are discovered without an equality check against the baseline. Maintain
the appropriate baseline group when adding or moving coverage so it is protected
against later disappearance. The implementation and missing-file test are in
[discover.mjs](discover.mjs) and [test/discover.test.mjs](test/discover.test.mjs).

## Planning and execution

[run.mjs](run.mjs) exports `buildRunPlan`, `runDiscovered` and `runTests`.
`buildRunPlan(discovered, { db = false } = {})` only returns command/argument
objects. Empty groups do not create Node invocations, preventing accidental
implicit test discovery. In default mode its order is:

1. Runner tests, then runner mutation scripts.
2. General Node tests and mutation scripts, excluding the deferred groups below.
3. Actor-assertion tests through `npx --no-install vitest run`.
4. Deployment tests, then the gateway web-ui/context-navigation/company-directory
   tests and the context-navigation/company-directory mutation scripts.
5. Private-document tests and mutations, excluding late lifecycle entries.
6. Observability tests, mutations and the synthetic exercise.
7. Candidate-lifecycle and R2-lifecycle document tests, then candidate-lifecycle
   mutations.

With `--db`, [run.mjs](run.mjs) selects only `dbTests` (Node's test runner with
`--test-concurrency=1`), `dbNodeTests`, individual `dbMutationTests` scripts, then
`dbDocumentTests`, in that order. Other Node test groups use `--test` without that
concurrency flag. Mutation scripts and the exercise run directly with the current
Node executable. Both modes validate the **whole** discovery and baseline before
spawning, including groups outside the selected mode.

`runDiscovered` logs each exact command via `formatRun`, executes each plan step
sequentially with the chosen root as working directory and inherited stdio, and
fails on spawn errors, nonzero exits or signal termination. `runTests` performs
discovery and baseline loading first. Importing [run.mjs](run.mjs) does not run
tests; its direct CLI entry calls `runTests` and detects `--db` in the arguments.
[test/run.test.mjs](test/run.test.mjs) imports these exports to check ordering,
empty groups, validation and failure handling with injected subprocess behavior.
[test/discover-mutations.mjs](test/discover-mutations.mjs) checks deliberate
discovery/runner regressions; [test/ci-workflow.test.mjs](test/ci-workflow.test.mjs)
checks the CI call sites.

The additional `discoverMigrations` export in [discover.mjs](discover.mjs)
returns sorted SQL basenames from the migration directory. It is tested by
[test/discover.test.mjs](test/discover.test.mjs); [run.mjs](run.mjs) does not call
it or use it to apply migrations.

## Verification for this documentation

Checks performed on 2026-11-22 against the source at this PR's base:

| Command/check | Result |
| --- | --- |
| `npm ci` | Passed in WSL with Node 22 |
| `npm run typecheck` | Passed on Windows with Node 24 |
| `npm test` on Windows | Build passed; runner tests failed on CRLF-sensitive CI workflow parsing and a denied symlink operation; the full plan did not finish |
| `node --test tools/test-runner/test/*.test.mjs` in WSL | Passed: 22 tests |
| `node tools/test-runner/test/discover-mutations.mjs` in WSL | Passed |
| Relative-link/base-path verification | Passed: 20 links, 10 distinct source files |
| `npm run test:db` locally | Not run: no disposable PostgreSQL instance was provisioned for this documentation task; CI supplies one |
| `npm run test:search-integration` | Not run: separate external-service suite, outside this documentation change |

The PR's Evidence section records the full WSL `npm test` and CI results.
No runtime files or baseline entries are changed here.
