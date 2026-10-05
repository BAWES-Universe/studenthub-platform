# SHU-220: outbound files and the money-movement boundary

**Proposed contract, awaiting independent Opus exact-head review. Outbound export,
bank delivery and payment execution remain BLOCKED for SHU-184.** Source establishes
several legacy serializers; it does not establish a provider-approved version,
delivery/approval procedure or execution acknowledgement. A separately scoped,
fake-adapter statement-import implementation can proceed against reviewed semantics.
This document neither implements that importer nor authorizes any live activity.

## 1. Authority and evidence limits

| Pin | Repository | Exact revision | Use |
| --- | --- | --- | --- |
| P | BAWES-Universe/studenthub | `c2ce255695eabc7e3a0f23b162f5996274234c63` | Legacy source authority used by merged SHU-97. |
| U | BAWES-Universe/studenthub-admin | `c789b17e3ec5ded542a9e55cd60255d759c26b1b` | Directly inspected admin client source. |
| T | BAWES-Universe/studenthub-platform | `1c7bf687d7939b89bcc69c87c527649ad5e835ae` | Starting current main, including SHU-97 / PR #84. |

All source assertions below cite E-receipts. Each receipt resolves to a full
repository/revision/file:line link in §9 and `evidence.json`, with Git blob and
excerpt hashes. Ranges include relevant control flow; comments are not executable
behavior. The data map is supporting evidence, not a substitute for inspecting P.
P is a historical parity pin, **not an assertion of today's deployed revision**.
The freshly cloned legacy default branch was `922bd05125b936c068c528586f92288ca7ed2e20`;
this research deliberately checked out P for consistency with SHU-97. No claim is
made about behavior added after P. U's default head matched the inspected pin.

Read SHU-220 and SHU-184, refreshed issue discussion and GitHub before claiming.
No competing SHU-220 PR was found. The earlier hold on unmerged SHU-97 was cleared
before claim. SHU-184's existing blocker remains. Only this issue is claimed.

Search scope: tracked PHP application/model/controller/component/console source
in P and tracked TypeScript admin services/pages in U. Followed export entrypoints,
serializer helpers, object persistence, importer previews and background processing,
state transitions, advice register, wallet stubs and latent wallet helpers. Searched
for `sftp`, bank submit/upload/acknowledgement, payment submit/execute, `FHR,`, `APO,`,
`S1,`, `getPayableCandidateListFormat`, `getPayableListFormat`, `getPayableAdvice`,
`saveExcelFile`. Excluded credential/config-value files, data fixtures, dumps, binaries
and production records. The routing-only `admin/config/main.php` entries were inspected
as navigation leads. No legacy PHP, job, ORM hook or provider adapter was executed.

The search does **not** establish absence from every repository, private operator
script, bank portal or provider system. Provider and operator evidence is explicitly
missing in §7. No donor repository or public bank specification is substituted for it.

## 2. Separate stages and current authoritative writers

“Writer” here identifies the source code that changes the relevant state, not a
claim of authorization for this session. Proposed platform owners/keys are in §6.

