# Production parity inventory: discover work, apply and recruit

**Card:** SHU-127 (parent SHU-88). Feeds SHU-96 (recruit contract), SHU-97 (data map).
**Production source:** `BAWES-Universe/studenthub` at `c2ce255`. Every `path:line` is at that revision; permalink base `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Method:** read-only static inspection. No database or live-host access. No personal data.
**Coverage:** 174 of 1,184 production endpoints (`docs/parity/coverage.md`, cluster RC) — second largest after organizations.

## 1. What this cluster is

How a company's need for staff becomes a student standing in a store. Production runs **two parallel pipelines** that share models but almost no journey:

**The staffing pipeline (dominant).** A company raises a `request`; a staff recruiter opens a `story` against it; the recruiter searches candidates, sends `suggestion`s to the company or `invitation`s to candidates; the company accepts; the candidate is assigned. This is a **brokered, staff-driven** flow. Most endpoints in this cluster serve it.

**The self-service job board (secondary).** Staff publish `job` rows against a request; candidates browse and apply, creating a `request_application`; interviews may follow. This is the marketplace-shaped flow, and it is the smaller of the two.

There is also a **full-timer** track: a separate `fulltimer` entity (a permanent-placement candidate, not a student) with its own skills, experience, tags and Algolia index, flowing through the same requests, suggestions and interviews.

For the platform this matters because the two pipelines produce different products. The staffing pipeline is an internal recruiting console; the job board is a candidate-facing marketplace. Decision D-RC1 asks which the platform must reproduce.

## 2. Data model

| Table | Role in the pipeline | Statuses |
|---|---|---|
| `request` | the company's need: position type and title, job description, compensation, number of employees, location, follow-up interval, and a full set of workflow timestamps (`request_started_at`, `_assigned_at`, `_finished_at`, `_re_worked_at`, `_delivered_at`) | `pending`, `started`, `delivered`, `cancelled`, `finished_by_recruitment`, `re_work` (**string** statuses, `common/models/Request.php:57-62`) |
| `story` | the recruiter's unit of work against a request, with `number_of_employees`, `story_time_spent`, `is_old` | 0 unstarted, 1 started, 2 finished, 3 delivered, 4 rejected, 5 accepted, 6 cancelled, 7 rework (`Story.php:29-37`) |
| `suggestion` | recruiter proposes a candidate or full-timer to the company, with an attached note | `suggestion_status` |
| `invitation` | candidate is invited to a request, with seen-tracking (`invitation_app_seen_at`, `_email_seen_at`, `_seen_in`, `_seen_via`) and separate created-by columns for staff and company | 1 invited, 2 rejected, 3 accepted (`Invitation.php:42-44`) |
| `job` | published listing: position, description, hours per day, days per week, compensation type and amount, area, **`min_age`, `max_age`, `gender`**, availability window | 10 draft (default), 1 active, 2 closed (`Job.php:51-53`) |
| `job_skills`, `request_skill` | skill tags | |
| `request_application` | a candidate's application to a request | 0 applied, 1 interview scheduled, 2 accepted, 3 rejected (`RequestApplication.php:27-30`) |
| `request_interview` | scheduled interview with internal and shared notes | 0 requested, 1 scheduled, 2 rejected, 3 cancelled (`RequestInterview.php:37-40`) |
| `interview_evaluation` + notes + note versions | staff evaluation of a candidate, versioned | |
| `exam`, `exam_question`, `exam_question_choice`, `exam_question_answer` | assessments tied to certificates | |
| `request_checklist` | configurable required steps per request, with Arabic names | |
| `request_activity` | activity feed on a request | |
| `fulltimer` + `fulltimer_skill`, `_experience`, `_tags` | permanent-placement candidate: nationality, university, employment status, driving licence, current and expected salary, CV PDF | |
| `story_activity` | activity feed on a story | |

Six status vocabularies across seven tables, one of them string-valued, none of them sharing a scheme. Any platform version needs one state-machine convention.

## 3. Journeys

### 3.1 Company raises and tracks a request

`company/modules/v1/controllers/RequestController.php` (12 actions): create (sets `request_status = pending`, `:235`), list filtered by status, view, update, and a delivered transition (`:397`). `RequestActivityController` (2) shows the feed. `RequestCandidateInvitationController` (5) lets the company invite candidates directly.

### 3.2 Staff recruiting console

`staff/.../RequestController.php` is the largest controller in the cluster (19 actions): assignment to a recruiter, status transitions to pending (`:477`), delivered (`:669`), cancelled (`:752`), and a generic status setter that takes the value straight from the request body (`:808`). `StoryController` (9) assigns stories, lists active and old stories, creates them and changes their status. `SuggestionController` (9) creates suggestions, reschedules the CV email, mails suggestions in bulk, accepts, rejects and deletes.

The recruiter's search is Algolia: `staff/.../AlgoliaController.php` `actionKey` mints a **secured API key** scoped to the candidate and full-timer indexes, filtered by currency (`:63-73`). The employer gets an equivalent key for the candidate index only (`company/.../AlgoliaController.php:29-46`), where a filter line restricting to unassigned candidates is commented out (`:31`). So an employer's search key covers every indexed candidate, and the index carries the profile fields listed in the profile inventory.

### 3.3 Candidate discovery and application

`candidate/.../JobController.php` (4 actions). `actionList` queries `job` joined with skills and area, filtered to `Job::STATUS_ACTIVE`. **The eligibility filter is commented out** (`:25-31`): availability window, `min_age`, `max_age` and `gender` are all inert, so every active job is shown to every candidate regardless of the criteria the job was published with. Finding RC-F1.

`candidate/.../RequestController.php` `actionApply($id)` (`:177`) creates a `request_application` from the caller's id and the request id, then tracks a Segment event in production. No duplicate-application check, no eligibility check, no verification that the request is open. Finding RC-F2.

`InvitationController` on the candidate side (7 actions) handles invitations with seen-tracking; the company side has 8, staff 7, admin 2.

### 3.4 Interviews and evaluations

`staff/.../InterviewEvaluationController.php` (9) with versioned notes; `CandidateEvaluationController` in staff (6) and admin (11). `RequestInterview` carries both an `internal_note` and an `interview_note`, which suggests one is candidate-visible and one is not — worth confirming before porting, since getting that boundary wrong exposes internal assessments.

### 3.5 Notifications

`cron/every-minute` (scheduled, `cron/cronlist`) calls `Suggestion::suggestionCandidateNotification()` and `suggestionFulltimerNotification()`. A per-minute job driving candidate-facing notifications is the highest-frequency scheduled work in the system.

## 4. Parity rows

| ID | Journey | Actor / grant | Legacy routes | Tests | Disposition | Slice |
|---|---|---|---|---|---|---|
| RC-01 | Raise a staffing request | org member | company `RequestController` create | `company RequestCest` 9 (0 JSON) | REQUIRED | R1 |
| RC-02 | Track my requests and their activity | org member | company request list, view, `RequestActivity` | `company RequestActivityCest` 3 (0 JSON) | REQUIRED | R1 |
| RC-03 | Assign a request to a recruiter, work it, deliver it | staff | staff `RequestController` (19), `StoryController` (9) | `staff RequestCest` 15 (3 JSON), `StoryCest` 8 (0 JSON) | REQUIRED, **ADAPT: one state machine** | R2 |
| RC-04 | Search candidates | staff, org member | Algolia secured keys | none | REQUIRED, **ADAPT: server-side scoped search, not a client key over the whole index** | R3 |
| RC-05 | Suggest a candidate to the company | staff | staff `SuggestionController` (9), company (4), admin (3) | `staff SuggestionCest` 8 (1 JSON), `company` 6 (0) | REQUIRED | R4 |
| RC-06 | Accept or reject a suggestion | org member | company suggestion actions | in the above | REQUIRED | R4 |
| RC-07 | Invite a candidate to a request | staff, org member | `InvitationController` in four apps, `RequestCandidateInvitation` | `candidate InvitationCest` 8 (0), `company` 4 (1), `staff` 5 (1) | REQUIRED | R4 |
| RC-08 | Candidate accepts or rejects an invitation, with seen-tracking | candidate, self | candidate `InvitationController` (7) | in the above | REQUIRED | R4 |
| RC-09 | Publish a job listing | staff | staff `JobController` (10) | none | REQUIRED if D-RC1 keeps the job board | R5 |
| RC-10 | Browse jobs | candidate, self | candidate `JobController` list, view | none | REQUIRED if D-RC1, **ADAPT: eligibility must actually filter (RC-F1)** | R5 |
| RC-11 | Apply to a request | candidate, self | candidate `RequestController` `Apply` | none | REQUIRED if D-RC1, **ADAPT: duplicate and open-state guards (RC-F2)** | R5 |
| RC-12 | See my applications and interview requests | candidate, self | candidate `Applications`, `InterviewRequests` | none | REQUIRED | R5 |
| RC-13 | Schedule and run an interview | staff, org member | `RequestInterview` through staff and company controllers | none | REQUIRED | R6 |
| RC-14 | Evaluate a candidate, versioned notes | staff | `InterviewEvaluationController` (9), `CandidateEvaluation` staff (6) admin (11) | none | REQUIRED, **with an explicit internal vs shared boundary** | R6 |
| RC-15 | Request checklist configuration | admin | `RequestChecklistController` (6) | `admin RequestChecklistCest` 8 (5 JSON) | REQUIRED | R2 |
| RC-16 | Full-timer placement track | staff, admin | `FulltimerController` staff (6) admin (4) plus the shared request flow | `staff FulltimerCest` 7 (2 JSON) | **EXCLUDE-PENDING-OWNER** (D-RC2) | — |
| RC-17 | Exams and certification | staff | `Exam*` models, `CertificateController` | none | OTHER-CLUSTER (profile S8 owns certificates); exam authoring is EXCLUDE-PENDING-OWNER (D-RC3) | — |
| RC-18 | Suggestion notifications | system | `cron/every-minute` | none | REQUIRED, ADAPT to event-driven | R4 |
| RC-19 | Bulk suggestion mail, CV email reschedule | staff | `MailSuggestions`, `RescheduleCvEmail` | none | OTHER-CLUSTER (communication SHU-129) | — |
| RC-20 | Company sign-up request review | staff | `CompanyRequestController` (5) | none | OTHER-CLUSTER (organizations OR-12) | — |

## 5. Tests and fixtures

| Suite | Methods (JSON asserts) | Journeys |
|---|---|---|
| `staff/RequestCest.php` | 15 (3) | RC-03 |
| `company/RequestCest.php` | 9 (0) | RC-01, RC-02 |
| `staff/StoryCest.php` | 8 (0) | RC-03 |
| `staff/SuggestionCest.php` | 8 (1) | RC-05 |
| `company/SuggestionCest.php` | 6 (0) | RC-06 |
| `candidate/InvitationCest.php` | 8 (0) | RC-08 |
| `company/InvitationCest.php` | 4 (1), `staff` 5 (1) | RC-07 |
| `admin/RequestChecklistCest.php` | 8 (5) | RC-15 |
| `staff/FulltimerCest.php` | 7 (2) | RC-16 |
| `company/RequestActivityCest.php` 3 (0), `staff` 3 (0) | | RC-02 |
| Fixtures | `RequestFixture`, `StoryFixture`, `StoryActivityFixture`, `SuggestionFixture`, `InvitationFixture`, `RequestChecklistFixture`, `FulltimerFixture` + skills, experience, tags, `ContactInvitationFixture` | reusable |

**Untested behaviour, explicitly:** the entire job board (publish, browse, apply — RC-09 to RC-11, which is the candidate-facing half of the cluster); interviews and evaluations (RC-13, RC-14); Algolia key minting and its scope (RC-04); the per-minute suggestion notification job (RC-18); bulk suggestion mail; request status transitions beyond what the route-level tests touch — 12 of the 15 test suites assert HTTP 200 with no JSON assertion at all.

## 6. Findings

| ID | Finding | Evidence | Severity | Action |
|---|---|---|---|---|
| **RC-F1** | Job eligibility filtering is commented out: availability window, `min_age`, `max_age` and `gender` are stored on every job and never applied, so all active jobs are shown to all candidates | `candidate/modules/v1/controllers/JobController.php:25-31` | Medium (the published criteria are misleading) | R5, and D-RC4 |
| **RC-F2** | Applying has no duplicate check, no eligibility check and no verification that the request is still open | `candidate/modules/v1/controllers/RequestController.php:177` | Medium | R5 |
| **RC-F3** | The employer's Algolia key covers the whole candidate index; the filter that would restrict it to unassigned candidates is commented out | `company/modules/v1/controllers/AlgoliaController.php:29-46` | Medium (bulk profile exposure to any employer with a login) | R3 |
| **RC-F4** | Request status is set from the request body with no transition check | `staff/modules/v1/controllers/RequestController.php:808` | Medium | R2 |
| **RC-F5** | Six status vocabularies across seven tables, one string-valued, none consistent | §2 | Design | R1: one convention |
| **RC-F6** | `request_interview` carries both `internal_note` and `interview_note` with no evidence of which is candidate-visible | `common/models/RequestInterview.php` | Needs verification before porting | R6, verifier spot-check |
| **RC-F7** | Jobs carry a `gender` criterion | `common/models/Job.php` | Decision, legal and policy | D-RC4 |
| **RC-F8** | A per-minute cron drives candidate notifications | `cron/every-minute`, `cron/cronlist` | Low (scalability) | R4: event-driven |
| **RC-F9** | 12 of 15 test suites in this cluster assert only HTTP 200 | §5 | Confidence | specify test-first |

## 7. Classification of prior findings

| Source | Claim | At `c2ce255` |
|---|---|---|
| SHU-34 | Request and suggestion flow is the core recruiting behaviour | **Production-supported**, and it is staff-driven brokerage, not a marketplace |
| SHU-39 | Algolia receives candidate PII | **Production-supported**; this inventory adds that employer-scoped keys reach the whole index |
| SHU-51 | Marketplace expansion is an open decision | **Directly relevant**: the job board already exists but its eligibility filtering is inert. D-RC1 |

## 8. Bounded slices for SHU-96

| Slice | Scope | Depends on | Points |
|---|---|---|---|
| R1 | Request model and one status convention; company raises, tracks, sees activity | SHU-91, organizations O1 | 5 |
| R2 | Recruiting console: assignment, story workflow, transitions as a real state machine, checklists | R1 | 8 |
| R3 | Candidate search: server-side, grant-scoped, no client-held index key | R1, profile S1 | 5 |
| R4 | Suggestions and invitations, with event-driven notifications and seen-tracking | R1, R3 | 5 |
| R5 | Job board: publish, browse with eligibility actually applied, apply with guards, my applications | R1, D-RC1 | 8 |
| R6 | Interviews and evaluations, with an explicit internal-versus-shared note boundary | R4 | 5 |

Cluster total: **36 points** (28 if D-RC1 drops the job board), against the 8-point placeholder. Running total: profile 40, organizations 46, work 31, recruit 36.

## 9. Decisions for Khalid

| ID | Decision | Recommended default | Cost of waiting |
|---|---|---|---|
| D-RC1 | Production runs both a staff-brokered pipeline and a self-service job board. Does the platform reproduce both, or is StudentHub a brokerage with the job board retired? | Keep both, but sequence brokerage first: it carries the volume today and the job board's eligibility rules do not currently work anyway | Blocks R5 only. It is 8 of the cluster's 36 points, so deciding late is cheap |
| D-RC2 | Keep the full-timer permanent-placement track (RC-16)? It is a separate entity with its own index and a shared request flow | Keep, but as a second candidate type on the same request pipeline rather than parallel models | Blocks nothing now; parallel models are expensive to unwind later |
| D-RC3 | Keep exam authoring and certification (RC-17)? | Keep certificates, drop exam authoring until someone asks for it | Blocks nothing |
| D-RC4 | Jobs carry `min_age`, `max_age` and `gender` criteria that production stores but does not apply (RC-F1, RC-F7). Which of these may filter who sees a job? | Age only where the law requires it; no gender filtering. Make whatever survives actually apply, and show candidates why they are ineligible | Blocks R5. This is a policy question, not a technical one, and it should be answered before the filter is re-enabled rather than after |

## 10. Not established

- Which pipeline carries the volume: requests versus job applications, per month. This sizes D-RC1 and needs the database.
- Whether the commented-out eligibility filter was disabled deliberately (a policy decision) or broke and was patched out.
- Whether `internal_note` is genuinely hidden from candidates in the front ends (SHU-138).
- The full-timer track's live usage.
