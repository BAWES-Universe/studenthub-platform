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
| Save and bulk-save decided any company's sessions (no ownership check) | Every decision is scoped: staff above the company, the company's owners and recruiters (subtree aware), or a store manager for their own store only | Ownership defect |
| A day decision rewrote every closed session, earlier decisions included | A day decision changes pending closed sessions only; changing a decided session is a session decision | Lost-decision defect |
| Bulk-save rolled back on a missing day | Same, and also on an out-of-scope or open session; the refusal names the item | Parity, stricter |
| Undo wrote nothing and kept the old decision link | Undo writes its own decision row; the session points at it. No undo window (legacy has none; D-WK2 keeps legacy) | Audit |
| Each feedback save left its own notification, so an old "approved" stayed beside a later "rejected" | A re-decision or undo withdraws the earlier notice; the person's feed shows what stands now | Misleading feed |
| Rating had no range | 1 to 5 | Docs said 1 to 5 |
| A person could read note, rating, reason and is_public through `expand` | The person sees outcome, reason, and the note only when public; never the rating | Leak defect |
| Date range strings went raw into SQL | Dates parsed and bound; at most a year per request | SQL injection |
| Company list scoped by a request parameter or the person's current store | Scope from the signed-in actor only | Scoping defect |
| A person could appeal any session id | Only their own session | Ownership defect |
| Mark-read on an appeal update had no owner check | Only the appellant marks their updates read | Ownership defect |
| Appeal status took any integer | Four named states (submitted, awaiting review, in progress, resolved) | Bad-input defect |
| Staff add-hour wrote an extra approved row beside the original, so both counted | `correct` replaces the session (original kept, out of every total and out of pay); `addMissing` adds time never logged, linked to the appeal; both staff-only with a reason and an approval decision by that staff member | Double-count defect; D-WK3 |
| Appeal list dates went raw into SQL | Dates parsed and bound | SQL injection |
| Stats returned the last session's status | Totals over the whole range, split by status | Mixed-status defect |

## Decision notifications (comms lane)

`PostgresWorkDecisionStore` takes optional hooks `{ onDecided, onUndone }` with the
shapes of `recordWorkSessionDecision` and `retractWorkSessionDecision` from
`@studenthub/db/comms`. They run on the decision's own client, so a notice commits or
rolls back with the decision. Each changed session gets one `decided` notice; a
re-decision or an undo first withdraws the earlier decision's notice. Gateway wiring
passes the comms functions.

## Payable seam for the pay lane (W-2)

`packages/work/src/payable.ts` defines `PayableWorkSource.payableInputs(query)`:
per assignment and period, the approved seconds of sessions in force, with the
session list (id, date, seconds, source, replaced session, decision, last
change). It computes no money. `splitSeconds` reproduces legacy's floor-per-unit
display for the replay. Hours are keyed by assignment, not by the person's
current store (legacy dropped hours at an earlier store in the same month).
`PostgresWorkPayableSource` (`@studenthub/db/work`) is the Postgres source: one
input per assignment with any session in force in the period, approved sessions
listed with their decision and `changedAt`, corrections in place of their
originals. The pay lane dedupes on `sessionId` and re-reads sessions whose
`changedAt` is after its run.

## Not yet here

The reconciliation report against imported legacy day rows, gateway
pages, and the legacy import mapping. They land as later slices on the same
lane.
