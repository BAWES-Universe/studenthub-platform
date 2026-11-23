# Profile records

`@studenthub/profile-records` provides the owner-scoped education, experience,
skills and links service used by the gateway. It is a private ESM workspace
requiring Node.js 22 or newer. Its single package entry point re-exports the
types, service, normalizers and in-memory adapters from [src/index.ts](src/index.ts);
build and export paths are defined in [package.json](package.json).

## Record model

[src/types.ts](src/types.ts) defines `PROFILE_RECORD_KINDS`, `ProfileRecordKind`,
`ProfileRecordFieldsByKind` and these field shapes:

| Kind | Fields |
| --- | --- |
| `education` | `educationType`, `currentlyStudying`; optional `universityId`, `institutionName`, `degreeId`, `majorId`, `customMajor`, `graduationYear` |
| `experience` | `title`, `employer`, `startYear`; optional `endYear` |
| `skill` | `name` |
| `link` | `title`, `url` |

`ProfileRecord` adds `id`, `kind`, `status` (`active` or `deleted`), `createdAt`,
`updatedAt` and optional `deletedAt`. `StoredProfileRecord` also carries `ownerId`;
the service removes it from public records. `ProfileBackground` contains one
active list per kind plus a combined `removed` list. Active lists sort by creation
time, then ID; removed rows sort by deletion time descending, then ID.
Sources: [types.ts](src/types.ts), `publicRecord` and `background` in
[records.ts](src/records.ts).

## Service and rules

`ProfileRecords(store, references, now?)` takes a `ProfileRecordStore`, a
`ReferenceResolver` and an optional clock. The following behavior is implemented
in [src/records.ts](src/records.ts):

| Method | Behavior |
| --- | --- |
| `background(ownerId)` | Returns the owner's active and removed records. |
| `create(ownerId, kind, input)` | Normalizes fields, checks references, generates a UUID and inserts an active row. |
| `update(ownerId, kind, id, input)` | Replaces the complete fields object of an active owned row; this is not a partial patch. |
| `remove(ownerId, kind, id)` | Soft-deletes an active row, retaining its fields for restoration. |
| `restore(ownerId, kind, id)` | Restores a deleted row with its existing fields, removes `deletedAt` and updates `updatedAt`; does not resolve catalogue references again. |
| `replaceSkills(ownerId, input)` | Accepts 1–50 skill strings or `{ name }` objects, soft-deletes all active skills and inserts the replacement list in one transaction with one audit entry. Creation timestamps preserve input order. |

The service requires a nonempty owner string, but does not authenticate it itself.
Callers must supply the authenticated owner. Unknown kinds, malformed record IDs,
missing or other-owner rows, and rows in the wrong lifecycle state produce
`not_found` (404) at their respective checks. Missing owners produce
`unauthorized` (401). Create and restore enforce at most 50 active rows per owner
and kind; skill names must be unique among active skills after normalization and
case folding with the `en-US` locale. Limit and duplicate failures are 409s.
These checks and their order are in [records.ts](src/records.ts); isolation,
restoration, rollback and limit tests are in [test/records.test.ts](test/records.test.ts).

The exported `normalizeEducation`, `normalizeExperience`, `normalizeSkill` and
`normalizeLink` functions reject unknown input fields. Text is trimmed, whitespace
collapsed and NFKC-normalized; remaining control/format characters are refused.
Titles, employer, skill and custom-major text are limited to 128 characters;
institution names to 160. Years are integers from 1950 through 2100 (four-digit
strings are accepted), and an experience end year cannot precede its start year.
Links accept only HTTP/HTTPS URLs without embedded credentials, with a raw URL
length limit of 2048. Source: [records.ts](src/records.ts).

Education uses `EDUCATION_TYPES` from [types.ts](src/types.ts):

- `standard` requires a university reference and forbids an institution name.
- `custom_university` and `studying_abroad` require an institution name and forbid
  a university reference.
- `not_studying` forbids both institution forms and a true `currentlyStudying`.
- A catalogue major and a custom major cannot both be supplied.

Reference IDs must be UUIDs. New or changed university, degree and major choices
must resolve as active; an unchanged historical reference may remain on update.
Create/update resolve supplied references before opening the write transaction,
including unchanged references on update. Resolver exceptions become
`reference_unavailable` (503); an unchanged reference therefore does not bypass a
resolver outage. Normalization and reference validation otherwise use 400 errors.
Sources: `normalizeEducation`, `resolveReferences` and `assertReferences` in
[records.ts](src/records.ts).

Each successful mutation and its audit entry share the store transaction.
`ProfileRecordAudit` contains operation, `ownerId`, kind and active counts before
and after; it contains no record fields. The in-memory audit retains `ownerId`;
the PostgreSQL adapter hashes it with `principalAuditRef` before persisting audit
references and stores only kind/count summaries. Sources:
[types.ts](src/types.ts), [memory-store.ts](src/memory-store.ts) and
[postgres-profile-records-store.ts](../db/src/postgres-profile-records-store.ts).

