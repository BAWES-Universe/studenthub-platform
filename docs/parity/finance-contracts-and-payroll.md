# Production parity inventory: finance, contracts and payroll

**Card:** SHU-128 (parent SHU-88). Feeds SHU-100 (financial records contract), SHU-97 (data map).
**Production source:** `BAWES-Universe/studenthub` at `c2ce255`; schema facts additionally from `railway/staging/studenthub.sql` in the same repository, which is the only place several tables are defined. Permalink base `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Method:** read-only static inspection. No database, bank, accounting-system or live-host access. No account numbers, amounts or personal data.
**Coverage:** 138 of 1,017 functional production actions (`docs/parity/coverage.md`, cluster FI).

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

- Hours, minutes and seconds are cast to `(float)` and a per-minute rate is derived as `candidate_hourly_rate / 60`, then a per-second rate as `minute_rate / 60` (`:326-327`, `:359-360`, and the company-side equivalent at `:403`).
- Rates fall back: an omitted candidate rate uses the candidate's own rate, an omitted company rate uses the company's, then the **parent company's** if the company's is zero (`:101-118`, `:334-346`).
- Monthly salary is divided by `$noOfPayout`, which the weekly cron sets to **4** with the comment "4 weeks per month/ salary/4 = 1 week salary" (`CronController.php` `actionWeekly`).
- Line totals are rounded to three decimals only at the end (`:227-228`).
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

So the quantity that multiplies every rate is a floating-point number, the line items are `decimal(10,3)` while their parent is `decimal(12,3)`, and PHP does the arithmetic in floats before rounding once at the end. Findings FI-F1 and FI-F2.

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

`process-transfer-files` is the one that touches a bank. It selects pending files in batches of 100 and processes them in a loop, with **no lock, no lease and no in-progress marker before `process()` is called** — the model has a `STATUS_PROCESSING` value, so whether it is set inside `process()` before any external call decides whether two overlapping minute-runs can process the same file twice. Finding FI-F3, and the single most important thing for a verifier to settle.

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
| FI-08 | Process a transfer file and reconcile entries | system | `cron/process-transfer-files` → `TransferFile::process()` | none | REQUIRED, **ADAPT: lock before external effect (FI-F3)** | F3 |
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

**Automated coverage of this cluster: zero.** No Cest or Test file in any app targets transfers, transfer files, contracts, invoices, balances, expenses, staff salaries, discounts or Xero. There is no finance fixture. The `admin/tests/functional/TransferCest.php` seen in the admin suite listing exercises the transfer **API listing** only (its `tryToList` asserts HTTP 200 and a JSON envelope), not any money calculation.

That means every statement in §3 and §4 is untested in production: the per-second rate derivation, the parent-company rate fallback, the quarter-month division, the rounding point, the zero-total refusal, the rollback path, and the entire transfer-file lifecycle.

**Untested behaviour, explicitly:** contract creation and type-specific amounts; transfer generation and its rollback; line adjustment; the weekly auto-generation; transfer-file export, processing, retry and error handling; reconciliation back to lines; payment notifications; invoices; balances; the candidate salary view; expenses; staff salaries; discounts; Xero sync.

## 8. Findings

| ID | Finding | Evidence | Severity | Action |
|---|---|---|---|---|
| **FI-F1** | `transfer_candidate.hours` is `double unsigned` — floating point — and PHP casts hours, minutes and seconds to `(float)` before multiplying by rates | schema dump; `TransferCandidate::saveCandidateTransfer` `:87-90` | **High** (money computed in binary floating point) | F2: integer minutes or a decimal type end to end |
| **FI-F2** | Money precision is inconsistent along one flow: parent `transfer` is `decimal(12,3)`, its `transfer_candidate` lines are `decimal(10,3)`, contracts are `decimal(12,3)` | schema dump | Medium (a line that fits its parent can overflow, and sums may not reconcile) | F2, and SHU-97 must check for existing overflow |
| **FI-F3** | `cron/process-transfer-files` runs **every minute**, batches 100 pending files and calls `process()` with no visible lock, lease or pre-marking; overlapping runs are possible | `CronController.php` `actionProcessTransferFiles`; `cron/cronlist` | **High if `process()` does not set `STATUS_PROCESSING` before any external call** | verifier settles this first; F3 makes it leased and idempotent regardless |
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

- Whether `TransferFile::process()` sets `STATUS_PROCESSING` before any external call, and whether the bank interaction is idempotent. This is the first thing a verifier should read; it decides FI-F3's severity.
- Where `Transfer::STATUS_LOCK` is set and what it prevents.
- Real volumes: transfers per week, lines per transfer, files per month. These size F3.
- Whether any existing `transfer_candidate` row has already lost precision, or any line exceeds `decimal(10,3)` — needs the database, and belongs in SHU-97.
- The bank's file format specification and its error codes, which are not in the repository.