| Operation | Observed source authority and operator control | Legacy retry / idempotency evidence |
| --- | --- | --- |
| Establish payable state | Operator calls payment-received action; `admin/models/Transfer::paymentReceived` updates the transfer and invoices after checking prior state. It also calls walletManager and notifications. E32–E33. | State guard rejects already-distributing; state update is not an atomic compare-and-swap. Wallet call resolves to a disabled stub at P (E30). No bank receipt verified by this action. |
| Select export lines | Backend query selects unpaid parent transfer lines in distribution state. Bank-info/civil/profile/invoice checks vary by route. Operator chooses export, currency and page slice. E01–E12, E47–E49. | No stable ordered snapshot or reservation demonstrated by these query/serializer paths. Offset/limit is not a dedupe key. |
| Generate instruction/advice bytes | Admin TransferController plus common TransferCandidate helpers write text/Xlsx; generate UUID, `count()+1` serial and `T{serial}V1` filename. E01–E07, E20. | No exclusive line claim, immutable batch membership or export idempotency key in these methods. Concurrent serial allocation can collide; a UUID per request does not dedupe the request. |
| Persist and download | TransferBankAdvice writes object content/path and advice record; HTTP response sends the file to the caller. E01–E05, E13–E14. | Object write precedes advice save. No shared transaction with object storage or retry receipt; DB failure can leave an object. This is delivery to storage/browser, not to a bank. |
| Bank approval/release | **UNKNOWN**: named operator, authority, dual approval, release conditions, signing/encryption and bank acceptance policy. | No provider approval or retry contract established. HOLD. |
| Deliver to bank | **UNKNOWN**: portal/SFTP/API/email/manual upload, destination, scheduling, cutoff and transport acknowledgement. | No delivery attempt ID, provider idempotency support or timeout reconciliation contract established. HOLD. |
| Execute/settle payment | **UNKNOWN provider authority**. A downloaded file, saved advice, successful HTTP response or local `paid=1` is insufficient evidence. | No exactly-once bank effect demonstrated. Unknown outcome must HOLD; never blindly resubmit. |
| Select/upload incoming file | Operator selects a file, uploads through client service, chooses parser label and opens preview. E47, E50–E51. | No content hash admission/dedupe in E23. Provenance of the operator's file remains unknown. |
| Preview incoming AUB results | TransferController actionImportExcel reads uploaded workbook; `FAIL` clears line AND profile bank details and marks unpaid; only `SUCCESS` enters preview result. E15. | **Preview is a writer** and can notify; no transaction across the preview loop. A later bad row can follow earlier mutations. It must not be reused as a pure parser. |
| Preview KFH/statement/manual | Controller resolves rows to database records using distinct matching rules; U chooses one of four routes. E17, E21, E39, E50. | Read projections are not a durable confirmation token or proof the later parser sees identical bytes/selection. |
| Confirm inbound file | Operator selects candidates; `mark-paid-all` copies the entire uploaded file and inserts TransferFile. Selected IDs feed initial amount calculation. E22–E23, E50. | Client sets maxRetryAttempts=0 (E47), but manual repeat/concurrent requests remain possible. No persisted selected-row binding/content key. |
| Process reconciliation | Cron selects pending files; TransferFile unconditionally writes PROCESSING then starts a transaction, inserts entries and changes paid/reference/file ID on lines. E16, E18–E19, E24–E26. | No pending→processing CAS. Three-attempt save loop is not a file lease or proof of safe deadlock retry. Background processing re-reads the WHOLE file, not the selected IDs. |
| Retry failed import | Operator re-schedules only FAILED files to PENDING. E27. | Positive server guard; no stale-PROCESSING recovery or content identity protection established. |
| Payment notifications / projections | `markProcessed` sends accountant mail before transaction commit. Paid hook updates stats; candidate paid email/push calls are commented out; unpaid transition can notify. E24–E25, E31. | No transactional outbox or unique per-line notification delivery proof. Local file completion is not a payment acknowledgement. |
| Replace payee | Operator picker; TransferCandidateController writes previous/current candidate and bank/name/IBAN snapshot. E28, E49. | No export-version binding or expected-version check in the action. Replacement must invalidate any proposed export approval. |
| Individual mark paid/unpaid | Admin TransferCandidate model/action writes paid state and confirmation; confirmation is required unless wallet mode. E28–E29. | Already-paid guard exists but is not a concurrency claim. **Corrects SHU-184 inventory wording:** controller permits null through, but model rejects it (E29:166–170). |
| Advice register | Backend CRUD stores/changes file_path; actor attribution on create. E13, E38. | Mutable register plus UUID is not an immutable bank-submission ledger. |
| Search reconciliation key | Operator searches by line/confirmation ID through the backend read route, filtered by currency/payable-with-paid (E54–E55); authoritative reconciliation matching remains E16/E18/E19. | A found line is a read result, not a new payment or dedupe receipt. |

The legacy `/text` action is explicitly excepted from the controller's bearer
authenticator (E34). This is a source-level authentication exclusion, not a tested
claim that every deployed ingress permits anonymous access. All observed export
routes need a separately reviewed authorization/export policy before retention.

### Wallet boundary, without reviving a retired path

`markPaid` and payment-received invoke walletManager; at P its `addEntry` logs the
payload and returns success before a commented-out HTTP implementation (E29–E30,
E32). Therefore these calls do not establish an active bank/wallet transport.
`WalletTransfer` uses `walletDb` and contains separate S2/D row helpers (E41–E42).
The tracked PHP search found their declarations only, no callers; no envelope,
retention decision or bank-delivery path is established for them. They are **not
retained export formats** in this contract and receive no fabricated bank fixtures.

The adjacent BalanceController init-transfer route actually imports
`common/models/Transfer`, not WalletTransfer (E43–E44). Its attribute assignments
must not be promoted into a verified wallet execution path. Wallet scope, deployed
wiring and external services remain unknown. Preserve SHU-97's separate namespace
and no-effects-on-import rules (E52–E53).

