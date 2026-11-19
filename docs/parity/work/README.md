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
| Company list scoped by a request parameter or the person's current store | Scope from the signed-in actor only; sub-companies are included only for a subtree grant (a self-scoped owner or staff sees that company alone) | Scoping defect |
| A person could appeal any session id | Only their own ended, rejected session that is in force (not deleted, not replaced by a correction), with one open appeal at a time (reopening a resolved appeal is refused while another is open); the service and the database both refuse the rest (imported legacy appeals keep their legacy state) | Ownership and state defect |
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
originals. Use `payableInputs` to discover the payable work of a period, and
dedupe on `sessionId`. For anything already paid, keep each paid session's
`lineageRootId` and call `lineage(rootIds)` before the next run: it resolves the
whole chain to the one session in force today, wherever its date now falls. A
reread of the old period alone can't show a change, because a paid November
session corrected into December returns from neither November's nor (for the
original) December's `payableInputs`. Reconcile replacements, rejections and
discards from the resolved chain (`inForce` is null when the chain was
discarded), not from `changedAt` on a reread.

## Gateway API

`apps/gateway/src/work/http.ts`, JSON under `/api/work/...` (the screens own `/work/...`), wired in `wiring/work.ts`.
The signed-in person is always the actor; writes need a same-origin JSON POST. It is
off (503), and so are the screens, unless both `SAFE_WRITE_SIGNING_KEY` and the
cutover switch `WORK_LANE_ENABLED=true` are set. The switch is off by default, so a
deployment that already signs other writes still leaves legacy as the only writer of
hours. The cutover owner turns it on when legacy stops writing hours. Any value other
than `true` or `false` stops startup. `wireWork` reads store managers from the access
lane (A4, `PostgresAccessStoreManagersStore.managedStores`) on the work pool. Decision notices
come from the comms lane's hooks, which are not on main yet, so **the switch cannot be
turned on yet**: `WORK_LANE_ENABLED=true` stops startup with "needs the comms lane's
decision notice hooks" until a follow-up wires them. Until then the lane stays off and
legacy stays the writer of hours.

| Who | Routes |
|---|---|
| Person | `GET /api/work/today`, `POST /api/work/sessions/{start,stop,discard,manual}`, `GET /api/work/hours/mine`, `GET /api/work/placements/mine`, `POST /api/work/appeals`, `GET /api/work/appeals/mine`, `GET /api/work/appeals/:id`, `POST /api/work/appeal-updates/:id/read` |
| Company, store manager | `GET /api/work/hours/company/:orgId`, `GET /api/work/placements/company/:orgId`, `GET /api/work/placement-requests/company/:orgId`, `POST /api/work/placement-requests`, `POST /api/work/decisions/{sessions,days}`, `POST /api/work/sessions/:id/undo` |
| Staff | `POST /api/work/placements`, `POST /api/work/placements/:id/end-date`, `POST /api/work/placement-requests/:id/{accept,reject,cancel}`, `GET /api/work/hours/all`, `GET /api/work/appeals`, `POST /api/work/appeals/:id/{updates,status,missing-time}`, `POST /api/work/sessions/:id/correct` |

Stop and discard name the open session they act on (`sessionId`, the id `today` returned). If another tab or device has
since stopped it and started a new one, they answer 409 `session_changed` and change nothing. A placement's end date
can't move before hours recorded on it (409 `sessions_after_end`, also refused by the database).

## Legacy import mapping and reconciliation (M-5, W-7)

`packages/work/src/legacy.ts` is the mapping the importer calls; it reads and writes
nothing. Legacy datetimes are Asia/Kuwait. `candidate_working_hour` rows import as
`source = 'import'` with `legacy_ref = cwh:<uuid>`; open rows, end before start and
bad statuses are reported, not imported; a null or wrong `total_time` is reported and
the duration comes from the times. `candidate_work_log_feedback` rows import as
decisions (`cwlf:<uuid>`), keeping the legacy contact in `legacy_decided_by` when it
has no principal (migration 0504); ratings outside 1 to 5 import as null with a
report. Placements come from where hours were logged (`derivePlacements`), with the
current store open-ended. `reconcileDays` compares legacy `candidate_working_date`
(`total_time` in seconds of every status; `total_approved`, `total_pending`,
`total_rejected` are session counts) with the totals here and lists every difference.
`PostgresWorkImportStore` (`@studenthub/db/work`) writes the mapped rows in one
transaction per batch, keyed by legacy reference with a stored digest: a re-run writes
nothing, a changed row is a conflict with both digests, an open placement that legacy
has since ended is updated, and a row the work rules refuse (overlap, no placement) is
reported and the batch goes on. Imported decisions then link each decided session to
the latest legacy decision with its status. Legacy ids keep their underscores
(`can_wrk_hr_<uuid>`), which migration 0504 allows.

