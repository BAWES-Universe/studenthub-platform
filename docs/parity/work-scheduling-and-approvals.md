# Production parity inventory: work, scheduling, attendance and approvals

**Card:** SHU-126 (parent SHU-88). Feeds SHU-95 (work contract), SHU-100 (finance contract, which consumes approved hours), SHU-97 (data map).
**Production source:** `BAWES-Universe/studenthub` at `c2ce255`. Every `path:line` is at that revision; permalink base `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Method:** read-only static inspection. No database or live-host access. No personal data.
**Coverage:** 122 of 1,184 production endpoints (`docs/parity/coverage.md`, cluster WK).

## 1. What this cluster is

The part of production where a student's time becomes money. A candidate is assigned to a store, clocks in and out on their phone, an employer approves or rejects the day, staff correct mistakes, the candidate can appeal, and the resulting approved hours are what the finance cluster multiplies by two rates to bill the company and pay the student.

**The single most important fact in this inventory: this cluster has no automated tests at all.** There is no `CandidateWorkingHourCest` in any of the five apps, no work-log feedback test, no appeal test, no standup or leave test, and only one fixture (`CandidateWorkHistoryFixture`) for the whole cluster. Every other cluster inventoried so far has at least route-level coverage. The code path that decides what students are paid is the one nobody tested. That is a parity risk and an opportunity: the platform's version can be specified test-first with no legacy expectations to preserve.

## 2. Data model

| Table | Purpose | Key columns |
|---|---|---|
| `candidate_work_history` | the assignment: which candidate works at which store for which company, at what rates, over what period | `id`, `candidate_id`, `contract_uuid`, `store_id`, `company_id`, `parent_company_id`, `staff_id`, `start_date`, `end_date`, `candidate_hourly_rate`, `company_hourly_rate`, `transfer_cost` |
| `candidate_working_hour` | one work session (a clock-in/clock-out pair, or a manual entry) | `candidate_working_hour_uuid`, `candidate_id`, `store_id`, `date`, `start_time`, `end_time`, `total_time`, `start_location_lat/long`, `end_location_lat/long`, `note`, `status` (0 pending / 1 approved / 2 rejected), `via`, `cwlf_uuid` (the feedback that decided it) |
| `candidate_working_date` | the day-level roll-up | `cwd_uuid`, `candidate_id`, `store_id`, `company_id`, `date`, `start_time`, `end_time`, `total_time`, `status`, `total_approved`, `total_rejected`, `total_pending` |
| `candidate_working_hour_appeal` | a candidate's challenge to a decided session | `appeal_uuid`, `candidate_working_hour_uuid`, `candidate_id`, `reason`, `status` (10 submitted / 1 awaiting review / 2 in progress / 3 resolved) |
| `candidate_working_hour_appeal_updates` | the conversation on an appeal | `appeal_update_uuid`, `appeal_uuid`, `update`, `detail`, `created_by`, `updated_by` |
| `candidate_work_log_feedback` | the employer's decision on a session or day | `cwlf_uuid`, `candidate_id`, `store_id`, `company_id`, `date`, `candidate_working_hour_uuid`, `status`, `note`, `reason`, `is_public`, `rating`, `created_by` (a contact) |
| `store_assignment_request` | employer asks for a candidate at a store | `sar_uuid`, `candidate_id`, `store_id`, `currency_code`, `status` |
| `staff_work_session` | internal staff time tracking | `work_session_uuid`, `staff_id`, `total_minutes` |
| `staff_leave` | internal staff leave | `staff_leave_uuid`, `staff_id`, `from_date`, `to_date`, `note`, `category`, `file`, `status` |
| `daily_standup_question`, `daily_standup_answer` | internal staff standup | question text, `staff_id`, `answer` |
| `firing_hitmap` | how many candidates a company ended per month | `fh_uuid`, `company_id`, `firing_month`, `firing_year`, `total`, `is_alerted` |

Note that `candidate_working_hour` carries no `deleted` column: staff corrections are **hard deletes** (§4.3).

## 3. The hours pipeline

```
assignment            session capture           day roll-up        decision            money
work_history  ──▶  candidate_working_hour  ──▶  working_date  ──▶  work_log_feedback ──▶ transfer_candidate
(rates fixed)      (clock in/out or manual)     (totals)          (approve/reject)      (hours × rates)
```

The rates are captured on the **assignment**, not looked up at payment time (`candidate_work_history.candidate_hourly_rate` and `.company_hourly_rate`), so a rate change does not retroactively alter past work. The finance cluster reads `hours` on `transfer_candidate` and applies the documented formula (`common/models/TransferCandidate.php:47-49`): the company pays hours × company rate plus bonus, the candidate receives hours × candidate rate plus bonus minus commission, and the difference is StudentHub's revenue.

## 4. Journeys in detail

### 4.1 Clock in and out (candidate)

`POST v1/account/start-time` and `POST v1/account/stop-time` (`candidate/modules/v1/controllers/AccountController.php`, actions `actionStartWorkingTime` and `actionStopWorkingTime`).

Start: refuses if an open session already exists for this candidate at this store (`end_time is null`), then creates a row with `start_time = now`, the caller's `store_id` taken from their identity, the posted latitude and longitude, and `via = "Timer"`.

Stop: finds the open session, sets `end_time = now` and the end coordinates — **and also overwrites `start_location_lat` and `start_location_long` with the end coordinates** (`actionStopWorkingTime`, the two lines following the end-location assignment). The clock-in location is destroyed on every clock-out. Finding WK-F1.

Neither action writes `total_time`; it is computed later by the repair cron (§5).

### 4.2 Employer decision

`company/modules/v1/controllers/CandidateWorkLogFeedbackController.php`: `Save` (one), `BulkSave` (many), `Undo`, plus listing. `Save` takes `status`, `note`, `reason`, `rating`, `is_public` and the session id from the request body and writes a feedback row; the response message says approved or rejected. `Undo` sets the underlying `candidate_working_hour.status` back to pending.

Two things worth carrying into the platform contract: `rating` and `is_public` mean an employer's assessment of the student can be made visible, which is reputation data with no moderation path; and the write takes a bare `status` from the body with no state-machine check, so an already-approved session can be flipped by a later call.

### 4.3 Staff corrections

`staff/modules/v1/controllers/CandidateWorkingHourController.php`:

- `DeleteDay` — `CandidateWorkingDate::delete()`, a **hard delete of an entire day** with no audit record beyond the HTTP response.
- `DeleteSession` — hard delete of one session, same absence.
- `AddHour($id)` — creates a session against an **appeal**, marked `STATUS_APPROVED` immediately, taking candidate and store from the appeal's original hour and computing `total_time` from the posted start and end. This is the correction path, and it bypasses the employer decision entirely.
- `AppealUpdate`, `AppealUpdateStatus`, `AppealDetail` — the appeal conversation; `AppealUpdateStatus` takes the new status straight from the body with no transition check.

### 4.4 Candidate appeal

`candidate/.../CandidateWorkingHourController.php` `Appeal($id)` creates an appeal row with a free-text reason against a session; `AppealDetail` and `MarkReadAppealUpdate` follow it. Nothing verifies the session belongs to the caller at the controller level — the ownership check would have to come from the model's rules, which is worth a verifier's spot-check.

### 4.5 Views per role

| App | Actions | Scope |
|---|---|---|
| candidate | `ListDate`, `DateDetail`, `Stats`, `AddHour`, `ListHour`, `WorkingDates`, `HoursDetail`, `Appeal`, `AppealDetail`, `MarkReadAppealUpdate` (11) | own |
| company | `ListDate`, `DateDetail`, `Stats`, `ListHour` (5) | its stores |
| manager | `ListDate`, `ListHour` (3) | one store |
| staff | 10 including the corrections above | unscoped |
| admin | `ListDate`, `ListHour` (3) | unscoped |

### 4.6 Internal staff time (a different product)

`staff_work_session`, `staff_leave` (with a file attachment and a status), and daily standup questions and answers, administered from the admin and staff apps. This is StudentHub's own HR tooling, not the student-work product. It shares no tables with the candidate hours pipeline. Decision D-WK4 asks whether it comes to the platform at all.

## 5. Scheduled jobs

| Job | Schedule | What it does |
|---|---|---|
| `cron/fix-work-logs` | not in `cron/cronlist` | walks `candidate_working_hour` and `updateAll`s the matching `candidate_working_date` |
| `cron/fix-work-log-dates` | not in `cron/cronlist` | recomputes each day's `total_time` from its sessions, handling the still-open case |
| `cron/check-daily-attendance` | commented out in `cron/cronlist` | emails staff whose timer is not running |
| `cron/gen-hit-map` | 13:30 on the 28th | `FiringHitmap::updateHitMap` per month |
| `cron/end-of-month` | 13:30 on the 28th | `Company::requestForAttendance()` — asks companies to confirm attendance |

The first two are named "fix". A repair job that recomputes day totals from sessions is not a scheduled task, it is a **missing invariant**: the roll-up should be derived, or maintained transactionally when a session changes. Neither is scheduled, so day totals are only correct after someone runs them by hand. Finding WK-F2.

## 6. Parity rows

| ID | Journey | Actor / grant | Legacy routes | Tests | Disposition | Slice |
|---|---|---|---|---|---|---|
| WK-01 | Assign a candidate to a store for a period at agreed rates | staff | `staff/.../CandidateController.php` assign/unassign; `candidate_work_history` | none | REQUIRED | W1 |
| WK-02 | Employer requests a candidate for a store | org member | `company/.../StoreController.php` `StoreAssignmentRequest`, `Cancel…` | none | REQUIRED | W1 |
| WK-03 | Clock in | candidate, self | `POST v1/account/start-time` | none | REQUIRED, **ADAPT: fix WK-F1, record `total_time` on close** | W2 |
| WK-04 | Clock out | candidate, self | `POST v1/account/stop-time` | none | REQUIRED, ADAPT | W2 |
| WK-05 | See my hours, days and totals | candidate, self | `ListDate`, `DateDetail`, `ListHour`, `WorkingDates`, `HoursDetail`, `Stats` | none | REQUIRED | W3 |
| WK-06 | Employer sees hours for its stores | org member | company `ListDate`, `DateDetail`, `ListHour`, `Stats` | none | REQUIRED | W3 |
| WK-07 | Manager sees hours for one store | store-scoped grant | manager `ListDate`, `ListHour` | none | REQUIRED | W3 |
| WK-08 | Approve or reject a session or day | org member | `CandidateWorkLogFeedback` `Save`, `BulkSave` | none | REQUIRED, **ADAPT: explicit state machine, audited** | W4 |
| WK-09 | Undo a decision | org member | `Undo` | none | REQUIRED, audited | W4 |
| WK-10 | Rate a candidate publicly | org member | `rating`, `is_public` on feedback | none | **EXCLUDE-PENDING-OWNER** (D-WK2) | — |
| WK-11 | Appeal a decided session | candidate, self | candidate `Appeal`, `AppealDetail`, `MarkReadAppealUpdate` | none | REQUIRED | W5 |
| WK-12 | Work an appeal (updates, status) | staff | staff `AppealUpdate`, `AppealUpdateStatus`, `AppealDetail` | none | REQUIRED, with a real transition check | W5 |
| WK-13 | Add a corrected session from an appeal | staff | staff `AddHour` | none | REQUIRED, **ADAPT: audited, and not auto-approved without a stated reason** | W5 |
| WK-14 | Delete a session or a whole day | staff | `DeleteSession`, `DeleteDay` | none | REQUIRED, **ADAPT to reversible with audit** | W6 |
| WK-15 | Day roll-up totals stay correct | system | `cron/fix-work-logs`, `cron/fix-work-log-dates` | none | REQUIRED as an **invariant, not a repair job** | W6 |
| WK-16 | Month-end attendance confirmation | system → org | `cron/end-of-month` → `Company::requestForAttendance()` | none | REQUIRED | W7 |
| WK-17 | Firing hit map | system, staff | `cron/gen-hit-map`, staff `FiringChart` | none | OTHER-CLUSTER (reporting SHU-137) | — |
| WK-18 | Approved hours become payable | system | `transfer_candidate.hours` | none in this cluster | OTHER-CLUSTER (finance SHU-128); this cluster owns the handover contract | W7 |
| WK-19 | Staff work sessions | staff, admin | `StaffWorkSessionController` (5) | none | **EXCLUDE-PENDING-OWNER** (D-WK4) | — |
| WK-20 | Staff leave | staff, admin | `StaffLeaveController` (staff 4, admin 5) | none | EXCLUDE-PENDING-OWNER (D-WK4) | — |
| WK-21 | Daily standup | staff, admin | `DailyStandupController` (9), admin question/answer controllers (20) | none | EXCLUDE-PENDING-OWNER (D-WK4) | — |
| WK-22 | Attendance reminder emails | system | `cron/check-daily-attendance` (disabled) | none | DISCARD unless D-WK4 keeps internal HR | — |

## 7. Tests and fixtures

**Legacy automated coverage of this cluster: zero.** No Cest or Test file in any app targets working hours, work-log feedback, appeals, work history, staff sessions, leave, standup or the hit map. The only fixture is `CandidateWorkHistoryFixture` with `data/candidate_work_history.php`.

Untested behaviour is therefore the entire cluster. Named explicitly, because these are the ones that decide money or a student's record:

- clock-in and clock-out, including the double-booking guard and the location handling;
- day roll-up totals and the two repair jobs;
- employer approval, bulk approval, and undo;
- appeal creation, the appeal conversation and status transitions;
- staff-added corrected sessions, which are approved on creation;
- day and session deletion;
- month-end attendance confirmation;
- the hand-off of approved hours into `transfer_candidate`.

## 8. Findings

| ID | Finding | Evidence | Severity | Action |
|---|---|---|---|---|
| **WK-F1** | Clock-out overwrites the clock-in coordinates with the clock-out coordinates, destroying where the shift started | `candidate/modules/v1/controllers/AccountController.php`, `actionStopWorkingTime` | Medium (evidence loss; location is the only proof of on-site attendance) | fix by construction in W2; do not port the assignment |
| **WK-F2** | Day totals are only correct after a manual "fix" job; neither repair job is scheduled | `cron/fix-work-logs`, `cron/fix-work-log-dates`, absent from `cron/cronlist` | High (payable totals can be wrong) | W6: derive or maintain transactionally |
| **WK-F3** | Session and day deletion are hard deletes with no audit trail, on records that determine payment | `staff/.../CandidateWorkingHourController.php` `DeleteDay`, `DeleteSession` | High | W6 |
| **WK-F4** | Approval status is taken from the request body with no state-machine check, in both feedback save and appeal status update | `company/.../CandidateWorkLogFeedbackController.php` `Save`; `staff/.../CandidateWorkingHourController.php` `AppealUpdateStatus` | Medium | W4, W5 |
| **WK-F5** | Staff-created corrected sessions are written as approved immediately, bypassing employer review | `staff/.../CandidateWorkingHourController.php` `AddHour` | Medium (legitimate as a remedy, but needs a recorded reason and an audit entry) | W5 |
| **WK-F6** | `candidate_working_hour` has no soft-delete column, so there is no way to reconstruct a deleted shift | `common/models/CandidateWorkingHour.php` | Medium | W6 |
| **WK-F7** | Employer ratings can be marked public with no moderation or appeal path | `candidate_work_log_feedback.rating`, `.is_public` | Decision | D-WK2 |
| **WK-F8** | No test anywhere covers the hours pipeline | §7 | High for migration confidence | specify test-first in W2–W6 |
| **WK-F9** | The candidate appeal endpoint does not verify session ownership at the controller level | `candidate/.../CandidateWorkingHourController.php` `Appeal` | Needs verification against model rules | verifier spot-check; W5 enforces it explicitly |

## 9. Classification of prior findings

| Source | Claim | At `c2ce255` |
|---|---|---|
| SHU-34 ledger | Time tracking and work logs are core reusable behaviour | **Production-supported**, and now sized |
| SHU-39 | Hard deletes without audit | **Production-supported** here, on payment-determining records |
| SHU-39 | Denormalised counters that drift | **Production-supported**: `candidate_working_date` totals exist only because a repair job recomputes them |
| SHU-51 | Marketplace expansion | untouched |

## 10. Bounded slices for SHU-95

| Slice | Scope | Depends on | Points |
|---|---|---|---|
| W1 | Assignment: candidate to store for a period with rates captured at assignment time; employer assignment requests | SHU-91, organizations O7 | 5 |
| W2 | Session capture: clock in and out with both locations preserved, open-session guard, `total_time` written on close, offline and clock-skew behaviour stated | W1 | 5 |
| W3 | Read models per grant: own hours, employer's stores, one store for a manager, staff view | W2 | 3 |
| W4 | Decision: approve, reject and undo as an explicit state machine, audited, with bulk operations | W2, SHU-59 | 5 |
| W5 | Appeals: raise, converse, resolve, and staff-corrected sessions with a recorded reason and audit | W4 | 5 |
| W6 | Integrity: day totals as a derived invariant, reversible deletion with audit, and a reconciliation report rather than a repair job | W2 | 5 |
| W7 | Hand-off to finance: the contract that turns approved hours into payable amounts, plus month-end attendance confirmation | W4, SHU-100 | 3 |

Cluster total: **31 points**, against the 8-point placeholder. Running total: profile 40, organizations 46, work 31.

## 11. Decisions for Khalid

| ID | Decision | Recommended default | Cost of waiting |
|---|---|---|---|
| D-WK1 | Should location be required to clock in, and what happens when it is unavailable or implausible? Production records it but never checks it | Record it, show it to the approver, do not block the clock-in; treat it as evidence rather than a gate | Blocks W2. Deciding late means re-opening the session schema |
| D-WK2 | Keep public employer ratings of students (WK-10, WK-F7)? | Keep the rating private to staff and the employer; no public reputation without a moderation and appeal path | Blocks W4 only |
| D-WK3 | Who may correct hours after an employer decision, and does a correction need employer re-confirmation? | Staff may correct with a recorded reason; corrections above a threshold notify the employer rather than requiring re-approval | Blocks W5. This is the rule that decides disputes, so it should be explicit before anyone writes it |
| D-WK4 | Does StudentHub's internal staff HR tooling (work sessions, leave, standup, attendance emails) move to the platform, or leave with the legacy system? | Leave it; it is internal HR, not the student-work product, and 20 endpoints of it | Blocks nothing; it removes about 40 endpoints from the parity surface if dropped |

## 12. Not established

- Real volumes: sessions per day, appeal rate, correction rate. These size W4 to W6.
- Whether the two repair crons are actually run by hand, and how often, which would tell us how wrong day totals get.
- Whether `candidate_working_hour.via` takes values other than `"Timer"` (a manual-entry path exists, so at least one more is likely) — needs the database.
- The candidate mobile clients, which own the offline and background-timer behaviour (SHU-138).