## Stores and reference adapters

The store and transaction ports are declared in [src/types.ts](src/types.ts):
`listAll(ownerId)` and `transaction(work)`, with `listOwned`, `findOwned`, `insert`,
`replace` and `audit` inside a transaction. `ReferenceResolver.resolve(type, id)`
returns an active/deleted status or no match for university, degree or major.

| Implementation | Purpose and behavior | Source |
| --- | --- | --- |
| `InMemoryProfileRecordStore` | Synthetic/local process memory, used by tests and preview. Serializes transactions with a promise queue, copies row/audit collections, and publishes both only if the callback succeeds. `failNextAudit` injects an audit failure; `auditLog` exposes a copied audit array. It provides no persistence across processes or restarts. | [memory-store.ts](src/memory-store.ts) |
| `InMemoryReferenceResolver` | Synthetic catalogue for tests/preview; `set` seeds active or deleted entries, and `resolve` checks both ID and type. | [memory-store.ts](src/memory-store.ts) |
| `PostgresProfileRecordStore` | Persists `candidate_profile_records` using owner-scoped queries and SQL transactions shared with `authorization_mutation_audit`; `listOwned` takes an advisory transaction lock per owner/kind and `findOwned` locks the matching row. | [PostgreSQL adapter](../db/src/postgres-profile-records-store.ts) |
| `PostgresReferenceResolver` | Reads status from `catalogue_items` by catalogue type and UUID. Both PostgreSQL adapters accept a pool or pool configuration and close only pools they own. | [PostgreSQL adapter](../db/src/postgres-profile-records-store.ts) |

The PostgreSQL adapters live in the database package and are exported through
[@studenthub/db/profile](../db/src/profile/index.ts), rather than this package.

## Verified consumers

These are concrete call sites, not inferred dependencies:

| Consumer | Use | Source |
| --- | --- | --- |
| Gateway runtime | Constructs `ProfileRecords` with the PostgreSQL store/resolver and a shared pool; returns no runtime if database or login callback configuration is absent. | [profile-records-runtime.ts](../../apps/gateway/src/profile-records-runtime.ts) |
| Gateway HTTP handler | Calls the service for JSON under `/profile/records` and native forms under `/profile/background`; obtains the owner from the session, checks exact origin for writes, and returns 503 when the runtime is absent. | [profile-records-http.ts](../../apps/gateway/src/profile-records-http.ts), [route registration](../../apps/gateway/src/routes/profile.ts) |
| Profile completeness | Reads `background` to supply active education and skill counts; missing or failed reads become failed completeness inputs. | [profile-completeness.ts](../../apps/gateway/src/profile-completeness.ts) |
| Local web preview | Constructs the service with both in-memory adapters and seeded synthetic catalogue options. | [web-preview.mjs](../../tools/fixtures/src/web-preview.mjs) |
| Browser acceptance fixture | Constructs the service with PostgreSQL adapters for its records runtime. | [fixture.mjs](../../tools/browser-acceptance/fixture.mjs) |
| Unit and HTTP tests | Instantiate the in-memory adapters and service; cover service rules and gateway behavior. | [records.test.ts](test/records.test.ts), [profile-records-http.test.ts](../../apps/gateway/test/profile-records-http.test.ts) |
| Database tests | Instantiate PostgreSQL adapters and the service to check persistence, owner isolation and audit behavior. | [postgres-profile-records.test.ts](../db/test/postgres-profile-records.test.ts) |

## Checks

Run commands from the repository root after installing dependencies. Root scripts
are defined in [package.json](../../package.json); the package's own
[package.json](package.json) provides only a build script. Root builds also compile
tests into root `dist`, distinct from the package's export build in its own `dist`.
The [test runner](../../tools/test-runner/run.mjs) and
[baseline](../../tools/test-runner/baseline.json) include the unit, HTTP and
[mutation checks](test/mutations.mjs), with database tests in the separate DB lane.

Validation for this documentation change on 2026-11-23 used Node.js 22.22.3 and
npm 10.9.8:

| Command | Result |
| --- | --- |
| `npm ci` | Passed. |
| `npm run typecheck` | Passed (exit 0). |
| `npm test` | Passed (exit 0), including the profile-records unit/HTTP tests and all four profile-records mutation kills. One existing MySQL client test skipped because `mysql` and `mysqldump` were not installed. |
| `npm run test:db` | Not run locally: no disposable PostgreSQL 17 database was provisioned for this documentation task. The [database test](../db/test/postgres-profile-records.test.ts) requires `DATABASE_URL`, runs migrations and resets fixture tables; do not point it at real data. |
| `git diff --check` | Passed. |

All relative Markdown links were also checked against the source tree on `main`.
These are local documentation-validation results, not live acceptance evidence.
