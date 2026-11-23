# Exports

This directory provides CSV encoding, an export service with a caller-supplied
kind registry, and company-directory and catalogue-list kinds. The gateway
assembles them in [wiring/ops.ts](../../apps/gateway/src/wiring/ops.ts).
There is no package-level manifest or barrel here: consumers import the source
modules directly; the root [build configuration](../../tsconfig.build.json)
compiles them.

## CSV helper

[src/csv.ts](src/csv.ts) exports:

- `csvCell(value)`: converts null and undefined to an empty string and other
  values with `String`. It prefixes an apostrophe when the first character is
  `=`, `+`, `-`, `@`, tab or carriage return. Cells containing a comma, quote,
  carriage return or newline are quoted, with embedded quotes doubled.
- `writeCsv(columns, rows)`: encodes the header and rows as a UTF-8 `Buffer`,
  starting with a BOM and using CRLF separators, including a final CRLF.
  Both header and data cells pass through `csvCell`.

The direct runtime caller of `writeCsv` is [src/exports.ts](src/exports.ts).
`csvCell` is called within the helper itself. Encoding is covered by
[test/exports.test.ts](test/exports.test.ts).

## Registry and lifecycle

[src/exports.ts](src/exports.ts) defines `ExportKind`, `ExportStore`,
`StoredExport`, `ExportFile`, `ExportRequestResult`, `ExportOutcome` and
`ExportService`. A kind supplies an `id`, allowed `filterKeys`, ordered
`columns`, an asynchronous `authorize` check and an async iterable of `rows`.
An optional `serialize` writes a custom format instead of CSV.

The service constructor builds a map from the supplied kinds, keyed by ID;
there is no global registry or automatic discovery. `request`:

1. Looks up the kind; an unknown ID returns `not_found` without a stored record.
2. Copies only declared, defined filter keys into a frozen object and checks
   authorization. Refusal saves `refused_authorization` and returns `not_found`.
3. Iterates all rows, counting the full total while retaining at most
   `EXPORT_ROW_CAP` (10,000). An excess saves `refused_limit` without bytes and
   returns `row_limit`.
4. Serializes the rows, using `writeCsv` by default. A custom serializer must
   return a Buffer and metadata matching `EXPORT_FILE_NAME` and
   `EXPORT_CONTENT_TYPE`; invalid output throws. Files exceeding
   `EXPORT_BYTE_CAP` (5 × 1024 × 1024 bytes) also return `row_limit` and save
   `refused_limit` without bytes.
5. Saves `created`, including the requester, closed filters, count and bytes,
   and returns an ID, `/exports/<id>` download path and row count.

`EXPORT_EXPIRY_MS` is 15 minutes. `downloadFile` requires the original
requester, a created record with bytes, an unexpired record, a still-registered
kind and current authorization. It returns bytes, kind ID and optional custom
file metadata, or null. `download` returns only bytes or null. `cleanExpired`
delegates to the store using the service clock. These rules and constants are
implemented in [src/exports.ts](src/exports.ts).

The service closes filter **keys**, not filter values, and copies each yielded
row without trimming it to the column count. Kinds own validation, row selection
and projection; custom serializers also own their encoding. See
[src/exports.ts](src/exports.ts) and the concrete kinds below.

## Company directory

[src/company-directory-export.ts](src/company-directory-export.ts) exports
`CompanyDirectoryExportFilters` and `createCompanyDirectoryExport(directory)`.
Its ID is `company-directory`; allowed filter keys are `orgId`, `role`, `query`,
`status`, `approvedToHire`, `currencyCode` and `accountManager`.

Authorization accepts only `staff` or `admin`, then requires a `found` response
from `OrganizationDirectory.listOrganizations` for page 1. Row generation
reads the directory page by page with the same principal, organization, role
and search filters. Any non-`found` response throws `export authorization changed`.
Pagination stops when `page * pageSize >= total`.

The five columns, in order, are defined by that same source:

| Column | Value |
| --- | --- |
| `Name` | Available legal name if truthy, otherwise registry name |
| `Status` | Available status, otherwise empty |
| `Approved to hire` | `Yes` for true, `No` for false, otherwise empty |
| `Currency` | Available currency code, otherwise empty |
| `Account manager name` | Optional account-manager display name, otherwise empty |

The directory dependency is the `OrganizationDirectory` interface from
`@studenthub/organizations`; the gateway passes its organization service in
[wiring/ops.ts](../../apps/gateway/src/wiring/ops.ts).
[company-directory.ts](../../apps/gateway/src/company-directory.ts) references
the filter type and parses the HTTP query, rejecting pagination and roles other
than staff/admin. [exports-http.ts](../../apps/gateway/src/exports-http.ts)
resolves account-manager `me` to the requesting person and names the CSV
`company-directory.csv`.

