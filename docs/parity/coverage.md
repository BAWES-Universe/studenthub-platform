# Production coverage ledger: every controller assigned to a cluster

**Card:** SHU-88 (acceptance items 2 and 4). **Production source:** `BAWES-Universe/studenthub` at `c2ce255`. **Generated** by counting `public function action…` per controller file and applying a fixed assignment table; regenerate rather than hand-edit.

**Purpose.** "Seven clusters cover everything" is a claim; this table is either the proof or the gap. Every controller in every app is assigned to exactly one cluster, or split by action with the split stated. Two buckets that are **not** among the seven inventories had to be added to make the assignment total: **Reporting and dashboards** and **Platform config, ops and integration plumbing**. Those are the coverage gaps in the roadmap as written, and each needs an owner before cutover.

## Totals by cluster

| Code | Cluster | Actions | Share |
|---|---|---:|---:|
| ID | Identity and access (SHU-124) | 139 | 12% |
| PD | Profile and private documents (SHU-123) | 128 | 11% |
| OR | Organizations, stores, contacts, reference data (SHU-125) | 192 | 16% |
| RC | Discover work, apply, recruit (SHU-127) | 174 | 15% |
| WK | Work, scheduling, attendance, approvals (SHU-126) | 122 | 10% |
| FI | Finance, contracts, payroll (SHU-128) | 155 | 13% |
| CM | Communication, support, marketing, clients (SHU-129) | 144 | 12% |
| RP | Reporting and dashboards (not one of the seven; new) | 63 | 5% |
| OPS | Platform config, ops, integration plumbing (not one of the seven; new) | 67 | 6% |
| X | Not an endpoint (base class) | 3 | – |
| | **Total endpoints (excluding base classes)** | **1184** | 100% |

## Totals by app

| App | Controllers | Actions |
|---|---:|---:|
| admin | 56 | 374 |
| candidate | 23 | 168 |
| company | 25 | 135 |
| staff | 52 | 364 |
| manager | 10 | 36 |
| inspector | 4 | 12 |
| status | 16 | 53 |
| verification | 2 | 6 |
| console | 7 | 39 |
| **All** | **195** | **1187** |

## Assignment, controller by controller

Cluster codes: ID identity, PD profile/documents, OR organizations, RC recruit, WK work, FI finance, CM communication, RP reporting, OPS platform, X base class.


### admin

| Controller | Actions | Cluster | Note |
|---|---:|---|---|
| Admin | 8 | ID |  |
| Auth | 5 | ID |  |
| Aws | 2 | OPS | upload-credential endpoint, same shape as SHU-134 |
| Balance | 4 | FI |  |
| Bank | 6 | OR | reference data consumed by finance |
| BlockedIp | 6 | ID |  |
| Brand | 6 | OR |  |
| Campaign | 6 | CM |  |
| Candidate | 12 | PD | search/review is recruit-adjacent |
| CandidateEvaluation | 11 | RC |  |
| CandidateWorkHistory | 2 | WK |  |
| CandidateWorkingHour | 3 | WK |  |
| CompanyContact | 11 | OR |  |
| Company | 19 | OR | includes sub-companies via parent_company_id |
| Country | 6 | OR |  |
| CronLog | 2 | OPS |  |
| Currency | 6 | OR |  |
| DailyStandupAnswer | 11 | WK |  |
| DailyStandupQuestion | 9 | WK |  |
| Degree | 6 | OR |  |
| DegreeGroup | 6 | OR |  |
| DiscountCategory | 6 | CM |  |
| Discount | 6 | CM | candidate perks |
| EmailCampaign | 8 | CM |  |
| Event | 2 | OPS |  |
| Expense | 6 | FI |  |
| Fulltimer | 4 | RC | full-time placement product; decision on liveness |
| Inspector | 7 | ID |  |
| Invitation | 2 | RC |  |
| MailLog | 4 | OPS |  |
| Major | 6 | OR |  |
| Note | 6 | CM |  |
| PermissionSection | 11 | ID |  |
| Ping | 2 | OPS |  |
| RequestChecklist | 6 | RC |  |
| Request | 8 | RC |  |
| Setting | 3 | OPS |  |
| Staff | 14 | ID 11, FI 3 | ListSalaries, ListCompanies, ImportSalary are finance |
| StaffExpenses | 7 | FI |  |
| StaffLeave | 5 | WK |  |
| StaffSalary | 6 | FI |  |
| StaffWorkSession | 5 | WK |  |
| Statistic | 6 | RP |  |
| Store | 4 | OR |  |
| Story | 6 | CM |  |
| Suggestion | 3 | RC |  |
| Tag | 6 | OR | tag vocabulary; applied to candidates in PD |
| TransferBankAdvice | 6 | FI |  |
| TransferCandidate | 13 | FI |  |
| Transfer | 27 | FI |  |
| TransferFile | 4 | FI |  |
| University | 7 | OR |  |
| Webhook | 7 | OPS |  |
| Xero | 8 | FI | owner disposition DEFER |
| XeroWebhook | 2 | FI | not routed in config; verify dead |
| Yeaster | 4 | CM | telephony/PBX |

