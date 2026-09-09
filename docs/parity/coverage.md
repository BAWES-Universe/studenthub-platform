# Production coverage ledger: every controller action assigned to a cluster

**Card:** SHU-88 (acceptance items 2 and 4). **Production source:** `BAWES-Universe/studenthub` at `c2ce255`.

**Generated** by `tools/parity/generate-coverage-ledger.mjs`. Regenerate rather than hand-edit:

```
node tools/parity/generate-coverage-ledger.mjs <path-to-studenthub-checkout>
```

## Counting rules

A **functional action** is a method matching `/^action[A-Za-z0-9_]+$/` that is not the Yii framework hook `actions()`. In this codebase `actions()` configures CORS `OptionsAction`, so it is an OPTIONS/plumbing declaration rather than a feature endpoint; it is counted separately below. The declaration regex tolerates arbitrary whitespace between `public`, `function` and the name, because production contains at least one method written `public  function actionAppealList()` (`staff/modules/v1/controllers/CandidateWorkingHourController.php:279`).

**Functional actions: 1017.** **`actions()` hooks (OPTIONS/CORS configuration), reported separately: 171.** Controllers: 195.

Cluster assignment is data, not inference. `CONTROLLER_CLUSTER` in the generator gives each controller a default; `ACTION_CLUSTER` overrides named actions for controllers that span clusters. The generator exits non-zero if any action is unassigned, so the mapping is total by construction.

## Totals by cluster

| Code | Cluster | Actions | Share |
|---|---|---:|---:|
| ID | Identity and access (SHU-124) | 125 | 12% |
| PD | Profile and private documents (SHU-123) | 120 | 12% |
| OR | Organizations, stores, contacts, reference data (SHU-125) | 164 | 16% |
| RC | Discover work, apply, recruit (SHU-127) | 153 | 15% |
| WK | Work, scheduling, attendance, approvals (SHU-126) | 105 | 10% |
| FI | Finance, contracts, payroll (SHU-128) | 138 | 14% |
| CM | Communication, support, marketing, clients (SHU-129) | 135 | 13% |
| RP | Reporting and dashboards (SHU-137) | 46 | 5% |
| OPS | Platform config, ops, integration plumbing (SHU-139) | 31 | 3% |
| | **Total functional actions** | **1017** | 100% |

The seven inventory clusters cover **940** of 1017 functional actions (92%). The remaining 77 needed two buckets no roadmap card owned when this ledger was first written: reporting and dashboards (46, now SHU-137) and platform config, ops and integration plumbing (31, now SHU-139).

## Totals by app

| App | Controllers | Functional actions | `actions()` hooks |
|---|---:|---:|---:|
| admin | 56 | 318 | 56 |
| candidate | 23 | 145 | 23 |
| company | 25 | 119 | 16 |
| staff | 52 | 315 | 50 |
| manager | 10 | 30 | 6 |
| inspector | 4 | 8 | 4 |
| status | 16 | 37 | 16 |
| verification | 2 | 6 | 0 |
| console | 7 | 39 | 0 |
| **All** | **195** | **1017** | **171** |

## Assignment, controller by controller

Codes: ID identity, PD profile/documents, OR organizations, RC recruit, WK work, FI finance, CM communication, RP reporting, OPS platform, X base class.


### admin

| Controller | Functional actions | `actions()` | Cluster | Note |
|---|---:|---:|---|---|
| Admin | 7 | 1 | ID |  |
| Auth | 4 | 1 | ID |  |
| Aws | 1 | 1 | OPS | upload-credential endpoint, same shape as SHU-134 |
| Balance | 3 | 1 | FI |  |
| Bank | 5 | 1 | OR |  |
| BlockedIp | 5 | 1 | ID |  |
| Brand | 5 | 1 | OR |  |
| Campaign | 5 | 1 | CM |  |
| Candidate | 11 | 1 | PD |  |
| CandidateEvaluation | 10 | 1 | RC |  |
| CandidateWorkHistory | 1 | 1 | WK |  |
| CandidateWorkingHour | 2 | 1 | WK |  |
| CompanyContact | 10 | 1 | OR |  |
| Company | 18 | 1 | OR | includes sub-companies via parent_company_id |
| Country | 5 | 1 | OR |  |
| CronLog | 1 | 1 | OPS |  |
| Currency | 5 | 1 | OR |  |
| DailyStandupAnswer | 10 | 1 | WK |  |
| DailyStandupQuestion | 8 | 1 | WK |  |
| Degree | 5 | 1 | OR |  |
| DegreeGroup | 5 | 1 | OR |  |
| DiscountCategory | 5 | 1 | CM |  |
| Discount | 5 | 1 | CM |  |
| EmailCampaign | 7 | 1 | CM |  |
| Event | 1 | 1 | OPS |  |
| Expense | 5 | 1 | FI |  |
| Fulltimer | 3 | 1 | RC | full-time placement product; liveness is a decision |
| Inspector | 6 | 1 | ID |  |
| Invitation | 1 | 1 | RC |  |
| MailLog | 3 | 1 | CM |  |
| Major | 5 | 1 | OR |  |
| Note | 5 | 1 | CM |  |
| PermissionSection | 10 | 1 | ID |  |
| Ping | 1 | 1 | OPS |  |
| RequestChecklist | 5 | 1 | RC |  |
| Request | 7 | 1 | RC |  |
| Setting | 2 | 1 | OPS |  |
| Staff | 13 | 1 | ID 10, FI 3 |  |
| StaffExpenses | 6 | 1 | FI |  |
| StaffLeave | 4 | 1 | WK |  |
| StaffSalary | 5 | 1 | FI |  |
| StaffWorkSession | 4 | 1 | WK |  |
| Statistic | 5 | 1 | RP |  |
| Store | 3 | 1 | OR |  |
| Story | 5 | 1 | CM |  |
| Suggestion | 2 | 1 | RC |  |
| Tag | 5 | 1 | OR |  |
| TransferBankAdvice | 5 | 1 | FI |  |
| TransferCandidate | 12 | 1 | FI |  |
| Transfer | 26 | 1 | FI |  |
| TransferFile | 3 | 1 | FI |  |
| University | 6 | 1 | OR |  |
| Webhook | 6 | 1 | CM |  |
| Xero | 7 | 1 | FI | owner disposition DEFER |
| XeroWebhook | 1 | 1 | FI | not routed in config; verify dead |
| Yeaster | 3 | 1 | CM | telephony/PBX |

