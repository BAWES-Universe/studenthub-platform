# Work and hours: parity notes

Lane: work and hours (W-1 to W-7), migrations 0500 to 0549, code in `packages/work`,
`packages/db/src/postgres-work-store.ts` (subpath `@studenthub/db/work`).

Legacy benchmark: Yii2 `studenthub` (staff `CandidateController` assign/unassign,
company `StoreController` and `StoreAssignmentRequestController`, candidate
`AccountController` start/stop/discard, `CandidateWorkingHourController`,
`CandidateWorkLogFeedbackController`, `CandidateWorkingHour::updateStats`, the
`FixWorkLogs` and `FixWorkLogDates` crons).

## Settled decisions applied (2026-10-27)

| Decision | Rule here |
|---|---|
| D-WK1 clock-in location | Start and Stop require a location. Both pairs are kept (fixes WK-F2, stop overwrote start). No geofence. A manual entry is accepted, pending, and flagged `late_entry` for the approver. |
| D-WK2 ratings | Kept as legacy (visible to other employers in search). Lands with W-4. |
| D-WK3 corrections | Staff correct approved hours without re-approval; a reason is required and history is kept. A correction is a new session that replaces the original in every total; the original row stays. A correction after month end reaches pay as a changed session (see the payable seam). No new notifications. |
| No regressions | The civil ID check on placement is a warning (`civil_id_missing`, `civil_id_expires_before_start`), not a refusal, because legacy has no such gate. |

## What changed from legacy, and why

| Legacy behaviour | Here | Why |
|---|---|---|
| Assign wrote `candidate.store_id`, created a contract, stored `parent_company_id` with `\|\|` (a boolean) | An assignment row with a date range; the F1 contract is chosen with the F1 resolver and the choice is recorded (`contract_resolution`); no contract is created | Contract defect not ported; F1 owns contracts |
| One store at a time, checked in PHP | Overlapping date ranges refused by trigger under a per-person advisory lock | Race-safe, and covers history and future placements |
| Unassign left an open session unreachable | Ending a placement today or earlier is refused while a session is open | Open-session orphan defect |
| Unknown `sar_id` skipped the request step silently | Request id required; accept places and accepts in one transaction | Silent skip defect |
| Open session check only at the current store | One open session per person everywhere (unique index plus overlap trigger) | Second-store defect, double-tap race |
| `total_time` from a BEFORE UPDATE trigger, negative or null on manual insert | Generated `duration_seconds`, whole seconds truncated like `TIMESTAMPDIFF(SECOND)`; end before start refused | Bad-input defect |
| Discard and staff delete were hard deletes | Soft delete with who and why; restore possible | W-7 contract |
| Day totals stored on `candidate_working_date`, rejected time inside `total_time`, day status = last session's status, two repair crons | `work_day_totals` view: approved, pending and rejected seconds and counts, open count; nothing stored, nothing to repair | WK-F3/F4 crons retired; drift impossible by construction |
| A session past midnight is dated by its start | Same, in Asia/Kuwait | Parity |

## Payable seam for the pay lane (W-2)

`packages/work/src/payable.ts` defines `PayableWorkSource.payableInputs(query)`:
per assignment and period, the approved seconds of sessions in force, with the
session list (id, date, seconds, source, replaced session, decision, last
change). It computes no money. `splitSeconds` reproduces legacy's floor-per-unit
display for the replay. Hours are keyed by assignment, not by the person's
current store (legacy dropped hours at an earlier store in the same month).

## Not yet here

W-4 decisions, W-5 views, W-6 appeals and corrections, the Postgres payable
source, the reconciliation report against imported legacy day rows, gateway
pages, and the legacy import mapping. They land as later slices on the same
lane.
