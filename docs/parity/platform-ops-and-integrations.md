# Production parity inventory: platform config, operations and integrations

**Card:** SHU-139 (parent SHU-88). **Production authority:** `BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63`. **Target comparison:** `BAWES-Universe/studenthub-platform@e825ff5aa9f28bade60079ac039ad8d9aeb15d83` (current main when this inventory was re-verified on 2026-09-15).

**Method and safety boundary:** read-only static inspection of the two revisions above, the reviewed coverage ledger at `84ab149`, and SHU-139/197/198/199. No database, provider console, credential store, live host, production request or deployment was accessed. This document names configuration fields and environment-variable identifiers only. It contains no credential value, provider URL, recipient address, queue identifier, tenant identifier, bucket identifier or live endpoint.

## 1. Count model and evidentiary vocabulary

SHU-139 asks for **67 inventory records**. That number is the sum of two required views:

- **29 OPS-assigned functional actions** in `84ab149:docs/parity/coverage-actions.json`; and
- **38 functional console commands** at the pinned production revision.

Six console commands occur in both views (`cron/index`, `cron/every-5-minute`, the three `cron/segment-*` commands, and `event/emulate`). The result is **67 records but 61 unique callable actions**. Treating 67 as a unique-endpoint count would double-count those six. The ledger independently reports 1,016 functional actions, 171 `actions()` hooks and 195 controllers; the OPS assignment is 29/1,016. The original PR branch did not contain the cited ledger, so the evidence is now identified by its exact reviewed commit instead of by a nonexistent branch-local path.

The status terms below are deliberately narrower than “live”:

- **SOURCE-ACTIVE** — executable code is wired by the named production config.
- **REPO-SCHEDULED** — an uncommented entry exists in `cron/cronlist`; this does not prove the daemon ran it.
- **CODE-ONLY** — callable code exists but no repository schedule or routed production use was found.
- **ENV-GATED** — source behavior depends on an environment variable or database setting whose live value was not inspected.
- **DISABLED-IN-PROD-CONFIG** — the integration block is commented in both checked-in production variants.
- **LIVE-UNKNOWN** — static source cannot establish current host, provider, database-row or credential state.

## 2. Configuration and deployment plumbing

| Surface | Production evidence | What is actually established | Cutover disposition / owner |
|---|---|---|---|
| Common component registry | `common/config/main.php:7-131` | S3 temporary upload, Textract, Maps, reCAPTCHA, SMS, Jira, Algolia, Ipstack, Cloudinary, Slack, Auth0, runtime DB settings and balance tooling are constructed for every environment unless overridden. Several credential fields are committed directly; values are intentionally omitted here. | Replace free-form and committed configuration with the typed startup schema and register — **SHU-197/X1**. Rotate/revoke committed material before legacy retirement — **SHU-134 + SHU-122**. |
| Database-backed runtime settings | `common/components/Config.php:21-79`; `common/models/Setting.php:95-166` | Settings load from `setting` into an indefinitely cached map. Lookup falls back to static params. No schema constrains the available keys. | Typed, closed configuration — **SHU-197/X1**. |
| Admin settings API | `admin/modules/v1/controllers/SettingController.php:16-49,67-155` | Bearer authentication is restored after CORS. `list` returns every row. `update` recognizes exactly ten Mixpanel/Segment keys; other submitted keys are ignored. There is no fine-grained permission check in the controller. | Replace, do not reproduce the generic table/API — **SHU-197/X1**; grants from identity catalogue. |
| Classic production config | `environments/prod/common/config/main-local.php:4-205` | Defines database, cache, mail, EventManager, Xero, MediaConvert, S3, Yeastar and a configured Sentry target. Static source does not prove this variant is deployed now. | Retire only after replacement and recovery sign-off — **SHU-122**. |
| Railway production config | `environments/prod-railway/common/config/main-local.php:2-212` | Same broad component set, with environment-gated mail/Sentry and mixed credential sourcing. Static source does not prove current live values. | Replacement register — **SHU-197/X1**; runtime observability — **SHU-198/X2**. |
| Environment materialization | `environments/index.php:347-415` | `Production-Nginx` and `Production-Railway` copy different environment directories into the application. Both make eight app trees writable and set cookie keys. | One typed deployment contract — **SHU-197/X1**; legacy retirement — **SHU-122**. |
| HTTP host routing | `nginx/production.conf:1-58`; `nginx/railway-prod.conf:1-75` | Both combined-server configs route admin, candidate, company, inspector, staff and verification trees. Neither routes manager or status. Railway adds a second verification hostname. Separate deployment outside these files remains LIVE-UNKNOWN. | One target gateway; do not infer manager/status liveness — **SHU-141 + SHU-122**. |
| Classic production image | `Dockerfile-nginx-prod:56-100` | Copies and installs the crontab, but starts cron only in a build layer; the runtime command does not start it. | Replace scheduler plumbing — **SHU-198/X2**. |
| Railway production image | `Dockerfile-nginx-railway:59-107` | Copies the same crontab and starts cron in the runtime command after init, migrations and deployment scripts. | Replace scheduler plumbing — **SHU-198/X2**. |
| Crontab command path | `cron/cronlist:1-37`; Docker workdirs above | Every entry invokes `~/www/yii`, while both images place the app at `/var/www/html`. No image creates the referenced `~/www` path. External scheduler overrides are LIVE-UNKNOWN. | Fail-closed startup/schedule validation — **SHU-197/X1 + SHU-198/X2**. |
| Schedule timezone | `common/config/main.php:4`; `cron/cronlist:1-37` | Yii uses `Asia/Kuwait`, but the crontab/image does not set the daemon timezone. Application date semantics do not establish cron trigger timezone. | Declare and test schedule timezone — **SHU-198/X2**. |
| CircleCI/ECR/ECS file | `.circleci/config-ecr.yml:232-304` | Contains template placeholders and unrelated example migration commands; it is not evidence of an active deployment path. | DISCARD as deployment authority unless an operator proves use — **SHU-122**. |

