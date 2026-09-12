# Production parity inventory: finance, contracts and payroll

**Card:** SHU-128 (parent SHU-88). Feeds SHU-100 (financial records contract), SHU-97 (data map).
**Production source:** `BAWES-Universe/studenthub` at `c2ce255`; schema facts additionally from `railway/staging/studenthub.sql` in the same repository, which is the only place several tables are defined. Permalink base `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Method:** read-only static inspection. No database, bank, accounting-system or live-host access. No account numbers, amounts or personal data.
**Coverage:** 138 of 1,016 functional production actions (`docs/parity/coverage.md`, cluster FI, regenerated at `84ab149` after an independent audit: comments are now masked, so a commented-out cron action is no longer counted, and six assignments were corrected; `cron/daily` is now primary FI with CM and ID effects, and `admin/Staff::actionListCompanies` moved to OR).

## 1. What this cluster is

Where StudentHub's money actually moves. A **contract** fixes what a company pays and a student earns. Approved hours (from the work cluster) plus bonuses become a **transfer** with a **transfer_candidate** line per student. Finance exports a **transfer file** in a bank's format, the bank processes it, and each line is reconciled back. Alongside that: invoices, expenses, staff salaries, discounts, and a Xero accounting integration the owner has already marked DEFER.

This is the highest-consequence cluster in the system: an error here mispays a student or overbills a customer, and unlike a profile field it cannot be quietly corrected later. It is also, per the work inventory, fed by a pipeline with no automated tests.

## 2. Contracts: three pay models

`contract` (`common/models/Contract.php`) is the parent: `contract_uuid`, `candidate_id`, `company_id`, `parent_company_id`, `store_id`, `type`, `start_date`, `end_date`, `transfer_cost`, `currency_code`, `auto_generate`, `status` (1 active / 0 inactive), `deleted`.

| Type | Detail table | Amount columns |
|---|---|---|
| `HOURLY` | `hourly_contract` | `candidate_hourly_rate`, `company_hourly_rate`, both `decimal(12,3)` |
| `FIXED_PRICE` | `fixed_price_contract` | `candidate_total`, `company_total` `decimal(12,3)`, plus `completion_percentage` `tinyint(3)` |
| `MONTHLY_SALARY` | `monthly_salary_contract` | `candidate_total`, `company_total` `decimal(12,3)`, plus `salary_day` |

`auto_generate` on a monthly-salary contract makes the weekly cron produce a payout automatically (§4.1).

## 3. The money path and its arithmetic

`Transfer::saveTransfer` (`common/models/Transfer.php:1182`) opens a database transaction, creates the transfer, then for each candidate calls `TransferCandidate::saveCandidateTransfer` and accumulates totals; it rolls back on any line failure and refuses a transfer whose total is zero or less ("Transfer total is zero. Please input hours worked."). That is a genuine transactional boundary and worth preserving.

Inside a line (`common/models/TransferCandidate.php`, `saveCandidateTransfer`):

- Hours, minutes and seconds are cast to `(float)` and a per-minute rate is derived as `candidate_hourly_rate / 60`, then a per-second rate as `minute_rate / 60` (`:1068-1071` and `:1149-1175` in the manual-rate fallback; `:1319-1324` and `:1367-1388` for hourly contracts). An earlier revision of this document cited `:326-327`, which is the `afterSave` docblock; the audit that caught it is recorded in §7.
- Rates fall back inside the manual-pay branch (`:1062-1208`): work with **no matching contract** is still payable; an omitted candidate rate uses the candidate's own rate, an omitted company rate uses the company's, then the **parent company's** if the company's is zero; a missing or non-positive rate, or a company rate below the candidate rate, is rejected; the line is saved with a null contract reference. The contract that applies is chosen by **overlap with the transfer period** (`:1006-1059`): non-deleted contracts for the candidate and store whose dates overlap the transfer's, newest first, with an explicit UUID/type filter honoured and **more than one match rejected**; when the transfer has no period it falls back to "active today". Neither rule was in this document before the independent audit.
- Monthly salary is divided by `$noOfPayout`, which the weekly cron sets to **4** with the comment "4 weeks per month/ salary/4 = 1 week salary" (`CronController.php` `actionWeekly`).
- Hourly and manual line totals are rounded to three decimals once, at the end (`:1191-1192`, `:1390-1392`). The monthly-salary and fixed-price branches assign **unrounded** float totals (`:1328-1351`), so there is no single rounding point across the three pay models.
- An hourly-contract line with `hours == 0` and `bonus == 0` returns zero **without looking at minutes or seconds** (`:1243-1252`); the manual branch checks all four values (`:1068-1082`). Minute-only hourly work is silently unpaid on the contract path. Finding FI-F8.
- A line with no hours, minutes, seconds or bonus returns success with zero totals rather than an error.

**Column types across the same flow are inconsistent** (from the schema dump):

| Table | Column | Type |
|---|---|---|
| `transfer` | `total`, `company_total`, `transfer_cost` | `decimal(12,3)` |
| `transfer_candidate` | `candidate_total`, `company_total`, `bonus`, `bonus_commission`, `transfer_cost`, rates | `decimal(10,3)` |
| `transfer_candidate` | **`hours`** | **`double unsigned`** |
| `transfer_candidate` | `minutes`, `seconds` | `tinyint(2)` |
| `hourly_contract`, `fixed_price_contract`, `monthly_salary_contract` | amounts | `decimal(12,3)` |
| `expense`, `staff_salary` | `amount`, `salary` | `decimal(10,3)` |

So the quantity that multiplies every rate is a floating-point number, the line items are `decimal(10,3)` while their parent is `decimal(12,3)`, and PHP does the arithmetic in floats, rounding once for hourly and manual lines and never for monthly or fixed-price lines. Findings FI-F1 and FI-F2.

## 4. Scheduled money movement

| Job | Schedule (`cron/cronlist`) | What it does |
|---|---|---|
| `cron/weekly` | Saturdays 00:00 | finds active `MONTHLY_SALARY` contracts with `auto_generate`, whose window covers today, and creates a transfer per contract at a quarter of the monthly amount |
| `cron/process-transfer-files` | **every minute** | takes every `transfer_file` with status pending and calls `$transferFile->process()` |
| `cron/payable-candidate-notification` | daily 05:00 | notifies about payable candidates |
| `cron/mid-month` | 13:30 on the 15th | civil-ID-expiring and missing-bank-info notifications |
| `cron/end-of-month` | 13:30 on the 28th | attendance request to companies (work cluster) plus the same notifications |
| `cron/segment-transfer`, `-suggestion`, `-expense` | not scheduled | analytics emitters |
| `xero/sync-transactions`, `xero/sync-after` | not scheduled | accounting sync |

`process-transfer-files` is the reconciliation step, not the payment step: `TransferFile::process()` reads a bank statement or the file's entries and **marks lines paid** (`common/models/TransferFile.php:238-250`); it does not issue a payment instruction. It sets `STATUS_PROCESSING` and saves **before** opening its transaction or reading any file (`:179-187`, verified after the independent audit), so the marker exists. What is missing is a claim: the cron preselects pending rows in batches of 100 (`CronController.php:338-348`) and the status save is unconditional, with no compare-and-swap on `pending`, so two overlapping minute-runs that both loaded the same batch can both enter `process()`. Whether that has ever produced a double `paid` mark is not established. Finding FI-F3, downgraded from High to Medium. Separately, `markProcessed` sends the confirmation mail (`:687-692`) **before** the transaction commits (`:327-329`), so a commit failure leaves an email that describes a reconciliation that did not happen. Finding FI-F7.

## 5. Transfer files and reconciliation

`transfer_file`: `bank`, the file itself, `transfer_amount`, `currency_code`, `error`, `status` (0 pending / 1 failed / 2 processed / 3 processing), `admin_id`.

`transfer_file_entry` mirrors a bank's payment-instruction row: transfer method, credit amount and currency, exchange rate, deal, value date, debit and credit account numbers, narratives, four payment-detail lines, beneficiary name, address lines, bank name, and a status with description. `transfer_bank_advice` holds generated advice documents by serial number.

`TransferCandidate` carries `transfer_confirmation_id` and `transfer_file_id`, which is how a paid line is tied back to a bank file, plus denormalised copies of store name, company name, company email, beneficiary name and IBAN — captured at payment time, which is correct for an audit trail.

Statuses on `transfer`: 10 initiated (draft), 1 payment sent, 3 salary distribution in progress, 4 transfer complete, 5 lock, 0 cancel. A `lock` state exists, which suggests finance freezes a transfer before export; where it is set and what it prevents needs confirming against the controllers.

## 6. Parity rows

| ID | Journey | Actor / grant | Legacy routes | Tests | Disposition | Slice |
|---|---|---|---|---|---|---|
| FI-01 | Create and maintain a contract (three types) | staff, admin | staff `ContractController` (6), company (3) | none | REQUIRED | F1 |
| FI-02 | See my contract | org member | company `ContractController` | none | REQUIRED | F1 |
| FI-03 | Generate a transfer from approved hours | staff, admin | staff `TransferController` (19), admin (27) | none | REQUIRED, **the transactional boundary preserved** | F2 |
| FI-04 | Auto-generate monthly-salary payouts weekly | system | `cron/weekly` | none | REQUIRED, **ADAPT: the quarter-month rule is a policy choice, not arithmetic** (D-FI2) | F2 |
| FI-05 | Adjust a transfer line: hours, bonus, rates, transfer cost | staff, admin | `TransferCandidateController` admin (13) | none | REQUIRED, audited | F2 |
| FI-06 | Lock, cancel, or advance a transfer's status | staff, admin | transfer controllers | none | REQUIRED as an explicit state machine | F2 |
| FI-07 | Export a bank transfer file | admin | `TransferFileController` (4), `TransferBankAdvice` (6) | none | REQUIRED, **ADAPT: idempotent, leased, single-writer** | F3 |
| FI-08 | Process a transfer file and reconcile entries | system | `cron/process-transfer-files` → `TransferFile::process()` | `admin/tests/functional/TransferFileCest.php` (list/view only) | REQUIRED, **ADAPT: compare-and-swap claim before processing, mail after commit (FI-F3, FI-F7)** | F3 |
| FI-09 | Notify a candidate that they were paid | system | `TransferCandidate` mail and SMS paths | none | REQUIRED | F3 |
| FI-10 | Invoices | staff, admin | `Invoice` model, transfer relation | none | REQUIRED | F4 |
| FI-11 | Company balance and statement | org member, staff | `BalanceController` in four apps (16) | none | REQUIRED | F4 |
| FI-12 | Candidate salary view | candidate, self | `GET v1/account/salary`, `salary/<id>` | none | REQUIRED | F4 |
| FI-13 | Bank details for payment | candidate, self | `update-bank-detail`; IBAN rules in the profile inventory | `candidate AccountCest::tryUpdateBankDetail` | REQUIRED (profile owns the field, finance owns the validation) | F1 |
| FI-14 | Expenses | admin | `ExpenseController` (6), `StaffExpenses` (staff 6, admin 7) | none | **EXCLUDE-PENDING-OWNER** (D-FI4, internal finance) | — |
| FI-15 | Staff salaries and salary processing | admin | `StaffSalaryController` (6), `StaffSalaryProcess` | none | EXCLUDE-PENDING-OWNER (D-FI4) | — |
| FI-16 | Discounts and discount categories | admin, staff | `Discount` (6+6), `DiscountCategory` (6+6) | none | EXCLUDE-PENDING-OWNER (D-FI5) | — |
| FI-17 | Xero accounting sync | admin | `XeroController` admin (8), console (3), `XeroWebhook` (unrouted) | none | **DEFER** (owner decision on SHU-46 stands) | — |
| FI-18 | Wallet | — | `WalletUser`, `WalletBank`, `WalletTransfer` in a separate database | none | DISCARD (integration disabled 2025-11-30, SHU-39) | — |
| FI-19 | Company revenue statistics | system | `cron/update-company-stats` | none | OTHER-CLUSTER (reporting SHU-137) | — |
| FI-20 | Transfer analytics events | system | `cron/segment-transfer` | none | OTHER-CLUSTER (platform SHU-139) | — |
| FI-21 | Payroll email to company contacts | staff | `PayrollEmail` | none | OTHER-CLUSTER (communication SHU-129) | — |
| FI-22 | Transfer rate excel | admin | `TransferRateExcel` model | none | REQUIRED, audited export | F4 |

## 7. Tests and fixtures

**Correction.** An earlier revision of this section said this cluster had zero tests and no fixtures. That was false, and an independent audit caught it. What exists at `c2ce255`:

| Suite | What it establishes |
|---|---|
| `common/tests/unit/models/TransferCandidateTest.php` (536 lines) | `:308-343` manual-rate fallback with persisted totals asserted; `:346-387` an overlapping hourly contract; `:390-465` zero-payable and missing-rate errors |
| `common/tests/unit/models/TransferTest.php` | transfer aggregate behaviour |
| `admin/tests/functional/TransferCest.php`, `TransferCandidateCest.php`, `TransferFileCest.php` | list/view return 200 with a JSON envelope; `TransferFileCest.php:18-24, :42-61` loads the finance fixture |
| Fixtures `common/fixtures/TransferFixture.php`, `TransferCandidateFixture.php`, `TransferFileFixture.php`, `TransferFileEntryFixture.php`, `InvoiceFixture.php`, `WalletTransferFixture.php` | synthetic finance rows, reusable for platform tests |

What remains untested in production: the per-second rate derivation on the contract path, the quarter-month division, the monthly and fixed-price (unrounded) branches, the minute-only hourly case (FI-F8), the transfer-file lifecycle beyond list/view, and the rollback path — which the legacy suite cannot reach because of FI-F10. Whether the suite currently passes is not established (nothing was executed).

**Untested behaviour, explicitly:** contract creation and type-specific amounts; transfer generation and its rollback; line adjustment; the weekly auto-generation; transfer-file export, processing, retry and error handling; reconciliation back to lines; payment notifications; invoices; balances; the candidate salary view; expenses; staff salaries; discounts; Xero sync.

## 8. Findings

| ID | Finding | Evidence | Severity | Action |
|---|---|---|---|---|
| **FI-F1** | `transfer_candidate.hours` is `double unsigned` — floating point — and PHP casts hours, minutes and seconds to `(float)` before multiplying by rates | schema dump; `TransferCandidate::saveCandidateTransfer` `:87-90` | **High** (money computed in binary floating point) | F2: integer minutes or a decimal type end to end |
| **FI-F2** | Money precision is inconsistent along one flow: parent `transfer` is `decimal(12,3)`, its `transfer_candidate` lines are `decimal(10,3)`, contracts are `decimal(12,3)` | schema dump | Medium (a line that fits its parent can overflow, and sums may not reconcile) | F2, and SHU-97 must check for existing overflow |
| **FI-F3** | `cron/process-transfer-files` runs **every minute**; `process()` does set `STATUS_PROCESSING` first (`TransferFile.php:179-187`), but the save is unconditional and the cron preselects pending rows, so overlapping runs that loaded the same batch can both enter | `CronController.php:338-348`; `TransferFile.php:179-187` | Medium (no double payment is evidenced; the method marks lines paid, it does not pay) | F3: claim with compare-and-swap, idempotent marking |
| **FI-F7** | Confirmation mail is sent inside `markProcessed` before the surrounding transaction commits | `TransferFile.php:327-329`, `:687-692` | Medium (mail can describe a rolled-back reconciliation) | F3: mail after commit |
| **FI-F8** | Hourly-contract lines with zero hours and zero bonus return zero without checking minutes or seconds; the manual branch checks all four | `TransferCandidate.php:1243-1252` vs `:1068-1082` | Medium (minute-only work unpaid) | F2: test `hours=0, minutes>0` on both branches; do not preserve |
| **FI-F9** | Locking is role-dependent: the common model locks an initiated transfer after checking assignments and then generates child transfers and invoices (`Transfer.php:1080-1129`, `:990-1018`); the admin subclass allows relocking payment-sent transfers and unlocking locked ones (`admin/models/Transfer.php:76-108`) | see evidence | Medium (state machine differs by app) | F2/F4: one explicit lock state machine |
| **FI-F10** | Explicit transaction operations are skipped when `inCodeception` is set (`Transfer.php:1200`, `:1271-1311`), so the legacy tests never exercise the production rollback path | see evidence | Migration-confidence | F2: platform tests run with real transactions |
| **FI-F4** | The quarter-month rule (`$noOfPayout = 4`) treats every month as four weeks, so a monthly salary paid weekly under-pays or over-pays depending on the month | `CronController.php` `actionWeekly` | Medium (systematic drift against the contract) | D-FI2 |
| **FI-F5** | Rounding happens once at the end of a line (`round(..., 3)`), so intermediate per-second products carry full float error | `TransferCandidate.php:227-228` | Medium | F2 |
| **FI-F6** | Rate fallback silently reaches through to the parent company when a company rate is zero | `:334-346`, `:112-118` | Medium (a missing rate produces a payment rather than an error) | F1: make the effective rate explicit and recorded on the line |
| **FI-F7** | A transfer line with no hours and no bonus succeeds with zero totals rather than being rejected | `:92-98` | Low–Medium | F2 |
| **FI-F8** | Zero automated tests anywhere in the money path | §7 | **High** for migration confidence | specify test-first in F1–F3 |
| **FI-F9** | `transfer.total` is described as `integer` in the model docblock but is `decimal(12,3)` in the schema | `common/models/Transfer.php` docblock vs dump | Low (documentation drift, but it misleads readers) | note in SHU-97 |
| **FI-F10** | `admin/XeroWebhook` has no route (coverage ledger) yet Xero sync actions exist | coverage ledger §"no route" | Low | confirm dead before migration |

## 9. Classification of prior findings

| Source | Claim | At `c2ce255` |
|---|---|---|
| SHU-46 | Xero integration → DEFER | **Owner decision stands**; FI-17 records it, nothing here reopens it |
| SHU-39 | Wallet integration disabled 2025-11-30 | **Production-supported**: a separate database, no live path (FI-18) |
| SHU-34 | Transfer and payment behaviour is core | **Production-supported**, and now sized |
| SHU-39 | Denormalised copies on records | **Production-supported** on `transfer_candidate`, and here it is **correct** — payment-time snapshots belong in an audit trail |

## 10. Bounded slices for SHU-100

| Slice | Scope | Depends on | Points |
|---|---|---|---|
| F1 | Contracts: three pay models, effective-rate resolution made explicit and recorded, bank-detail validation | organizations O1, profile S2 | 5 |
| F2 | Transfer generation: exact-decimal arithmetic end to end, integer time units, one transactional boundary, audited line adjustment, explicit state machine | F1, work W7, SHU-59 | 8 |
| F3 | Bank files: idempotent export with a lease, single-writer processing, reconciliation back to lines, retry and error semantics, payment notification | F2 | 8 |
| F4 | Invoices, balances, statements, candidate salary view, audited rate exports | F2 | 5 |

Cluster total: **26 points**, against the 8-point placeholder, and this is the estimate most likely to grow once D-FI1 is answered. Running total: profile 40, organizations 46, work 31, recruit 36, finance 26.

## 11. Decisions for Khalid

| ID | Decision | Recommended default | Cost of waiting |
|---|---|---|---|
| D-FI1 | Does the platform take over money movement at cutover, or does finance stay on the legacy system while everything else migrates? | **Split the cutover**: migrate identity, profile, organizations, work and recruiting first; keep finance on legacy until a full parallel run reconciles. Money is the one place a silent difference is unacceptable | This is the largest scope decision left in the programme. It changes P5 entirely, and every week it stays open is a week F1–F4 might be built for a date that moves |
| D-FI2 | The weekly auto-payout divides a monthly salary by four (FI-F4). Is that the intended commercial rule? | Pay by actual calendar period, not a fixed quarter-month | Blocks F2. If the current rule is intentional, say so and it becomes a documented policy rather than a bug |
| D-FI3 | Rounding and currency policy: at what point are amounts rounded, and what precision does each currency carry? | Round once at the payable line, three decimals for KWD, per-currency precision from the currency table | Blocks F2. Answering late means reworking arithmetic that has already been tested |
| D-FI4 | Internal finance (expenses, staff salaries, salary processing) — does it move to the platform? | Leave it; it is internal finance, not the student-work product, and pairs with D-WK4 on internal HR | Removes about 25 endpoints from the parity surface if dropped |
| D-FI5 | Keep candidate discounts and perks (FI-16)? | Drop unless it is commercially live | Low |

## 12. Not established

- Whether two overlapping `process-transfer-files` runs have ever double-marked a line (`process()` does pre-mark, but without a compare-and-swap; FI-F3). Needs `cron_log` and the database.
- Where the actual bank payment instruction is produced. `process()` reconciles statements; the outbound file or portal step is outside this method and was not located in this pass.
- Where `Transfer::STATUS_LOCK` is set and what it prevents.
- Real volumes: transfers per week, lines per transfer, files per month. These size F3.
- Whether any existing `transfer_candidate` row has already lost precision, or any line exceeds `decimal(10,3)` — needs the database, and belongs in SHU-97.
- The bank's file format specification and its error codes, which are not in the repository.
