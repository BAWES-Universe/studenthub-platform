# F4 invoices (F4.1 to F4.9, legacy facts) and F4.6 legacy billing import

Draft from legacy code, 2026-11-05. Legacy source: `/home/user/studenthub` (master). F4.1 (SHU-263, #219) and F4.2 (SHU-264, #220) are hand PRs by GPT and are not legacy rules; they are not covered here beyond the legacy facts they must match.

## Legacy invoice model (verified)
- `common/models/Invoice.php`, table `invoice`. Columns used in code: `invoice_id` (auto id, the invoice number), `transfer_id` (FK, one per main transfer), `invoice_date` (date, set to today at creation), `invoice_status` (string; values used: `'unpaid'`, `'paid'`), `deleted` (soft).
- `invoice_total` is NOT stored. It is computed in `fields()` as `transfer.company_total` (`Invoice.php` fields).
- No credit, void, or reversal fields. No series or year prefix on the number. Searched `common/models` for void/credit; the only hits were unrelated (`TransferCandidate`, `TransferFile`, `BalanceAccount`, `Discount`, `CandidateIdCard`) and none are invoice reversal.
- No per-invoice line table. The invoice is one row per transfer; its lines are the `transfer_candidate` rows of that transfer.

## Creation
- At Draft → Locked (`common/models/Transfer.php:972` `generateTransferInvoice()`): `findOne(['transfer_id'])`; if none, insert with `invoice_status = 'unpaid'`, `invoice_date = today`. Not transactional with the lock (see F-3). Only when the company has no sub-companies (line 990-1000).
- Sub-company children: `generateSubCompanyTransfer` (line 877) creates child transfers with `parent_transfer_id`; each child gets its own invoice (`getChildTransferInvoices`, `common/models/Transfer.php:589`).

## Numbering used on documents
- `TransferCandidate::getInvoiceNumber()` (`common/models/TransferCandidate.php:937`): returns the invoice id of the child transfer for the candidate's company if one exists, else the main transfer's first invoice id. This is the number printed on the candidate-facing payable document.
- Consequence for F4.2 (SHU-264 numbering): legacy numbers are database autoincrement ids. A new series must not collide with legacy ids that are already printed; the billing import (F4.6) must keep legacy numbers or map them. Decide and record; do not ask Khalid.

## Payment state
- Set to `'paid'` only in `admin/models/Transfer.php:115` `paymentReceived()` (all invoices of the transfer and its child transfers, `Invoice::updateAll`). No other path. There is no partial or overdue state.
- Legacy has no void, credit, or refund documents. Any "void and credit" in F4.7 is new.

## Legacy billing import (F4.6, SHU-268) - what to reconcile
- Source rows: `invoice` (legacy, prod MySQL on Railway per legacy usage memory) joined to `transfer` (`transfer_status`, `company_total`, `company_id`, `currency_code`, `deleted`).
- Reconcile per invoice: `invoice_id`, `transfer_id`, company, invoice_date, `invoice_status`, company_total (3 dp), currency.
- Totals to reconcile: count and sum of `company_total` by currency and status, per company, excluding `deleted = 1` (legacy soft delete; confirm whether the import includes deleted rows).
- Legacy `transfer` rows with status Cancel (0) or Draft (10) normally have no invoice; any that do are an anomaly to report.

## Read model and screens (F4.4, F4.5, F4.8) - legacy comparison
- Legacy company-facing invoices list: `company/modules/v1/controllers/TransferController.php` `actionInvoices` (near line 214 in the admin controller; company controller not read in this pass).
- Legacy statements/balances: none found in this pass beyond the invoice list. Balance-like code exists only in the wallet (`BalanceAccount`, out of scope by SHU-213).

## Pay history (F4.9, person's own pay)
- Candidate app: `candidate/modules/v1/controllers/AccountController.php:811` `actionSalary` and `:834` `actionSalaryDetail`.
- Query: `transfer_candidate` joined to `transfer` where `transfer_status` IN (Distributing 3, Complete 4), `paid = 1`, filtered to the candidate, paginated 10, newest first (`tc_id DESC`). Detail: same filter by `tc_id`, 404 otherwise.
- Shows own lines only (ownership by `filterCandidate`). Frozen amounts: the stored `candidate_total` and `company_total` (no recalculation).
- Conflict: contract says own lines visible "once locked". Legacy shows only paid lines after payment received. Record the choice (keep legacy).

## Wallet dependency (affects F4 and F-3)
- `admin/models/Transfer.php:115` `paymentReceived()` calls `Yii::$app->walletManager->addEntry` in prod before the status change. The wallet is out of scope by SHU-213 (10-04) and the usage memory says wallet last used 2025-10. The rebuild's payment-received path must either not call wallet or have a named replacement. Record the choice; the 10-04 decision already exists.

## Edge cases
- Invoice date is set at lock time, not at payment. Invoice number is assigned at lock (insert).
- `invoice_status` is a free string in the model (`rules`: `string`), not an enum. Only two values are used in code.
- Deleting a transfer cascades a soft delete to its invoices (`deleteTransfer`, F-3).
- `getInvoiceNumber` falls back to the main invoice when a child exists for another company; wrong number possible if the candidate's company is a child that has no invoice yet. Test it.

## Test cases
1. Lock a main transfer with no sub-companies -> exactly one invoice, status unpaid, invoice_date today.
2. Lock twice (second call refused by status) -> still one invoice.
3. Lock with sub-companies -> one child invoice per child company; no main invoice (legacy line 990-1000 logic).
4. paymentReceived -> main and child invoices become paid; no other invoice touched.
5. getInvoiceNumber for a candidate under a child company -> child invoice id; under no child -> main invoice id.
6. Billing import (F4.6): counts and sums by currency and status match legacy exactly; zero unexplained rows.
7. Deleted transfer -> its invoices are soft deleted and absent from the company list.
8. Candidate pay history (F4.9): only paid lines of Distributing or Complete transfers; other candidates' lines never appear (ownership test); detail with another candidate's tc_id returns 404.
9. Frozen amounts: changing contract rate after payment does not change the pay history value.
10. Void/credit (F4.7): new behaviour, no legacy rule; test additive reversal only (no edit of issued documents).
