# Synthetic fixtures

This directory provides a deterministic, in-memory dataset generator for local
tests. Use synthetic inputs only: never add real people, legacy exports or
production data. [generate.ts](src/generate.ts) constructs values itself, uses
NATO alphabet name parts and reserved `.invalid` contact addresses, and reads no
external data. The local browser preview has its own synthetic setup described
below.

## Dataset and manifest

[generate.ts](src/generate.ts) exports `generateDataset(seed, size)` and
`DEFAULT_SIZE`; [types.ts](src/types.ts) defines `FixtureDataset` and its four
collections. The returned object also contains the supplied seed.

| Collection | Default size | Generated fields and relationships |
| --- | ---: | --- |
| `organizations` | 4 | Sequential ID, synthetic holding name and country code |
| `candidates` | 24 | Sequential ID, synthetic email and display name, university ID and active/inactive status |
| `requests` | 8 | Sequential ID, generated organization ID, synthetic title, 1–5 openings and open/closed status |
| `applications` | Up to 40 | Sequential ID, generated request and candidate IDs, and applied/interview/offer/rejected stage |

These defaults and relationships come from [generate.ts](src/generate.ts).
Applications use a fixed number of attempts: repeated request/candidate pairs
are skipped, so `size.applications` is an upper bound, not a guaranteed count.
Custom sizes must provide organizations for requests, and requests and
candidates for application attempts; the generator dereferences these arrays
without validating an empty dependency.

[manifest.ts](src/manifest.ts) exports `buildManifest(dataset)`. It returns the
seed, actual collection counts, a SHA-256 hash for each collection and a
`manifestHash` over `{ seed, counts, entityHashes }`. It adds no timestamp or
machine details. The collection order is `ENTITY_KINDS` in
[types.ts](src/types.ts). The public exports, including the types and helpers,
are collected in [index.ts](src/index.ts).

## Reproducing output

[prng.ts](src/prng.ts) maps the seed string to a 32-bit seed with `seedFromString`
(FNV-1a), then supplies the mulberry32 generator via `createPrng`. All random
choices in [generate.ts](src/generate.ts) use that generator, with no clock,
UUID or ambient randomness. With the same generator implementation, seed and
size, the resulting dataset is reproducible.

[canonical.ts](src/canonical.ts) supplies `canonicalize`, `sha256` and
`shortDigest`. Canonical JSON sorts object keys and omits object properties
whose values are `undefined`; arrays retain their order. A standalone
`undefined` is serialized as `null`. `sha256` hashes the canonical UTF-8 string;
`shortDigest` takes its first 12 hexadecimal characters. Reordering dataset
arrays can therefore change the manifest even when object key order does not.

After building from the repository root, this example prints only the manifest
(the code uses the exports from [index.ts](src/index.ts)):

```sh
node --input-type=module -e 'import { generateDataset, buildManifest } from "./dist/tools/fixtures/src/index.js"; console.log(JSON.stringify(buildManifest(generateDataset("readme-example")), null, 2));'
```

## Actual consumers

- [fixtures.test.ts](test/fixtures.test.ts) checks repeated-seed equality, a
  fixed manifest hash, different-seed divergence, canonical key ordering,
  counts, hashes, absence of a timestamp and synthetic email suffixes.
- [import.test.ts](../legacy-import/test/import.test.ts) generates a dataset to
  check invariants, idempotence and conflict handling;
  [dry-run.test.ts](../legacy-import/test/dry-run.test.ts) also uses the generator.
- [reconciliation.test.ts](../reconciliation/test/reconciliation.test.ts)
  generates source and target datasets for comparison, including reordered and
  deliberately changed collections.
- [baseline.json](../test-runner/baseline.json) registers the compiled fixture
  tests; [run.mjs](../test-runner/run.mjs) includes discovered Node tests in the
  ordinary non-database run. The root [package.json](../../package.json) defines
  `npm test` as build followed by that runner.

### Browser preview

The root [package.json](../../package.json) defines `npm run dev` as
`npm run build` followed by `node tools/fixtures/src/web-preview.mjs`.
[web-preview.mjs](src/web-preview.mjs) does **not** call `generateDataset` or
`buildManifest`: it uses `SYNTHETIC_PROFILE_FIXTURES` from the profile package,
`SYNTHETIC_ORGANIZATION_FIXTURES` from the organizations package, a synthetic
login rig and in-memory stores. Those are separate from the four collections
above.

The same preview source refuses `NODE_ENV=production`, serves an explicit
`/__preview/profile` journey and an injected-session `/__preview/workspace`
journey, and supplies a responsive layout lab at `/__preview/responsive`.
Without `--navigation-journey`, ordinary `/profile` receives no injected preview
session. With that flag, the wrapper injects its synthetic session across
requests and adds local navigation controls. This is local synthetic QA, not
production authentication or database evidence.

## Commands and verification

Run commands from the repository root. Build, typecheck, test and dev script
definitions are in the root [package.json](../../package.json).

| Command | Result during this documentation change |
| --- | --- |
| `npm ci` | Passed on the PR base; installed the locked dependencies |
| `npm run build` | Passed on the PR base; produced the compiled generator and tests |
| `node --test dist/tools/fixtures/test/fixtures.test.js` | Passed: 5 tests |
| Manifest example above | Passed; repeated runs produced identical manifests |
| `npm run typecheck` | Passed on the unchanged PR base; this change adds only Markdown |
| `npm test` | Build passed; runner stopped with 8 failures (7 workflow-text checks and a Windows symlink permission error), also reproduced on the unchanged base |
| `npm run dev` | Not run: the browser preview was checked against its source; no interactive preview acceptance claimed |

The focused test command runs the existing [fixture tests](test/fixtures.test.ts)
after compilation. This README adds no data files or generator CLI.