### candidate

| Controller | Functional actions | `actions()` | Cluster | Note |
|---|---:|---:|---|---|
| Account | 50 | 1 | PD 36, ID 6, FI 3, RC 2, WK 3 |  |
| Auth | 16 | 1 | ID |  |
| Aws | 1 | 1 | OPS | SHU-134 |
| Balance | 3 | 1 | FI |  |
| Campaign | 1 | 1 | CM |  |
| Candidate | 4 | 1 | WK |  |
| CandidateEducation | 9 | 1 | PD |  |
| CandidateExperience | 6 | 1 | PD |  |
| CandidateLink | 5 | 1 | PD |  |
| CandidateNotification | 3 | 1 | CM |  |
| CandidateWorkingHour | 10 | 1 | WK |  |
| Chat | 8 | 1 | CM |  |
| Country | 1 | 1 | OR |  |
| DiscountCategory | 1 | 1 | CM |  |
| Discount | 1 | 1 | CM |  |
| GoogleMap | 2 | 1 | OPS |  |
| Invitation | 6 | 1 | RC |  |
| Job | 3 | 1 | RC |  |
| Ping | 1 | 1 | OPS |  |
| Request | 5 | 1 | RC |  |
| Statistic | 1 | 1 | RP |  |
| Ticket | 5 | 1 | CM |  |
| University | 3 | 1 | OR |  |

### company

| Controller | Functional actions | `actions()` | Cluster | Note |
|---|---:|---:|---|---|
| Account | 4 | 0 | ID |  |
| Algolia | 1 | 0 | RC |  |
| Auth | 13 | 1 | ID |  |
| Aws | 1 | 1 | OPS | SHU-134 shape |
| Balance | 3 | 1 | FI |  |
| Base | 0 | 1 | X |  |
| Campaign | 1 | 1 | CM |  |
| Candidate | 12 | 0 | RC 5, WK 6, PD 1 |  |
| CandidateWorkLogFeedback | 3 | 1 | WK |  |
| CandidateWorkingHour | 4 | 1 | WK |  |
| Chat | 8 | 1 | CM |  |
| CompanyContact | 4 | 0 | OR |  |
| Company | 8 | 1 | OR |  |
| Contract | 2 | 1 | FI |  |
| Country | 1 | 1 | OR |  |
| Currency | 1 | 1 | OR |  |
| Invitation | 7 | 1 | RC |  |
| Note | 5 | 0 | CM |  |
| Ping | 1 | 1 | OPS |  |
| RequestActivity | 2 | 0 | RC |  |
| RequestCandidateInvitation | 4 | 1 | RC |  |
| Request | 12 | 0 | RC |  |
| Store | 5 | 0 | OR |  |
| Suggestion | 4 | 0 | RC |  |
| Transfer | 13 | 1 | FI |  |

### staff

