# W-2 (SHU-175): approved work becomes payable inputs for finance

Source: legacy Yii2 `studenthub` @ 55119d3. Haiku draft, 2026-11-05. Verify the status-flow question on the staging prod copy before the card is written.

## Legacy behaviour

- Hours export for transfers: `staff/modules/v1/controllers/TransferController.php` `actionApprovedWorkLog` (~line 930-960) and `actionTransferExcelTemplate` (~line 1000-1030). For each candidate of the company, sum `candidate_working_date.total_time` where `status = APPROVED`, date range filter, and `store_id` = the candidate's CURRENT store. Output hours, minutes, seconds (floor per unit).
- Template path also builds rows with `bonus = 0`. Contract filter: `contract_uuid` given, else `contract_uuid IS NULL` via work history join.
- Company side: `company/.../CandidateController.php` `actionWorkLogExcel` and `actionWorkLogDetailedExcel` (exports).
- No "Confirm month" step exists in legacy. The contract's confirmation is new (D-WK3).
- Usage (from the SHU-213 comment, 12 months to 2026-10-04): hour logging is rare, 43 rows.

## Fields (new payable input)

`payable_input_id`, `assignment_id` (W-1), `contract_id`, `period_start`, `period_end`, `basis` (hours | fixed | monthly), `approved_seconds`, `rejected_seconds` (excluded, shown for audit), `provenance` (list of session ids and decision ids), `status` (draft | confirmed | invalidated), `confirmed_by`, `confirmed_at`.

## Rules

1. Hours basis: sum only sessions that are closed AND approved (W-4). Rejected and pending sessions are excluded from the amount.
2. Fixed and monthly contracts: no hour sum; the contract's amount is the input. Monthly contracts pay through the weekly job (contract text).
3. Employer must confirm the month before the input can go to transfer generation (F2). Confirmation is per assignment and per month.
4. A correction after confirmation reopens the month and marks the input invalidated until re-confirmed (D-WK3, SHU-206).
5. This card does not compute money. F2 owns arithmetic and rounding. Legacy rounding (floor per unit) must be replayed to the same seconds in the replay test.

## Permissions

- Staff: read all inputs, export.
- Company: confirm own store's months only (scope by company and store, sub-company aware as in `CandidateWorkLogFeedbackController::actionUndo`).
- Candidate: no access to payable inputs.

## Edge cases

- **Status on the day row (verify, high priority):** `candidate_working_date.status` is written only by `CandidateWorkingHour::updateStats` (on session insert/update), and that method copies the saved session's status. The approval path `CandidateWorkLogFeedback::afterSave` updates session rows with `updateAll` (no afterSave on sessions) and does not write the day's status. If that is right, approved days never reach the `status = APPROVED` filter. Check whether finance sees approved hours in production before porting.
- **Rejected seconds included:** `candidate_working_date.total_time` sums ALL closed sessions regardless of status (`CandidateWorkingHour::updateStats`). If a day is marked approved, rejected sessions can be paid. Rebuild must sum approved sessions only.
- **Store change mid-month:** filtering by the current store drops hours logged at the previous store. Legacy comment says "in case store changed in month" but the effect is the opposite. Rebuild should key by assignment id.
- **Floor per unit:** hours, minutes, seconds computed from floor divisions; remainder seconds shown separately. Replay must match legacy to the second.
- **Open session at export:** excluded (not closed). Show count of open sessions as a warning.

## Test cases

1. One approved 2h session plus one rejected 1h session on the same day: payable hours 2h, rejected 1h shown, not paid.
2. Day where session 1 approved and session 2 rejected: payable 1 session only (the status bug above must not reproduce).
3. Store change mid-month: hours from both stores included under the same assignment.
4. Confirm month: input becomes confirmed; a later correction invalidates it; re-confirm restores it.
5. Replay: a legacy month export reproduces the same hours, minutes, seconds per candidate on the staging copy (exact match).
6. Fixed and monthly basis: amount equals contract amount, no hour sum.
7. Company confirm for another store: refused.

## Dependencies

W-1 (assignment), W-4 (approved status), W-7 (day totals). Feeds F2 (finance).