### candidate

| Controller | Actions | Cluster | Note |
|---|---:|---|---|
| Account | 51 | PD 39, ID 6, FI 3, WK 3 | ID: change-password, toggle-two-step-auth, discard-session, validate-password, update-email, delete-profile shares PD; FI: salary, salary/<id>, update-bank-detail; WK: current-status, start-time, stop-time |
| Auth | 17 | ID |  |
| Aws | 2 | OPS | SHU-134 |
| Balance | 4 | FI |  |
| Campaign | 2 | CM |  |
| Candidate | 5 | WK | work history, working dates; appreciation certificate PDF is PD slice S8 |
| CandidateEducation | 10 | PD |  |
| CandidateExperience | 7 | PD |  |
| CandidateLink | 6 | PD |  |
| CandidateNotification | 4 | CM |  |
| CandidateWorkingHour | 11 | WK |  |
| Chat | 9 | CM |  |
| Country | 2 | OR |  |
| DiscountCategory | 2 | CM |  |
| Discount | 2 | CM |  |
| GoogleMap | 3 | OPS |  |
| Invitation | 7 | RC |  |
| Job | 4 | RC |  |
| Ping | 2 | OPS |  |
| Request | 6 | RC |  |
| Statistic | 2 | RP |  |
| Ticket | 6 | CM |  |
| University | 4 | OR |  |

### company

| Controller | Actions | Cluster | Note |
|---|---:|---|---|
| Account | 4 | ID |  |
| Algolia | 1 | RC |  |
| Auth | 14 | ID |  |
| Aws | 2 | OPS | SHU-134 shape |
| Balance | 4 | FI |  |
| Base | 1 | X |  |
| Campaign | 2 | CM |  |
| Candidate | 12 | PD 2, WK 7, RC 3 | view + work-history are PD/WK; work-log excel, stats, working-dates are WK; search, list, total are RC |
| CandidateWorkLogFeedback | 4 | WK |  |
| CandidateWorkingHour | 5 | WK |  |
| Chat | 9 | CM |  |
| CompanyContact | 4 | OR |  |
| Company | 9 | OR |  |
| Contract | 3 | FI |  |
| Country | 2 | OR |  |
| Currency | 2 | OR |  |
| Invitation | 8 | RC |  |
| Note | 5 | CM |  |
| Ping | 2 | OPS |  |
| RequestActivity | 2 | RC |  |
| RequestCandidateInvitation | 5 | RC |  |
| Request | 12 | RC |  |
| Store | 5 | OR |  |
| Suggestion | 4 | RC |  |
| Transfer | 14 | FI |  |

### staff

