# Running StudentHub Platform tests

Run commands from the repository root. Use Node 22 to match CI and install the locked dependencies with `npm ci` before building. The root [package.json](../../package.json) defines the scripts. [Platform CI](../../.github/workflows/ci.yml) defines the CI environment.

For a routine change, start with `npm run typecheck` and `npm test`. Run `npm run test:db` against a disposable database for database or migration changes. For a focused check, use the tables below. Run `npm run build` first if the script reads compiled files under `dist/`; `test`, `test:db`, and `test:search-integration` build automatically.

## Root scripts

Run `test` as `npm test`. Run the other names with `npm run <script>`. Every row comes from the `scripts` object in [package.json](../../package.json).

| Script | What it runs |
| --- | --- |
| `build` | Builds the prerequisite workspaces, then compiles the platform with `tsconfig.build.json`. |
| `typecheck` | Builds the same prerequisite workspaces, then checks TypeScript with `tsc --noEmit`. |
| `test` | Builds and runs the default discovery plan, including web, documents, deployment, observability, and mutation checks. |
| `test:db` | Builds and runs the database discovery plan. See the PostgreSQL setup below. |
| `test:web` | Runs the compiled gateway UI, context navigation, and company directory tests, then the navigation and directory mutation scripts. |
| `test:assertion` | Runs the actor assertion tests with Vitest. |
| `test:coordinator` | Runs the coordinator core and service Node tests. See [CI setup](../../.github/workflows/ci.yml) for Linux host prerequisites. |
| `test:deployment` | Runs the Coolify deployment Node tests. |
| `test:search-integration` | Builds and runs the Typesense integration test. Use a disposable Typesense service as in [Search adapter parity](../../.github/workflows/search-adapter.yml). |
| `test:documents` | Runs the private documents test. |
| `test:documents:hardening` | Runs the private document hardening test. |
| `test:documents:r2:postgres` | Runs the R2 PostgreSQL store test with a disposable database. |
| `test:documents:r2` | Runs the R2 lifecycle test. |
| `test:documents:lifecycle` | Runs the candidate document lifecycle test. |
| `test:observability` | Runs the compiled observability Node test. |

Each of these scripts runs a focused mutation check against its named behavior.

| Script | Behavior checked |
| --- | --- |
| `test:catalogue:mutations` | Reference catalogue behavior |
| `test:catalogue-bank-payment-details:mutations` | Catalogue bank payment details |
| `test:catalogue-currency-details:mutations` | Catalogue currency details |
| `test:profile-records:mutations` | Profile records |
| `test:profile:mutations` | Profile behavior |
| `test:idempotency:mutations` | Idempotency contract |
| `test:organizations:mutations` | Organization behavior |
| `test:organization-profile:mutations` | Organization profile writes |
| `test:organization-status:mutations` | Organization status writes |
| `test:organization-status-batch:mutations` | Batch status reads |
| `test:organization-status-events:mutations` | Organization status events |
| `test:organization-commercial-terms:mutations` | Commercial terms writes |
| `test:organization-documents:mutations` | Organization documents through the gateway |
| `test:organization-directory:mutations` | Organization directory |
| `test:organization-approved-to-hire:mutations` | Approval-to-hire writes |
| `test:organization-notes:mutations` | Organization notes |
| `test:organization-note-types:mutations` | Organization note types |
| `test:organization-brands:mutations` | Organization brands |
| `test:organization-stores:mutations` | Organization stores |
| `test:organization-creation:mutations` | Organization creation |
| `test:organization-account-manager:mutations` | Account manager writes |
| `test:organization-deletion:mutations` | Organization deletion writes |
| `test:pay-contracts:mutations` | Pay contract behavior |
| `test:pay-contract-writes:mutations` | Pay contract writes |
| `test:pay-contract-changes:mutations` | Pay contract changes |
| `test:pay-contract-reads:mutations` | Pay contract reads |
| `test:documents:mutations` | Private documents |
| `test:documents:hardening:mutations` | Private document hardening |
| `test:documents:deletion:mutations` | Organization document deletion |
| `test:documents:lifecycle:mutations` | Candidate document lifecycle |
| `test:observability:mutations` | Observability behavior |