No checked-in artifact identifies which production variant or external scheduler is live. That question needs operator evidence; it is not answered by repository presence.

## 3. The 29 OPS-assigned actions

Each row below is one ledger record. “Public” means the controller removes the inherited authenticator and does not restore it; it does not claim that a host is reachable.

| # | Action | Source and authorization | Production behavior | Disposition / precise owner |
|---:|---|---|---|---|
| 1 | admin `Aws::Config` | `admin/modules/v1/controllers/AwsController.php:15,56`; public | Returns long-lived upload material and bucket configuration. Admin is routed by both combined production configs. | Endpoint DROP; server-scoped object authorization. Legacy exposure/retirement **SHU-134**; domain upload capability **SHU-101/SHU-145**. |
| 2 | candidate `Aws::Config` | `candidate/modules/v1/controllers/AwsController.php:15,34-42,64`; public because the restoration block is commented | Same shape; candidate is routed by both configs and the clients consume it. | REPLACE with personal-document flow — **SHU-145/S4**; retire/rotate — **SHU-134**. |
| 3 | company `Aws::Config` | `company/modules/v1/controllers/AwsController.php:15,56`; public | Same shape; company is routed by both configs. | REPLACE only through org-owned upload capabilities — **SHU-125**; retire/rotate — **SHU-134**. |
| 4 | staff `Aws::Config` | `staff/modules/v1/controllers/AwsController.php:15,56`; public | Same shape; staff is routed by both configs. | Endpoint DROP; server-scoped domain uploads only — **SHU-134 + SHU-213**. |
| 5 | inspector `Aws::Config` | `inspector/modules/v1/controllers/AwsController.php:15,56`; public | Same shape; inspector is routed by both configs. | Endpoint DROP — **SHU-134 + SHU-213**. |
| 6 | manager `Aws::Config` | `manager/modules/v1/controllers/AwsController.php:15,56`; public | Same shape; manager is absent from the combined production Nginx maps, so live reachability is unknown. | Endpoint DROP — **SHU-134 + SHU-213**. |
| 7 | status `Aws::Config` | `status/modules/v1/controllers/AwsController.php:15,56`; public | Same shape; status is absent from the combined production Nginx maps, so live reachability is owned by SHU-141. | Endpoint DROP — **SHU-134 + SHU-141 + SHU-213**. |
| 8 | admin `CronLog::List` | `admin/modules/v1/controllers/CronLogController.php:11-43,64-68`; bearer | Returns all task rows ordered by `last_ran_at`; no permission gate in this controller. | REPLACE with grant-scoped job visibility — **SHU-198/X2**. |
| 9 | staff `CronLog::List` | `staff/modules/v1/controllers/CronLogController.php:11-43,64-68`; bearer | Same unfiltered operational rows. | REPLACE — **SHU-198/X2**. |
| 10 | admin `Event::ImportExcel` | `admin/modules/v1/controllers/EventController.php:18-52,74-205`; bearer, production-only branch | Reads a temporary-bucket workbook and emits caller-named analytics events except a deny-list. This is an event replay/import tool, not an unexplained generic import. | **EXCLUDE-PENDING-OWNER D-OP2**; if a bounded migration replay is approved, it belongs behind **SHU-199/X3**. Decision record **SHU-213**. |
| 11 | admin `Ping::Test` | `admin/modules/v1/controllers/PingController.php:15,56`; public | Health response; host routed. | Capability already exists at target `/health`; retire legacy route — deploy package + **SHU-122**. |
| 12 | candidate `Ping::Test` | `candidate/modules/v1/controllers/PingController.php:15,56`; public | Same; host routed. | Same as #11. |
| 13 | company `Ping::Test` | `company/modules/v1/controllers/PingController.php:15,56`; public | Same; host routed. | Same as #11. |
| 14 | staff `Ping::Test` | `staff/modules/v1/controllers/PingController.php:15,56`; public | Same; host routed. | Same as #11. |
| 15 | manager `Ping::Test` | `manager/modules/v1/controllers/PingController.php:15,56`; public | Same; manager host not established. | Same as #11; liveness not inferred. |
| 16 | inspector `Ping::Test` | `inspector/modules/v1/controllers/PingController.php:15,56`; public | Same; host routed. | Same as #11. |
| 17 | admin `Setting::List` | `admin/modules/v1/controllers/SettingController.php:16-49,67-69`; bearer | Returns values as stored, including configuration rows that may be sensitive. | Generic read DROP; typed redacted admin projection only — **SHU-197/X1**. |
| 18 | admin `Setting::Update` | same file `:76-155`; bearer | Writes ten analytics keys; no schema or dedicated grant. | REPLACE — **SHU-197/X1**; analytics decision **D-OP1**. |
| 19 | candidate `GoogleMap::PlacePredictions` | `candidate/modules/v1/controllers/GoogleMapController.php:11-44,69`; bearer | Server calls Maps using server configuration. | KEEP capability behind one allow-listed server adapter — **SHU-199/X3**. |
| 20 | candidate `GoogleMap::PlaceDetail` | same file `:80`; bearer | Server-side place detail. | **SHU-199/X3**. |
| 21 | staff `GoogleMap::PlacePredictions` | `staff/modules/v1/controllers/GoogleMapController.php:11-45,70`; bearer | Same capability for staff. | **SHU-199/X3** with grants. |
| 22 | staff `GoogleMap::PlaceDetail` | same file `:81`; bearer | Same. | **SHU-199/X3**. |
| 23 | staff `GoogleMap::AreaByLocation` | same file `:92`; bearer | Reverse lookup into StudentHub area data. | **SHU-199/X3 + SHU-125**. |
| 24 | console `Cron::Index` | `console/controllers/CronController.php:40-90`; local command | Executable body is comments only. | DISCARD — **SHU-213/SHU-122**. |
| 25 | console `Cron::Every5Minute` | same file `:330-333`; local command | Updates only `last_ran_at`; no repository schedule. | DISCARD as work; X2 tests must prove it is not a health signal — **SHU-198/X2**. |
| 26 | console `Cron::SegmentTransfer` | same file `:797-848`; local command | Historical analytics replay containing finance/person fields; no repository schedule. | DISCARD after any explicitly approved migration replay — **SHU-199/X3 + SHU-213**. |
| 27 | console `Cron::SegmentSuggestion` | same file `:853-904`; local command | Historical analytics replay containing person/staff fields; no repository schedule. | Same as #26. |
| 28 | console `Cron::SegmentExpense` | same file `:909-949`; local command | Historical analytics replay containing expense detail; no repository schedule. | Same as #26. |
| 29 | console `Event::Emulate` | `console/controllers/EventController.php:284-309`; local command | Re-emits six historical event families; no repository schedule. | Same as #26. |

