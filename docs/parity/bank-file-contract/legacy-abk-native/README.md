# Legacy ABK payment-advice workbook: native output from the legacy path

Synthetic evidence only. No real people, accounts, amounts or credentials. The
workbook was produced by running the legacy export code itself, not a re-implementation.

## What was run

| Item | Value |
|---|---|
| Legacy repo / revision | `BAWES-Universe/studenthub` `55119d36b87b9255eec51ecb865398c04bccbda0` (master, 2026-10-30) |
| Route | admin API `GET v1/transfer/download-payment-advice-for-abk` → `admin\modules\v1\controllers\TransferController::actionDownloadPaymentAdviceForAbk()` (L1591–1830); header `Currency` (default `KWD`), query `offset`, `limit`, `only-payable` |
| Generator call | the `\common\components\PhpExcel::export([...])` block in that action (L1658–1803), executed verbatim via `eval`; sha256 of the block text before substitution `a809d78d9e8c12fce5febfb7290f9b821b6ac3c85ce61cbc4461ca404bb8d80b` |
| Helper | in-repo `common/components/PhpExcel.php` (fork of moonlandsoft/yii2-phpexcel 2.0.0, last changed in `a4ffcfd`), `export()` → `run()` → `executeColumns()` → `writeFile()` |
| Libraries (from legacy `composer.lock`) | `yiisoft/yii2` 2.0.51 `ea1f112f`, `phpoffice/phpspreadsheet` 4.0.0 `2d4b9f35`, `maennchen/zipstream-php` 3.1.2 `aeadcf5c`, `markbaker/complex` 3.0.2, `markbaker/matrix` 3.0.1 |
| Runtime | PHP 8.3.6 CLI; app `language` `en`, `timeZone` `Asia/Kuwait` and `i18n` taken from legacy `common/config/main.php` |
| Models | real `admin\models\TransferCandidate`, `admin\models\Candidate`, `common\models\Bank` subclasses that only override `attributes()` (no DB); relations `candidate`, `candidate.bank`, `bank` populated as `payable()`'s `joinWith(['transfer','candidate'])` would |
| Only substitution | the hard-coded debit account constant is replaced by `0999999999001` (same shape: 13 digits, leading zero) |

Reproduce: `composer install --ignore-platform-reqs --no-scripts` in this folder, then
`php run-legacy-abk-export.php <legacy-checkout> vendor <out-dir>` (add `empty` as a 4th argument for the zero-row case).

## Resolved format (observed in the produced XML)

- One sheet named `Worksheet`, `dimension A1:Q4`, shared strings, no styles or number formats (all cells style 0), no column widths, no autofilter, no total row.
- Row 1 headers are **not** the controller's `label` strings (the helper ignores `label`; it reads `header`, then `headers[attr]`, then `getAttributeLabel(attribute)`). Resolved headers, A→Q:
  `Debit Account`, `Name`, `IBAN`, `Beneficiary Bank Address`, `Beneficiary Bank Name`, `Beneficiary Bank Branch Id`, `Beneficiary City`, `Beneficiary Country`, `Beneficiary Address 1`, `Beneficiary Address 2`, `Txn Currency`, `Amount`, `Type`, `Beneficiary Bank Identifier`, `Purpose Of Transfer`, `Payment Details`, `Charge`.
  `IBAN` comes from `Candidate::attributeLabels()['candidate_iban']` via the `candidate.candidate_iban` attribute; the rest are `Inflector::camel2words()` of the attribute names. These match `ABK_SOURCE_HEADERS` in `packages/payroll/src/abk-workbook.ts`.
- Cell typing is PhpSpreadsheet 4.0 `DefaultValueBinder`:
  - Debit account, `007`/`042` bank codes, extracted account `0001234567890`: string (leading zero keeps them text).
  - Extracted within-bank account with no leading zero (`9123456789012`, row 3): **numeric cell**. Longer than 15 digits would lose precision in Excel.
  - Amount: numeric, written as `123.45`, `80.0`, `7.5` (DB string `80.000` → `80.0`), no number format.
  - Name starting with `=` (row 4): written as a **formula** cell (`<f>SYNTHETIC+1</f>`), no cached value (`preCalculateFormulas` false).
- Zero rows: an empty `Worksheet` with no header row (`dimension A1:A1`, `<sheetData/>`); the file is still saved and uploaded.
- Metadata: `docProps/core.xml` creator and lastModifiedBy `Unknown Creator`, title `Untitled Spreadsheet`, `created`/`modified` = generation time with the `+03:00` offset; `docProps/app.xml` Application `Microsoft Excel`. File name `T<serial>V1.xlsx`.
- Byte stability: every part except `docProps/core.xml` is identical across runs (`parts.sha256`); the ZIP bytes differ per run (timestamps in core.xml and ZIP entries).

`sheet1.xml`, `sharedStrings.xml` and `core.xml` here are the decoded parts of `synthetic-legacy-abk-T1V1.xlsx`.