## Screens: Track, History and Appeals (C-11 to C-13)

`apps/gateway/src/work/pages.ts` serves `/work/track`, `/work/history[/:date]` and `/work/appeals[/:id]`. The pages are rendered on the server with the shared page shell and profile card styles, and they call the same services as the JSON API.

| Legacy | Here | Why |
|---|---|---|
| Track tab started and stopped with the app's last known position, or `0,0` | Clock in and Clock out ask the browser for a fresh position on the press; without one the server refuses (D-WK1). The only script on the page is that step, under a per-response CSP nonce | D-WK1 |
| Manual log and end-session screens | One "Forgot to clock in?" form on Track, read as Kuwait time; the hours are marked as entered late and wait for approval | D-WK1 |
| Discarding an open session was not possible; people logged a wrong end time | Discard removes the open session (soft delete, kept on record) | Data quality |
| Work history listed dates, then hours per date | History lists one month by day with totals by status (approved, waiting, rejected); a day lists each session with its store, status, marks (entered late, corrected, no location) and the reason and note when the employer made the note public | Parity, W-5 privacy |
| Candidate could appeal any session id; staff replies were marked read by id with no owner check | "Appeal these hours" appears on the person's own rejected sessions in History, as in legacy; the appeal page opens for its owner only and shows the status, staff replies (newest first, new ones marked) and any correction or added time; opening it marks the replies read | Ownership defect (W-6) |

The person comes from the session cookie, and posts need the same origin and a form body. A refusal shows the Track page again with a plain message (400 or 409).

## Screens: employer and staff (C-10, O-11, M-03, M-04, A-12, A-13)

`apps/gateway/src/work/review-pages.ts` and `staff-pages.ts`, same pattern as the person's screens (no script on these pages). Every read and write goes through the work services, which check the actor's grants on each request.

| Screen | Path | What it does |
|---|---|---|
| C-10 Placement | `/work/assignment[/:id]` | Where the person works now, what is coming up and where they worked before |
| O-11 Work review | `/organization/:orgId/work` | The company's hours by date range, status and store, with names; approve or reject the selected sessions with a reason, note (private unless shared) and rating; undo a decision. Filters survive the post |
| M-03 Time approvals | `/store/:storeId/time-approvals` | The same queue for one store, waiting hours by default; only that store's manager (or the company, or staff) |
| M-04 Assignment changes | `/store/:storeId/assignment-changes` | Ask StudentHub for a person at the store, follow the answer, cancel a waiting request |
| A-12 Work | `/work/assignments?org=`, `/work/logs` | Staff: a company's placements and waiting requests; place, end or extend, accept or decline. Work logs across companies with a person filter, the same decisions, and "Correct these hours" |
| A-13 Appeals and corrections | `/work/appeals?as=staff`, `/work/appeals/:id`, `/work/corrections` | Staff list appeals by status; on an appeal, reply, set the status, correct the appealed hours or add missing time (Kuwait time, reason required); correct any closed session from the logs |

| Legacy | Here | Why |
|---|---|---|
| A store manager could not see or cancel the company's placement requests | A store's manager lists, asks for and cancels requests for their own stores (the store must belong to the request's company) | M-04 contract |
| No way to list requests outside the accept screen | `PlacementService.requestsFor` and `GET /api/work/placement-requests/company/:orgId`, scoped like the other company lists | API gap |
| One appeal page for everyone | `/work/appeals/:id` shows the person's view to the appellant and the staff view to staff of that company; anyone else gets 404 | W-6 ownership |
| The A-13 list shares `/work/appeals` with the person's list | `?as=staff` asks for the staff list; the server checks the staff grant on every request (contract rule 1) | No context switch exists yet |

## Not yet here

- A-14 (staff my work: standup, leave, expenses and their own sessions); it depends on the P1 and F4 lanes.
- A session detail page for M-03 (`/store/:storeId/time-approvals/:sessionId`); each session is decided in the queue for now.
- A "Work" entry in the main navigation. This goes through the shared `apps/gateway/src/contributions` seam and copy keys, as its own small change.
- Arabic copy for the work screens.
- A reply box for the person on an appeal: the contract lists `appeals.self.comment`, but W-6 lets only staff post updates, as legacy did. This is to be confirmed with the legacy rules before it is added.
- Wiring the comms lane's notice hooks once it lands; until then `WORK_LANE_ENABLED=true` stops startup.
- The importer run itself (cutover lane, M-5).