## How discovery works

[discover.mjs](../../tools/test-runner/discover.mjs) scans compiled `*.test.js` files under `dist/apps`, `dist/packages`, and `dist/tools`, plus source tests and mutation scripts in designated directories. It groups suites by how they run. For example, actor assertion tests use Vitest, and the compiled `dist/packages/db/test/postgres-*.test.js` files go in `dbTests`. [run.mjs](../../tools/test-runner/run.mjs) checks those groups before starting any tests, then runs the default or database plan. The stand-alone Typesense and coordinator suites have their own scripts.

Add each new runner-managed test to the matching group in [baseline.json](../../tools/test-runner/baseline.json). For a TypeScript test, record its compiled path when the group expects one. Discovery can pick up a file before it is in the baseline. The baseline makes that file mandatory so a rename, exclusion, or build regression cannot silently drop it. A listed file missing from its group fails the run. Use an existing entry of the same kind as a model, and run the matching root suite to verify discovery.

## Disposable PostgreSQL 17

Use a fresh UTF-8 PostgreSQL 17 database with synthetic fixtures. [Platform CI](../../.github/workflows/ci.yml) uses `postgres:17-alpine`. PostgreSQL 16 lacks the built-in `pg_c_utf8` collation used by [the person profiles migration](../../packages/db/migrations/0211_person_profiles.sql), so applying that migration fails there.

Set `DATABASE_URL` in the shell running the tests to your disposable database. For example, a local connection string can have the form `postgresql://test_user:<local-password>@127.0.0.1:55432/studenthub_test`. Substitute the database, user, password, and port for your scratch instance. Keep the connection string out of Git and point it only at a database you can discard.

`npm run test:db` includes the PostgreSQL suites (run serially), the other database Node tests, database mutation scripts, and the R2 PostgreSQL document test. `npm run test:documents:r2:postgres` selects that R2 store test alone. See [run.mjs](../../tools/test-runner/run.mjs) and [r2-postgres.test.mjs](../../packages/private-documents/test/r2-postgres.test.mjs). A skipped database test is not database verification.

The root [.gitignore](../../.gitignore) ignores `*.sql`. When a change adds an intended migration, stage that specific file with `git add -f` and verify the staged path. Apply this only to the new migration file.

## What runs on a pull request

| Source | Jobs and when they run |
| --- | --- |
| [Platform CI](../../.github/workflows/ci.yml) | Ordinary PRs run `application-checks` (typecheck, default and DB tests, build, Compose validation), `coordinator-tests`, `coordinator-future-clock`, `coordinator-git243`, and `gateway-image-smoke`. `fast-checks` requires both the application and coordinator suites to succeed. The image smoke job builds and probes the gateway with scratch PostgreSQL. |
| [Repository Policy](../../.github/workflows/repository-policy.yml) | `repository-policy` runs repository policy and verifier receipt tests and validates PR acceptance metadata. |
| [Coordinator](../../.github/workflows/coordinator.yml) | `reconcile` runs on listed PR events in dry-run mode. |
| [Build and push gateway](../../.github/workflows/build.yml) | The `pull_request_target` check runs `env-manifest` on its listed events. Publishing the gateway image is a separate push job. |
| [Profile browser acceptance](../../.github/workflows/profile-browser-acceptance.yml) | `browser-acceptance` runs when the PR touches its listed paths. |
| [Search adapter parity](../../.github/workflows/search-adapter.yml) and [Search bake-off](../../.github/workflows/search-bakeoff.yml) | `typesense-parity` and `benchmark` run for their respective path filters. |
| [Staging on-dev](../../.github/workflows/staging-on-dev.yml) | On the listed PR events, `decide` checks whether a staging target exists. `build` and `switch` depend on the result and are separate from routine test checks. |
| [Verifier receipt](../../.github/workflows/verifier-receipt.yml) | `trust`, `measure`, and `emit` are part of the path-filtered PR workflow. Attestation is dispatched from protected `main`. |
| [Sandbox probe](../../.github/workflows/sandbox-probe-verification.yml) | `probe` is manual only. |

For the results from adding this guide, see the PR's **Evidence** section and checks.
