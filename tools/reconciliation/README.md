# Reconciliation

This private ESM workspace is named `@studenthub/reconciliation` in
[package.json](package.json). It compares two in-memory `FixtureDataset`
values; it does not fetch data or write a report file. Its public exports in
[src/index.ts](src/index.ts) are `reconcile`, `EntityDifference`,
`ReconciliationReport`, `assertRedacted`, `findUnredacted` and `RedactionFinding`
(`EntityDifference`, `ReconciliationReport` and `RedactionFinding` are type exports).

## Comparison and report

[`reconcile(source, target)`](src/reconcile.ts) walks the four collections in
[`ENTITY_KINDS`](../fixtures/src/types.ts): `organizations`, `candidates`,
`requests` and `applications`. Dataset `seed` is not compared. Each row's entire
content is hashed with [`sha256`](../fixtures/src/canonical.ts), which uses
canonical JSON with sorted object keys and omitted undefined object properties.
Collection hashes sort rows by ID first, so reordering uniquely identified rows
does not change the result.

The returned [`ReconciliationReport`](src/reconcile.ts) contains:

| Field | Meaning |
| --- | --- |
| `counts` | Source and target row counts for every entity kind. |
| `hashes` | Source and target SHA-256 collection digests for every entity kind. |
| `differences` | Entries only for entities with missing, extra or changed IDs. |
| `clean` | True only when there are no difference entries and every collection hash matches. |

Each `EntityDifference` names its `entity` and has sorted ID arrays:
`missingInTarget` (source only), `extraInTarget` (target only), and `changed`
(present in both, different row hash). The report does not include row payloads,
changed field names or before/after values. In particular, names and contact
fields are not copied into it. IDs are included verbatim; they must themselves
be safe. Counts and hashes are shallow-frozen by the implementation.

This is a typed dataset comparison, not a schema or uniqueness validator:
[`indexById`](src/reconcile.ts) uses a map, so duplicate IDs overwrite earlier
row hashes in that index while collection counts and hashes still include all
rows. Do not interpret an empty `differences` array alone as a clean result.

## Redaction guard

[`reconcile`](src/reconcile.ts) calls [`assertRedacted`](src/redaction.ts) before
returning. The guard rejects suspicious output rather than replacing values:

- `findUnredacted(value, path = "$")` walks string values, arrays and object
  values, returning `{ kind: "email" | "digits", at: string }` findings.
- Email-shaped text is flagged except for the synthetic fixture email domain
  allowed by the regex in [src/redaction.ts](src/redaction.ts).
- Runs of seven or more digits inside alphanumeric tokens are flagged, except
  tokens consisting entirely of at least 12 hexadecimal characters with at
  least one letter from `a` to `f`. A digits-only token is not exempt.
- `assertRedacted` throws an error listing finding kinds and paths, without
  copying the offending values into the error.

These are pattern checks, not comprehensive anonymization: numeric primitives
and object key text are not scanned, and digest-shaped tokens are exempt wherever
they occur. The guard checks the report, not the input dataset, and does not
prove arbitrary data safe to publish. These limits follow directly from
[src/redaction.ts](src/redaction.ts).

## Consumers and coverage

The production-source call site within this repository is
[`runFullImportDryRun`](../legacy-import/src/dry-run.ts), re-exported from
[legacy-import's index](../legacy-import/src/index.ts). It generates synthetic
fixtures by default, imports into an in-memory `ImportStore`, materializes a
target dataset and calls `reconcile`. Its wrapper contains `seed`, `import`,
`reconciliation` and `ok`; `ok` requires both import success and a clean report.
Its CLI prints JSON and sets exit code 1 for an unsuccessful result. The store
implementation is in [import.ts](../legacy-import/src/import.ts).

[`reconciliation.test.ts`](test/reconciliation.test.ts) directly exercises
`reconcile` and `findUnredacted`: identical and reordered datasets, missing and
changed rows, omission of names/contact fields, email/digit detection, digest
exceptions and nested finding paths. It does not separately test extra-only
rows or every possible redaction bypass.
[`dry-run.test.ts`](../legacy-import/test/dry-run.test.ts) covers the consumer's
successful synthetic import and failure when missing references prevent a
complete import. Both compiled suites are listed in the test runner's
[`baseline.json`](../test-runner/baseline.json) and run through
[`run.mjs`](../test-runner/run.mjs).

## Local verification

Run commands from the repository root with Node 22 or later; the root
[package.json](../../package.json) defines the npm scripts and engine floor.
The reconciliation workspace has no separate test script or CLI.

```sh
npm ci
npm run typecheck
npm test
```

After the build produced by `npm test`, the focused suites can also run directly:

```sh
node --test dist/tools/reconciliation/test/reconciliation.test.js dist/tools/legacy-import/test/dry-run.test.js
```

Verification results for this documentation change are recorded in the PR's
Evidence section. `npm run dry-run:import` is the root script for the synthetic
consumer CLI; it was not run separately for this documentation task because
importer runs are outside this lane's authorization. The consumer is covered
through its synthetic unit tests above.
