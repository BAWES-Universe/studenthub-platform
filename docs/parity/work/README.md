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
| D-WK1 clock-in location | Start and Stop require a location. Both pairs are kept (fixes WK-F2, stop overwrote start) and both are shown to the approver on the review screens. No geofence. A manual entry is accepted, pending, and flagged `late_entry` for the approver. |
| D-WK2 ratings | Kept as legacy: an employer rates 1 to 5 with a decision (W-4), and ratings stay visible to other employers in search through `PostgresWorkHoursViewStore.employerRatings(personIds)` (count and average of the ratings on decisions that still stand; no note, reason or decider). The person never sees a rating. Search (recruit lane) gates who may call it. |
| D-WK3 corrections | Staff correct approved hours without re-approval; a reason is required and history is kept. A correction is a new session that replaces the original in every total; the original row stays. A correction after month end reaches pay as a changed session (see the payable seam). No new notifications: a correction or an added entry sends the person nothing (the appeal store has no notice hook); they hear back on their appeal thread. |
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
| Rows could be wiped with a delete or a `TRUNCATE` | Placements, sessions, decisions, appeals, appeal updates, staff time and the event log refuse `DELETE`, and every one of those tables refuses `TRUNCATE`, directly or by a `CASCADE` from `principals` or `organizations` | Audit; history is never lost |
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
passes the comms functions. Staff corrections and added entries (W-6) send no notice
(D-WK3), so `PostgresWorkAppealStore` takes no hooks.

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
go to the person's feed through the comms lane's `recordWorkSessionDecision` and
`retractWorkSessionDecision` (`@studenthub/db/comms`), on the decision's own client. A
notice port given in place of them must have both, or startup stops. When the lane is on, the
main navigation shows "My work" (`nav.work`, `apps/gateway/src/contributions/work.ts`), which
opens `/work/track`; when it is off the entry is hidden.

A person whose StudentHub access is paused (access lane A6, `PostgresAccessPausesStore.paused`)
can't be placed: staff placing them, accepting a company's request for them, and
`placeFromRecruit` are refused with `person_paused` (409). The placement reads the pause inside
its own transaction after taking the person's access lock, the same advisory lock the pause and
resume take, so a pause can't commit between the check and the placement. When the work lane is on, the gateway gives
`wireRecruit` the work lane's placement port (`recruitPlacementPort` in `wiring/work.ts`), so the
recruit stage's "placed" goes through `placeFromRecruit`; while the lane is off the recruit stage
answers `work_unavailable` (409). A company asking for them is told the person
isn't found, because a paused person is hidden from employers. Pausing already ends their
sign-ins and takes their grants, so they can't log hours; hours already logged stay visible to
their employer and to pay.

| Who | Routes |
|---|---|
| Person | `GET /api/work/today`, `POST /api/work/sessions/{start,stop,discard,manual}`, `GET /api/work/hours/mine`, `GET /api/work/placements/mine`, `POST /api/work/appeals`, `GET /api/work/appeals/mine`, `GET /api/work/appeals/:id`, `POST /api/work/appeal-updates/:id/read` |
| Company, store manager | `GET /api/work/hours/company/:orgId`, `GET /api/work/placements/company/:orgId`, `GET /api/work/placement-requests/company/:orgId`, `POST /api/work/placement-requests`, `POST /api/work/decisions/{sessions,days}`, `POST /api/work/sessions/:id/undo` |
| Staff | `POST /api/work/placements`, `POST /api/work/placements/:id/end-date`, `POST /api/work/placement-requests/:id/{accept,reject,cancel}`, `GET /api/work/hours/all`, `GET /api/work/appeals`, `POST /api/work/appeals/:id/{updates,status,missing-time}`, `POST /api/work/sessions/:id/{correct,remove,restore}` |

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

### Staff time and the stand-up (M-5)