## 3. Established outbound serializer shapes, not approved bank formats

The reference account literals in P are deliberately not reproduced. Fixtures
replace them with conspicuously synthetic values. No debit account, credentials,
real IBAN, source row or personal name was copied. Fixtures are unsuitable for bank
submission. `V1` below is a filename literal, **not proof of a bank specification version**.

| Local fixture format ID | Observed structure | Dates, amounts and identity | Evidence |
| --- | --- | --- | --- |
| `legacy-s123` | Header `S1,<source-account>,,MXD,M,,<date>,<date>-01`; ordered S2 rows, trailing comma + native newline; `S3,<count>,<total>` without terminal newline. | Header dates `d/m/Y`, `dmY`; S2 amount and footer three decimal places. Row currency comes from parent transfer; filtering is by line currency. S2 uses CURRENT candidate IBAN/name/bank, despite checking snapshot presence. | E04, E06, E09 |
| `legacy-hdt-advice` | `H,<batchId>,<unix-seconds>`; `D,transfer_id,email,dmY,tc_id,parent-currency,amount,` + newline; `T,count,total` without final newline. | Clock-generated date is not proven invoice date. Three decimals; companion advice correlation uses transfer and line IDs. Separate request generates a separate serial; no guaranteed pairing with S123. | E05, E07 |
| `legacy-abk-fhr-apo` | `FHR,batchId,m/d/Y,count,total;` + newline, then `APO` rows ending `,O,,,,,,,;` + newline. No trailer. Full ordered fields are in fixtures. | `ABKK` selects WIB and extracts account; otherwise KASIP and full snapshot IBAN. Uses snapshot beneficiary name/bank, line currency and candidate_total. Appends `XXX` to SWIFT and `S <tc_id>` reference. | E03, E08–E09 |
| `legacy-abk-workbook` | Xlsx writer, one sheet, 17 ordered attributes, header + data rows, no total row. Fixture retains decoded cell values rather than claiming byte-identical ZIP output. | No date field. Debit account constant replaced; TXN CURRENCY hardcoded KWD even though request filters another currency. Current candidate name/bank-code mix with snapshot IBAN/bank. Amount is candidate_total without explicit serializer number format. | E02, E35–E37 |

ABK account extraction is literally `str_replace("000000000", "", substr(iban,8))`
(E08), not a validated general IBAN conversion algorithm. Do not export a target
implementation from this expression without provider evidence.

Text code uses raw concatenation/`implode`, `PHP_EOL`, `date/time`, `number_format`
and `fwrite` (E03–E07). It specifies neither character transcoding nor escaping,
BOM, platform-independent line endings, timezone, maximum field length or
provider byte limits. Our text fixtures select **UTF-8, no BOM, LF, UTC frozen clock**
as synthetic construction choices, not bank requirements. Arabic round-trip proves
fixture bytes only. Comma/newline inputs for comma-delimited serializers and
comma/newline/semicolon inputs for FHR/APO deliberately demonstrate broken legacy
framing; no invented CSV quoting repair is represented as historical output.

The 17 ABK workbook attributes are: `DEBIT ACCOUNT`, `Name`,
`candidate.candidate_iban`, `BENEFICIARY BANK ADDRESS`, `BENEFICIARY BANK NAME`,
`BENEFICIARY BANK BRANCH ID`, `BENEFICIARY CITY`, `BENEFICIARY COUNTRY`,
`BENEFICIARY ADDRESS 1`, `BENEFICIARY ADDRESS 2`, `TXN CURRENCY`, `Amount`, `Type`,
`BENEFICIARY BANK IDENTIFIER`, `PURPOSE OF TRANSFER`, `PAYMENT DETAILS`, `Charge`.
**The helper ignores `label`**, instead calling `getAttributeLabel(attribute)`
(E35). Thus the controller's desired `BENEFICIARY NAME` label is not proof of the
emitted header for attribute `Name`. Translations/model labels and automatic cell
binding can affect workbook output. The fixture identifies columns by attributes,
not a fabricated bank-approved header. Exact serialized header, cell typing,
formula handling and provider workbook constraints remain HOLD.

General payable and transfer-specific exports are reporting spreadsheets, not
proven bank instruction formats (E01, E46). Their explicit columns include IDs,
personal/bank data, work/rate/bonus and totals; SHU-196 owns their export policy.
Manual/Google export (E20) is an operator reconciliation worksheet, with `Paid=Yes`
prefilled and a misspelled `Refrence Number` output attribute, while import requires
`Reference Number` (E19, E21). A round trip cannot be assumed. Keep the discrepancy
visible, not “fixed” in a supposed production fixture.