The AWS result is stronger than the original inventory: **all seven controllers are unauthenticated at code level**, not “authenticated except possibly status.” Five app trees are routed by the two combined production Nginx variants; manager/status reachability remains unproved without live access.

## 4. All 38 console commands and scheduled behavior

The schedule column is derived only from `cron/cronlist`. “None” means callable but not scheduled by that file. Active lines redirect output to `/dev/null` except the five month-day commands; none uses `flock`, a database lease, a run identifier or a timeout.

| # | Command and source | Repository schedule | Observable completion | Required implementation or exclusion owner |
|---:|---|---|---|---|
| 1 | `algolia/index` — `console/controllers/AlgoliaController.php:19` | Daily 02:00 with candidate/expiry arguments (`cron/cronlist:10`) | No `CronLog`; stdout discarded | Replace Algolia indexing with the target Typesense/index lifecycle — **SHU-127/R3**; expiry semantics also **SHU-145**. |
| 2 | `central-db/index` — `CentralDbController.php:20` | None | None | One-off legacy identity copy; DISCARD after migration reconciliation — **SHU-124/I8 + SHU-122**. |
| 3 | `central-db/staff` — same file `:58` | None | None | Same owner/disposition as #2. |
| 4 | `central-db/agent` — same file `:95` | None | None | Same owner/disposition as #2. |
| 5 | `central-db/provider` — same file `:132` | None | None | Same owner/disposition as #2. |
| 6 | `cron/index` — `CronController.php:40` | None | No-op | DISCARD — **SHU-213/SHU-122**. |
| 7 | `cron/fill-civil-id-expiry-date` — same file `:96` | None | Timestamp after work | Replace with private-document/OCR lifecycle — **SHU-145/S4**; job instrumentation **SHU-198/X2**. |
| 8 | `cron/fill-civil-id-expiry-date-not-assigned` — `:116` | None | Timestamp after work | Same as #7. |
| 9 | `cron/validate-civil-id` — `:137` | None | Timestamp after work | Same as #7. |
| 10 | `cron/check-if-candidate-total-mismatch` — `:200` | None | Timestamp after work | Transfer reconciliation/invariant owner — **SHU-184/F3**; job instrumentation **SHU-198/X2**. |
| 11 | `cron/daily` — `:225` | Daily 13:30 (`cron/cronlist:22`) | Timestamp after a mixed workflow | Split: paid-line event **SHU-183/F2→SHU-189/C4**; token expiry **SHU-124**; civil expiry **SHU-145**; hit map **SHU-194/P2**. X2 owns the schedule/lease, not those domain effects. |
| 12 | `cron/gen-hit-map` — `:287` | Day 28 at 13:30 (`cron/cronlist:37`) | Timestamp after work | Derived reporting model — **SHU-194/P2**; schedule — **SHU-198/X2**. |
| 13 | `cron/every-minute` — `:316` | Every minute (`cron/cronlist:2`) | Timestamp after two notification scans; stdout discarded | Recruitment events **SHU-127**; delivery **SHU-188/C3 + SHU-189/C4**; lease/observability **SHU-198/X2**. |
| 14 | `cron/every-5-minute` — `:330` | None | Timestamp only | DISCARD — **SHU-198/X2** records exclusion. |
| 15 | `cron/process-transfer-files` — `:338` | Every minute (`cron/cronlist:3`) | Timestamp after batch; stdout discarded | Bank-file lease/reconciliation — **SHU-184/F3**; schedule — **SHU-198/X2**. |
| 16 | `cron/process-campaign` — `:364` | Every minute (`cron/cronlist:4`); second daily entry commented at `:7` | Timestamp after batch; stdout discarded | Leased campaign delivery/log — **SHU-189/C4**; schedule — **SHU-198/X2**. |
| 17 | `cron/weekly` — `:386` | Saturday 00:00 (`cron/cronlist:28`) | Timestamp is after a `return` inside the first company loop, so it is skipped whenever work returns early | Exact transfer generation — **SHU-183/F2**; schedule/failed completion evidence — **SHU-198/X2**. |
| 18 | `cron/mid-month` — `:457` | Day 15 at 13:30 (`cron/cronlist:31`) | Timestamp after notifications | Bank/civil reminders — **SHU-145 + SHU-189/C4**; schedule — **SHU-198/X2**. |
| 19 | `cron/end-of-month` — `:471` | Day 28 at 13:30 (`cron/cronlist:36`) | Timestamp after attendance and reminders | Attendance **SHU-126**; civil/bank reminders **SHU-145 + SHU-189/C4**; schedule **SHU-198/X2**. |
| 20 | `cron/remove-duplicate` — `:489` | None | None | One-off destructive repair; do not port as a standing job. Migration disposition — **SHU-123 + SHU-213**. |
| 21 | `cron/summary` — `:513` | Daily 05:00 (`cron/cronlist:19`; comment says 08:00) | Mail intent plus timestamp; stdout discarded | Eleven-counter digest — **SHU-193/P1**; delivery **SHU-189/C4**; schedule **SHU-198/X2**. |
| 22 | `cron/payable-candidate-notification` — `:621` | Daily 05:00 (`cron/cronlist:13`) | Mail intent plus timestamp; stdout discarded | Finance event **SHU-184/F3**; delivery **SHU-189/C4**; private export **SHU-196/P4**; schedule **SHU-198/X2**. |
| 23 | `cron/kuwait-mom-check` — `:783` | None | Timestamp after mail call | Marketing use EXCLUDE-PENDING-OWNER — **SHU-189/C4 + SHU-213**. |
| 24 | `cron/segment-transfer` — `:797` | None | No run record | Analytics migration replay only — **SHU-199/X3 + SHU-213**. |
| 25 | `cron/segment-suggestion` — `:853` | None | No run record | Same as #24. |
| 26 | `cron/segment-expense` — `:909` | None | No run record | Same as #24. |
| 27 | `cron/check-daily-attendance` — `:977` | Repository entry commented (`cron/cronlist:16`) | Timestamp after mail batch | Required only if attendance reminder survives — **SHU-126 + SHU-189/C4**; schedule **SHU-198/X2**; decision **SHU-213**. |
| 28 | `cron/update-candidate-stats` — `:1049` | Day 15 at 13:30 (`cron/cronlist:32`) | Timestamp after work | Replace stored cumulative update with derived/idempotent read model — **SHU-195/P3**; schedule **SHU-198/X2**. |
| 29 | `cron/update-company-stats` — `:1109` | Day 15 at 13:30 (`cron/cronlist:33`) | Timestamp after work | Same as #28. |
| 30 | `cron/fix-work-logs` — `:1165` | None | None | One-off repair; migration-only or DISCARD — **SHU-126 + SHU-213**. |
| 31 | `cron/fix-work-log-dates` — `:1188` | None | None | Same as #30. |
| 32 | `cron/fix-education` — `:1255` | None | None | One-off repair; migration-only or DISCARD — **SHU-123 + SHU-213**. |
| 33 | `event/emulate` — `console/controllers/EventController.php:284` | None | No run record | Analytics replay only — **SHU-199/X3 + SHU-213**. |
| 34 | `report/recruiter` — `console/controllers/ReportController.php:16` | Sunday–Thursday 17:00 (`cron/cronlist:25`; comment says 20:00) | Timestamp after sending staff data to analytics and Slack; stdout discarded | Grant-scoped digest — **SHU-193/P1**; delivery **SHU-189/C4**; analytics minimisation **SHU-199/X3**; schedule **SHU-198/X2**. |
| 35 | `resource/s3-to-cloudinary` — `ResourceController.php:18` | None | No run record; deletes the source object after migration | Destructive one-off; do not port. R2 migration/recovery owner **SHU-145 + SHU-122**; explicit approval **SHU-213**. |
| 36 | `xero/test` — `XeroController.php:12` | None | Prints a credential-bearing token object to console | DISCARD immediately as a cutover journey; Xero business disposition remains **SHU-128/finance + D-OP1**. |
| 37 | `xero/sync-transactions` — `XeroController.php:25` | None | Exception text only | DEFER with finance reconciliation; no schedule inferred — **SHU-128/SHU-185 + D-OP1**. |
| 38 | `xero/sync-after` — `XeroController.php:41` | None | Exception text only | Same as #37. |