`packages/work/src/legacy-staff.ts` maps the internal staff rows the same way, with the
legacy id as `legacy_ref` (`work_session_<uuid>`, `question_<uuid>`, `answer_<uuid>`). The
importer resolves the legacy `staff_id` to a principal; a staff id with no principal is
reported by the importer, not passed on.

| Legacy | Here | Rules |
|---|---|---|
| `staff_work_session` | `work_staff_sessions`, `source = 'import'` | The start is `created_at`; the day is its Kuwait date. Ending a session saved `total_minutes` and `updated_at` together, so `updated_at` is the end when its whole minutes match `total_minutes`; otherwise the end is the start plus `total_minutes` (what legacy showed and exported) and the row is reported as `minutes_mismatch`. No minutes: imported open, as legacy showed it. Negative or fractional minutes are reported, not imported. A second open session on one day is refused (`open_twice`). |
| `daily_standup_question` | `work_standup_questions` | Trimmed text, 1 to 255 characters, asked (not retired), no author. |
| `daily_standup_answer` | `work_standup_answers`, `source = 'import'` | The question text as it read, the day as the Kuwait date of `created_at`; repeats on a day are kept. An answer whose question legacy deleted is refused (`no_question`); a blank answer, one over 4,000 characters, or text holding a NUL character (which Postgres can't store) is reported, not cut. |

`PostgresWorkImportStore.importStaffSessions`, `importStandupQuestions` (run before the
answers) and `importStandupAnswers` follow the contract above, with the digest stored in
`legacy_digest` (migration 0508). A session imported open that legacy has since ended gets
its end once (counted as updated); any other change is a conflict. The import key of a
staff session or question can't be changed afterwards. Rows that already had a
`legacy_ref` before 0508 get the all-zero digest, which no import produces, so a re-run
reports each of them as a conflict and never overwrites it. Within a batch, ends are applied
before new open sessions, and each staff member's day is locked with the refs, so two
batches can't deadlock. `reconcileStaffImport(table, legacyRefs, reportedRefs)` gives each table's reconciliation by legacy reference only: the legacy and
imported counts, the legacy refs with no imported row (split into `skipped`, the refs the
run passes in `reportedRefs` because it reported or refused them, and `missing`, the
unexplained ones; without `reportedRefs` every absent ref is `missing`), and imported refs legacy no
longer holds. Issues and results carry legacy ids, rule codes and numbers only, never row
text, and importing sends nothing (no notices, outbox rows or emails).

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

### Arabic

The person's screens (Placement, Track, History, a day, Appeals) are in Arabic or English
(`apps/gateway/src/work/copy.ts`). The language is the one the person saved on their profile
(`person_preferences`, read through the `language` port), else the browser's Accept-Language,
else English; error pages before sign-in follow the browser. An Arabic page is marked
`lang="ar" dir="rtl"`. Dates and times are Kuwait's, with Latin digits as the legacy apps showed
them, and durations read "2 س 30 د". Store names, notes and replies are shown as written.

The screens of the people who look after the work are in Arabic or English the same way, by the
viewer's own saved language: the company's Work review (O-11), a store's Time approvals and
Assignment changes (M-03, M-04), and StudentHub staff's Placements, Work logs, Appeals and
corrections (A-12, A-13), `/me/work` with its stand-up card, Staff time and the stand-up admin page
(`apps/gateway/src/work/team-copy.ts`). Stand-up questions and answers are shown as written.

## Screens: employer and staff (C-10, O-11, M-03, M-04, A-12, A-13)

`apps/gateway/src/work/review-pages.ts` and `staff-pages.ts`, same pattern as the person's screens (no script on these pages). Every read and write goes through the work services, which check the actor's grants on each request.

| Screen | Path | What it does |
|---|---|---|
| C-10 Placement | `/work/assignment[/:id]` | Where the person works now, what is coming up and where they worked before |
| O-11 Work review | `/organization/:orgId/work` | The company's hours by date range, status and store, with names; approve or reject the selected sessions with a reason, note (private unless shared) and rating; undo a decision. Filters survive the post |
| M-03 Time approvals | `/store/:storeId/time-approvals`, `/:sessionId?date=` | The same queue for one store, waiting hours by default; only that store's manager (or the company, or staff). Each entry opens on its own page (where it started and stopped, its note, the decision and who made it), and is approved, rejected or undone there. An entry at another store, on another day, or out of the viewer's scope is one "not found" answer |
| M-04 Assignment changes | `/store/:storeId/assignment-changes` | Ask StudentHub for a person at the store, follow the answer, cancel a waiting request |
| A-12 Work | `/work/assignments?org=`, `/work/logs`, `/work/logs/remove` | Staff: a company's placements and waiting requests; place, end or extend, accept or decline. Work logs across companies with a person filter, the same decisions, "Correct these hours" and "Remove these hours" (a reason is required; the notice after a removal puts the hours back) |
| A-13 Appeals and corrections | `/work/appeals?as=staff`, `/work/appeals/:id`, `/work/corrections` | Staff list appeals by status; on an appeal, reply, set the status, correct the appealed hours or add missing time (Kuwait time, reason required); correct any closed session from the logs |

| Legacy | Here | Why |
|---|---|---|
| A store manager could not see or cancel the company's placement requests | A store's manager lists, asks for and cancels requests for their own stores (the store must belong to the request's company) | M-04 contract |
| No way to list requests outside the accept screen | `PlacementService.requestsFor` and `GET /api/work/placement-requests/company/:orgId`, scoped like the other company lists | API gap |
| One appeal page for everyone | `/work/appeals/:id` shows the person's view to the appellant and the staff view to staff of that company; anyone else gets 404 | W-6 ownership |
| The A-13 list shares `/work/appeals` with the person's list | `?as=staff` asks for the staff list; the server checks the staff grant on every request (contract rule 1) | No context switch exists yet |

## Internal staff time (legacy staff_work_session)

StudentHub's own staff time their day here (hours are hours). `StaffTimeService`
(`packages/work/src/staff-time.ts`) over `work_staff_sessions` (migration 0505):

- Any operator staff member (staff or admin on the operator organization) starts and ends their
  day at `/me/work`, the session part of A-14 (the stand-up is below). A second start the same Kuwait day returns the open
  session, as legacy did; starting again after an end (Start my day) opens a second session that day, and another end without one is refused (`not_working`). The minutes come from the
  stored start and end (legacy stored only the minutes, from the app server's clock).
- A session left open on an earlier day stays open for good, as in legacy; the staff member's
  end only closes today's.
- Operator admins see every staff member's days at `/work/staff-time` (a range of at most a
  year, one staff member optional, 100 days a page) and who didn't start on a date (legacy
  list-inactive: operator staff with no session that day). A staff member who isn't an admin
  reads only their own days.
- The table refuses edits to a closed session, a second open session for the same day, an end
  before the start, and deletes.

The staff hours export is under Exports below. The legacy rows are mapped for the cutover
lane's importer (M-5) as described under "Staff time and the stand-up".

## Daily stand-up (legacy daily_standup_question / daily_standup_answer)

The stand-up part of A-14. `StandupService` (`packages/work/src/standup.ts`) over
`work_standup_questions` and `work_standup_answers` (migration 0506):

- While their day is in progress, `/me/work` asks an operator staff member the next question they
  haven't answered today, one at a time, as legacy's staff home did beside the session timer. Their
  answers today are listed under it. A question is answered once per staff member and Kuwait day;
  a second answer, or two at once, is refused (`already_answered`). Answers are 1 to 4,000
  characters.
- Both rules hold for an answer posted straight to `/me/work/standup`, not only for the form: with
  no staff session in progress today the answer is refused (`not_working`), and an answer to any
  question but the next one is refused (`out_of_order`). The store checks both in the answer's own
  transaction, holding the session and the question `FOR SHARE`, so the day can't end and the
  question can't be retired under it.
- Operator admins keep the questions at `/work/staff-time`'s "Stand-up" link (`/work/standup`):
  add, reword, stop asking. Questions are asked in the order they were added; legacy had no order.
  Legacy deleted a question; here it is retired, so its answers stay. Rewording keeps the wording
  each answer was given to.
- The same page lists the answers on a date, by staff member (one staff member optional, 100 a
  page), and the operator staff who answered nothing that day (legacy list-inactive).
- The tables refuse edits and deletes of answers, deletes of questions, and an empty answer.
  Imported answers (`source = 'import'`, `legacy_ref`) may repeat a question on a day, as legacy
  allowed; answers given here may not.

Legacy's emailed stand-up report (`standupReport`) was switched off in its cron and is not ported.
The legacy rows are mapped for the cutover lane's importer as described under "Staff time and
the stand-up".

## Exports (P-1)

The work exports go through the one export service (`packages/exports`), so each is checked
when it is asked for and again at download, its link works for 15 minutes for the person who
asked, and every export, refused ones included, is audited. The kinds live in
`apps/gateway/src/work/exports.ts` and are registered with the service by `wireOps` when the work
lane is on (the staff hours kind only where staff time is wired). Each kind has an entry in the
gateway's `EXPORT_HTTP_KINDS`, which parses its filters strictly from the query string of the
shared route: the screens' buttons post to `/exports/<kind>?<filters>`, and the file downloads
from `/exports/<id>` under the kind's name. Files are CSV; legacy wrote Excel.

| Kind | Legacy | Who | Columns |
|---|---|---|---|
| `work-log-detailed` | company `candidate/work-log-detailed-excel` | the company, staff, a store's manager for their stores | Session ID, Person ID, Person, Store ID, Store, Date, Start time, End time, Total time, Total seconds, Note, Status, Via, Created at, Decided at |
| `work-log-summary` | company `candidate/work-log-excel` | as above | Person ID, Person, Company, Store, Hours, Minutes, Seconds, Approved, Waiting, Rejected |
| `work-assigned-history` | staff `candidate/export-assigned-history` | operator staff | Person ID, Person, Start date, End date, Company, Store |
| `work-staff-sessions` | staff `staff-work-session/download-list-excel` | operator admins (everyone or one staff member); a staff member, themself | Staff ID, Name, Email, Total minutes, Total hours, From, To |

- The company export takes the work review screen's filters (dates, status, store), with the
  same range limit of a year. The buttons are on `/organization/:orgId/work`; staff export who
  worked where from `/work/logs`. Store screens have no export, as in legacy.
- Legacy put the summary and one sheet per person in the detailed file; here they are two
  files. Legacy's summary added every status into one total; that total is kept, with the
  approved, waiting and rejected parts beside it. Hours still in progress count nowhere.
  Legacy's bonus column was always 0 and is left out.
- Times are Kuwait time. Total time keeps legacy's "2 hour 30 minutes 5 seconds", with the
  seconds beside it.
- Who worked where lists every placement that overlaps the range. Legacy's currency, name and
  email filters are not carried over; the file can be filtered after download.
- Over 10,000 rows is refused; the screen asks for a shorter range. Every work export reads
  page by page and stops one row past the cap: the detailed and who-worked-where files never
  hold more than that, and the summary and staff hours files keep only per-person totals
  (staff hours stops once there are more than 10,000 staff members; a range is at most 366 days).
- Staff hours: legacy counted a session with no end as the staff record's hours per day. That
  comes from the `staffHoursPerDay` port (`wireWork` option), absent until the staff record
  exists; while it is absent a day not ended adds nothing. The release matrix gates cutover on
  wiring it (the cutover lane's STAFF-HOURS-FALLBACK step). The button is on `/work/staff-time`.

## Legacy parity sweep (legacy @ 55119d3, 2026-11-20)

Every action of legacy's work and attendance controllers, and where it lives here. Legacy paths
are relative to each app's `modules/v1/controllers`.

| App | Legacy action | Here |
|---|---|---|
| candidate | `AccountController` start-working-time, stop-working-time, discard | Track (`/work/track`), `POST /api/work/sessions/{start,stop,discard}` |
| candidate | `CandidateWorkingHour` add-hour (manual log) | "Forgot to clock in?" on Track, `POST /api/work/sessions/manual` |
| candidate | `CandidateWorkingHour` list-date, working-dates, date-detail, hours-detail, list-hour, stats | History (`/work/history[/:date]`), `GET /api/work/hours/mine` (one month by day, totals by status) |
| candidate | `CandidateWorkingHour` appeal, appeal-detail, mark-read-appeal-update | Appeals (`/work/appeals[/:id]`), `POST /api/work/appeals`, `POST /api/work/appeal-updates/:id/read` |
| candidate | `Candidate` work-history, work-history-detail | Placement (`/work/assignment[/:id]`), `GET /api/work/placements/mine` |
| candidate | `Candidate` appreciation-certificate | Reports lane certificates (`apps/gateway/src/reports/certificates-http.ts`) |
| company | `CandidateWorkingHour` list-date, date-detail, list-hour, stats | Work review (O-11), `GET /api/work/hours/company/:orgId` |
| company | `CandidateWorkLogFeedback` save, bulk-save, undo | O-11 and M-03 decisions, `POST /api/work/decisions/{sessions,days}`, `POST /api/work/sessions/:id/undo` |
| manager | `CandidateWorkingHour` list-date, list-hour | Time approvals (M-03, and each entry's page) |
| staff | `CandidateWorkingHour` list-date, list-hour, hours-detail | Work logs (A-12), `GET /api/work/hours/all` |
| staff | `CandidateWorkingHour` add-hour | "Correct these hours" and "Add missing time" (A-13), `POST /api/work/sessions/:id/correct`, `POST /api/work/appeals/:id/missing-time` |
| staff | `CandidateWorkingHour` delete-session | "Remove these hours" on the work logs, `POST /api/work/sessions/:id/remove` (added in this sweep; legacy hard-deleted, here a soft delete with who and why, and `restore` puts it back) |
| staff | `CandidateWorkingHour` delete-day | Remove each of the day's entries. Legacy deleted the `candidate_working_date` row only, leaving its hours; day totals here are a view over the sessions, so there is no day row to remove |
| staff | `CandidateWorkingHour` appeal-list, appeal-detail, appeal-update, appeal-update-status | A-13 (`/work/appeals?as=staff`, `/work/appeals/:id`), `GET /api/work/appeals`, `POST /api/work/appeals/:id/{updates,status}` |
| admin | `CandidateWorkingHour` list-date, list-hour | Work logs (A-12) |
| admin | `CandidateWorkHistory` list | A-12 placements, `PlacementService.history` |
| admin | `StaffWorkSession` list, list-inactive, view, download-list-excel | Staff time (`/work/staff-time`) and the staff hours export (P-1) |
| status | `CandidateWorkHistory` list | Not ported: it listed every placement with no sign-in. Placements are shown only to the person, their company and staff |

Legacy had no reply from the person on an appeal: the candidate app could raise an appeal, read it
and mark staff replies read, and only staff posted updates (`appeal-update`). The contract's
`appeals.self.comment` is therefore not added; the person replies by raising a new appeal once the
open one is resolved, as in legacy.

A removed session leaves every total and pay (`lineage` reads its chain as discarded). The
person's feed keeps the decision notice it had; removal itself sends nothing, like a correction
(D-WK3).

## Not yet here

- The rest of A-14 (staff leave and expenses); it depends on the pay lane's settlement (P1, F4).
- The importer run itself (cutover lane, M-5): reading the mirror, resolving staff ids and
  writing the run's report.
