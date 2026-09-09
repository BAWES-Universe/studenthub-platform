# Production parity inventory: reporting and dashboards

**Card:** SHU-137 (parent SHU-88). Closes one of the two coverage gaps found by PR #52. Feeds SHU-97 (data map) and whichever contract card owns reporting.
**Production source:** `BAWES-Universe/studenthub` at `c2ce255`. Permalink base `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Method:** read-only static inspection. No database, live-host or network access. No personal data, amounts or record contents.
**Coverage:** 46 of 1,017 functional production actions (`docs/parity/coverage.md`, cluster RP, regenerated at `cab8d90`).

## 1. What this cluster is

Everything that answers "how are we doing" rather than "do a thing": a separate read-only reporting API (the `status` app), per-app statistics endpoints, two nightly report emails, two revenue roll-up tables, and a set of Excel exports.

It exists as a cluster only because the coverage ledger forced every action to be assigned and 46 of them belonged to none of the seven feature clusters. That is the useful finding by itself: **reporting was invisible to the roadmap** until the assignment was made total.

## 2. The `status` app

A sixteenth Yii application, `status/`, with 16 controllers and 47 action declarations (46 functional plus one that re-adds auth). It reads across every domain: candidates, companies, staff, transfers, transfer candidates, requests, stories, notes, expenses, banks, countries, universities, work history, and a statistics controller with `List`, `Transfer` and `Graph`.

Its user identity is `common\models\Inspector` (`status/config/main.php:27-30`, `enableSession => false`). That answers the open question left in the identity inventory: **inspectors are the reporting-dashboard users.** The inspector app itself has only Auth, Account, Aws and Ping, which is why it looked dormant; the feature surface for that role lives here.

### 2.1 Authentication

Fifteen of the sixteen controllers do this:

```php
$behaviors = parent::behaviors();
// remove authentication filter for cors to work
unset($behaviors['authenticator']);
$behaviors['corsFilter'] = [ /* ... */ ];
return $behaviors;
```

(`status/modules/v1/controllers/CandidateController.php:20` and the same in `Aws`, `Bank`, `CandidateWorkHistory`, `Company`, `Country`, `Expense`, `Note`, `Request`, `Staff`, `Statistic`, `Story`, `TransferCandidate`, `Transfer`, `University`.)

Only `AccountController` restores it (`:33-37`, `HttpBearerAuth`). The correct pattern — unset for the preflight, then re-add — exists elsewhere in the same codebase at `staff/modules/v1/controllers/AlgoliaController.php:34`, so this is an error rather than a design choice.

**Whether those endpoints are reachable is unresolved and is tracked as SHU-141**, which can be settled with one request. Evidence exists on both sides: `environments/prod-railway/status/web/index.php` ships the entry point, `params-local.php:14` defines `statusAppUrl => https://status.studenthub.co/`, `status/Dockerfile` points Apache at `status/web`, `aws-template.sh:165-218` enables a vhost, and CI runs the app's Codeception suites (`.circleci/config.yml:204-212`). Against that, **none of the six nginx configs routes to it** — `nginx/production.conf` and `nginx/railway-prod.conf` serve admin, student, employer, inspector, staff and verification only.

This inventory does not assert the app is exposed. It asserts the code removes authentication and that the deployment question is open.

## 3. Statistics endpoints in the feature apps

| App | Actions | What they compute |
|---|---|---|
| admin | `List`, `Transfer`, `Revenue`, `InvitationGraphData`, `ClearCache` | `List`: retained and hired counts from `candidate_work_history`, invitations sent. `Transfer`: transfer-candidate counts, company totals received and candidate totals owed, summed with child transfers excluded. `Revenue`: company and candidate counts plus sum, min and max over `company_stats` and `candidate_stats`. `InvitationGraphData`: invitations by month. `ClearCache`: flushes the whole application cache |
| staff | `List` | staff-scoped counters |
| candidate | `List` | own counters |
| company | via `Candidate` work-log endpoints | employer-side stats live in the work cluster |

`ClearCache` flushes the entire application cache from an HTTP endpoint. Worth noting for the platform: cache invalidation should not be a user-reachable button.

## 4. Roll-up tables

`candidate_stats` and `company_stats` are the same shape: a uuid, the subject id, `total_revenue`, `currency_code`, timestamps. They are accumulated, not recomputed:

