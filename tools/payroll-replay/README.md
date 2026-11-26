# Payroll replay: first synthetic decoded-cell slice

Read-only CLI and library. This slice compares the **existing**
`docs/parity/bank-file-contract/fixtures.json` → `legacy-abk-workbook` decoded cells
against separately supplied candidate decoded cells. It does not calculate pay,
produce a workbook, read staging, submit a bank file or establish real payroll
parity. No new fixture format is presented as a bank-approved specification.

## Run

From the repository root, after the normal build:

```sh
node --test dist/tools/payroll-replay/test/replay.test.js
node dist/tools/payroll-replay/src/cli.js --synthetic-cells \
  docs/parity/bank-file-contract/fixtures.json /path/to/candidate-cells.json
```

Tests are TypeScript under `tools/**/test/*.test.ts`, compiled by the root build and
automatically selected by the existing test runner. No workflow or shared
configuration changes are required. The CLI reads files only; its sole output is
a sanitized JSON receipt on stdout, or a fixed error code on stderr. Exit codes:
0 synthetic-cell match, 1 mismatch, 2 unsupported/invalid input. File inputs are
limited to 16 MiB each. No default-mode or production-mode success is possible.

Candidate input is an object with exactly these fields:

- `synthetic_only: true`
- `format_id: "legacy-abk-workbook"`
- `column_attributes`: the 17 ordered attributes in the existing fixture
- `header_values: null`: actual runtime labels are **not established**
- `rows`: decoded string-cell arrays, exactly 17 cells each

The amount at index 11 must be an exact nonnegative three-decimal string; it is
compared as integer fils without rounding. `PAYMENT DETAILS` at index 15 contains
the source-derived `S <line-id>` identity. Duplicates are rejected before indexing.
Row values, row order, counts, membership and totals must match; offsetting
one-fils errors fail even when the batch total is unchanged. Current fixture
scope is KWD, not a new cross-currency policy. Empty inputs fail instead of yielding
a vacuous pass. The marker is an explicit operator assertion, not a PII detector:
do not feed real workbooks or records into this tool outside authorized staging.

The receipt excludes identities, names, bank details, cell contents and file
paths. It always reports `productionReplay: false`,
`nativeWorkbookFidelity: "NOT_ESTABLISHED"` and `bankAcceptance: "UNKNOWN"`.
An exact identity comparison of a fixture against itself is only a smoke test;
independent actual output must come from a real platform generator for meaningful
adapter validation.

## Authority and scope

- SHU-208 keeps legacy salary / 4, legacy rate selection and per-model rounding.
  This comparator never computes or changes these rules.
- SHU-209 requires twelve historical months plus the live comparison cycle and
  owner go/no-go; synthetic tests satisfy none of those gates.
- Desk #393 comment 6951132592 grants GPT `tools/payroll-replay/**` and F1–F4,
  with export-only scope; no money execution or bank delivery.
- The existing bank-file contract's `legacy-abk-workbook` format has decoded cells
  only. Its unresolved runtime labels, native XLSX cell types/styles/formulas,
  numeric binding and provider acceptance remain unresolved, not silently guessed.
- Tested base: `36171e353c884de6b080f6a2fb5a8fc5c755dd68`.

## Remaining work

Bind a platform-generated decoded-cell adapter independently of the legacy
fixture, then implement native workbook validation. Amount generation (including
hourly/manual/weekly cases and named deductions), correction lineage accounting,
concurrent retry/finalization effects and immutable exports remain separate
implementation work. For the first real replay the staging operator must supply
a read-only, refresh-excluding snapshot reader and official reference workbook;
keep raw artifacts on staging and publish counts/differences only. No staging
runner is implemented or claimed here.

The focused suite validates the comparator, CLI and fixture adapter only. It is
not an aggregate build, database suite, staging comparison or independent review.