## Country and university lists

[src/catalogue-list-export.ts](src/catalogue-list-export.ts) exports
`CatalogueListType`, `CatalogueListKindId`, `CatalogueListRow`,
`CatalogueListSource`, `CatalogueListFilters`, `CATALOGUE_LIST_KINDS`,
`createCatalogueListExport(source, type)` and `createCatalogueListExports(source)`.
The plural factory creates both `catalogue-country` and `catalogue-university`.
Both have no filter keys, so the service stores `{}` even if a direct caller
supplies extra keys. They call `source.isStaff` for authorization and again
before listing rows.

Both kinds produce these columns in this order:

| Column | `CatalogueListRow` value |
| --- | --- |
| `ID` | `id` |
| `Name` | `name` |
| `Code` | `code`, or empty for null |
| `Total Candidate` | `people` |

The gateway's [ops wiring](../../apps/gateway/src/wiring/ops.ts) supplies the
staff check and a
[PostgresCatalogueListStore](../db/src/reports/postgres-catalogue-list-store.ts).
That adapter selects active catalogue entries, orders by `normalized_name`
then ID, and counts person profiles by `nationality_id` for countries or
`university_id` for universities. The package factory itself only projects the
rows supplied by its source.

[exports-http.ts](../../apps/gateway/src/exports-http.ts) imports the kind IDs,
rejects any query parameters for these HTTP kinds and names their files
`countries.csv` and `universities.csv`.
[reports/list-exports-http.ts](../../apps/gateway/src/reports/list-exports-http.ts)
also imports the IDs for the staff list page's export buttons.

## Consumers and persistence

The direct application imports are in `apps/gateway`:

| Source | Use |
| --- | --- |
| [wiring/ops.ts](../../apps/gateway/src/wiring/ops.ts) | Constructs `ExportService`, registers company and catalogue kinds plus supplied `areaKinds`, and supplies PostgreSQL persistence |
| [exports-http.ts](../../apps/gateway/src/exports-http.ts) | Uses the service type and catalogue IDs; maps sessions to requesters, service results to HTTP results, and stored files to downloads |
| [company-directory.ts](../../apps/gateway/src/company-directory.ts) | References `CompanyDirectoryExportFilters` for parsed queries |
| [reports/list-exports-http.ts](../../apps/gateway/src/reports/list-exports-http.ts) | Uses catalogue IDs in export forms |
| [work/exports.ts](../../apps/gateway/src/work/exports.ts) | Imports `ExportKind` and `EXPORT_ROW_CAP` to define additional work kinds outside this package |

The HTTP registry `EXPORT_HTTP_KINDS` is separate from the service registry:
its filenames and query parsers do not register service implementations. A kind
offered by HTTP but absent from the service still returns not found. See
[exports-http.ts](../../apps/gateway/src/exports-http.ts).

[PostgresExportsStore](../db/src/postgres-exports-store.ts) in `packages/db`
provides compatible `save`, `find` and `cleanExpired` methods, but declares its
own structural record type rather than importing this package. Cleanup clears
expired bytes while retaining the record. The catalogue database adapter also
declares its own structural types. No other package or worker source directly
imports these four export modules at this revision.

The package tests directly consume the service, CSV helper and both factories:
[exports.test.ts](test/exports.test.ts) and
[catalogue-list-export.test.ts](test/catalogue-list-export.test.ts).
Gateway integration coverage includes
[exports-http.test.ts](../../apps/gateway/test/exports-http.test.ts),
[list-exports-http.test.ts](../../apps/gateway/test/list-exports-http.test.ts),
[export-own-format-http.test.ts](../../apps/gateway/test/export-own-format-http.test.ts)
and [work-exports.test.ts](../../apps/gateway/test/work-exports.test.ts).

## Verification

Run checks from the repository root. Scripts are defined in
[package.json](../../package.json); the general test command builds and invokes
[tools/test-runner/run.mjs](../../tools/test-runner/run.mjs).

Validation for this documentation change: `npm ci` and `npm run typecheck`
passed. After the build, `node --test dist/packages/exports/test/exports.test.js
dist/packages/exports/test/catalogue-list-export.test.js` passed all 10 tests
with no skips. All 32 relative links resolved and `git diff --check` passed.
The full `npm test` result and hosted CI evidence are recorded in the PR.
`npm run test:db` requires a disposable PostgreSQL database;
it was not run locally because none was configured for this documentation task.