## 4. Inbound formats and partial results are separate

Workbook fixtures are synthetic **decoded single-sheet cell matrices** at the
PhpExcel boundary, serialized as JSON for review. They preserve consumed key
spellings and preamble/header row numbers. Unconsumed title rows are null placeholders;
provider titles, original order where key-based, native Xls/Xlsx packaging/version,
cell styles and bank document authenticity are unknown. This is not an assertion
that JSON is a bank format. No native workbook fidelity or live importer execution
is claimed. Each case states the source-derived outcome and the proposed safe outcome.

| Parser | Established input boundary / matching | Partial rejection and duplicate behavior at P |
| --- | --- | --- |
| AUB | Header row 2; full consumed keys recorded in fixture. Credit Narrative→tc_id, Debit Narrative used as transfer_id, Status Description→confirmation. E15–E16. | Preview SUCCESS-only; FAIL clears payee/profile bank data. Background accepts every nonempty Status, including FAIL; it does not compare Credit Amount/Currency to line amount/currency before marking paid. **Do not reproduce this as target success behavior.** |
| KFH | Header row 9; exact typo `Refrence Number`; account+Amount+Transfer Currency, latest unpaid tc_id wins. E16–E17. | No success/failure status interpretation; presence of reference is treated as success. Background only checks paid+same-reference duplicate after finding no unpaid match. Another matching unpaid line can therefore consume a repeated row. Multiple matches must HOLD in target. No KFH rejection status invented. |
| BankStatement | Header row 8; Description plus optional Debit/Credit. Extract `SALARY <digits>`, otherwise `S <digits>`; unpaid tc_id lookup; slash component 3 (index 2), otherwise component 1, becomes confirmation. E18, E39. | Blank/unrecognized descriptions ignored; missing/already-paid candidate skipped. Backend records Debit but does not compare amount or infer actual settlement from bank status. A credit/reversal containing the matching text is not proven a successful salary payment. |
| Manual/Google | Header row 1; Reference Number and Paid (`Yes`/`YES` after trim), Candidate ID+Candidate Total+Currency Code; latest unpaid match. E19, E21. | Rows without reference or accepted Paid spelling skipped. Operator assertion, not provider acknowledgement. Re-import and multiple matching candidates have no durable dedupe contract. Background dereferences candidate after query without a prior null-record guard. |

Common failure paths: AUB/KFH use `array_combine` without schema/row-width checks;
missing/duplicate headers, malformed numeric values and unexpected bank label are
not a validated version negotiation. Any nonempty label other than BankStatement
enters populateEntries; non-AUB then follows the KFH-shaped branch (E16, E24).
Selected preview IDs do not constrain background parsing; initial file total sums
selected IDs, while background reads the whole workbook (E22–E24). This can make
selection, amount receipt and actual written lines disagree.

The background sets paid/reference/file ID and inserts reconciliation entries,
then marks transfer completion (E24). Those are local financial-record mutations.
They neither send instructions to a bank nor prove that a bank executed them.
One inbound file may contain accepted, rejected, unmatched and duplicate rows;
local atomicity and provider partial acceptance are different questions.

## 5. Synthetic fixtures and exact expected results

`fixtures.json` contains fabricated input values, established ordered row/column
shapes, output text or decoded cell matrices, explicit source-derived observations,
and proposed target dispositions. `synthetic-*.txt` are byte fixtures for the three
text serializers. `verify.py` checks their bytes, totals, row shapes, UTF-8, dates,
precision, malformed cases and source receipts using read-only Git access. It is a
fixture/document consistency checker, **not a bank adapter or implementation test**.

Primary amounts are 10.125 and 20.005: two lines, **30.130 KWD**. AUB partial fixture
contains SUCCESS 10.125 and FAIL 20.005: source preview returns one line/10.125,
whereas direct background parsing would admit both rows if both candidate records
still resolve. Target result must retain explicit rejection and must not mark the
FAIL line paid. The preview's own clearing side effects make subsequent state
order-dependent; this is not presented as an executed end-to-end result.

Cases cover zero and minimum 0.001, maximum decimal(10,3) 9999999.999, 10000000.000
overflow, negative values, extra scale, malformed decimals, currency mismatch,
leap day/year boundary/invalid date, Arabic, delimiter/newline corruption, missing
columns, unknown statuses, repeated references, multiple matches, manual omitted
reference, ignored statement row, credit/reversal and a debit mismatch. Exact
three-decimal source formatting is not approval of a rounding policy; the target
rejects unsupported scale/range/currency until policy is approved (E40, E52).