### 4.1 Job observability and overlap result

`common/models/CronLog.php:8-48` has only `task`, `last_ran_at` and `last_output`. Nineteen `CronController` commands and `report/recruiter` write only `last_ran_at`; no write to `last_output` was found at the pinned revision. Updates occur after work, except paths that return or fail first. There is no start row, success/failure state, duration, attempt identity, heartbeat, lease, overlap refusal, timeout, retry count or missed-run detector.

The three every-minute jobs can overlap with their own prior run and with each other. `process-transfer-files` preselects pending rows before per-row processing (`CronController.php:338-360`); the domain's partial processing flag is not a scheduler lease. `process-campaign` selects every ready campaign with no claim step (`:364-379`). `weekly` can exit before its timestamp (`:386-451`). This is the exact operational gap owned by **SHU-198/X2**, while the domain cards own business idempotency.

## 5. Mail, SMS, Sentry and alert visibility

| Channel | Production evidence | Visibility actually provided | Required owner |
|---|---|---|---|
| Mail | `common/models/MailLog.php:10-181`; admin API `MailLogController.php:16-118` | Stores from/to/subject/app/timestamps before or around some sends. It has no provider message id, acceptance, delivery, bounce, failure, retry or template/event id. The admin list interpolates the search term into SQL. `afterSave` counts intent rows, not delivery, and contains an assignment where a date comparison was intended (`:111`). | Canonical delivery log and provider outcome — **SHU-189/C4**; PII-safe alert/read model — **SHU-198/X2**. |
| SMS | `common/components/SMSComponent.php:10-40` | Synchronous provider request with embedded credential fields; no durable log, outcome normalization, retry identity or consent evidence. | **SHU-189/C4**; config/rotation **SHU-197/X1**. |
| Push | `common/models/MobileNotification.php:8-82` | OneSignal request using app/key params; no durable delivery receipt shown here. It was absent from the original integration list. | StudentHub-owned device registry/event rendering — **SHU-188/C3**; provider delivery logging **SHU-189/C4**. |
| Legacy Sentry | classic config `environments/prod/common/config/main-local.php:188-205`; Railway config `:195-212` | Classic config contains a configured target; Railway is ENV-GATED and records error/warning levels while excluding common HTTP errors. Static source proves configuration, not successful ingestion. | PII-safe operational alerts — **SHU-198/X2**; live enablement remains the operator gate from **SHU-90**. |
| Legacy Slack logging | `common/config/main.php:71-75,122-130`; `console/config/main.php:27-44`; `common/components/SlackLogger.php:26-67` | Common and console logs render entire messages into Slack attachments. This can carry exception or model text; no field allow-list exists. | Replace with allow-listed X2 events — **SHU-198/X2**. |
| Target observability at current main | `docs/observability.md:1-23`; `packages/observability/src/index.ts:17-27`; `local-sentry.ts:18` | PII-safe local/in-memory worker only. Ambient `SENTRY_*` variables confer no external transport authority. Therefore “platform already runs Sentry” is false if read as live external ingestion. | External Sentry enablement remains an explicit operator action — **SHU-90 + SHU-198/X2**. |