| Controller | Actions | Cluster | Note |
|---|---:|---|---|
| Account | 5 | ID |  |
| Algolia | 2 | RC |  |
| Auth | 8 | ID |  |
| Aws | 2 | OPS | SHU-134 shape |
| Bank | 3 | OR |  |
| Base | 1 | X |  |
| Brand | 7 | OR |  |
| Candidate | 42 | PD 16, WK 12, RC 10, FI 4 | PD: create, update, tags, email, civil expiry, login-as, duplicate, merge, restore, list; WK: assign/unassign, assigned lists, toggle-committed, history; RC: search, not-assigned, applications; FI: hour rate, transfer cost |
| CandidateEvaluation | 6 | RC |  |
| CandidateIdCard | 9 | PD |  |
| CandidateIdRequest | 5 | PD |  |
| CandidateWorkingHour | 10 | WK |  |
| Certificate | 7 | PD |  |
| Chat | 10 | CM |  |
| CompanyContact | 13 | OR |  |
| Company | 14 | OR |  |
| CompanyRequest | 5 | RC |  |
| Contract | 6 | FI |  |
| Country | 4 | OR |  |
| CronLog | 2 | OPS |  |
| Currency | 2 | OR |  |
| DailyStandup | 9 | WK |  |
| DiscountCategory | 6 | CM | not routed in config; verify dead |
| Discount | 6 | CM | not routed in config; verify dead |
| EmailCampaign | 8 | CM |  |
| FiringHitmap | 2 | WK |  |
| Fulltimer | 6 | RC |  |
| GoogleMap | 4 | OPS |  |
| InterviewEvaluation | 9 | RC |  |
| Invitation | 7 | RC |  |
| Jira | 3 | CM | support tooling |
| Job | 10 | RC |  |
| Mall | 7 | OR |  |
| Note | 5 | CM |  |
| PermissionSection | 3 | ID |  |
| Ping | 2 | OPS |  |
| RequestActivity | 3 | RC |  |
| Request | 19 | RC |  |
| Staff | 3 | ID |  |
| StaffExpenses | 6 | FI |  |
| StaffLeave | 4 | WK |  |
| Statistic | 2 | RP |  |
| StoreAssignmentRequest | 5 | WK |  |
| Store | 10 | OR |  |
| Story | 9 | CM |  |
| Suggestion | 9 | RC |  |
| Tag | 3 | OR |  |
| Ticket | 8 | CM |  |
| Transfer | 19 | FI |  |
| University | 4 | OR |  |
| Webhook | 6 | OPS |  |
| Yeaster | 4 | CM |  |

### manager

| Controller | Actions | Cluster | Note |
|---|---:|---|---|
| Account | 4 | ID |  |
| Auth | 13 | ID |  |
| Aws | 2 | OPS | SHU-134 shape |
| Base | 1 | X |  |
| Candidate | 4 | PD 2, WK 2 | view/list are PD; work-history/total are WK |
| CandidateWorkingHour | 3 | WK |  |
| CompanyContact | 3 | OR | not routed in config; verify dead |
| Company | 3 | OR |  |
| Ping | 2 | OPS |  |
| Store | 1 | OR |  |

### inspector

| Controller | Actions | Cluster | Note |
|---|---:|---|---|
| Account | 2 | ID |  |
| Auth | 6 | ID |  |
| Aws | 2 | OPS | SHU-134 shape |
| Ping | 2 | OPS |  |

### status

| Controller | Actions | Cluster | Note |
|---|---:|---|---|
| Account | 2 | ID | not routed in config; verify dead |
| Aws | 2 | OPS | SHU-134 shape |
| Bank | 3 | RP |  |
| Candidate | 5 | RP |  |
| CandidateWorkHistory | 2 | RP |  |
| Company | 4 | RP |  |
| Country | 3 | RP |  |
| Expense | 3 | RP |  |
| Note | 3 | RP |  |
| Request | 3 | RP |  |
| Staff | 4 | RP |  |
| Statistic | 4 | RP |  |
| Story | 3 | RP |  |
| TransferCandidate | 5 | RP |  |
| Transfer | 4 | RP |  |
| University | 3 | RP |  |

### verification