No bank-response fixture is fabricated for S123, HDT or ABK: their response grammar
is not established. For those formats, partial rejection is an **unknown-provider
outcome** tied to a synthetic two-line batch; it holds delivery/retry/paid changes
until a genuine provider contract supplies row statuses and correlation. KFH has
no invented rejection column. Workbook JSON tests parser semantics only; acquiring
an approved synthetic native workbook/sample is an explicit prerequisite below.

## 6. Proposed platform operation ownership and retry contract

These are **normative proposals for SHU-184 review**, not existing implementation
claims. All provider ports stay fake/disabled. Preserve SHU-97 SourceRef namespaces,
exact decimal amounts and payment-time snapshots; import historical paid state
without firing any effect (E52–E53).

| Operation | Sole proposed writer | Proposed key and retry behavior |
| --- | --- | --- |
| Approve payable snapshot | Financial workflow service under explicit finance grant | Command ID + organization + expected aggregate version. Receipt commits with state; repeated identical command returns same receipt, changed payload conflicts. |
| Replace payee / edit line | Same financial workflow service | Command ID + expected line version; invalidate batch/approval snapshots. Never substitute current profile into an already-approved instruction. |
| Prepare/export local artifact | Export service, exclusively leased per batch | Immutable batch ID + format/version + ordered `(line ID, line version)` + currency + content digest. Unique active membership for each line/version. CAS lease with fencing; staged object and durable manifest reconciled after crash. Same command returns same artifact. No provider effect. |
| Advice register / retrieve | Export service for immutable records; authorized download reader | Artifact ID/version/digest. Retrieval cannot regenerate, change serial or modify financial state. Tombstone/correction is an audited command, never overwrite a release receipt. |
| Release / approve delivery | Explicit designated finance approver(s), through workflow service | Approval bound to artifact digest, amount, count, currency, payee versions and provider contract version. Authority/dual-control policy unknown; disabled until decided. |
| Submit to provider | One delivery service per approved instruction | Durable attempt intent before I/O; use provider-supported key scoped exactly as documented. Timeout becomes UNKNOWN; reconcile with provider before any repeat. Local lease alone cannot guarantee exactly-once external effects. Currently BLOCKED. |
| Execute payment | Provider under explicit approved release | Provider transaction identity and authenticated finality evidence. No application “execute” success synthesized from upload or download. Currently BLOCKED. |
| Admit incoming statement | Reconciliation admission service | Provider/account context + immutable content digest + parser version; same bytes/context returns prior artifact; conflicting identity/digest HOLD. Bind selection and preview digest if selection is retained. |
| Parse / preview | Pure parser and read-only matching service | Parser version + artifact digest + financial snapshot version. Zero DB/profile/notification writes. Unknown label/header/status, formula, extra scale or ambiguous match HOLD. |
| Reconcile lines | Single financial reconciliation writer, CAS claim on pending file | Provider row/reference scoped to provider/account plus immutable row digest and line ID/version. Unique receipt; compare amount, currency, payee, direction, final status and parent. Replay identical receipt no-op; changed body conflicts. No “latest match” heuristic. |
| Partial result | Same reconciliation writer | Retain every accepted/rejected/unmatched/duplicate row outcome. Apply only established successful, uniquely matched rows in one local commit; malformed/ambiguous financial aggregate HOLD under the reviewed policy. Rejected rows stay unpaid. No silent blanket success. |
| Retry/recover import | Same writer with fenced lease recovery | Claim token + generation; only proven rolled-back/retryable work resets. Unknown commit first reconciles immutable receipts. Concurrent old worker cannot write after takeover. |
| Emit payment notification | Transactional outbox writer, then delivery worker | One event ID per newly reconciled paid line/version; insert in same commit; send after commit with dedupe receipt. Rollback sends nothing. Imported history is nondispatchable. |
| Reconciliation search / totals | Authorized query service | Read-only; totals recomputed over the immutable full batch per currency, not current UI page. No mutation or money effect. |
| Wallet history | Separately scoped wallet domain | SourceRef namespaced `wallet.*`; no active queue/release/job imported. External wallet retry/authority unknown; no revival under this issue. |