| Controller | Functional actions | `actions()` | Cluster | Note |
|---|---:|---:|---|---|
| Account | 4 | 1 | ID |  |
| Algolia | 1 | 1 | RC |  |
| Auth | 7 | 1 | ID |  |
| Aws | 1 | 1 | OPS | SHU-134 shape |
| Bank | 2 | 1 | OR |  |
| Base | 0 | 1 | X |  |
| Brand | 6 | 1 | OR |  |
| Candidate | 41 | 1 | PD 19, WK 11, RC 5, FI 4, ID 2 |  |
| CandidateEvaluation | 5 | 1 | RC |  |
| CandidateIdCard | 8 | 1 | PD |  |
| CandidateIdRequest | 4 | 1 | PD |  |
| CandidateWorkingHour | 10 | 1 | WK |  |
| Certificate | 6 | 1 | PD |  |
| Chat | 9 | 1 | CM |  |
| CompanyContact | 12 | 1 | OR |  |
| Company | 13 | 1 | OR |  |
| CompanyRequest | 4 | 1 | RC |  |
| Contract | 5 | 1 | FI |  |
| Country | 3 | 1 | OR |  |
| CronLog | 1 | 1 | OPS |  |
| Currency | 1 | 1 | OR |  |
| DailyStandup | 8 | 1 | WK |  |
| DiscountCategory | 5 | 1 | CM | not routed in config; verify dead |
| Discount | 5 | 1 | CM | not routed in config; verify dead |
| EmailCampaign | 7 | 1 | CM |  |
| FiringHitmap | 1 | 1 | WK |  |
| Fulltimer | 5 | 1 | RC |  |
| GoogleMap | 3 | 1 | OPS |  |
| InterviewEvaluation | 8 | 1 | RC |  |
| Invitation | 6 | 1 | RC |  |
| Jira | 2 | 1 | CM | support tooling |
| Job | 10 | 0 | RC |  |
| Mall | 6 | 1 | OR |  |
| Note | 5 | 0 | CM |  |
| PermissionSection | 2 | 1 | ID |  |
| Ping | 1 | 1 | OPS |  |
| RequestActivity | 2 | 1 | RC |  |
| Request | 18 | 1 | RC |  |
| Staff | 2 | 1 | ID |  |
| StaffExpenses | 5 | 1 | FI |  |
| StaffLeave | 3 | 1 | WK |  |
| Statistic | 1 | 1 | RP |  |
| StoreAssignmentRequest | 4 | 1 | WK |  |
| Store | 9 | 1 | OR |  |
| Story | 8 | 1 | CM |  |
| Suggestion | 8 | 1 | RC |  |
| Tag | 2 | 1 | OR |  |
| Ticket | 7 | 1 | CM |  |
| Transfer | 18 | 1 | FI |  |
| University | 3 | 1 | OR |  |
| Webhook | 5 | 1 | CM |  |
| Yeaster | 3 | 1 | CM | telephony/PBX |

### manager

| Controller | Functional actions | `actions()` | Cluster | Note |
|---|---:|---:|---|---|
| Account | 4 | 0 | ID |  |
| Auth | 12 | 1 | ID |  |
| Aws | 1 | 1 | OPS | SHU-134 shape |
| Base | 0 | 1 | X |  |
| Candidate | 4 | 0 | PD 2, WK 2 |  |
| CandidateWorkingHour | 2 | 1 | WK |  |
| CompanyContact | 3 | 0 | OR | not routed in config; verify dead |
| Company | 2 | 1 | OR |  |
| Ping | 1 | 1 | OPS |  |
| Store | 1 | 0 | OR |  |

### inspector

| Controller | Functional actions | `actions()` | Cluster | Note |
|---|---:|---:|---|---|
| Account | 1 | 1 | ID |  |
| Auth | 5 | 1 | ID |  |
| Aws | 1 | 1 | OPS | SHU-134 shape |
| Ping | 1 | 1 | OPS |  |

### status

| Controller | Functional actions | `actions()` | Cluster | Note |
|---|---:|---:|---|---|
| Account | 1 | 1 | ID | not routed in config; verify dead |
| Aws | 1 | 1 | OPS | SHU-134 shape |
| Bank | 2 | 1 | RP |  |
| Candidate | 4 | 1 | RP |  |
| CandidateWorkHistory | 1 | 1 | RP |  |
| Company | 3 | 1 | RP |  |
| Country | 2 | 1 | RP |  |
| Expense | 2 | 1 | RP |  |
| Note | 2 | 1 | RP |  |
| Request | 2 | 1 | RP |  |
| Staff | 3 | 1 | RP |  |
| Statistic | 3 | 1 | RP |  |
| Story | 2 | 1 | RP |  |
| TransferCandidate | 4 | 1 | RP |  |
| Transfer | 3 | 1 | RP |  |
| University | 2 | 1 | RP |  |

### verification

| Controller | Functional actions | `actions()` | Cluster | Note |
|---|---:|---:|---|---|
| Site | 2 | 0 | PD | public QR card |
| View | 4 | 0 | PD | public resume/video/phone redirects |

### console

| Controller | Functional actions | `actions()` | Cluster | Note |
|---|---:|---:|---|---|
| Algolia | 1 | 0 | RC |  |
| CentralDb | 4 | 0 | ID | exports users with password hashes to a second database |
| Cron | 28 | 0 | OPS 7, PD 6, OR 1, WK 5, RC 1, FI 3, CM 2, RP 3 |  |
| Event | 1 | 0 | OPS |  |
| Report | 1 | 0 | RP |  |
| Resource | 1 | 0 | PD |  |
| Xero | 3 | 0 | FI |  |

## What this ledger does not claim

- That every action is a distinct user journey. Many are CRUD variants of one journey; the per-cluster inventories collapse them.
- That the assignment is the only defensible cut. It is expressed as data in the generator, so a different cut is a diff, not a recount.
- Anything about the front-end repositories, the live database, or live infrastructure.

