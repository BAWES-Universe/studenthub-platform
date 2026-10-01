# Production parity inventory: finance, contracts and payroll

**Card:** SHU-128 (parent SHU-88). Feeds SHU-100 (financial records contract), SHU-97 (data map).
**Production source:** `BAWES-Universe/studenthub` at `c2ce255`; schema facts additionally from `railway/staging/studenthub.sql` in the same repository, which is the only place several tables are defined. Permalink base `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Method:** read-only static inspection. No database, bank, accounting-system or live-host access. No account numbers, amounts or personal data.
**Coverage:** 138 of 1,016 functional production actions in the independently regenerated SHU-88 ledger at `84ab149` ([immutable ledger](https://github.com/BAWES-Universe/studenthub-platform/blob/84ab149/docs/parity/coverage.md), cluster FI). The ledger is not on platform `main` yet, so this inventory does not use a dangling relative link. Its counting rule excludes Yii `actions()` CORS/OPTIONS hooks and masks comments; all controller counts below use the same rule.

## 1. What this cluster is

Where StudentHub's money actually moves. A **contract** fixes what a company pays and a student earns. Approved hours (from the work cluster) plus bonuses become a **transfer** with a **transfer_candidate** line per student. Finance exports a **transfer file** in a bank's format, the bank processes it, and each line is reconciled back. Alongside that: invoices, expenses, staff salaries, discounts, and a Xero accounting integration the owner has already marked DEFER.

This is the highest-consequence cluster in the system: an error here mispays a student or overbills a customer, and unlike a profile field it cannot be quietly corrected later. It is also, per the work inventory, fed by a pipeline with no automated tests.

## 2. Contracts: three pay models

`contract` (`common/models/Contract.php`) is the parent: `contract_uuid`, `candidate_id`, `company_id`, `parent_company_id`, `store_id`, `type`, `start_date`, `end_date`, `transfer_cost`, `currency_code`, `auto_generate`, `status` (1 active / 0 inactive), `deleted`. The checked-in SQL dump contains the 2024 base table but omits later model-visible columns: `candidate_id`, `parent_company_id`, and `store_id` are added by `console/migrations/m250209_144529_contract.php`; `transfer_candidate.contract_uuid` is added by `m250306_191700_transfer_contract.php`. Schema evidence therefore comes from the dump **and** later migrations, not the dump alone. The source for `auto_generate` is the model/cron path; its migration is not established in this pass.

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

### 3.1 Parent/child billing lineage and invoice regeneration

Company ancestry and billing lineage are separate. `company.parent_company_id` describes organization structure; `transfer.parent_transfer_id`, introduced by `console/migrations/m170428_113508_invoice.php:12-30`, groups money.

- A locked parent transfer owns the only persisted `transfer_candidate` rows. `Transfer::generateEachCompanyTransfer()` groups those lines by their own `company_id`, explicitly excluding the parent's company (`TransferCandidateQuery::groupByCompany:246-251`).
- Each child transfer records `parent_transfer_id = parent.transfer_id`, one company, copied currency, and status LOCK (`Transfer.php:877-946`). A child does **not** own copied lines: `getTransferCandidates()` reads the parent's lines filtered to the child's company (`:521-535`). Child totals are sums of the already-computed parent-owned line totals.
- If children exist, `getInvoices()` on the parent returns only child invoices; otherwise it returns the parent's own invoice (`:542-593`). `TransferCandidate::getInvoiceNumber()` prefers the matching child's invoice and falls back to the parent's (`TransferCandidate.php:937-955`).
- Parent-owned lines are a real gap: `groupByCompany()` excludes the parent's own company, and when any sub-company group exists the parent gets no invoice. Repository evidence cannot establish whether such lines exist in live data; SHU-268 must measure this rather than assuming them away.
- Invoice identity is mutable legacy state. Invoice number is the autoincrement `invoice_id`; regeneration may mint replacement IDs and soft-delete old invoices (`Transfer.php:1645-1671`). PDFs are rendered on demand from live transfer rows, so the repository does not establish immutable issued documents.
- Regeneration contains a deterministic defect: at `Transfer.php:1594-1625`, `$company_total` is initialized to zero and then used as the guard for the entire child aggregation. The body can never run, leaving regenerated child totals at zero before a new invoice may be minted. Finding FI-F14.
- Double-count prevention is not structural. It is repeated `parent_transfer_id IS NULL` filtering in admin statistics, transfer-candidate listings, `TransferCandidateQuery` unpaid/payable scopes, and `Company::getParentTransfers`; `Transfer::getInvoices` avoids returning parent and child invoices together, while `InvoiceQuery::byTransfer` intentionally returns the whole group. A new query can omit a guard. Finding FI-F15.

## 4. Scheduled money movement

| Job | Schedule (`cron/cronlist`) | Authority, retry/failure and effects |
|---|---|---|
| `cron/process-transfer-files` | **every minute** | Selects pending files in batches of 100 and calls `process()`. There is no CAS/lease. A file is unconditionally pre-marked PROCESSING, then the method opens one DB transaction, reads an S3/resource-manager file or stored entries, retries a deadlocked line save up to three times, marks lines paid, emails before commit, commits, then emits a payable-candidate event. Several failures call `die()`, so later files and the CronLog update are skipped. |
| `cron/daily` | daily 13:30 | For each paid, unnotified line, sends email + app/SMS notification and only then sets `is_candidate_notified=1`; a delivery/save crash can duplicate or lose effects. The same job also deletes expired auth tokens and runs identity/profile/reporting work. |
| `cron/weekly` | Saturdays 00:00 | Groups active auto-generated monthly contracts by billing company and calls `saveTransfer(..., noOfPayout=4)`. It `return`s inside the first company iteration, so at most one grouped company is processed and CronLog is not updated when work exists. Finding FI-F16. |
| `cron/payable-candidate-notification` | daily 05:00 | Builds an XLSX of payable lines in a temp file, logs and sends it to the operations email, catches mail exceptions, deletes the temp file, then updates CronLog. This is an external email/export effect, not a candidate notification. |
| `cron/mid-month` | 13:30 on the 15th | Sends missing-bank-info and civil-ID-expiry notifications; the source retains a “stop until we found culprit” TODO but executes both calls. |
| `cron/update-company-stats` | 13:30 on the 15th | Aggregates paid line profit by company/currency and calls `updateCounters`; because it adds the full historical sum on every run, repeated runs can inflate stored revenue. Owned by reporting SHU-137 but financially consequential. |
| `cron/end-of-month` | 13:30 on the 28th | Requests attendance from companies (work cluster), sends the same bank/civil notifications, and updates CronLog. |
| `cron/segment-transfer`, `cron/segment-suggestion`, `cron/segment-expense` | not scheduled in `cronlist` | Batch historical rows to the external event manager/Segment and flush. Transfer and expense payloads contain monetary values; these are analytics effects, not payment effects. |
| `xero/sync-transactions`, `xero/sync-after` | not scheduled in `cronlist` | Accounting synchronization entry points; DEFER per SHU-46. |

`process-transfer-files` is the reconciliation step, not the payment step: `TransferFile::process()` reads a bank statement or the file's entries and **marks lines paid** (`common/models/TransferFile.php:238-250`); it does not issue a payment instruction. It sets `STATUS_PROCESSING` and saves **before** opening its transaction or reading any file (`:179-187`, verified after the independent audit), so the marker exists. What is missing is a claim: the cron preselects pending rows in batches of 100 (`CronController.php:338-348`) and the status save is unconditional, with no compare-and-swap on `pending`, so two overlapping minute-runs that both loaded the same batch can both enter `process()`. Whether that has ever produced a double `paid` mark is not established. Finding FI-F3, downgraded from High to Medium. Separately, `markProcessed` sends the confirmation mail (`:687-692`) **before** the transaction commits (`:327-329`), so a commit failure leaves an email that describes a reconciliation that did not happen. Finding FI-F7.

## 5. Transfer files and reconciliation

`transfer_file`: `bank`, the file itself, `transfer_amount`, `currency_code`, `error`, `status` (0 pending / 1 failed / 2 processed / 3 processing), `admin_id`.

`transfer_file_entry` mirrors a bank's payment-instruction row: transfer method, credit amount and currency, exchange rate, deal, value date, debit and credit account numbers, narratives, four payment-detail lines, beneficiary name, address lines, bank name, and a status with description. `transfer_bank_advice` holds generated advice documents by serial number.

`TransferCandidate` carries `transfer_confirmation_id` and `transfer_file_id`, which are written during reconciliation. Its denormalised store name, company name/email, bank, beneficiary name and IBAN are copied earlier by `saveCandidateTransfer()` at **transfer-generation time** (`TransferCandidate.php:979-994`) and are not refreshed by `TransferFile::process()`. That preserves the generation-time payment destination, not a payment-time snapshot.

Statuses on `transfer`: 10 initiated (draft), 1 payment sent, 3 salary distribution in progress, 4 transfer complete, 5 lock, 0 cancel. Common `lock()` permits INITIATED → LOCK, checks that all lines still belong to company candidates, and generates child transfers/invoices before saving (`Transfer.php:1080-1129`). Child transfers are created already LOCKed. Admin `lock()` instead permits PAYMENT_SENT → LOCK as a revert, and admin `unlock()` permits LOCK or PAYMENT_SENT → INITIATED (`admin/models/Transfer.php:76-108`). This role-dependent state machine is FI-F9.

## 6. Parity rows

| ID | Journey | Actor / grant | Legacy routes | Tests | Disposition | Slice |
|---|---|---|---|---|---|---|
| FI-01 | Create and maintain a contract (three types) | staff | staff `ContractController` (5 functional actions) | none | REQUIRED | F1 |
| FI-02 | See my contract | org member | company `ContractController` (2 functional actions; scoped through server-side `companyManager`) | none | REQUIRED | F1 |
| FI-03 | Generate a transfer from approved hours | staff, admin | staff `TransferController` (18 functional actions), admin (26) | none | REQUIRED, **the transactional boundary preserved** | F2 |
| FI-04 | Auto-generate monthly-salary payouts weekly | system | `cron/weekly` | none | REQUIRED, **ADAPT: the quarter-month rule is a policy choice, not arithmetic** (D-FI2) | F2 |
| FI-05 | Adjust a transfer line: hours, bonus, rates, transfer cost | staff, admin | admin `TransferCandidateController` (12 functional actions) | none | REQUIRED, audited | F2 |
| FI-06 | Lock, cancel, or advance a transfer's status | staff, admin | transfer controllers | none | REQUIRED as an explicit state machine | F2 |
| FI-07 | Export/reconcile a bank transfer file and maintain bank advice | admin | `TransferFileController` (3 functional actions), `TransferBankAdviceController` (5); outbound shapes separately traced by SHU-220 | none | REQUIRED, **ADAPT: idempotent, leased, single-writer**; unsupported outbound execution remains blocked | F3 |
| FI-08 | Process a transfer file and reconcile entries | system | `cron/process-transfer-files` → `TransferFile::process()` | `admin/tests/functional/TransferFileCest.php` (list/view only) | REQUIRED, **ADAPT: compare-and-swap claim before processing, mail after commit (FI-F3, FI-F7)** | F3 |
| FI-09 | Notify a candidate that they were paid | system | `TransferCandidate` mail and SMS paths | none | REQUIRED | F3 |
| FI-10 | Invoices | staff, admin | `Invoice` model, transfer relation | none | REQUIRED | F4 |
| FI-11 | Wallet payable balance and transaction list | candidate, company contact, admin | three `BalanceController` copies × 3 functional actions (admin/candidate/company); stored `walletDb` `BalanceAccount.balance`, not invoice-derived | none | EXCLUDE-PENDING-OWNER with FI-18 on SHU-213; **not evidence for invoice balances/statements** | — |
| FI-12 | Candidate salary view | candidate, self | `GET v1/account/salary`, `salary/<id>` | none | REQUIRED | F4 |
| FI-13 | Bank details for payment | candidate, self | `update-bank-detail`; IBAN rules in the profile inventory | `candidate AccountCest::tryUpdateBankDetail` | REQUIRED (profile owns the field, finance owns the validation) | F1 |
| FI-14 | Expenses | admin, staff | admin `ExpenseController` (5), `StaffExpensesController` (admin 6, staff 5 functional actions) | none | **EXCLUDE-PENDING-OWNER** (D-FI4, internal finance) | — |
| FI-15 | Staff salaries and salary processing | admin | `StaffSalaryController` (5 functional actions), `StaffSalaryProcess` model | none | EXCLUDE-PENDING-OWNER (D-FI4) | — |
| FI-16 | Discounts and discount categories | admin, staff | `DiscountController` (5+5), `DiscountCategoryController` (5+5 functional actions; staff routes are not configured) | none | EXCLUDE-PENDING-OWNER (D-FI5) | — |
| FI-17 | Xero accounting sync | admin, system | admin `XeroController` (7 functional actions), console (3), `XeroWebhookController` (1, unrouted) | none | **DEFER** (owner decision on SHU-46 stands) | — |
| FI-18 | Wallet | candidate, company contact, admin | `WalletUser`, `WalletBank`, `WalletTransfer`, `BalanceAccount`, `BalanceTransaction` in `walletDb`; API/UI entry points remain, while `WalletManager::addEntry()` is a success-returning no-op | wallet fixtures only | EXCLUDE-PENDING-OWNER on SHU-213; do not call the whole surface dead | — |
| FI-19 | Company revenue statistics | system | `cron/update-company-stats` | none | OTHER-CLUSTER (reporting SHU-137) | — |
| FI-20 | Transfer analytics events | system | `cron/segment-transfer` | none | OTHER-CLUSTER (platform SHU-139) | — |
| FI-21 | Payroll email to company contacts | staff | `PayrollEmail` | none | OTHER-CLUSTER (communication SHU-129) | — |
| FI-22 | Transfer rate excel | admin | `TransferRateExcel` model and staff transfer template/update/export actions | none | REQUIRED through audited export SHU-196 | F4 |

Permissions in this cluster are mostly authentication, not fine-grained authorization. Staff/admin finance controllers install bearer authentication but generally do not enforce per-action grants. Company contract reads are scoped through `companyManager`; candidate salary list/detail explicitly filter `candidate_id` to the authenticated principal (`AccountController.php:709-746`). Admin transfer reads/writes are broadly available to an authenticated admin, with the limited-admin restriction enforced only on the PDF path. These gaps are requirements for SHU-183–185, not permissions to preserve.

The production repository does **not** establish an invoice-derived account balance or immutable statement. SHU-270 is a target requirement derived from the approved consolidated-billing capability; it must not be cited as legacy parity. Likewise, consolidated billing design must reconcile the parent/child lineage above without assuming company ancestry is billing membership.

## 7. Tests and fixtures

**Correction.** An earlier revision of this section said this cluster had zero tests and no fixtures. That was false, and an independent audit caught it. What exists at `c2ce255`:

| Suite | What it establishes at source level |
|---|---|
| `common/tests/unit/models/TransferCandidateTest.php` (536 lines) | Live tests cover validation/list formatting plus manual-rate fallback with persisted totals, overlapping-contract selection, zero-payable behavior and missing-rate errors. Several older total/profit methods are commented out. |
| `common/tests/unit/models/TransferTest.php` | Only fixture setup and validation are live; save/delete aggregate tests are commented out. It does not establish transaction rollback. |
| `common/tests/unit/models/InvoiceTest.php` | Required-field validation only. |
| `admin/tests/functional/TransferCest.php` | Live HTTP scenarios cover list/view, received/lock/unlock, candidate paid/unpaid, invoice/receipt download, invoices, import, suspicious list and update-from-file. Some export/download scenarios are commented out. These mostly establish responses over fixtures, not exact monetary invariants. |
| `admin/tests/functional/TransferCandidateCest.php` | Live list/by-transfer/by-file/view and paid/unpaid bulk/single endpoints. |
| `admin/tests/functional/TransferFileCest.php` | List/view only; no processing lifecycle. |
| Company/staff transfer suites | `company/tests/unit/models/TransferTest.php` has live validation and lock/payment-sent/delete-state tests. The parent/child create/edit/invoice unit scenarios and nearly all company/staff functional scenarios are commented out; the only live company child functional scenario lists relations. |
| Fixtures `TransferFixture`, `TransferCandidateFixture`, `TransferFileFixture`, `TransferFileEntryFixture`, `InvoiceFixture`, `WalletTransferFixture` | Synthetic finance rows exist, but fixture existence is not behavior coverage. |

What remains untested or not established by an assertion: per-second contract arithmetic; quarter-month and first-company-only weekly behavior; monthly/fixed branches; minute-only hourly work; real transaction rollback; transfer-file claiming, parsing, reconciliation, retry/error and after-commit notification; parent-owned-line completeness; child regeneration totals; stable invoice identity; invoice-derived balances/statements; candidate salary isolation beyond source filtering; and external mail/SMS/Segment/Xero outcomes. The suite was not executed in this read-only audit, so pass/fail status is not claimed.

**Other untested behavior:** contract create/update across all three pay models; audited line adjustment; transfer-rate export; expenses; staff salary processing; discounts; and Xero sync.

## 8. Findings

| ID | Finding | Evidence | Severity | Action |
|---|---|---|---|---|
| **FI-F1** | `transfer_candidate.hours` is `double unsigned`, and PHP casts time inputs to floats before multiplying by rates | schema dump; `TransferCandidate.php:1068-1071,1149-1175,1319-1324,1367-1388` | **High** | F2: integer time units and decimal money end to end |
| **FI-F2** | Parent transfer money is `decimal(12,3)`, while line money/rates are `decimal(10,3)` | schema dump | Medium | F2 and SHU-97 overflow/reconciliation check |
| **FI-F3** | Every-minute transfer-file processing preselects pending rows and unconditionally writes PROCESSING; no CAS/lease | `CronController.php:338-348`; `TransferFile.php:179-187` | Medium; this reconciles, it does not initiate payment | F3: CAS claim and idempotent marking |
| **FI-F4** | Weekly auto-payout divides monthly salary by four | `CronController::actionWeekly:386-446` | Medium | D-FI2 |
| **FI-F5** | Hourly/manual totals round once at line end, but monthly/fixed totals are unrounded floats | `TransferCandidate.php:1191-1192,1328-1351,1390-1392` | Medium | D-FI3/F2 |
| **FI-F6** | Manual rate fallback reaches through to the parent company when the direct company rate is zero | `TransferCandidate.php:1062-1208` | Medium | F1: explicit recorded effective-rate resolution |
| **FI-F7** | Transfer-file confirmation email is sent before the reconciliation transaction commits | `TransferFile.php:327-329,687-692` | Medium | F3: durable outbox/after-commit delivery |
| **FI-F8** | Hourly-contract lines with zero hours and bonus return zero without checking minutes/seconds; manual lines check all units | `TransferCandidate.php:1243-1252` vs `:1068-1082` | Medium | F2 minute-only tests |
| **FI-F9** | Lock/unlock transitions differ between common and admin models | `Transfer.php:1080-1129`; `admin/models/Transfer.php:76-108` | Medium | F2: one state machine |
| **FI-F10** | Transfer transactions are skipped when `inCodeception` is set | `Transfer.php:1200,1271-1311,1430-1431,1675-1676` | Migration-confidence | F2 tests with real transactions |
| **FI-F11** | A zero-work/zero-bonus line succeeds with zero totals; transfer-level validation catches only an all-zero aggregate | `TransferCandidate.php:1068-1082`; `Transfer.php:1327-1338` | Low–Medium | F2: explicit zero-line rule |
| **FI-F12** | Model docblocks call decimal transfer totals integers, and the checked-in dump omits later contract columns | `Transfer.php:23-24`; contract dump vs `m250209_144529_contract.php` | Low | SHU-97: migration-derived schema authority |
| **FI-F13** | Xero webhook controller has an action but no configured route | coverage ledger at `84ab149`; config trace | Low | confirm dead before migration |
| **FI-F14** | Child regeneration aggregation is unreachable because `$company_total` starts at zero and guards its own increments; a replacement invoice may then be minted | `Transfer.php:1594-1647` | **High** | F4 import/reconciliation fixtures; never port |
| **FI-F15** | Parent/child double-count protection is repeated query filtering rather than a structural invariant; parent-owned lines can be omitted from invoices when sub-company lines exist | `Transfer.php:521-593,990-1018`; `TransferCandidateQuery.php:202,219,246-251`; statistics/list filters | **High** | F4: exactly-once line ownership and full-group reconciliation; SHU-268 measures legacy gaps |
| **FI-F16** | Weekly cron returns after the first grouped company and skips its CronLog update whenever work exists | `CronController::actionWeekly:420-447` | **High** | F2: process every eligible group idempotently |
| **FI-F17** | `update-company-stats` adds each run's full historical profit sum to stored counters | `CronController::actionUpdateCompanyStats` | Medium | SHU-137: derive or replace atomically with reconciliation |

## 9. Classification of prior findings

| Source | Claim | At `c2ce255` |
|---|---|---|
| SHU-46 | Xero integration → DEFER | **Owner decision stands**; FI-17 records it, nothing here reopens it |
| SHU-39 | Wallet integration disabled 2025-11-30 | **Partially supported**: external `WalletManager::addEntry()` is disabled, but walletDb models and three API controllers remain reachable in source (FI-11/FI-18); SHU-213 owns the exclusion decision |
| SHU-34 | Transfer and payment behaviour is core | **Production-supported**, and now sized |
| SHU-39 | Denormalised copies on records | **Production-supported** on `transfer_candidate`; they are generation-time snapshots, while payment linkage is written later |

## 10. Bounded slices for SHU-100

| Slice | Scope | Depends on | Points |
|---|---|---|---|
| F1 | Contracts: three pay models, effective-rate resolution made explicit and recorded, bank-detail validation | organizations O1, profile S2 | 5 |
| F2 | Transfer generation: exact-decimal arithmetic end to end, integer time units, one transactional boundary, audited line adjustment, explicit state machine | F1, work W7, SHU-59 | 8 |
| F3 | Bank files: idempotent export with a lease, single-writer processing, reconciliation back to lines, retry and error semantics, payment notification | F2 | 8 |
| F4 | Parent/child invoice lineage and reconciliation, candidate salary view, audited rate exports; invoice-derived balance/statements are a target requirement on SHU-270, not established legacy parity | F2 | 5 |

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
- Provider-specific outbound shapes were traced separately by SHU-220, but provider version, approval/release, delivery, acknowledgement, duplicate handling and finality remain unestablished; unsupported outbound execution stays blocked on SHU-184.
- Real volumes: transfers per week, lines per transfer, files per month. These size F3.
- Whether any existing `transfer_candidate` row has already lost precision, or any line exceeds `decimal(10,3)` — needs the database, and belongs in SHU-97.
- The bank's file format specification and its error codes, which are not in the repository.