No logs contain file contents, bank rows, names, accounts, references or free-form
provider error bodies. Proposed operational logs use closed event/reason codes,
opaque internal artifact/run IDs, counts and status. Restricted evidence storage
holds any later authorized sensitive receipts separately. Existing source error
paths print rows/bank data (E16, E24, E30); copying them is not acceptable parity.

## 7. Explicit missing provider/operator evidence and export gates

| Unknown | Evidence required before affected behavior can leave HOLD |
| --- | --- |
| Retained providers and versions | Owner names each retained bank/product/account context; provider-issued format version and effective date. `V1`, AUB/KFH/ABK code labels and a route name do not settle this. |
| Native file contract | Approved synthetic native samples, required column names/order/types, delimiter/escaping, encoding/BOM/EOL, length limits, date/timezone/cutoffs, amount scale/rounding, currency support, totals and empty-file rules. |
| Debit account / origin identity | Authorized operator attestation of origin configuration and scope, without placing credentials/account details in this repo. Synthetic placeholders cannot be enabled. |
| Operator process | Who creates, checks, approves, downloads, possibly edits, uploads, releases and reconciles; separation of duties, exact manual tool/portal steps and retained audit receipts. Source demonstrates the UI controls; actual use is unknown. |
| Delivery channel | Documented endpoint/channel identity, signing/encryption and transport acknowledgement distinct from instruction validation and payment completion. No access requested here. |
| Provider status/finality | Full success/pending/failure/partial/reversal/return semantics, row and batch correlation, amount/fee/FX interpretation, statement timing and finality. No unsupported response format invented. |
| Duplicate/retry policy | Provider key scope/lifetime, same key/different bytes behavior, batch vs row handling, unknown-outcome lookup and operator replay procedure. |
| Snapshot and cross-format differences | Decide current-profile vs payment snapshot fields, ABK KWD constant, S123 parent currency, ABK account conversion, workbook header/typing, manual spelling discrepancy and companion-file pairing. |
| Deployed/operator-only source | Identify any private delivery scripts/repositories, bank software or worker versions; inspect read-only under separate scope if needed. This bounded search cannot disprove their existence. |
| Notification/approval policy | Recipient and event semantics, once-per-line outbox contract, retention and authorized reviewers. Source comments or historical sent flags are not evidence of external delivery. |

**Release gate:** serializer shape alone is insufficient. Retained format/version,
approval, delivery, authenticated results, duplicates/unknown recovery and reconciliation
must all be independently reviewed. Unsupported export/submission stays blocked;
merging this research must not clear SHU-184's export gate by implication.

## 8. Handoff and validation

The PR must link SHU-220 and attach this exact-head contract link to SHU-184 as
**pending review**. Opus must post independent PASS/BLOCK on the PR and SHU-220
against the full head SHA; after PASS, that same immutable link is the reviewed
contract attachment. Until that verdict exists, do not label this reviewed, mark
SHU-220 Done, clear the export gate, self-PASS or merge. A changed head needs a new
verdict and attachment. This author cannot supply the independent review.

Reproduce the local checks (Python standard library, no PHP, dependencies or network):

```sh
python docs/parity/bank-file-contract/verify.py /path/to/studenthub /path/to/studenthub-admin
```

Verifier priorities: challenge AUB preview/background mismatch; selected-vs-whole-file
reconciliation; KFH latest-match duplicate weakness; statement debit/credit mismatch;
manual header typo; ignored workbook labels; disabled wallet transport; per-format
currency/snapshot differences; absent outbound membership/delivery evidence. Check
receipt lines against the exact Git pins and challenge this document's conclusions,
not just fixture arithmetic. No production adapter, bank format or live parity PASS
is established by a green static checker.

## 9. Exact source receipts

The E IDs above refer to these complete repository revision and file:line citations.
Machine-readable hashes are in [evidence.json](evidence.json).