`cron/update-company-stats` (`CronController.php:1109-1128`) groups transfers by currency, computes `SUM(company_total - candidate_total) AS profit`, and calls `updateCounters(['total_revenue' => $row['profit']])` on an existing row or inserts a new one. `cron/update-candidate-stats` does the equivalent for candidates.

Both run **13:30 on the 15th** (`cron/cronlist`) — mid-month only, alongside `cron/mid-month`. So revenue statistics advance once a month and by increment, which means a re-run double-counts and a missed run leaves a permanent gap. There is no reconciliation job and no recompute-from-source path. Finding RP-F2.

## 5. Scheduled reports

| Job | Schedule | Content |
|---|---|---|
| `cron/summary` | daily 05:00 | the morning operations email: expired ID cards, assigned candidates with expired civil IDs, IDs needing generation, profiles awaiting approval, candidates assigned to work with incomplete profiles, candidates missing bank information, companies requiring follow-up, active requests, assigned idle candidates, and companies with no payment in 40 days (`CronController.php` `actionSummary`) |
| `report/recruiter` | daily 17:00, Sunday to Thursday | per-recruiter productivity: suggestions and story employees since a date, mailed out (`console/controllers/ReportController.php` `actionRecruiter`) |

The morning summary is a genuine operational product: eleven counters that tell staff what needs attention today. It is the clearest thing in this cluster to reproduce.

The recruiter report filters staff by `Staff::ROlE_RECRUITER` — note the typo in the constant name, which is production's own.

## 6. Exports

| Export | Where | Note |
|---|---|---|
| Candidates for a company | `admin/.../CompanyController.php:829` `DownloadCandidatesExcel` | bulk personal data, no audit record |
| Company list | `:860` `DownloadListExcel` | |
| University list | `admin/.../UniversityController.php` | |
| Candidate data, assigned history | `staff/.../CandidateController.php` `ExportCandidateData`, `ExportAssignedHistory` | |
| Work logs | `company/.../CandidateController.php` `WorkLogExcel`, `WorkLogDetailedExcel` | employer-facing (work cluster) |
| Transfer rates | `TransferRateExcel` model | finance |
| Company year report | `admin` and `status` `YearReport` | |

Seven export paths, none of them audited. The organizations inventory raised this as OR-F5; it belongs here too and the platform answer is one audited export service.

## 7. Parity rows

| ID | Journey | Actor / grant | Legacy routes | Tests | Disposition | Slice |
|---|---|---|---|---|---|---|
| RP-01 | Morning operations summary | staff | `cron/summary` | none | **REQUIRED** — the most valuable thing in this cluster | P1 |
| RP-02 | Recruiter productivity report | staff, admin | `report/recruiter` | none | REQUIRED | P1 |
| RP-03 | Admin business statistics: hired, retained, invitations | admin | admin `Statistic` `List`, `InvitationGraphData` | none | REQUIRED | P2 |
| RP-04 | Transfer and revenue statistics | admin | admin `Statistic` `Transfer`, `Revenue` | none | REQUIRED | P2 |
| RP-05 | Staff and candidate counters | staff, candidate | staff and candidate `Statistic` `List` | none | REQUIRED | P2 |
| RP-06 | Revenue roll-ups maintained | system | `cron/update-company-stats`, `-candidate-stats` | none | REQUIRED, **ADAPT: derive or make idempotent (RP-F2)** | P3 |
| RP-07 | Cross-domain read-only dashboard | inspector | the `status` app, 46 actions | `status/tests` run in CI | **EXCLUDE-PENDING-OWNER** (D-RP1); blocked on SHU-141 | — |
| RP-08 | Company year report | admin, inspector | `YearReport` in admin and status | none | REQUIRED | P2 |
| RP-09 | Bulk exports (seven paths) | admin, staff | §6 | none | REQUIRED, **ADAPT: one audited, time-bounded export service** | P4 |
| RP-10 | Flush the application cache over HTTP | admin | admin `Statistic` `ClearCache` | none | **DISCARD** | — |
| RP-11 | Firing hit map | staff | `cron/gen-hit-map`, staff `FiringChart` | none | REQUIRED | P2 |
| RP-12 | Marketing attribution reporting | admin | `Campaign` counters, `campaign` table | none | REQUIRED | P2 |

## 8. Tests and fixtures