| Controller | Actions | Cluster | Note |
|---|---:|---|---|
| Site | 2 | PD | public QR card; finding F10 |
| View | 4 | PD | public resume/video/phone redirects; F10 |

### console

| Controller | Actions | Cluster | Note |
|---|---:|---|---|
| Algolia | 1 | RC |  |
| CentralDb | 4 | ID | exports users with password hashes to a second database; see identity inventory |
| Cron | 28 | OPS 7, PD 6, OR 1, WK 5, RC 1, FI 3, CM 2, RP 3 | see cron table |
| Event | 1 | OPS |  |
| Report | 1 | RP |  |
| Resource | 1 | PD |  |
| Xero | 3 | FI |  |

## Scheduled jobs (`console/controllers/CronController.php`), one row per action

Schedule source: `cron/cronlist` in the repository. Actions absent from that file run only by hand or through `actionIndex`.

| Action | Cluster | Note |
|---|---|---|
| Index | OPS | ad-hoc entry; calls several of the above |
| FillCivilIdExpiryDate | PD |  |
| FillCivilIdExpiryDateNotAssigned | PD |  |
| ValidateCivilId | PD |  |
| CheckIfCandidateTotalMismatch | OR |  |
| Daily | OPS | composite: token purge (ID), birthday and civil-expiry alerts (CM), standup report and hit map (WK), unpaid-invoice alert and transfer-paid mails (FI) |
| GenHitMap | WK |  |
| EveryMinute | RC |  |
| Every5Minute | OPS |  |
| ProcessTransferFiles | FI |  |
| ProcessCampaign | CM |  |
| Weekly | FI | creates transfers from contracts |
| MidMonth | CM | civil-ID-expiring and missing-bank-info notifications (CM/FI) |
| EndOfMonth | WK | same as MidMonth plus attendance request to companies (WK) |
| RemoveDuplicate | PD | hard-deletes experiences (CONSTRAINT, PD finding F4) |
| Summary | RP | morning report email |
| PayableCandidateNotification | FI |  |
| KuwaitMomCheck | PD |  |
| SegmentTransfer | OPS |  |
| SegmentSuggestion | OPS |  |
| SegmentExpense | OPS |  |
| Test | OPS |  |
| CheckDailyAttendance | WK |  |
| UpdateCandidateStats | RP |  |
| UpdateCompanyStats | RP |  |
| FixWorkLogs | WK |  |
| FixWorkLogDates | WK |  |
| FixEducation | PD |  |

Active crontab lines at this revision: 14: `cron/every-minute`; `cron/process-transfer-files`; `cron/process-campaign`; `algolia candidate civilIdExpiredToday`; `cron/payable-candidate-notification`; `cron/summary`; `cron/daily`; `report/recruiter`; `cron/weekly`; `cron/mid-month`; `cron/update-candidate-stats`; `cron/update-company-stats`; `cron/end-of-month`; `cron/gen-hit-map`.

## Controllers with no route in their app's `config/main.php`

These files exist but no URL rule points at them at this revision. Verify before excluding from parity: `admin/XeroWebhook`, `staff/Discount`, `staff/DiscountCategory`, `manager/CompanyContact`, `status/Account`.

## API consumers

| Client | Backend app | Status at this revision |
|---|---|---|
| `studenthub-candidate-react` (pushed 2026-09-04) | candidate | most recent candidate UI; which one production serves is unresolved |
| `studenthub-candidate-next` (2026-08-19) | candidate | unresolved |
| `studenthub-candidate` Cordova (2026-07-06) | candidate | unresolved |
| Staff, admin, company, manager, inspector, status front ends | respective apps | separate repositories; not inventoried here |
| MobileNotification / OneSignal | candidate | push channel, CM cluster |
| `studenthub-mcp` | candidate read API | live bridge per SHU-34 |

## What this ledger does not claim

- That every action is a distinct user journey. Many are CRUD variants of one journey; the per-cluster inventories collapse them.
- That the assignment is the only defensible one. Splits are stated per row so a different cut can be applied without recounting.
- Anything about the front-end repositories, the live database, or the live infrastructure.