- **E01** — General payable spreadsheet and advice registration: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:1449-1585`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L1449-L1585).
- **E02** — ABK spreadsheet selection, columns, persistence and download: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:1591-1830`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L1591-L1830).
- **E03** — ABK FHR/APO text generation: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:1838-1964`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L1838-L1964).
- **E04** — S1/S2/S3 text envelope: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:1971-2030`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L1971-L2030).
- **E05** — H/D/T advice envelope: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:2035-2103`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L2035-L2103).
- **E06** — S2 selection, fields and total: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferCandidate.php:775-861`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferCandidate.php#L775-L861).
- **E07** — D selection, fields and total: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferCandidate.php:869-930`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferCandidate.php#L869-L930).
- **E08** — ABK account extraction: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferCandidate.php:417-419`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferCandidate.php#L417-L419).
- **E09** — candidate_total amount authority: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferCandidate.php:622-636`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferCandidate.php#L622-L636).
- **E10** — Payable parent unpaid distribution-state selection: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/query/TransferCandidateQuery.php:191-204`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/query/TransferCandidateQuery.php#L191-L204).
- **E11** — Bank snapshot presence: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/query/TransferCandidateQuery.php:226-231`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/query/TransferCandidateQuery.php#L226-L231).
- **E12** — Civil expiry predicate: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/query/TransferCandidateQuery.php:361-365`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/query/TransferCandidateQuery.php#L361-L365).
- **E13** — Advice identity/serial rules and actor attribution: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferBankAdvice.php:36-82`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferBankAdvice.php#L36-L82).
- **E14** — Object persistence, not bank delivery: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferBankAdvice.php:130-175`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferBankAdvice.php#L130-L175).
- **E15** — AUB preview mutates failure records: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:494-630`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L494-L630).
- **E16** — AUB/KFH background parsing, row writer and duplicate branch: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferFile.php:408-678`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferFile.php#L408-L678).
- **E17** — KFH preview: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:823-992`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L823-L992).
- **E18** — Statement processing: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferFile.php:700-890`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferFile.php#L700-L890).
- **E19** — Manual processing: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferFile.php:893-1028`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferFile.php#L893-L1028).
- **E20** — Manual/Google export: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:1000-1129`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L1000-L1129).
- **E21** — Manual preview: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:1135-1317`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L1135-L1317).
- **E22** — Queue whole file, selected IDs only feed initial total: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:1369-1444`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L1369-L1444).
- **E23** — Copy upload and insert inbound file: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferFile.php:140-171`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferFile.php#L140-L171).
- **E24** — Unconditional processing claim and transaction: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferFile.php:179-335`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferFile.php#L179-L335).
- **E25** — Failure and completion mail ordering: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferFile.php:681-692`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferFile.php#L681-L692).
- **E26** — Pending file batch scheduling: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `console/controllers/CronController.php:338-348`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/console/controllers/CronController.php#L338-L348).
- **E27** — Failed-only reschedule: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferFileController.php:99-121`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferFileController.php#L99-L121).
- **E28** — Replacement, mark paid, wallet API boundary: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferCandidateController.php:257-342`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferCandidateController.php#L257-L342).
- **E29** — Individual paid guard and wallet call sites: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/models/TransferCandidate.php:147-263`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/models/TransferCandidate.php#L147-L263).
- **E30** — Disabled wallet implementation, commented transport: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/components/WalletManager.php:22-71`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/components/WalletManager.php#L22-L71).
- **E31** — Paid hook statistics and unpaid notification: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/TransferCandidate.php:327-346`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/TransferCandidate.php#L327-L346).
- **E32** — Payment received state transition: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/models/Transfer.php:115-169`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/models/Transfer.php#L115-L169).
- **E33** — Operator payment-received action: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:370-407`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L370-L407).
- **E34** — Bearer authentication excludes text action: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:30-60`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L30-L60).
- **E35** — Worksheet header and cell writing: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/components/PhpExcel.php:451-530`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/components/PhpExcel.php#L451-L530).
- **E36** — Worksheet value resolution: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/components/PhpExcel.php:589-605`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/components/PhpExcel.php#L589-L605).
- **E37** — Xlsx writer and imported formatted/calculated cell arrays: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/components/PhpExcel.php:695-772`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/components/PhpExcel.php#L695-L772).
- **E38** — Advice register CRUD: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferBankAdviceController.php:69-181`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferBankAdviceController.php#L69-L181).
- **E39** — Statement preview: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:636-820`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L636-L820).
- **E40** — Decimal declaration: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `console/migrations/m210628_063748_transfer_candidate_total_fields.php:10-20`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/console/migrations/m210628_063748_transfer_candidate_total_fields.php#L10-L20).
- **E41** — Separate wallet database/table: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/WalletTransfer.php:62-74`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/WalletTransfer.php#L62-L74).
- **E42** — Latent wallet row format helpers: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/WalletTransfer.php:215-342`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/WalletTransfer.php#L215-L342).
- **E43** — Balance init transfer action: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/BalanceController.php:188-213`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/BalanceController.php#L188-L213).
- **E44** — Balance action imports common Transfer, not WalletTransfer: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/BalanceController.php:1-14`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/BalanceController.php#L1-L14).
- **E45** — Legacy transfer type vocabulary: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `common/models/Bank.php:143-146`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/common/models/Bank.php#L143-L146).
- **E46** — Transfer-specific reporting spreadsheet: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferController.php:2110-2202`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferController.php#L2110-L2202).
- **E47** — Import/export client routes and zero auto retries for confirmation: [BAWES-Universe/studenthub-admin@c789b17e3ec5ded542a9e55cd60255d759c26b1b `src/app/providers/logged-in/transfer.service.ts:161-316`](https://github.com/BAWES-Universe/studenthub-admin/blob/c789b17e3ec5ded542a9e55cd60255d759c26b1b/src/app/providers/logged-in/transfer.service.ts#L161-L316).
- **E48** — Operator export/pagination choices: [BAWES-Universe/studenthub-admin@c789b17e3ec5ded542a9e55cd60255d759c26b1b `src/app/pages/logged-in/transfer/payable-candidates/payable-candidates.page.ts:201-304`](https://github.com/BAWES-Universe/studenthub-admin/blob/c789b17e3ec5ded542a9e55cd60255d759c26b1b/src/app/pages/logged-in/transfer/payable-candidates/payable-candidates.page.ts#L201-L304).
- **E49** — Page totals and payee replacement: [BAWES-Universe/studenthub-admin@c789b17e3ec5ded542a9e55cd60255d759c26b1b `src/app/pages/logged-in/transfer/payable-candidates/payable-candidates.page.ts:330-402`](https://github.com/BAWES-Universe/studenthub-admin/blob/c789b17e3ec5ded542a9e55cd60255d759c26b1b/src/app/pages/logged-in/transfer/payable-candidates/payable-candidates.page.ts#L330-L402).
- **E50** — Parser selection and selected row confirmation: [BAWES-Universe/studenthub-admin@c789b17e3ec5ded542a9e55cd60255d759c26b1b `src/app/pages/logged-in/transfer/transfer-paid/transfer-paid.page.ts:40-145`](https://github.com/BAWES-Universe/studenthub-admin/blob/c789b17e3ec5ded542a9e55cd60255d759c26b1b/src/app/pages/logged-in/transfer/transfer-paid/transfer-paid.page.ts#L40-L145).
- **E51** — Operator file selection/upload: [BAWES-Universe/studenthub-admin@c789b17e3ec5ded542a9e55cd60255d759c26b1b `src/app/pages/logged-in/transfer/import-transfer-form/import-transfer-form.page.ts:50-124`](https://github.com/BAWES-Universe/studenthub-admin/blob/c789b17e3ec5ded542a9e55cd60255d759c26b1b/src/app/pages/logged-in/transfer/import-transfer-form/import-transfer-form.page.ts#L50-L124).
- **E52** — Typed finance mapping, source keys and monetary precision: [BAWES-Universe/studenthub-platform@1c7bf687d7939b89bcc69c87c527649ad5e835ae `docs/parity/data-map/README.md:99-147`](https://github.com/BAWES-Universe/studenthub-platform/blob/1c7bf687d7939b89bcc69c87c527649ad5e835ae/docs/parity/data-map/README.md#L99-L147).
- **E53** — Cross-cluster job/side-effect boundaries: [BAWES-Universe/studenthub-platform@1c7bf687d7939b89bcc69c87c527649ad5e835ae `docs/parity/data-map/README.md:220-254`](https://github.com/BAWES-Universe/studenthub-platform/blob/1c7bf687d7939b89bcc69c87c527649ad5e835ae/docs/parity/data-map/README.md#L220-L254).
- **E54** — Reconciliation search by line and confirmation: [BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63 `admin/modules/v1/controllers/TransferCandidateController.php:173-200`](https://github.com/BAWES-Universe/studenthub/blob/c2ce255695eabc7e3a0f23b162f5996274234c63/admin/modules/v1/controllers/TransferCandidateController.php#L173-L200).
- **E55** — Operator reconciliation search controls: [BAWES-Universe/studenthub-admin@c789b17e3ec5ded542a9e55cd60255d759c26b1b `src/app/pages/logged-in/transfer/candidate-payment-search/candidate-payment-search.page.ts:40-103`](https://github.com/BAWES-Universe/studenthub-admin/blob/c789b17e3ec5ded542a9e55cd60255d759c26b1b/src/app/pages/logged-in/transfer/candidate-payment-search/candidate-payment-search.page.ts#L40-L103).
