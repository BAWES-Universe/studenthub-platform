# Production parity inventory: platform config, operations and integrations

**Card:** SHU-139 (parent SHU-88). Closes the second coverage gap found by PR #52. Feeds SHU-97 (data map) and the P4 operational-readiness work.
**Production source:** `BAWES-Universe/studenthub` at `c2ce255`. Permalink base `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Method:** read-only static inspection. No database, provider console, network or live-host access. **No credential values, keys, endpoints or secrets appear in this document**, including ones the repository itself contains.
**Coverage:** 31 of 1,017 functional production actions (`docs/parity/coverage.md`, cluster OPS, regenerated at `cab8d90`).

## 1. What this cluster is

Not a product. It is the machinery every other cluster stands on: runtime settings, health checks, scheduled-job bookkeeping, mail logging, the upload-credential endpoint each app exposes, map lookups, and the analytics fan-out that ships events to three destinations plus arbitrary webhooks.

It appears as a cluster for the same reason reporting did: the coverage ledger forced every action to be assigned, and 31 of them belonged to no feature cluster. The platform equivalent of most of this already exists in `studenthub-platform` (health endpoint, migrations, deployment preflight), so the parity question here is mostly **what to retire, not what to rebuild**.

## 2. Configuration and bookkeeping

| Surface | Routes | Model | Disposition |
|---|---|---|---|
| Runtime settings | `admin/.../SettingController.php` `List`, `Update` | `setting`: `code`, `key`, `value`, `serialized` flag, timestamps | REQUIRED as typed configuration, not free-form key/value rows |
| Scheduled-job bookkeeping | `admin` and `staff` `CronLogController` `List` | `cron_log`: `task`, `last_ran_at`, `last_output` | REQUIRED, and it should carry outcome and duration, not just a timestamp |
| Mail logging | `admin/.../MailLogController.php` `List`, `View`, `Stats` | `mail_log`: from, to, subject, app, timestamps | REQUIRED (communication cluster owns delivery; this is the observability of it) |
| Health check | `PingController::actionTest` in six apps | — | REQUIRED, already exists on the platform as `/health` |
| Excel import | `admin/.../EventController.php` `ImportExcel` | — | needs a purpose check before disposition |
| Event emulation | `console/controllers/EventController.php` `Emulate` | — | development tool, DISCARD |

`cron_log` records only the last run time per task. Combined with the finding in the reporting inventory that revenue roll-ups are incremental, and the finance finding that the bank-file processor has no visible lease, the system has **no operational record of whether a scheduled job succeeded, how long it took, or whether it ran twice**. That is one gap expressed three times, and it is the most valuable thing this cluster contributes to the platform design.

## 3. The upload-credential endpoint, in every app

`AwsController::actionConfig` exists in **seven** applications: candidate, company, staff, admin, manager, inspector and status. The candidate one is 74 lines; the other six are 66 and byte-identical in shape.

The candidate instance is already filed as **SHU-134** — it returns a static AWS access key id and secret to any authenticated caller, with the author's own `//todo: key with expiry`. This inventory establishes the scope that card did not: **it is not one endpoint, it is seven**, one per app, and the `status` app's copy sits among the fifteen controllers that remove authentication (SHU-141), so if that app is reachable its credential endpoint is reachable unauthenticated.

No credential values are reproduced here. SHU-134 should be widened from the candidate app to all seven, and SHU-141's outcome decides whether one of them is exposed without a login.

## 4. Integrations

Third-party services this system depends on, from `composer.json` and `common/components/`:

