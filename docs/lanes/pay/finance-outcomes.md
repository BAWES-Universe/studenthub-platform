# Finance: contracts, pay, bank files and invoices (F1 to F4.9)

Outcome contracts; full briefs written one queue ahead. Spec: `docs/parity/finance-contracts-and-payroll.md` (on main), §2 contracts, §3 money path, §4 scheduled jobs, §5 bank files, §11 decisions; `docs/parity/bank-file-contract`; SHU-185 checkpoints 2 and 3 (invoice model, invariants I1 to I9). Execution contract rows SHU-182 to SHU-185, SHU-220.

Built so far: F1 contracts (SHU-182, `packages/pay-contracts`: three pay models, rate resolution, bank details, safe writes). In flight by hand: F4.1 billing account (#219), F4.2 invoice numbering (#220), F4.6 legacy billing import (SHU-268, In Review), bank-file contract (SHU-220, In Review). These are GPT-written hand PRs; route them to the "Codex PR reviewer" lane and merge between queues, never while a box card is landing.

Usage (§1a): transfers and bank files are used every month; most transfer lines are entered by staff; the weekly monthly-salary job carries most of the rest.

Decisions (all settled):
- D-FI1 (SHU-209): settled 10-27, see `decisions-2026-10-27.md`. Scope clarified 2026-11-17: StudentHub generates the official payroll workbook and bank files; it never sends money. The gates (12-month zero-difference replay, one live side-by-side month, month-boundary switch, Khalid's go/no-go) apply to the generator switch; the sequence is in the desk reply of 2026-11-17.
- D-FI2/D-FI3 (SHU-208): settled 10-27 and it governs: reproduce legacy to the fils. Weekly auto-payout keeps salary ÷ 4 on the legacy rolling 7-day window; rounding and rate selection follow legacy. (The earlier text here, "calendar period, round once", was a recommendation that SHU-208 overruled.)

Placement: queues 24 to 27. Because of D-FI1's recommendation, finance can run while the earlier domains cut over.

## Queue 24

### F-1 (F2a): staff enter pay lines into a transfer (R3)
- Outcome: staff create a transfer for a company and period, add lines per person (amount, hours or units, note) with exact decimal arithmetic and integer minutes, see totals per currency, and lock it; every line edit audited; the person sees "Pay" on My profile with their own lines once locked.
- Guards: no floats anywhere (decimal type from `pay-contracts/decimal.ts`); amounts in the contract's currency; lines only for people assigned to the company in that period (W-1).
- Legacy: `Transfer.php`, `TransferCandidate.php` `saveCandidateTransfer()`.

### F-2 (F2b): transfers generate from approved work and monthly contracts (R3)
- Outcome: from W-2's confirmed payable inputs and active monthly-salary contracts, a "Generate" preview shows the lines it will create; confirm creates them in one transaction (a late failure leaves zero lines); the weekly job does the same for auto-generate contracts, for every company (fixes FI-F16, which stopped after the first), using legacy's rolling 7-day window and salary ÷ 4 (SHU-208).
- Legacy: `cron/weekly` `saveTransfer(..., noOfPayout=4)`.

### F-3 (F2c): a transfer's states are a checked state machine (R2)
- Outcome: Draft → Locked → Payment sent → Complete, plus Cancel and the admin revert, every legal and illegal pair tested; child transfers and invoices created on lock exactly once.

## Queue 25

### F-4 (F3a, SHU-184): finance exports a bank file (R3)
- Outcome: from locked transfers, finance generates a bank file in the bank's format (SHU-220 contract), downloads it once per generation with an audit row, and the file records its lines; regenerating the same set gives the same file (idempotent).

### F-5 (F3b): the bank's result is reconciled to lines, once (R3)
- Outcome: finance uploads the bank's result file; one worker claims it with a lease (two workers never process one file; FI-F3); lines are marked paid or rejected, transfers complete when all lines are paid; notifications to people are queued after commit, never before; an ambiguous result is held for a person to decide.
- Legacy: `cron/process-transfer-files` every minute, no lease.

### F-6: people are told when they're paid (R2)
- Outcome: each paid line produces one notification event after commit (C3 feed now; email/SMS when C4 lands), never duplicated on retry.

## Queues 26 and 27: invoices (SHU-185 children)

- F4.1 (SHU-263, #219) billing account and membership; F4.2 (SHU-264, #220) invoice numbering: land the hand PRs between queues, or re-cut as box cards if their reviews fail.
- F4.3 (SHU-265): invoice group preview, single-transaction issue, exactly-once line claim.
- F4.4 (SHU-266): billing read model and drill-down, per-document grant checks.
- F4.5 (SHU-267): staff billing screens: preview → issue → drill-down, bookmarkable frozen documents.
- F4.7 (SHU-269): void and credit documents (additive reversal).
- F4.8 (SHU-270): account balance and statements derived from issued documents, for the company's finance users.
- F4.9 (SHU-271): a person's own pay history view ("Pay" page): own lines only, frozen amounts.
- F4.6 (SHU-268): legacy billing import with reconciliation gate (migration.md).
Each of these already has a Linear card with acceptance; the build thread converts them to box briefs in the queue 12 style, pairing every API with its screen (F4.4 with F4.5; F4.8 with a company "Balance" page).

Out of scope by decision (SHU-213, 10-04): wallet, discounts and perks, staff expenses, Xero. Staff salaries (D-FI4): temporary legacy dependency until a named replacement or approved retirement.
