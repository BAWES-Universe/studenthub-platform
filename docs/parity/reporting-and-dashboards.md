# Production parity inventory: reporting and dashboards

**Card:** SHU-137 (parent SHU-88). **Implementation owners:** SHU-193–196.
**Production authority:** `BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63`. Permalink base: `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Client cross-check:** `docs/parity/ui-journeys/**` on `BAWES-Universe/studenthub-platform@e825ff5aa9f28bade60079ac039ad8d9aeb15d83`.
**Method:** read-only static inspection. No database, live-host, production-data or deployment access.

## 1. Census and boundary

The coverage-ledger count and the broader reporting-related product surface are different numbers.

| Census | Reproduced count | Derivation |
|---|---:|---|
| RP-assigned functional actions in the earlier coverage ledger | **46** | 37 `status` actions + 5 admin `Statistic` actions + 1 staff `Statistic` action + 1 candidate `Statistic` action + `cron/summary` + `report/recruiter` |
| `status` application | **16 controllers, 37 functional actions, 16 `actions()` hooks** | `rg 'public function action[A-Z]' status/modules/v1/controllers/*Controller.php`; controller-by-controller table in §2 |
| Routable spreadsheet/text/bank/ZIP output actions | **22**, plus **1 scheduled workbook** | 12 admin + 7 staff + 3 employer actions; `cron/payable-candidate-notification` is the scheduled workbook (§7) |

The number **46 is only ledger arithmetic**. It does not include the two revenue roll-up jobs, the hit-map jobs/read routes, campaign attribution actions, most exports, employer/candidate dashboards, or client-derived reports. Those journeys are inventoried below and each has an implementation or exclusion owner.

## 2. The `status` application: exact action and owner map

`status/config/main.php:27-30` binds the app to `common\models\Inspector` with sessions disabled. Fifteen controllers remove the inherited authenticator and never restore it; only `AccountController.php:33-37` restores `HttpBearerAuth`. The code fact is established. Whether the app is externally reachable remains a live-topology question owned by SHU-141: the repository ships a status entry point and Apache/Docker configuration, but none of the six nginx configurations routes a status host.

The migration default is to **exclude the separate app**, not to drop its domain capabilities. D-RP1 decides whether any standalone shell survives. Every action has a destination even while that decision is pending:

| Controller | Count | Functional actions | Required destination / exclusion owner |
|---|---:|---|---|
| Account | 1 | `UpdatePassword` | **DISCARD** status-local credential path; identity/Authentik owner (identity I2) |
| Aws | 1 | `Config` | **DISCARD** browser credential distribution; private storage/operations owner (SHU-101 / X1) |
| Bank | 2 | `List`, `View` | finance reference projection (F1/F3) |
| Candidate | 4 | `Search`, `View`, `Transfers`, `WorkHistory` | search/recruit (R3), self/profile projection (S1), finance history (F4), work history (W1) respectively |
| CandidateWorkHistory | 1 | `List` | work history read model (W1) |
| Company | 3 | `List`, `YearReport`, `View` | organization projection (O1/O2); `YearReport` is reporting P2 / SHU-194 |
| Country | 2 | `List`, `View` | reference data (O8) |
| Expense | 2 | `List`, `View` | finance expenses/statements (F4) |
| Note | 2 | `List`, `View` | typed notes (O9/C1); no status-specific copy |
| Request | 2 | `List`, `View` | recruit request read model (R1) |
| Staff | 3 | `List`, `ListSalaries`, `View` | identity/staff projection (I1); salary is finance F4 |
| Statistic | 3 | `List`, `Transfer`, `Graph` | reporting P2 / SHU-194 |
| Story | 2 | `View`, `List` | recruit story read model (R2) |
| TransferCandidate | 4 | `List`, `ByTransfer`, `ByTransferFile`, `View` | finance F2/F3/F4 |
| Transfer | 3 | `List`, `View`, `SuspiciousList` | finance F2/F4 |
| University | 2 | `List`, `View` | reference data (O8) |
| **Total** | **37** |  |  |

If D-RP1 retains an inspector experience, these become read grants inside the single application; they do not justify a second identity store or a second unauthenticated API. If D-RP1 deletes it, the table above is the exclusion receipt for the shell and the implementation map for its capabilities.

## 3. Authorization and cache behavior

| Surface | Production behavior | Migration requirement / owner |
|---|---|---|
| `status` | 36 functional actions on 15 controllers execute without the bearer filter; only account password update is authenticated | SHU-141 establishes reachability; D-RP1 removes the shell or SHU-194/domain owners require fresh grants on every replacement read |
| admin statistics | bearer-admin only; no report-specific grant | SHU-194 grant-scoped read models |
| staff statistics | bearer-staff only; not scoped to the individual staff member; several counts are global and some omit even the Currency scope | SHU-194 grant and organization/source scope |
| candidate statistics | bearer-candidate and self-derived, but the response also returns the serialized candidate object | SHU-194 returns an aggregate allowlist only; profile fields stay with S1 |
| employer work-log statistics | company context is resolved by `companyManager`; no employer revenue dashboard exists | work owner W3/W7; reporting P2 only consumes an explicit projection |
| exports | app-level bearer/context checks only; no durable per-export grant decision or audit row | SHU-196, with each domain owner supplying its projection |

Two cache-flush paths exist, not one. Admin `StatisticController::actionClearCache` (`:85-87`) flushes the application cache. Staff `StatisticController::actionList` flushes it when `?refresh=1` (`:82-90`). The staff endpoint builds `DbDependency` SQL by interpolating the unvalidated `Currency` header (`:94-123`); the replacement must use bound parameters/a closed currency code. Count-only dependencies do not invalidate cached counters after status or attribute changes, so the stated one-day cache can be stale even when source rows change.

## 4. Scheduled operational reporting

### 4.1 Morning summary (`cron/summary`)

`cron/cronlist:18-19` runs the command at **05:00 daily** (the comment says “8:00 AM”; the cron expression is authoritative). `CronController.php:513-566` computes these **12 values**:

1. expired candidate ID cards;
2. assigned candidates with expired civil IDs;
3. assigned candidates needing an ID generated;
4. completed profiles awaiting approval;
5. assigned candidates with incomplete profiles;
6. candidates missing bank information or with payment constraints;
7. companies requiring follow-up;
8. active requests;
9. assigned idle candidates;
10. companies with no payment in 40 days;
11. companies with no request in 40 days; and
12. interviews scheduled today.

The email does not faithfully render those 12. `common/mail/summary.php:2236` comments out `profileApprovalRequire`; `:891` and `:1049` render two blocks guarded by `activeRequests`; the first prints `id_need_generated` at `:930`. The resulting template has 12 active cards but only 11 distinct source values, with the ID-generation number duplicated and profile approval absent.

Recipients are not “all staff”: the primary `To` is the configured `invoiceFrom`; active staff with a `morning-report` permission are added as CC (`CronController.php:568-595`). On successful delivery, `return $mailer->send()` at `:602` bypasses the `CronLog::updateAll` at `:611-612`. There is no day idempotency key, per-recipient delivery ledger or retry-safe completion state.

**Owner:** SHU-193. Preserve the 12 source questions only after product confirmation; render one value once, resolve recipients from grants at send time, whitelist count-only content, and make the daily delivery idempotent. D-RP2/SHU-211 owns email versus in-product delivery.

### 4.2 Recruiter productivity (`report/recruiter`)

`cron/cronlist:24-25` runs at **17:00 Sunday–Thursday** (the comment says 20:00). `ReportController.php:20-53` selects every staff row with the misspelled production constant `Staff::ROlE_RECRUITER` and computes 11 measures for the current date: assigned candidates, requests, notes, stories, accepted invitations, rejected invitations, suggestions, invitations, completed stories, story employees, and time for completed stories.

Delivery is **not email**. The complete data object, including staff name/email, is sent to the event manager (`:56-58`); a Slack message per recruiter contains ten measures (`:60-75`) and omits the computed `totalRequests`. `CronLog` is updated only after the whole loop (`:82-83`), with no delivery idempotency or per-recipient acknowledgement.

The staff UI also computes a separate “analytics/valocity” leaderboard client-side from paginated `GET /staff?page=` data (`docs/parity/ui-journeys/staff.md:91,200`). It is a distinct report, not this scheduled command.

**Owner:** SHU-193. Define the approved measure set, remove PII from telemetry/digest bodies, compute from source read-model contracts, and deliver idempotently to grant-resolved recipients. The client leaderboard is either implemented by the same read model or explicitly excluded there.

### 4.3 Adjacent scheduled reports with other owners

| Job/effect | Production schedule and semantics | Owner |
|---|---|---|
| `cron/payable-candidate-notification` | 05:00 daily; creates a PII/payment workbook and emails it to configured operations (`CronController.php:621-775`) | finance F3 + SHU-196 delivery/audit |
| firing hit map | `cron/daily` at 13:30 recomputes the current month; `cron/gen-hit-map` at 13:30 on day 28 recomputes a 13-month range (`CronController.php:225-309`, `cron/cronlist:21-22,35-37`) and can email operations/Khalid on a spike (`FiringHitmap.php:136-219`) | SHU-194 |
| campaign processor | every minute, processes ready email campaigns (`CronController.php:364-379`, `cron/cronlist:1-4`) | communication campaign owner C4; attribution reads belong to SHU-194 |

## 5. Dashboard and statistics semantics

### 5.1 Admin

`admin/modules/v1/controllers/StatisticController.php` exposes five authenticated actions:

| Action | Stored or derived | Material semantics |
|---|---|---|
| `List` (`:92-190`) | live queries plus cached helper queries | candidate totals/assigned/unapproved/invited/suggested; retention = work histories longer than 365 days ÷ all work histories; recruitment yield = all work histories ÷ all invitations; company/request/payable/transfer/staff-attendance values. The accepted start/end dates do not scope retention or yield (`:111-133`) |
| `Transfer` (`:196-260`) | live transfer headers | excludes child transfer headers with `transfer.parent_transfer_id IS NULL`; sums parent `company_total`, `total` and the difference after payment received. Parent-owned transfer lines are therefore represented once through the parent header |
| `Revenue` (`:266-365`) | mixed: drifting `candidate_stats`/`company_stats` plus live averages | total/min/max stored revenue, CLV, prior-month hire count and recruiter salary, average line profit, projected earning, story time. `costPerCandidate` tests `salaryPaid` rather than `noOfHired`, so nonzero salary with zero hires divides by zero (`:320-355`) |
| `InvitationGraphData` (`:370-372`) | derived by `Invitation::getDataByMonths()` | monthly invitation graph |
| `ClearCache` (`:85-87`) | destructive operational action | whole-cache flush over HTTP; **DISCARD**, tracked in SHU-213 |

The admin and unauthenticated status `CompanyController::actionYearReport` concatenate request parameters `year` and `company_id` into SQL (`admin/.../CompanyController.php:779-820`; status equivalent `:92-134`). The replacement uses typed/bound parameters and a company grant. It returns twelve month buckets of request, suggestion and hired counts.

### 5.2 Staff

`staff/modules/v1/controllers/StatisticController.php:78-289` returns **24 top-level keys**, including the refresh echo and 23 counters: work-log appeals, unverified emails, ID/civil/profile/bank queues, follow-up/request/minor/idle/company queues, pending company/store/interview requests, no-profit/same-rate transfers, and ticket counts. These are organization-wide operational queues, not recruiter-self productivity.

Most expensive counters are cached for one day. Several are not currency scoped (`workLogAppeals`, `totalMinor`, both interview counts, both ticket counts), and the cache dependencies observe row counts rather than the status/date fields that define the counters. The staff tab shell polls this endpoint every 60 seconds per open tab. The “minors” navigation passes a client flag that the candidate list ignores, so the destination is unfiltered.

**Owner:** SHU-194 for the read models; SHU-193 for digest/queue presentation; the underlying profile, work, recruit, finance and communication clusters own source truth.

### 5.3 Candidate and employer

Candidate `StatisticController::actionList` (`:72-107`) derives time and earnings from `Candidate::getAccountStatistic()` and adds upcoming interviews. It also returns the candidate model. `getAccountStatistic()` (`common/models/Candidate.php:2237-2273`) recomputes “paid” as `hours × candidate_hourly_rate`, omitting minutes and seconds, then the controller casts paid and bonus to integers. This truncates KWD’s three-decimal values and can disagree with stored `candidate_total`. Hours/minutes/seconds are formatted as strings.

Employer reporting is split: `CandidateController::actionWorkLogStats` (`:547-575`) computes active sessions, total seconds and a floating “today total paying”; `CandidateWorkingHourController::actionStats` serves day/session totals; request-list headers use `Request::getStats()`. There is no employer view of `company_stats` or revenue. The work-log export UI supports plain, detailed and approved-only variants.

**Owners:** candidate salary/history is finance F4 (and SHU-194 only for an aggregate dashboard); employer work-log statistics stay with W3/W7. P2 consumes these source ports and must not create a second truth.

### 5.4 Domain-native reports outside the 46-action ledger

The ledger label did not make every route with report semantics a reporting-cluster route. These production journeys remain owned and cannot be silently reimplemented inside P1/P2:

| Production read/output | Source | Final owner |
|---|---|---|
| assigned-candidate report filtered by company/date | admin `CandidateController::actionReportSearch` (`:151`) | SHU-193 presentation over recruit/work source ports |
| payable-candidate totals by bank/profile/civil readiness | admin `TransferCandidateController::actionPayableCandidatesStats` (`:72-114`) | F3 / SHU-184; SHU-194 may present the aggregate |
| mail-log totals by day | admin `MailLogController::actionStats` (`:100-102`) | X2 / SHU-198 operations view |
| support response/resolution/status totals | staff `TicketController::actionStats` (`:69-112`) | C2 / SHU-187 |
| candidate evaluation list/detail/PDF | admin/staff `CandidateEvaluationController` report actions | SHU-234; SHU-196 supplies private delivery for the PDF |
| candidate work-hour day/session totals | candidate/company `CandidateWorkingHourController::actionStats` | W3/W7; F4 owns monetary interpretation |

Provider downloads (for example Xero transaction retrieval and Yeastar voicemail audio) and spreadsheet imports are integration/domain journeys, not generated reporting exports; they stay with X1/F2/F3 and C2 respectively.

## 6. Stored versus derived revenue, parent/child transfers, and precision

`candidate_stats` and `company_stats` store `DECIMAL(12,3)` totals (`console/migrations/m240325_073509_revenue.php:21-88`), but there is no unique constraint on `(candidate_id,currency_code)` or `(company_id,currency_code)`.

They have **two additive writers**:

1. when a transfer-candidate row changes to paid, `TransferCandidate::afterSave` calls `updateStats()` (`common/models/TransferCandidate.php:335-395`) and increments both stored rows by `company_total - candidate_total`; changing paid→unpaid does not subtract, and paying again increments again;
2. on the 15th at 13:30, both stats crons sum **all paid history** by subject/currency and increment the same existing rows (`CronController.php:1049-1158`). A normal monthly run therefore re-adds values already added by the paid transition; a retry re-adds them again.

The roll-up queries operate on `transfer_candidate`, whose lines remain owned by the parent transfer when child company transfer headers are generated (`Transfer::generateSubCompanyTransfer`, `common/models/Transfer.php:877-947`). The admin transfer dashboard correctly excludes child headers before summing parent totals. P3 reconciliation must state this ownership explicitly: reconcile each parent-owned line once, never add both the parent aggregate and child invoice header totals.

Money creation uses PHP floating arithmetic and `round(..., 3)` before persisting line totals (`TransferCandidate.php:1169-1192,1319-1392`). Reporting then casts DECIMAL results to `double`, and candidate/campaign projections cast some monetary values to `int` (`candidate StatisticController.php:78-90`; `Campaign.php:102-118`). No reporting endpoint declares a rounding mode. The platform contract is exact decimal/integer minor units from F2, summed once and rounded only at the declared currency boundary; presentation formatting must not alter the stored value.

Campaign attribution is also mixed stored/derived state: click and signup counters are incremented on request/model saves without an idempotency key (`candidate/company CampaignController`; `Candidate.php:966-969`; `Contact.php:139-146`), chart series are derived from related rows, and `campaign.total_revenue` has no writer at this revision. SHU-194 must report provenance per field rather than presenting that column as established revenue.

**Owner:** SHU-195 / P3, depending on finance F2. Drift is reported, never silently overwritten; any materialization is unique, idempotent and reconciled to parent-owned transfer lines.

## 7. Export and document-delivery census

Every action below is routable at `c2ce255`. Static inspection found no durable export authorization/audit record. Admin/staff routes generally require only an app bearer; employer routes use company context. UI controls are one-click and client-side `limited_access` gates do not provide server authorization. Several bank/advice routes accept client-selected `offset`/`limit`, so a file can be only the current slice.

| App / owner | Routable output actions | Count |
|---|---|---:|
| admin — organizations/reference data (O8/O9) | Company `DownloadCandidatesExcel`, Company `DownloadListExcel`, University `DownloadListExcel`, Country `DownloadListExcel` | 4 |
| admin — work/internal ops (W3/W6) | StaffWorkSession `DownloadListExcel` | 1 |
| admin — finance (F3/F4) | Transfer `ExportGoogleExcel`, `ExportPayableCandidates`, `DownloadPaymentAdviceForAbk`, `DownloadTextPaymentAdviceForAbk`, `Text`, `DownloadPaymentAdvice`, `Export` | 7 |
| staff — profile/recruit (S8/R2) | Candidate `ExportCandidateData`, `ExportAssignedHistory`; CandidateIdCard `Generate` returns a ZIP | 3 |
| staff — finance (F2/F3/F4) | Transfer `ExportCandidateTransfers`, `TransferRatesTemplate`, `TransferExcelTemplate`, `ExportCompaniesTransfer` | 4 |
| employer — work (W3/W7) | Candidate `WorkLogDetailedExcel`, `WorkLogExcel` | 2 |
| employer — finance (F2) | Transfer `TransferExcelTemplate` | 1 |
| **Routable total** |  | **22** |
| console — finance (F3) | `cron/payable-candidate-notification` workbook attachment | **1 scheduled** |

Separate document-delivery routes also exist for transfer invoice/receipt PDFs, candidate resumes, appreciation certificates, evaluation reports and staff ID-card/certificate output. Their domain lifecycle remains F4, S4/S8 and SHU-234 respectively, but private object creation, expiring delivery and audit use the same SHU-196 primitive. Imports are not exports and remain with F2/F3.

**Owner contract:** SHU-196 owns request → fresh authorization → bounded job → private object → expiring requester/lead download → audit `(actor, grant, filter, source revision/freshness, row count, object, expiry, outcome)`. O9, W3/W6/W7, S4/S8, SHU-234 and F2/F3/F4 own the typed source projections. SHU-196 must be re-estimated from this 22-action census; its current “seven paths” title is historical, not an acceptance bound.

## 8. Tests and fixtures

| Surface | Tests present at `c2ce255` | Gaps |
|---|---|---|
| admin statistics | `admin/tests/functional/StatisticsCest.php` exercises `List` content and a `Transfer` 200; `admin/tests/unit/models/StatisticsTest.php` covers selected helpers | no Revenue, InvitationGraphData, cache flush, date/tenant boundary, decimal, or active child-exclusion assertion; several transfer-stat tests are commented out |
| staff statistics | `staff/tests/functional/StatisticsCest.php` bearer-authenticated 200 smoke | expected counter assertions are commented out |
| candidate statistics | `candidate/tests/functional/StatisticsCest.php` asserts time/earning fields | codifies integer truncation and does not challenge minute/second pay |
| status | CI runs functional/unit suites (`.circleci/config.yml:204-212`), but functional files are only Auth/Account | none of the 37 reporting/domain actions is exercised |
| scheduled jobs, stored roll-ups, exports, year report | none found | all delivery, idempotency, precision, auth, parent/child and audit behavior needs synthetic fixtures |

## 9. Parity journeys and final owner

| ID | Journey | Disposition | Exact owner |
|---|---|---|---|
| RP-01 | twelve-source morning operational queue/digest, with legacy rendering defects excluded | REQUIRED / ADAPT | SHU-193; D-RP2/SHU-211 decides delivery |
| RP-02 | recruiter productivity + client leaderboard | REQUIRED / ADAPT | SHU-193 |
| RP-03 | hired, retained, invitations, company/request/payable/attendance statistics | REQUIRED / ADAPT | SHU-194; source clusters provide ports |
| RP-04 | transfer totals and revenue/projection statistics | REQUIRED / ADAPT | SHU-194 read model + SHU-195 materialization; F2/F4 source truth |
| RP-05 | staff operational counters and candidate/employer dashboards | REQUIRED / SPLIT | SHU-194 aggregate views; SHU-193 queue; W3/W7 and F4 source views |
| RP-06 | candidate/company stored revenue | REQUIRED / REPLACE | SHU-195, blocked only by F2 and SHU-137 |
| RP-07 | standalone status/inspector shell | EXCLUDE by default; decision pending | D-RP1; SHU-141 reachability; each of 37 capabilities mapped in §2 |
| RP-08 | twelve-month company request/suggestion/hire report | REQUIRED / ADAPT | SHU-194 |
| RP-09 | 22 routable bulk outputs + scheduled workbook + document delivery | REQUIRED / ADAPT | SHU-196 service; domain projection owners in §7 |
| RP-10 | admin/staff whole-cache flush controls | DISCARD | SHU-213 exclusion |
| RP-11 | firing hit map and spike delivery | REQUIRED / ADAPT | SHU-194 |
| RP-12 | UTM click/signup charts and attribution revenue | REQUIRED / ADAPT; `total_revenue` unavailable at source | SHU-194; CM-18 owns capture/consent |
| RP-13 | assigned-candidate date/company report (`admin Candidate::ReportSearch`) | REQUIRED | SHU-193; recruit/work source ports |
| RP-14 | daily-standup question/inactive-staff reporting | REQUIRED if internal-work decision retains it | SHU-193; internal work owner W-internal |
| RP-15 | page-scoped client totals on payable candidates, work logs and staff sessions | DISCARD calculations; replace with server read models | F3, W3/W6; surfaced through SHU-194 only where dashboarded |

## 10. Bounded implementation slices and dependencies

| Slice | Scope | Current dependency truth | Estimate |
|---|---|---|---:|
| P1 / SHU-193 | morning queue/digest, recruiter productivity, assigned-candidate and retained internal reports | **Only D-RP2/SHU-211 blocks delivery policy.** Source read-model contracts and synthetic fixtures allow implementation before producing UIs | 5, split if delivery/report paths diverge |
| P2 / SHU-194 | grant-scoped, aggregate-only statistics: recruit/work/finance/company year report, hit map and attribution | independent of P1; finance revenue views must consume P3/F2 reconciliation | 5, split by source as the card permits |
| P3 / SHU-195 | derived or unique/idempotent revenue materialization with drift report | finance F2 / SHU-183 and SHU-137 | 3 |
| P4 / SHU-196 | common audited, private, expiring export/document-delivery primitive and migration of §7 routes | SHU-101 private storage; SHU-59 audit is related; each domain projection owner must be ready | **re-estimate required** from 22-action census |

The earlier 16-point total is no longer defensible because P4 was sized from seven paths and the status-shell decision can add UI work. Do not update the overall roadmap total until P4 is re-estimated and D-RP1 is closed.

## 11. Findings

| ID | Finding | Severity | Owner |
|---|---|---|---|
| RP-F1 | 15 status controllers expose 36 functional actions without bearer restoration; reachability unresolved | conditional high | SHU-141 / D-RP1 |
| RP-F2 | paid-transition and monthly full-history writers double-add stored revenue; reversals/retries add more; no uniqueness or reconciliation | high reporting integrity | SHU-195 |
| RP-F3 | 22 routable output actions plus a scheduled workbook, with no durable export audit | high privacy/integrity | SHU-196 + domain owners |
| RP-F4 | both admin and staff can flush the whole cache over HTTP | medium | SHU-213 discard |
| RP-F5 | staff cache SQL interpolates Currency and several counters cross currency boundaries | high | SHU-194 |
| RP-F6 | candidate monetary dashboard truncates decimals and omits minute/second pay | high payroll display integrity | F4 + SHU-194 |
| RP-F7 | admin Revenue mixes drifting stored totals with live projections and can divide by zero when hires are zero | medium-high | SHU-194/195 |
| RP-F8 | morning/recruiter deliveries are not idempotent; summary success skips its CronLog write; recruiter omits requests from Slack | medium | SHU-193 |
| RP-F9 | admin and unauthenticated status year reports concatenate query parameters into SQL | high | SHU-194 / D-RP1 |
| RP-F10 | status CI contains no reporting action tests; legacy statistics tests exist but are shallow and partly commented | process | SHU-193–196 acceptance suites |
| RP-F11 | campaign revenue has no writer; clicks/signups are non-idempotent increments | medium | SHU-194 + CM-18 |

## 12. Decisions and unknowns

| Decision | Recommended default | Blocking effect |
|---|---|---|
| D-RP1: retain a separate reporting dashboard/inspector identity? | Delete the separate shell; express inspector as read-only grants in the single app | no backend slice is blocked; any replacement UI size waits on this choice |
| D-RP2 / SHU-211: who receives the operational digest and by which channel? | in-product queue plus an idempotent email digest to current grant holders | blocks SHU-193 delivery policy only |

Not established by source inspection:

- whether `status.studenthub.co` is reachable or any inspector credential is active (SHU-141);
- the amount of historical drift in `candidate_stats`, `company_stats` or campaign counters (requires production data; do not inspect for this card);
- the actual timezone of the host running `cron/cronlist`; schedules above are literal cron expressions;
- whether configured report recipients still correspond to active people/grants;
- which document/export paths are still used beyond the five audited clients; the census proves code and routes, while UI usage is separately recorded in `ui-journeys`.