| Purpose | Component | Cluster that uses it |
|---|---|---|
| Object storage | `S3ResourceManager`, `S3FileExistValidator` | profile, organizations |
| Image CDN | `CloudinaryManager` | profile |
| Video transcoding | `MediaConvert`, `php-ffmpeg` | profile |
| ID document OCR | `IdExpiryDateExtractor` (AWS Textract) | profile |
| Search | `Algolia` | recruit |
| Identity provider | `Auth0` | identity (superseded by Universe) |
| Captcha | `ReCaptcha` | identity |
| SMS | `SMSComponent` | identity, communication |
| Geolocation | `Ipstack` | identity |
| Maps | `GoogleMap` (`PlacePredictions`, `PlaceDetail`, `AreaByLocation` in candidate and staff) | profile, organizations |
| Product analytics | `EventManager` → Segment, Mixpanel, SQS | all |
| Error tracking | `notamedia/yii2-sentry` | all |
| Ops alerting | `SlackLogger` | all |
| Accounting | `Xero` | finance (DEFER) |
| Telephony | `Yeaster` | communication |
| Issue tracking | `JiraComponent` | communication |
| Wallet | `WalletManager` | finance (disabled) |
| PDF, Excel, QR | `kartik-v/yii2-mpdf`, `PhpExcel`, `Excel`, `chillerlan/php-qrcode`, `spatie/browsershot` | profile, reporting |
| Ledger | `yii2tech/balance` | finance |

**Twenty integrations.** Each is a migration decision, a credential to rotate, and a failure mode. The platform currently has one external dependency (Universe through Authentik) plus its own database, so this list is the real measure of what cutover has to replace, keep or drop.

### 4.1 The analytics fan-out

`common/components/EventManager.php` is the single busiest integration point. One `track()` call can reach:

- **Segment** (`:333-335`, `Segment::track` then `flush`)
- **Mixpanel** (`:303`, plus a separate wallet client at `:296` tracking a "Revenue" event)
- **Amazon SQS** (`:364`, `sendMessage`)
- **Every webhook registered for that event** (`:388-393`, `Webhook::findAll(['event' => $event])` then `callWebhook($eventData)`)

The webhook leg is the one the communication inventory raised as CM-F4: staff-configurable destinations, no allow-list, no signing, no retry, no audit. Seen from here it is worse than it looked, because the same payload that goes to Segment and Mixpanel goes to whatever URL a row names, and the profile inventory established that these payloads carry personal data (name, email, age, gender, university, country on `Candidate Profile Created`).

## 5. Parity rows

| ID | Journey | Actor / grant | Legacy routes | Tests | Disposition | Slice |
|---|---|---|---|---|---|---|
| OP-01 | Health check | anonymous | `Ping::Test` ×6 | none | **ALREADY DONE** on the platform (`/health`) | — |
| OP-02 | Runtime settings | admin | `Setting` `List`, `Update` | none | REQUIRED, ADAPT to typed configuration | X1 |
| OP-03 | Scheduled-job observability | admin, staff | `CronLog` `List` ×2 | none | REQUIRED, **ADAPT: outcome, duration, overlap detection, not just a timestamp** | X2 |
| OP-04 | Mail delivery observability | admin | `MailLog` `List`, `View`, `Stats` | none | REQUIRED | X2 |
| OP-05 | Direct-upload credentials | any authenticated caller | `Aws::Config` ×7 | none | **REPLACE**: short-lived, object-scoped credentials; never a static key (SHU-134, widened) | profile S4 |
| OP-06 | Map place lookup | candidate, staff | `GoogleMap` ×2 (5) | none | REQUIRED, server-side | X3 |
| OP-07 | Analytics fan-out | system | `EventManager` → Segment, Mixpanel, SQS | none | **ADAPT**: one event bus, consent-aware, PII-minimised | X3 |
| OP-08 | Outbound webhooks | staff | `EventManager:388-393`, `Webhook` | none | REQUIRED with controls (communication C5) | — |
| OP-09 | Error tracking and ops alerting | system | Sentry, `SlackLogger` | none | REQUIRED (platform already runs Sentry) | X2 |
| OP-10 | Excel import of events | admin | `Event::ImportExcel` | none | **UNRESOLVED**: purpose not established; confirm before excluding | X1 |
| OP-11 | Event emulation | developer | `console/Event::Emulate` | none | DISCARD | — |
| OP-12 | Search index maintenance | system | `console/Algolia::Index`, app `Algolia::Key` | none | OTHER-CLUSTER (recruit R3) | — |
| OP-13 | Cache flush over HTTP | admin | admin `Statistic::ClearCache` | none | DISCARD (reporting RP-F4) | — |
| OP-14 | Legacy identity export to a second database | system | `console/CentralDb` | none | DISCARD (identity I8) | — |
| OP-15 | One-off media migration | system | `console/Resource::S3ToCloudinary` | none | DISCARD after the migration inventory | — |