The `status` app has its own Codeception suites and CI runs them (`.circleci/config.yml:204-212`), which is more coverage than the work or finance clusters have. Nothing else in this cluster is tested: no test covers the morning summary, the recruiter report, any statistics endpoint, either roll-up cron, or any export.

**Untested behaviour, explicitly:** all eleven morning-summary counters; recruiter productivity aggregation; hired and retained counts; transfer and revenue sums including the child-transfer exclusion; both revenue roll-up crons and their increment semantics; every Excel export; the year report; cache flushing.

## 9. Findings

| ID | Finding | Evidence | Severity | Action |
|---|---|---|---|---|
| **RP-F1** | Fifteen `status` controllers remove the authentication filter and never restore it; reachability is unresolved | §2.1 | **Conditional, potentially high** | **SHU-141** settles it with one request |
| **RP-F2** | Revenue roll-ups accumulate by `updateCounters` on a monthly cron with no idempotency and no recompute path: a re-run double-counts, a missed run leaves a permanent gap | `CronController.php:1109-1128`; `cron/cronlist` | Medium (reported revenue can silently drift from the transfers it summarises) | P3 |
| **RP-F3** | Seven bulk export paths, none audited | §6 | Medium (privacy) | P4 |
| **RP-F4** | The whole application cache can be flushed from an HTTP endpoint | admin `Statistic` `ClearCache` | Low–Medium | discard |
| **RP-F5** | Reporting had no owner in the roadmap until the coverage ledger forced a total assignment | PR #52 | Process | this card |
| **RP-F6** | Inspector is the reporting-dashboard role, which the identity inventory left open | §2, `status/config/main.php:27` | Resolves SHU-124 decision D-ID2 | fold into D-RP1 |

## 10. Classification of prior findings

| Source | Claim | At `c2ce255` |
|---|---|---|
| SHU-34 | `studenthub-inspector` dormant | **Refined**: the inspector *app* has no feature endpoints, but the inspector *identity* is the login for the `status` reporting app. Not dormant, differently located |
| SHU-39 | Denormalised counters drift | **Production-supported** and sharper here: revenue roll-ups are incremental with no reconciliation |
| SHU-124 D-ID2 | "Keep the inspector role?" left open pending evidence | **Evidence found**; the decision is now D-RP1 |

## 11. Bounded slices

| Slice | Scope | Depends on | Points |
|---|---|---|---|
| P1 | Operational reports: the eleven-counter morning summary and recruiter productivity, as scheduled digests with grant-scoped delivery | all feature clusters (they own the sources) | 5 |
| P2 | Statistics read models: hired and retained, invitations, transfers, revenue, year report, hit map, attribution — computed from source, grant-scoped | P1 | 5 |
| P3 | Revenue roll-ups: derived or idempotent with a reconciliation report against transfers | finance F2 | 3 |
| P4 | One audited, time-bounded export service replacing seven ad-hoc paths | SHU-59, profile S4 | 3 |

Cluster total: **16 points**, or 16 plus a rebuilt dashboard if D-RP1 keeps one.

**Running total across all sized clusters: profile 40, organizations 46, work 31, recruit 36, finance 26, communication 26, identity 30, reporting 16 — 251 points.** Platform and operations (SHU-139) and live front ends (SHU-138) remain.

## 12. Decisions for Khalid

| ID | Decision | Recommended default | Cost of waiting |
|---|---|---|---|
| D-RP1 | Does the separate reporting dashboard (the `status` app, and the inspector role that logs into it) survive the migration? | **Delete it.** Rebuild reporting inside the one grant-aware app, where an inspector becomes a read-only grant rather than a separate credential store and a separate application. That removes 46 endpoints, one identity table, and the RP-F1 risk permanently | Blocks nothing today, but SHU-141 may force the question this week. If the app is live and exposed, the decision becomes urgent |
| D-RP2 | Who receives the morning summary, and does it stay an email or become an in-product queue? | Keep the email, add an in-product view; the eleven counters are a work queue, not a report | Blocks P1 |

## 13. Not established

- Whether `status.studenthub.co` resolves and serves (SHU-141).
- Whether the revenue roll-ups have already drifted — needs the database and belongs in SHU-97.
- Who currently receives the morning summary and the recruiter report.
- Whether any inspector account is active (identity inventory §12 also lists this).