## 6. Integration register

Rotation state is intentionally evidence-based:

- **ROTATE/REVOKE** — credential material is committed or returned to clients; no safe current state can be assumed.
- **UNKNOWN-OPERATOR-CHECK** — only a name/source is known; provider validity or last rotation was not inspected.
- **DB-STATE-UNKNOWN** — enabled/key state lives in production data, which was not accessed.
- **NONE** — no secret is required for the local library/capability.

“Decision pending” is not a keep/drop decision. It is a fail-closed disposition that blocks retirement until D-OP1/SHU-213 records the owner's choice.

| ID | Integration / activation at `c2ce255` | Credential identifiers only | Rotation state | Cutover disposition / owner |
|---|---|---|---|---|
| INT-01 | Temporary AWS S3 upload — SOURCE-ACTIVE in common config; returned by seven public controllers (`common/config/main.php:8-19`; §3 #1–7) | `temporaryBucketResourceManager.key`, `.secret`; response field names for access id/secret | **ROTATE/REVOKE** | REPLACE with object-scoped server authorization; **SHU-134 + SHU-101/SHU-145**. |
| INT-02 | Primary AWS S3 storage — SOURCE-ACTIVE in both production variants (`environments/prod/.../main-local.php:152-165`; Railway `:157-172`) | `resourceManager.key`, `.secret`, role/region/bucket fields | **ROTATE/REVOKE** where committed; IAM state UNKNOWN | REPLACE with R2; target runtime exists on current main. **SHU-101/SHU-145 + SHU-122**. |
| INT-03 | AWS MediaConvert — SOURCE-ACTIVE in both variants (`prod ...:144-151`; Railway `:147-156`) | Railway access-id/secret environment names; role/job-queue fields | UNKNOWN-OPERATOR-CHECK | KEEP/ADAPT only for the approved video-intro lifecycle — **SHU-123/PD-26**; otherwise DROP via **SHU-213**. |
| INT-04 | AWS Textract OCR — SOURCE-ACTIVE in common config (`common/config/main.php:20-24`; `IdExpiryDateExtractor.php:34-79`) | `AWS_TEXTRACT_ACCESS_KEY_ID`, `AWS_TEXTRACT_SECRET_ACCESS_KEY` | UNKNOWN-OPERATOR-CHECK | KEEP/ADAPT server-side — **SHU-145/S4**. |
| INT-05 | AWS SQS event leg — code-capable but DISABLED-IN-PROD-CONFIG (`EventManager.php:338-386`; both prod configs comment the SQS fields) | `eventManager.sqsKey`, `.sqsSecret`, `.sqsQueue`, `.sqsEndpoint` | UNKNOWN; no active config established | DROP-PENDING D-OP1 unless a consumer is proven — **SHU-199/X3 + SHU-213**. |
| INT-06 | Cloudinary — SOURCE-ACTIVE component (`common/config/main.php:56-65`; `CloudinaryManager.php:28-132`) | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | UNKNOWN-OPERATOR-CHECK | DROP after R2 migration/recovery — **SHU-145 + SHU-122**. |
| INT-07 | Algolia — SOURCE-ACTIVE component and APIs; one REPO-SCHEDULED command (`common/config/main.php:45-50`; `Algolia.php`; `cron/cronlist:10`) | `algolia.appId`, `algolia.apiKey` | **ROTATE/REVOKE** | REPLACE with Typesense; adapter exists but is not a live cutover claim — **SHU-127/R3 + SHU-122**. |
| INT-08 | Auth0 — SOURCE-ACTIVE component and login routes (`Auth0.php:9-75`; auth controllers cited by SHU-124) | public client/connection identifiers; request access tokens | No server secret established here | DROP identity mechanism; Authentik is target authority — **SHU-124/I2/I8 + SHU-122**. |
| INT-09 | Google identity — login actions in admin, candidate, company, staff and manager auth controllers | client/audience identifiers; per-request identity token | UNKNOWN-OPERATOR-CHECK | DROP direct mechanism; Authentik owns target identity — **SHU-124/I2**. |
| INT-10 | Apple identity — candidate login action (`candidate/.../AuthController.php:1048`) | client/audience identifiers; per-request identity token | UNKNOWN-OPERATOR-CHECK | DROP direct mechanism — **SHU-124/I2**. |
| INT-11 | reCAPTCHA — SOURCE-ACTIVE (`common/config/main.php:29-32`; `ReCaptcha.php:15-47`) | `reCaptcha.secretKey` | **ROTATE/REVOKE** | KEEP/REPLACE-PENDING identity-abuse design — **SHU-124 + SHU-197/X1**. |
| INT-12 | SMS gateway — SOURCE-ACTIVE (`SMSComponent.php:10-40`) | embedded account/password/sender fields | **ROTATE/REVOKE** | KEEP capability behind C4 provider port; vendor choice pending — **SHU-189/C4 + SHU-197/X1**. |
| INT-13 | OneSignal push — SOURCE-ACTIVE call path (`MobileNotification.php:8-82`) | `oneSignalCandidateAPPID`, `oneSignalCandidateAPIKey` | UNKNOWN-OPERATOR-CHECK | REPLACE with C3 registry and consent-aware delivery — **SHU-188/C3 + SHU-189/C4**. |
| INT-14 | SMTP/mail transport — SOURCE-ACTIVE in both variants (`prod ...:73-128`; Railway `:58-131`) | `MAIL_HOST`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_PORT`; classic transport fields | **ROTATE/REVOKE** for committed classic material; Railway UNKNOWN | KEEP capability behind C4; provider choice/rotation in **SHU-189/C4 + SHU-197/X1**. |
| INT-15 | Ipstack geolocation — SOURCE-ACTIVE (`common/config/main.php:51-55`; `Ipstack.php:10-57`) | `ipstack.accessKey` | **ROTATE/REVOKE** | KEEP/REPLACE-PENDING server-side lookup need — **SHU-199/X3 + SHU-213**. |
| INT-16 | Google Maps/Places — SOURCE-ACTIVE, five bearer actions (`common/config/main.php:25-28`; §3 #19–23) | `GOOGLE_MAPS_API_KEY` | UNKNOWN-OPERATOR-CHECK | KEEP/ADAPT server-side — **SHU-199/X3**. |
| INT-17 | Mixpanel main/wallet — ENV/DB-GATED (`EventManager.php:115-133,184-192,254-307`) | five named `Mixpanel-*` setting keys | DB-STATE-UNKNOWN | KEEP-OR-DROP-PENDING D-OP1; if kept, allow-listed/consented adapter — **SHU-199/X3**. |
| INT-18 | Segment main/wallet — ENV/DB-GATED (`EventManager.php:135-147,194-201,309-336`) | five named `Segment-*` setting keys | DB-STATE-UNKNOWN | KEEP-OR-DROP-PENDING D-OP1; if kept, **SHU-199/X3**. |
| INT-19 | Staff-configured outbound webhooks — SOURCE-ACTIVE when DB rows exist (`EventManager.php:388-394`; `Webhook.php:38-101`; staff controller `:19-205`) | destination stored in DB; no signing credential exists | DB-STATE-UNKNOWN | KEEP capability only with allow-list, signature, retry and audit — **SHU-190/C5**; bus boundary **SHU-199/X3**. |
| INT-20 | Legacy Sentry — classic configured, Railway ENV-GATED (§5) | `SENTRY_DSN`, environment and trace-rate names | **ROTATE/REVOKE** classic; Railway UNKNOWN | KEEP capability, operator-gated external transport — **SHU-90 + SHU-198/X2**. |
| INT-21 | Slack logging/direct reports — SOURCE-ACTIVE in common/console config and recruiter report | `slack.url` | **ROTATE/REVOKE** | Replace operational logs with X2; digest delivery with C4 — **SHU-198/X2 + SHU-189/C4**. |
| INT-22 | Xero — SOURCE-ACTIVE component in both variants; console sync is CODE-ONLY (`prod ...:138-143`; Railway `:141-146`; `Xero.php`) | client id/secret, tenant and token fields | **ROTATE/REVOKE** where committed; provider state UNKNOWN | **DEFER / DECISION-PENDING D-OP1** — finance owner **SHU-128/SHU-185**. |
| INT-23 | Yeastar voicemail microservice — SOURCE-ACTIVE component; production host reachability unknown (`Yeaster.php:8-65`; prod configs `:166-169` / Railway `:173-176`) | `microserviceApiKey` | **ROTATE/REVOKE** | KEEP-OR-DROP-PENDING communication use — **SHU-129 + SHU-213**. |
| INT-24 | Jira — SOURCE-ACTIVE component and staff reads (`JiraComponent.php:6-145`; staff `JiraController.php:74,101`) | `jira.email`, `jira.apiToken` | **ROTATE/REVOKE** | REPLACE with StudentHub support tickets unless owner keeps sync — **SHU-187/C2 + SHU-213**. |
| INT-25 | Wallet service — component is wired, but outbound method is an explicit no-op (`WalletManager.php:22-71`) | `walletManager.apiKey` | UNKNOWN; external call disabled | DROP external service; preserve only approved internal ledger/balance semantics — **SHU-128 + SHU-213**. |
| INT-26 | PDF/Excel/QR/headless-browser toolchain — installed local libraries (`composer.json`; `PhpExcel.php`; report/export paths) | none | NONE | Keep only behind audited private export service — **SHU-196/P4**. |
| INT-27 | MySQL/Redis and secondary wallet DB — SOURCE-ACTIVE infrastructure in both production configs | connection environment/config field names only | **ROTATE/REVOKE** where committed; live state UNKNOWN | Replace/migrate under platform DB, source-connection and retirement controls — **SHU-97 + SHU-122 + deploy preflight**. |

### 6.1 Analytics fan-out and privacy

`EventManager::track()` conditionally sends the same event payload to Mixpanel (`common/components/EventManager.php:254-307`), Segment (`:309-336`), SQS (`:338-386`, disabled in checked-in prod configs), and every matching webhook row (`:388-394`). Mixpanel/Segment enablement is database state and therefore LIVE-UNKNOWN. Webhook delivery is not gated by those analytics settings.

No consent lookup or sink field allow-list exists. `setUser()` forwards caller-supplied traits (`:176-201`). Production event producers include profile and ticket text; SHU-199's whitelist must explicitly reject name, email, age, gender, university, country, ticket/support description and chat text. Client-side Mixpanel, OneSignal, Sentry replay, GA/GTM and Hotjar emitters are separately evidenced in `docs/parity/ui-journeys.md` and remain cross-cluster inputs to **SHU-188/189/199**; they are not added to the backend 67-record count.

### 6.2 Webhook controls

Staff `Webhook::List` is excluded from authentication (`staff/modules/v1/controllers/WebhookController.php:44-50,72-78`). Create/update accept arbitrary destination and method strings (`:94-168`); the model requires only event and destination and provides no URL/scheme allow-list (`common/models/Webhook.php:38-49`). Dispatch has no signature, durable attempt, retry, timeout, response audit or per-destination payload allow-list (`Webhook.php:88-101`). **SHU-190/C5** owns transport controls; **SHU-199/X3** owns the event payload boundary.

## 7. Tests and falsification result

No legacy test under the nine app/common/console test trees references the settings, cron log, mail log, ping, AWS config, Maps, EventManager, webhook, SMS, SlackLogger or Sentry surfaces. The absence was reproduced by exact-name search at `c2ce255`; it is not inferred from empty CI.

Required target tests are owned as follows:

| Risk | Required falsification | Owner |
|---|---|---|
| Unknown/missing config or undeclared integration | Remove a required key/register owner/disposition and prove startup/schema failure names it; scan outputs/register for values rather than approved identifiers | **SHU-197/X1** |
| Job overlap/missed run | Run two instances and remove the lease; shift the schedule clock and remove the gap detector; both mutations must fail named tests | **SHU-198/X2** |
| Delivery visibility | Provider acceptance/failure/retry recorded without recipient/body; real C4 log consumed, not a fake-only reader | **SHU-189/C4 → SHU-198/X2**, integration verified by **SHU-221** |
| PII to analytics/webhook | Add each forbidden profile/support/chat field to one sink and bypass consent; whitelist/opt-out tests must fail | **SHU-199/X3** |
| Import graph | Import a sink SDK outside the bus or expose a map key in a response; named tests fail | **SHU-199/X3** |
| Legacy retirement | Attempt retirement with unknown rotation, recovery or consumer status; operation remains blocked | **SHU-122**, using X1 register |

## 8. Current target-platform reconciliation

At current main `e825ff5aa9f28bade60079ac039ad8d9aeb15d83`:

- `/health` is a public, versioned gateway contract (`apps/gateway/src/index.ts:180`; gateway health tests).
- Authentik is the target identity authority; legacy Auth0/Google/Apple/password mechanics are migration evidence only.
- Candidate document R2 storage is wired behind server credentials (`apps/gateway/src/candidate-documents-runtime.ts:23-38`; `docs/contracts/candidate-document-lifecycle.md`). This does not itself retire every legacy upload endpoint.
- A Typesense adapter/indexer exists, but its README explicitly disclaims live indexing, traffic cutover and Algolia removal (`packages/search/README.md:1-11`).
- Observability is PII-safe and local-only; no external Sentry transport is authorized (§5).
- Coolify preflight, image health and revision binding exist, but X1's complete typed business/integration configuration schema does not.
- No production job scheduler/lease, C4 delivery log, C5 webhook adapter or X3 consent-aware event bus is present.

Therefore this inventory is an input to implementation and retirement, not evidence that cutover is ready.

## 9. Bounded delivery ownership

| Slice | Corrected scope from this audit | Dependencies / boundary |
|---|---|---|
| **SHU-197 / X1** | Typed startup schema for both deployment/runtime config and a machine-readable register covering INT-01..27 with owner, identifiers-only credential source, rotation state and explicit keep/replace/drop/pending disposition. Validate scheduler path/timezone and reject unknown required keys. | Describes integrations; connects to none. Uses current deploy preflight. Register blocks SHU-122 retirement when any state is unknown. |
| **SHU-198 / X2** | Instrument the full 38-command operational surface: start/end/outcome/duration/attempt, lease/overlap refusal, timeout/retry and missed-run detection. Consume C4's real delivery log for mail/SMS/push failure visibility and emit PII-safe alerts. | Depends on SHU-90 and versioned **SHU-189/C4** port; SHU-221 must exercise the real integration. X2 does not own domain idempotency. |
| **SHU-199 / X3** | One consent-aware, PII-minimised domain event bus. Registered sink adapters for whichever D-OP1 sinks survive; server-side map/geolocation calls; no direct sink imports elsewhere. Cover support/chat text and client emitters. | Depends on **SHU-188/C3** event model and D-OP1. Webhook transport controls remain **SHU-190/C5**. |

The original 11-point estimate is not re-certified here: the missing scheduler, delivery, deployment and client-integration scope must be reconciled on X1–X3 before forecasting.

## 10. Decisions and unresolved runtime facts

| ID | Required decision/fact | Fail-closed default | Owner |
|---|---|---|---|
| D-OP1 | Which optional external sinks/services survive (especially Mixpanel vs Segment, SQS, Cloudinary, Xero, Yeastar, Jira, Ipstack) | No cutover connection and no retirement while status is pending | Khalid on **SHU-213**; implementation routes to X1/X3/domain card |
| D-OP2 | Whether production event workbook replay has a named continuing use | Exclude from parity; allow only a separately approved, bounded migration tool | Khalid on **SHU-213**; if approved, **SHU-199/X3** |
| R-OP1 | Which checked-in production variant and scheduler are live | LIVE-UNKNOWN; do not infer from files | Operator evidence; record on **SHU-197/X1** without exposing values |
| R-OP2 | Provider credential validity/last rotation and webhook/SQS/settings database state | UNKNOWN blocks retirement and connection | Operator rotation attestation in X1 register; **SHU-122** consumes it |
| R-OP3 | Whether any SQS consumer, external crontab or separate manager/status deployment exists | Treat as absent for implementation but not safe to delete until checked | **SHU-197/X1 + SHU-122**; status host also **SHU-141** |

## 11. Security findings without credential disclosure

| ID | Finding | Evidence class | Action |
|---|---|---|---|
| OP-F1 | Seven public controllers return long-lived upload credential material; five corresponding app trees are routed by checked-in production Nginx configs | §3 #1–7 | Rotate/revoke and replace — **SHU-134 + SHU-145** |
| OP-F2 | Credential material is committed across common and production-environment configuration, and several components embed it in source | §2 and INT register; values intentionally omitted | Treat as exposed, rotate, purge history under approved security process — **SHU-197 + SHU-122** |
| OP-F3 | Cron plumbing cannot prove execution: path mismatch, one image does not start cron at runtime, timezone unspecified, output discarded | §2, §4 | **SHU-198/X2** |
| OP-F4 | No scheduler lease or complete outcome record exists across jobs that send messages, generate transfers and mutate aggregates | §4.1 | **SHU-198/X2** plus domain idempotency owners |
| OP-F5 | Mail log is intent metadata; SMS/push have no durable provider-delivery record | §5 | **SHU-189/C4 → SHU-198/X2** |
| OP-F6 | Analytics/webhook fan-out has no consent or payload allow-list; SQS is code-capable but disabled in checked-in prod configs | §6.1 | **SHU-199/X3 + SHU-190/C5** |
| OP-F7 | Staff webhook listing is public; destinations/methods are insufficiently validated and delivery is unsigned/unbounded/unlogged | §6.2 | **SHU-190/C5** |
| OP-F8 | Legacy Slack logging can forward raw log/model/exception text; target external Sentry is intentionally not enabled yet | §5 | Allow-listed PII-safe events and operator-gated enablement — **SHU-90 + SHU-198** |
| OP-F9 | The production-only workbook action is a caller-named analytics replay, not an unknown import | §3 #10 | D-OP2 / **SHU-213** |
| OP-F10 | The entire legacy surface is untested | §7 | Named positive and mutation tests on X1–X3 and cross-cluster ports |

No statement above asserts a live credential value, successful third-party delivery, database row, provider account state or deployed-host reachability that static evidence cannot prove.