## 6. Tests

No test in any app covers settings, cron logging, mail logging, ping, the upload-credential endpoints, map lookups, the analytics fan-out or webhook dispatch. The platform's own deployment suite (`deploy/coolify/test/deployment.test.mjs`, 9 tests) already covers more operational ground than the legacy system does.

## 7. Findings

| ID | Finding | Evidence | Severity | Action |
|---|---|---|---|---|
| **OP-F1** | The upload-credential endpoint is not one endpoint but **seven**, one per app, and the `status` copy sits among controllers that remove authentication | §3; SHU-134; SHU-141 | **High**, pending SHU-141 | widen SHU-134 to all seven |
| **OP-F2** | `cron_log` records only `last_ran_at` and `last_output`: no success flag, no duration, no overlap detection — across a system whose scheduled jobs move money and mail real people | §2 | Medium–High (operational blindness) | X2 |
| **OP-F3** | One `track()` call fans out to Segment, Mixpanel, SQS and every registered webhook, carrying payloads that include personal data | §4.1; profile inventory §4 | Medium–High (privacy and exfiltration surface) | X3, communication C5 |
| **OP-F4** | Twenty third-party integrations, each a cutover decision and a credential to rotate; no inventory of them existed before this document | §4 | Planning | X1 owns the register |
| **OP-F5** | The whole cluster is untested | §6 | Low in itself, but it is the machinery everything else runs on | X2 |
| **OP-F6** | `Event::ImportExcel` has no established purpose | §5 OP-10 | Unresolved | confirm before excluding from parity |

## 8. Classification of prior findings

| Source | Claim | At `c2ce255` |
|---|---|---|
| SHU-134 | The candidate app returns a static AWS key to any logged-in candidate | **Production-supported and wider than filed**: seven apps, not one |
| SHU-39 | Analytics receives candidate PII | **Production-supported**, and this document adds the SQS and webhook legs |
| SHU-46 | Xero DEFER | unchanged |
| SHU-39 | Wallet disabled | **Production-supported**: `WalletManager` still present, integration disabled |

## 9. Bounded slices

| Slice | Scope | Points |
|---|---|---|
| X1 | Typed platform configuration, plus an integration register recording each third-party dependency, its owner, its credentials' rotation state and its cutover disposition | 3 |
| X2 | Operational observability: job outcome, duration and overlap detection; mail delivery visibility; alerting wired to the platform's existing Sentry | 3 |
| X3 | One consent-aware, PII-minimised event bus replacing the four-way fan-out, with map and other server-side lookups behind it | 5 |

Cluster total: **11 points**, the smallest of the nine, because the platform already implements much of it.

**Final running total across all nine sized clusters: profile 40, organizations 46, work 31, recruit 36, finance 26, communication 26, identity 30, reporting 16, platform 11 — 262 points**, against the 56 the roadmap carried across seven 8-point placeholders. Only SHU-138 (live front-end revisions) remains, and it sizes client work rather than backend parity.

## 10. Decisions for Khalid

| ID | Decision | Recommended default | Cost of waiting |
|---|---|---|---|
| D-OP1 | Twenty integrations. Which survive cutover? The consequential ones are Algolia (recruit R3 already proposes replacing it with server-side search), Cloudinary (the platform stores objects itself), Mixpanel and Segment together (two analytics products), and SQS | Keep object storage, OCR, SMS, maps, error tracking. Replace Algolia with server-side search. Drop Cloudinary, one of the two analytics products, and SQS unless something consumes the queue | Blocks nothing immediately, but every one kept is a credential to rotate and a contract to carry into production |
| D-OP2 | `Event::ImportExcel` (OP-10) — what is it for? | Exclude from parity unless someone names a use | Trivial, but it is the one action in this cluster I could not disposition on evidence |

## 11. Not established

- What `Event::ImportExcel` imports, and whether anyone uses it.
- Whether anything consumes the SQS queue.
- Which of the twenty integrations still hold valid credentials.
- Whether `cron_log` rows show gaps, which would evidence missed runs — needs the database (SHU-97).
- The IAM policies behind the seven upload-credential endpoints (SHU-134).
