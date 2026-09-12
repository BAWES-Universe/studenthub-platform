# SHU-97 — production-to-platform data map and isolated test-data plan

Status: **proposed mapping; no data movement authorized; independent exact-head review pending**.
Author: Codex Work session `3b731a8a2834`. A non-author verifier from a different
model family must verify the final PR head. This document is not a PASS, deployment receipt, schema
migration, authorization to open the sealed lab, or evidence of live parity.

## Authority, scope and how to read the map

Production code authority is [StudentHub at
`c2ce255695eabc7e3a0f23b162f5996274234c63`](https://github.com/BAWES-Universe/studenthub/tree/c2ce255695eabc7e3a0f23b162f5996274234c63).
`P:path:line` below means that repository and exact revision. The GitHub commit was
re-fetched, and the local checkout had no tracked or untracked changes at that
pin. This establishes
source provenance, **not which migrations ran or which bundle is deployed**.
No donor Prisma schema, database dump, live database, bucket, provider console,
credential file or secret store was used.

Platform baseline is [main at
`9ef9259309505ceab9200a6648bf1036b37e24b6`](https://github.com/BAWES-Universe/studenthub-platform/tree/9ef9259309505ceab9200a6648bf1036b37e24b6).
`T:path` means that tree. SHU-97 was re-fetched before claim: Todo, no assignee,
comments or blockers. The re-fetched open PR list had no SHU-97 work. The claim
is recorded on [SHU-97](https://linear.app/bawes/issue/SHU-97).

The bounded deliverable covers all nine clusters, with every field encountered
in the literal migration/scalar-model census assigned a proposed typed field.
It also accounts for computed values, retired fields, frontend effects, object
families and cross-cluster jobs. It does **not** claim a complete verified live
schema: source ambiguity remains explicit rather than filled with assumptions.

| Artifact | Meaning and limitation |
| --- | --- |
| [fields.csv](fields.csv) | 1,336 field entries across 133 source entities/namespaces; 1,278 have literal migration declarations, 58 are annotation-only. Target field/type/handling is a **proposal**, not an implemented domain contract. |
| [relationships.csv](relationships.csv) | 1,116 receipts for FK/PK/index changes and ORM relationships. This is an ordered declaration history, not the effective deployed constraint set. `hasOne`/`hasMany` does not establish database uniqueness or cascade behavior. |
| [retired-fields.csv](retired-fields.csv) | Source drop/rename history, including fields no longer in the literal migration projection. Never turn these declarations into permission to delete data. |
| [source-gaps.csv](source-gaps.csv) | 299 raw SQL/data-command/lifecycle-hook receipts requiring semantic interpretation. A receipt is a review obligation, not 299 proven defects. |
| [frontend-effects.csv](frontend-effects.csv) | All 226 named frontend-only inventory rows, retained as **inventory-only** evidence unless reverified below. This is coverage of reported effects, not acceptance of all claims. |
| [jobs.csv](jobs.csv) | All 38 public console `action*` declarations after removing comments, with checked cron-file references. Source schedule presence is not proof a job runs. |
| [manifest.json](manifest.json) | Counts and SHA-256 digests of the CSV artifacts. No personal-record digests. |

The census enumerates and reads legacy migrations, models, controllers and the
cron file directly from the production Git tree at the pin. The checkout must
also be at that revision with no tracked or untracked changes; ignored files
are never enumerated as inputs. It binds its five frontend inputs to platform revision
`9ef9259309505ceab9200a6648bf1036b37e24b6`: each appendix must exist and be
byte-identical to that commit, and its SHA-256 is recorded in the manifest.
Appendix content that differs from the pin fails before a manifest is written.

Evidence states: **SOURCE-VERIFIED** means the stated code/declaration was checked
at the pin; **PROPOSED** is a new target decision; **ANNOTATION-ONLY**, **DISPUTED**
and **UNVERIFIED** do not permit automatic import. All live-state claims remain
unverified in this task. The generated type classifier is deliberately a proposal
aid. The explicit domain/type overrides below take precedence; a residual
`SourceText`, ambiguous enum, relation, currency or temporal value must HOLD
before an executable importer is approved. No blanket JSON bag is an accepted
business-domain contract.

## Environments, readers/writers and existing authorization

Read [SHU-26](https://linear.app/bawes/issue/SHU-26) and
[SHU-79](https://linear.app/bawes/issue/SHU-79) descriptions and full comment
histories before mapping. Their evidence describes distinct stores:

| Store | Authority / existing evidence | Reader/writer boundary for this work |
| --- | --- | --- |
| Legacy StudentHub MySQL | Yii2 is the live application authority. Angular/React/mobile clients invoke its APIs. Source schema is the pinned migrations/models, not the failed refactor. | Existing application readers/writers continue unchanged. This author has **no live reader or writer role** under SHU-97. Do not infer operational access from an agent label. |
| Platform PostgreSQL | SHU-79 execution comment `c3954d5b-b245-4bd0-b1f8-4bca5a0f96ca` records a separate `platform-postgres` resource and own volume, initially fresh with migrations 0001–0004. Closure comment `63978b82-808f-4a44-a5e7-8688cc68e552` records gateway revision `acbe6bf1bee26b445f9c773ddc09c8321b36f376` on 2026-09-09. These are historical operator reports, not a current inspection. | Runtime gateway uses its own persistence boundary. SHU-97 does not connect, bootstrap identities or run migrations. Staging is **not asserted to share the production database**. |
| Sealed lab copy | SHU-26 correction `9078d19d-de18-4ad7-a5f3-1f62941d4c9b` and verifier `a24a9994-a357-4cda-8564-85e6935c36ca` record encrypted copies, isolated restore evidence and teardown. The access log is a logbook, not a tamper-proof audit. | Owner retention permission is recorded in `ba43af51-b3ee-4a50-983f-ac4208ff2dc4`: copies may remain on the personal machine. That does not authorize this session to decrypt, read rows, transfer, mask or export them. |
| Wallet database | SOURCE-VERIFIED: `P:common/models/WalletUser.php:39`, `WalletBank.php:29`, `WalletTransfer.php:62`, `BalanceAccount.php:23`, `BalanceTransaction.php:30` override `getDb()` to `walletDb`. | Separate `wallet.*` namespace in this map. Same-named `bank`/`transfer` tables must never merge with StudentHub tables. No wallet connection or import. |
| Isolated synthetic test target | PROPOSED disposable local DB/object store with explicit run ID and fake identities. Existing fixture/import tools are in-memory and only cover four entities (`T:tools/fixtures/src/types.ts`, `tools/legacy-import/src/import.ts`). | Synthetic fixture work remains available without a data-transfer approval. No production secrets, sender accounts, network destinations or restored volume. |

SHU-26's corrected threat model does not protect against compromise of the Linux
guest or Windows host. Deleted plaintext files/volumes were unlinked; residual
recovery was not excluded. Do not present that historical teardown as forensic
erasure. SHU-79 also records that OIDC `user_email` subjects can store tester email
in `external_identities`; “no profile import” does not mean “no personal data.”

Before any later approved import, the operator must attest the target resource
identity, project/environment, database engine/name, dedicated volume/network,
schema version, image revision, object-store namespace and empty/run-owned
target marker. Validate **resolved target identity**, not just a friendly DNS
name or `NODE_ENV`. The current preflight (`T:deploy/coolify/preflight.mjs:13-29`)
checks a PostgreSQL URL with host/database, not a production-resource denylist;
it cannot prove isolation alone. Proposed import preflight must fail closed on
an unknown/shared target, restored production mount, enabled outbound provider,
missing purge deadline or missing authorization receipt. No such checks are
executed against an environment by this PR.

## Typed domain contract mapping

The names below are logical API/domain records, not a copied physical schema.
Each CSV field belongs to the indicated record family; fields remain separately
addressable for review. Splitting an aggregate into PostgreSQL tables is SHU-103
implementation work. Keep original source identity and provenance even when
several legacy records contribute to one domain aggregate.

Every proposed record carries `mappingVersion`, `sourceSystem`, `sourceEntity`,
`sourceKey`, `sourceRevision`, `snapshotRef`, `targetId`, `recordVersion`,
`lifecycle`, and typed domain fields. Source keys are exact strings, namespaced
by database and entity; numeric-looking IDs never pass through a JavaScript
float. New target IDs are deterministic **within a synthetic run**; a later
approved masked run uses a private dataset-specific mapping, never public hashes
of email, civil ID or phone. The source-key map is private and is purged with the
dataset. No source key alone grants access.

| Cluster | Source entities and target aggregate | Relationship / ownership / conflict contract |
| --- | --- | --- |
| Identity (176 fields) | `admin`, `staff`, `inspector`, `store_manager` → proposed `LegacyAccountBinding` and explicit grant proposals; token/OTP/verification-attempt rows → excluded credential state plus fabricated failure cases. `permission_section/sub_section/user`, limited-access and two-step flags → reviewed capability proposals, never automatic grants. | Existing `Principal`, `Organization`, `RoleGrant` and exact `(issuer, subject)` `ExternalIdentity` contracts are authoritative (`T:packages/contracts/src/authz/*`, `packages/login-contract/src/types.ts`). Candidate/contact are identities **and** business profiles; join through explicit binding evidence, never email/name/phone matching. Multiple candidates/accounts claiming one person or conflicting issuer bindings HOLD all affected bindings. Unknown legacy roles do not expand the closed target role union. |
| Profile (169) | `candidate` → `CandidateProfile` with contact, Arabic/English names, DOB, nationality/university, location, availability, language, compliance, bank-detail and document subrecords. Education, experience, skills, links, tags, warnings, certificates, ID cards/requests and video logs → typed child collections. Degree/group/major/university/tag → reference catalogues. | Candidate ID is the business key, distinct from `Principal.id` and `candidate_uid`. Keep `store_id` as current-assignment reference and history as separate records. Tag/education/skill duplicates remain explicit; no silent dedupe. Pending-profile text requires a validated field-level proposed-change contract; do not apply it to the accepted profile. Birth/civil dates are dates; bank fields are restricted payment details. |
| Organizations (150) | `company` → `OrganizationProfile` extending existing `Organization`; `store` → `Workplace`; `company_contact`, contact/email/phone/invitation/request → `MembershipProposal`, `BusinessContact`, `OrganizationOnboarding`; brand/mall/area/country/currency → catalogues. | Parent-company reference defines hierarchy only, not inherited authority. Contact membership and `allow_access` require explicit grant policy. One contact may have many memberships; retain each company-contact key. Reject hierarchy cycles and missing parents. `company_status` is computed by `Company::fields()` at `P:common/models/Company.php:245-268`; preserve override and inputs, recompute output. |
| Work (105) | `candidate_work_history` → `Assignment`; working-hour/date → `WorkSession` / `WorkDayProjection`; appeal/updates/feedback → `WorkApprovalCase`; store-assignment requests → `AssignmentChangeRequest`; staff sessions/leave and firing hitmap → separate internal-HR/projection records. | Assignment binds person, store, company, parent company and effective contract/rate period. Sessions retain **both** start/end coordinates and timestamps plus manual/automatic `via`, notes and status. Cross-person feedback/appeal or session outside assignment HOLD. Do not infer payroll approval from a client badge. Rollups are reconciled separately from canonical sessions. |
| Recruitment (232) | Job/skills/interests; request/skills/checklist/application/interview/activity; invitations/suggestions; candidate/interview evaluations, note versions; exams/questions/choices/answers; fulltimer and child skills/experience/tags → `Opportunity`, `Application`, `Invitation`, `Interview`, `Evaluation`, `Assessment`, `Prospect`. | Preserve job→request and candidate→application→interview/evaluation edges, including optional/legacy links. Fulltimer is a prospect, not automatically a candidate identity. Internal note, candidate-visible interview note and versioned assessment notes are distinct typed fields. File answers use a discriminated `TextAnswer \| ChoiceAnswer \| FileAnswer`, not undifferentiated text. Duplicate applications/ambiguous version heads HOLD; preserve author and visibility scope. |
| Finance (300) | Three contract-detail types → `PayContract`; transfer/lines/cost/rates/invoice → `PayrollBatch`, `PayableLine`, `Invoice`; transfer-file/entry/bank-advice → `BankReconciliationArtifact`; bank/Xero transactions/contact/line-items → `AccountingReference`; expenses/staff salaries/process/discounts → separate pending-scope records; `wallet.*` excluded pending explicit scope. | Keep payment-time candidate/company/store/bank/rate snapshots, not live-profile substitutions. Preserve parent/child transfers and nullable contract links. Paid/locked/cancelled state never causes money movement on import. Missing currency, line-parent mismatch, two matches for a bank row, different source body for one key, or unexplained rounding difference HOLD the entire financial aggregate. Internal finance/discount/wallet inclusion requires an explicit decision; capture coverage without quietly discarding history. |
| Communication (174) | Chat/message, tickets/comments/attachment links, notes, candidate/staff/mobile notifications, stories/activity, campaigns/filters/attribution, webhooks, standup questions/answers and legacy note/activity tables → `Conversation`, `SupportCase`, `ScopedNote`, `NotificationHistory`, `CampaignDefinition`, `AttributionRecord`, `IntegrationSubscription`. | Preserve sender type and sender key together; a bare numeric ID is ambiguous across admin/staff/contact/candidate. Polymorphic notes/notification links need explicit target kind. Read/unread history and localized rendered text stay distinct from delivery state. Imported notifications/campaigns/webhooks are historical and **non-dispatchable**; live device tokens, destinations and content are replaced. Missing target/owner or mixed-org attachments HOLD. |
| Reporting (12 plus derived projections) | Candidate/company revenue-stat rows → `LegacyAggregateReceipt`; reports/statistics/export views across apps → rebuilt `ReportProjection`. | Preserve a reconciliation comparison, not the old total as canonical truth. Recompute from imported approved work/payroll facts by currency and period. SOURCE-VERIFIED incremental revenue updates at `P:console/controllers/CronController.php:1084,1139`; no assumption of idempotent replay. Inspector identity does not automatically grant all reports. |
| Operations (18 plus external configuration) | Setting/cron-log/mail-log → `TypedSettingProposal`, `JobRunHistory`, `DeliveryReceipt`; search/video/analytics/provider state → explicit disabled integration references. | Unknown setting keys and serialized values HOLD; credentials/destinations are excluded. `cron_log.last_ran_at/last_output` is not enough to synthesize a successful job receipt. Do not migrate provider sessions, cursors or retry queues into active workers. Search indexes/caches are derived and rebuilt only from approved target projections. |

### Type, key and temporal rules

| Proposed type / field override | Target semantics and rejection path |
| --- | --- |
| `SourceRef` | `{system, entity, key}`; relationship registry resolves to a target ID or explicit null. Composite PK/index declarations are in relationships.csv, including UUID and multi-column link keys. Do not assume every `_id` is a PK or every `hasOne` unique. Foreign-key target missing → `orphan_reference`, never fabricate a person/company. |
| `MoneyDecimal` | `{coefficient: signedIntegerString, scale: integer, currency: ISOCode}`; rates additionally state `per: hour/month/unit`, period and provenance. Validate supported currency, scale and signed range. Never use binary floating point or infer KWD globally. Currency code is joined as a catalogue key; currency rate is a decimal ratio, not an amount. |
| Finance precision | SOURCE-VERIFIED `transfer_candidate.candidate_total/company_total` are declared `decimal(10,3)` in `P:console/migrations/m210628_063748_transfer_candidate_total_fields.php:15-16`. Contract rates/cost declarations include `decimal(12,3)`. CSV retains each declaration; model “integer” comments are not authoritative. Existing value overflow is **UNVERIFIED**, not a fact inferred from schema. Proposed fixtures exercise each boundary. |
| Duration | Work-session `total_time` and day totals are seconds, not a timestamp or money. SOURCE-VERIFIED trigger at `P:console/migrations/m221130_112258_candidate_working_hour_trigger.php:15` uses `TIMESTAMPDIFF(SECOND, OLD.start_time, NEW.end_time)` when new total is negative/null. Preserve trigger-derived versus explicit total provenance. Payroll `hours`, `minutes`, `seconds` remain separately lossless until conversion under a reviewed formula. |
| `TemporalValue` | Discriminated `Instant{utc, originalOffset}` / `LocalDateTime{value, zone}` / `LocalTime{value}` / `DurationSeconds` / `UnknownTemporal{reason}`. MySQL `datetime` without zone is not automatically UTC. Source schedule timezone is unverified. Establish one approved timezone before conversion; no guessed offsets. Birth/expiry/work/pay dates stay calendar dates. Preserve null versus zero date versus open session; malformed/negative durations HOLD. |
| Percent / count / boolean | Commission/discount/completion percentage is a bounded decimal percentage, not currency. Headcount, unread count, attempts, sort order, progress and IDs are integers or explicit enums. Only documented 0/1 maps to a boolean; nullable is three-state. `company_followup_interval_weeks` is an interval, not the docblock's boolean. |
| `SourceEnum` | `{domain, sourceValue, mappedValue}` with an exhaustive reviewed dictionary per field. Preserve unknown/null separately and HOLD unknown states. A transfer status, candidate status, request status and notification type never share a global numeric mapping. No automatic inference of authorization or consent. |
| Text / locale | Bilingual fields remain paired, with absence distinguished from empty text. Proposed storage supports Unicode/emoji. HTML notes/descriptions become scoped sanitized rich text or plain text under a selected contract. Test Arabic RTL, emoji, combining characters, long text, spreadsheet-formula prefixes and invalid encoding using fabricated strings. |
| Arrays / polymorphism | `candidate_ids`, permissions' company lists, filters, pending-profile text and provider payloads require typed element schemas and bounded lengths. No string splitting without a verified serialization rule. Unknown element format HOLD; zero “best effort” grants. |
| Derived / transient | `company_status`, chat unread counts, search fields, display URLs, completion badges and revenue rollups are recomputed or compared, not persisted as authority. `candidate_tag_id` and `transfer_candidate.transfer_candidate` annotation-only entries require reconciliation against migration/source logic; they are not presumed physical columns. |

### Lifecycle and conflict handling

Every source tombstone (`deleted`, `is_deleted`, `deleted_at`, inspector-specific
deletion) is preserved as a **typed lifecycle fact** with source provenance.
Absent deletion metadata means unknown, not active. Read query scopes can hide
soft-deleted rows; a future approved snapshot must explicitly state whether they
are included. FK CASCADE/SET NULL declarations remain historical evidence and
must not become a platform retention policy. `retired-fields.csv` is not an
erasure instruction. Preserve cancelled/paid/inactive/expired states and historical
snapshots; do not activate accounts, publish opportunities or re-send notifications.

Import conflict result is proposed as
`{runRef, entityKind, opaqueRowRef, reason, dependentAggregateRefs, disposition}`.
Reasons include `duplicate_source_key`, `different_body_same_key`,
`identity_binding_conflict`, `orphan_reference`, `cycle`, `unknown_enum`,
`invalid_time`, `currency_mismatch`, `amount_overflow`, `ambiguous_object_owner`,
`unsupported_document_type`, `unverified_schema` and `policy_unresolved`.
Same key/same canonical body is a no-op; same key/different body never overwrites.
Independent aggregates may be staged, but none with unresolved dependencies may
publish. A payroll aggregate commits atomically with its lines/receipts. Rejected
records retain only protected diagnostic references; public reports carry
reason/counts, never row values. SHU-233 retry keys do not substitute for an
import source-key registry or grant authority.

## Documents, attachments and generated files

The existing private-document primitive accepts only eight types and synthetic
filesystem storage (`T:packages/private-documents/src/index.ts:7`,
`T:docs/contracts/private-documents.md`). It is not mounted in the gateway and
does not yet represent every legacy attachment type. New types below are
**proposals**, not silently accepted by that primitive.

| Object family / source receipt | Proposed target and isolated substitute |
| --- | --- |
| Candidate personal photo; `P:common/models/Candidate.php:2798-3051` | Existing `personal-photo`. Source supports legacy Cloudinary and newer storage forms; retain source-kind metadata privately. Fabricated image with no face/EXIF/GPS. Never fetch profile URLs. |
| Resume and fulltimer CV; `Candidate.php:2333-2397`; `Fulltimer` field ledger | `resume` for linked candidates; proposed `prospect-resume` for fulltimer scope. Fabricated PDF; unsupported legacy format HOLD. No document text copied. |
| Civil front/back; `Candidate.php:3114-3307` | Existing civil types, separately owned/versioned. Account for bare filename, `photos/…`, and `candidate-civil-id/…` normalization. Use an obvious “SYNTHETIC TEST — NOT ID” graphic. No real ID, OCR, original key or public URL. |
| Candidate video/thumbnail and processing state; `Candidate.php:2399-2581` | Existing video/video-thumbnail types with synthetic MP4/image pair; fabricated pending/completed/failed processing receipts. Do not resume an old transcoder job ID. |
| Company logo/licence; `P:common/models/Company.php:971-1082` | Existing company-logo/commercial-licence, scoped to organization. Fabricated image/PDF, with replacement and deleted-old-version cases. |
| Generic organization files; `P:common/models/File.php:131-201` | Proposed `organization-attachment`, retaining owner/title/type/size/version separately from storage locator. Old source path is not a browser URL. Unsupported media quarantined. |
| Ticket and comment attachment joins; `Attachment.php:13-14`, `TicketAttachment.php:92-102`, `TicketCommentAttachment.php:92-102` | Proposed `support-attachment`. Resolve ticket→participant/org and comment→ticket before ownership. Shared attachment references remain multiple explicit links; mixed-scope reuse HOLD. Fabricated bytes and missing-object cases. |
| Exam file answer; `P:common/models/ExamQuestionAnswer.php:117-151,192-201` | Proposed `assessment-answer-attachment`; discriminate using question type. Source copies from temporary storage to `candidate-answer/` and deletes via the model hook. Preserve question/candidate ownership; do not treat all `answer` values as text. |
| Bank transfer files, bank advice, rate exports; `TransferFile.php:140-147,408-412,700-702,893-897`; `TransferBankAdvice.php:130-175`; `TransferRateExcel` field ledger | Proposed `finance-artifact` plus immutable parsed-line manifest. Synthetic CSV/XLSX/PDF with fake beneficiaries and balanced amounts. Never submit a bank file or reuse bank identifiers, addresses, confirmation IDs or delivery destinations. |
| Certificates/ID-card PDFs, invoice PDFs and report exports | Generated projections from synthetic records; preserve template/version/owner and generating event separately. No need to copy historical PDF bytes for a test baseline. Existing eight-type document union does not authorize these new types. |
| Brand/discount/category images, stories and recordings/integration URLs | Explicit pending-scope assets. Fabricated images/audio or disabled reference only. Provider-only metadata/retention is UNVERIFIED; no provider retrieval to resolve it in SHU-97. |

SOURCE-VERIFIED: `P:common/components/S3ResourceManager.php:96-147` defaults
save/copy to `public-read`. This does **not** prove effective live access. Do not
copy ACLs, keys or temporary upload credentials. New manifest entries require
`objectId`, immutable `version`, `ownerPrincipalId` or organization owner,
`documentType`, `mime`, byte size, checksum of **substitute** bytes, lifecycle,
source reference class and reconciliation state. Original object locators never
enter public evidence. Unknown owner/type or missing object HOLD rather than
silently dropping the document. Two source references to one object and one
source reference to multiple revisions are separate fixture cases.

Stage bytes privately, validate type/signature/size and ownership, then commit
metadata/version; a failed metadata commit leaves no delivered reference. Retired
versions are inaccessible immediately. The existing primitive retains retired
bytes and has no physical purge API pending policy. Whole disposable **synthetic**
stores may be removed after closing writers; a later masked store needs its own
approved purge implementation and evidence before admitting real-derived data.

## Frontend and mobile effects

Checked source pins (clean tracked trees): candidate web
`2f0a1213e6ea1bb6fa3f27be1d6701199c38e1fa`, mobile
`de3ac8c8177d0a4c127f2668cb938adbff2755b4`, staff
`49ed05c55592a981118da413287eb71f2e75e6f8`, admin
`c789b17e3ec5ded542a9e55cd60255d759c26b1b`, employer
`b9578d5225657d17e602455cdcdafbd842991a0b`, in the corresponding
`BAWES-Universe/studenthub-*` repositories. These are source pins, not observed
deployed or app-store versions. The 226-row ledger keeps each prior finding
addressable; unverified rows cannot establish server enforcement or absence.

| Effect | Independent source check / target test-data obligation |
| --- | --- |
| Permission menus and active employer | Staff `src/app/providers/permission.service.ts:30-43` returns true for an unlisted company in the company-specific branch. Employer `src/app/providers/auth.service.ts:431-434` changes client company selection. Proposed target requires fresh grants for every read/write; test forged role/org, stale grant, revoked membership and ambiguous multi-org selection. Do not migrate menu booleans or local company choice as authority. |
| Admin limited-access/cache | Admin `src/app/providers/auth.service.ts:223,255` copies/persists the limited-access value; `:602` begins the always-true `restrictedAccess()` method. Test both limited/unlimited UI states with server-denied writes. The aggregate count of 123 template gates was **not independently recounted here**. |
| Job eligibility/display | Candidate web `src/components/app/jobs/job.tsx:80-125` renders gender/availability; `src/models/job.ts:22-23` declares age bounds. This component is 167 lines at the pin: the inventory's `:253-298` reference is **DISPUTED**. This local component check does not alone prove no eligibility rule anywhere. Test min/max boundary, gender/availability mismatch, closed job, duplicate application and apply after status changes; authoritative policy must be server-side. |
| Mobile clock-in/out | Mobile `src/app/pages/logged-in/candidate-work-log/track-work/track-work.page.ts:135-139,184-188` obtains coordinates and submits them separately for stop/start. Preserve both points. Test denied GPS, missing one coordinate, offline retry, clock skew, crossing midnight, open session and double tap using fabricated location/clock providers. Do not assume an offline replay queue exists. |
| Direct uploads | Employer `src/app/providers/aws.service.ts:202-214` specifies public-read and uploads from the browser. Test new scoped upload flow using synthetic bytes; old cached AWS configuration is not migrated. Apply the same ownership/type test to every frontend attachment entry, not just candidate photos. |
| Private interview fields | `P:candidate/modules/v1/controllers/RequestController.php:131-169` returns scheduled own interviews via the model; `RequestInterview` has no `fields()` override in the checked file. An omitted UI field does not remove it from the API projection. Fabricate internal/shared notes with distinct sentinels and assert the internal sentinel is absent from candidate responses. |
| Browser/native transient state | Login tokens, local cached records, in-progress forms, theme/language/currency choices, selected org, notifications, push registration, camera/file permissions and OAuth deep-link state are **not a database import source**. Reauthenticate; clear/rebuild stale caches; re-enrol synthetic device push IDs in a fake provider. Offer UX recovery for unsent drafts only under a future explicit local-data policy. |
| Validation, labels, totals, ordering and optimistic UI | Preserve UX intent in fixtures, but server computes money/eligibility/visibility. Test Arabic/English, timezone/currency formatting, pagination, empty/error/slow responses, optimistic rollback, duplicate submit and client/server version mismatch. Every unverified ledger row must acquire an actual source/runtime test before parity sign-off. |

Candidate mobile job-board absence, deployed bundle identity, app-store review
timing, missing-route reachability and provider-only state remain UNVERIFIED here.
No new frontend inventory PR is opened; discrepancies are recorded in SHU-97 only.

## Cross-cluster jobs and side effects

All legacy console jobs stay **off** in every fixture/import run. Do not invoke
Yii ActiveRecord save hooks while loading a baseline: source lifecycle hooks can
send mail, update indexes or copy/delete objects. `jobs.csv` inventories every
console action; `source-gaps.csv` records model save/delete hooks separately.
These are not executable scripts or authorization to replay history.

| Job family / pinned receipt | Data dependency and isolated plan |
| --- | --- |
| Minute tasks, transfer-file processing, campaigns; `P:cron/cronlist:2-4`, `CronController.php:316-373` | Work/profile/finance/communication. Import states as historical; replace clock and queue. No timers start automatically. Inject duplicate selection, stale processing lease, crash-before/after-commit and retry; one semantic output per run key. |
| Weekly payroll; `CronController.php:386-445` | Contract→assignment→payroll→notification. Source uses `$noOfPayout = 4` at `:388`. Fixture both four- and five-week months; proposed calendar policy remains a decision. No real transfer/payable generation. |
| Daily/mid-month/end-month/payable reminders; `CronController.php:225,457,471,621` and cron file | Candidate bank/civil status, assignments, organizations, payroll and mail. Synthetic expiry/absence/due-date cases; fake sender captures envelopes with no real recipients. Preserve consent/preference facts separately from disabled historical delivery state. |
| Revenue rollups and firing hitmap; `CronController.php:287,1049-1139` | Work/payroll→reporting. Rebuild from canonical facts; retain original aggregates only as comparison receipts. Source rollups increment; replay may double-count. Test repeat/missed/partial period and currency split. |
| Morning summary, recruiter report, attendance checks; `CronController.php:513,977`, `ReportController.php:16` | Recruiting/work/finance→scoped reporting/communication. Cron comments and expressions disagree: summary comment says 08:00 but expression is `0 5`; recruiter comment 20:00 but expression `0 17`. Preserve expressions, mark timezone unverified. Attendance cron is commented out. Test report scope, date cutoff and redaction. |
| Civil-expiry indexing / Algolia; `cron/cronlist:10`, `AlgoliaController.php:19`; `Candidate.php:3613` | Profile/reference data→derived search. Rebuild only allowlisted searchable projection; no civil number/photos/bank fields or private notes. Fake provider; source index IDs are not person keys. |
| Analytics and webhook fan-out; `EventManager.php:207-393`; cron segment actions `:797,853,909` | All clusters→Segment/Mixpanel/SQS/webhooks. SOURCE-VERIFIED fan-out calls include Mixpanel `:303`, SQS `:364`, webhook loop `:390-393`. Replace all sinks with captured synthetic event envelopes. Never replay imported events; retain dedupe and version state separately from active delivery queues. |
| Transfer reconciliation mail; `TransferFile.php:179-190,327-329,687-692` | Status becomes processing before the transaction; `markProcessed` sends mail before commit. Proposed target uses exclusive claim plus transactional outbox. Test rollback produces no sent notification, retry does not double-mark, and ambiguous bank line holds. This is reconciliation code, not proof that the function itself executes a bank payment. |
| Video and object conversion; `Candidate.php:2399-2581`, `ResourceController.php:18-52` | Profile/object metadata→transcoding, thumbnails and storage. Resource action deletes old S3 objects after conversion. Never execute it. Fabricate input/output/error receipts, not resumable provider job IDs. |
| Repairs/backfills; cron fill/validate/remove-duplicate/check-mismatch/kuwait-mom/fix-work/fix-education actions; `jobs.csv` | Historical corrective algorithms are not import normalization authority. Retain source anomaly as a conflict; test the proposed correction using synthetic inputs and obtain explicit policy before alteration. No replay of destructive migration commands. |
| Central DB sync, Xero and event emulation; `CentralDbController.php:20,58,95,132`, `XeroController.php:12,25,41`, `EventController.php:284` | External identity/accounting/analytics state. Disabled references only. Their existence does not prove current use; external authority/cursors/ownership unverified. No network access, reconnect or new credentials. |

Proposed `JobRun` contains kind/version, period, opaque input-manifest hash,
idempotency key, lease owner/expiry, attempt, started/finished instants,
`pending|running|succeeded|failed|unknown`, output receipt and outbox status.
Do not invent success/duration from the two legacy cron-log fields. No active
queue lease, device token, browser session, reset token or provider cursor survives
an import. Historical “paid”, “sent” and “processed” facts remain history.

## Isolated datasets and reconciliation acceptance

### S0: available now, entirely fabricated

Use a deterministic seed, frozen clock and per-run namespace. Fabricate at least
two unrelated organizations, one parent with two children, three stores, twelve
people with overlapping roles, multi-company contacts, and multiple candidates
with **intentionally identical synthetic emails but different source IDs**.
No copied fixture contents from an unknown-origin legacy dump. Expand the current
four-entity fixture harness through typed contracts; the current in-memory
implementation is not an all-domain PostgreSQL importer.

| Fixture pack | Required cases and observable assertions |
| --- | --- |
| Identity / organizations | Same numeric ID in different account tables; different issuer/same subject; same email/different people; ambiguous binding; revoked membership; cycle/orphan parent; candidate+staff+owner grants. Binding conflict has zero accepted links; cross-org reads/writes denied. |
| Profile / catalogues | Complete/partial/deleted/inactive profiles; duplicate skills/tags; current/past education; pending changes; bilingual text; civil expiry before/on/after test date; missing bank details; separate front/back IDs. Rejected fields never enter profile, search or audit output. |
| Work | Assigned/unassigned; overlapping assignments; manual/automatic sessions; open/closed/cross-midnight; both GPS points; missing/invalid GPS; negative/zero/null duration; approved/pending/rejected/appealed work; deleted assignment still referenced historically. Day totals match the selected status policy and exact seconds. |
| Recruitment | Open/closed/draft jobs; zero/many applicants; duplicate apply; stale eligibility; accepted/rejected/viewed invitation; scheduled/past/cancelled interview; internal/shared note sentinels; multi-version evaluation; each exam answer kind; fulltimer without candidate binding. Private sentinel never appears in candidate projection. |
| Finance | Hourly/fixed/monthly contracts; minute-only work; bonus-only; absent versus zero rate; parent fallback proposal; each transfer state; parent/child batch; null contract reference; currency mismatch; signed/maximum precision boundary; same key/different body; overpayment/unmatched/duplicate bank line; five-week month; internal payroll explicitly separate. Reconcile exact lines→batch→invoice in currency; unexplained discrepancy HOLD, no actual money movement. |
| Communication | Chat with each sender kind; shared/missing attachment; ticket with comment attachments; unread/read notifications; localized frozen text; campaign ready/processing/failed; duplicate/revoked webhook; opted-out contact; note with unknown polymorphic target. No real sender or outbound request; historical deliveries produce zero dispatch. |
| Reporting / operations | Empty and high-cardinality projections; repeated/missed monthly rollup; page-boundary filters; unknown setting; stale cron timestamp with no outcome; wrong target marker; absent/misleading revision; denied sink; duplicate job receipt. Rebuild deterministic totals and fail isolation preflight without writing. |
| Documents / mobile | Every family above, missing bytes, MIME mismatch, oversized file, unknown owner, wrong org/person, expired delivery, revoked grant, replaced version, orphan upload; offline/duplicate mobile submit and denied camera/GPS. Only valid synthetic private bytes become visible; stale links deny. |

### M1: proposed masked production-shaped dataset, not authorized or created

Approval owner is [SHU-105](https://linear.app/bawes/issue/SHU-105); executable
import/reconciliation is [SHU-103](https://linear.app/bawes/issue/SHU-103).
The request must name source snapshot, exact permitted fields/objects, operator,
purpose, allowed readers/writers, destination resource identity, maximum size,
expiry, purge/backup behavior and handling of the sealed source. Permission to
retain that source locally is not permission to transfer it to Coolify or this
workspace. No new approval or credentials are requested by SHU-97.

Proposed selection is **join-closed connected components**, not independent table
sampling. Select complete assignments/payroll batches/applications/support cases
and their owners/reference parents. Preserve 1:0, 1:1, 1:many, many:many,
cross-cluster edges, state frequencies and null/duplicate/error classes. A sampled
dataset preserves selected-component cardinality, not claimed whole-production
counts. Rare identifiable combinations should be replaced with synthetic
equivalents; do not claim anonymization merely because names were changed.

Masking is executed only in the subsequently authorized source boundary. Use one
private surrogate registry across clusters, preserving exact FK joins and snapshot
consistency. Replace names, contacts, civil/bank identifiers, IPs, device IDs,
addresses, free text, rich text, payloads, URLs, filenames and object bytes.
Use reserved `.invalid` email/web destinations and fake provider adapters. Remove
credentials entirely. Never publish unsalted hashes of low-entropy identifiers.
Dates move coherently per connected component with a fixed test clock; keep age,
expiry, payroll-month and timezone edge classes via fabricated overrides when a
simple shift would change their meaning. Financial values are regenerated from
balanced synthetic primitives, preserving precision/zero/sign/overflow classes,
not original salaries. Mask document metadata too, including EXIF, embedded
authors, links, PDF text and spreadsheet formulas.

Proposed access: one isolated loader identity can write the run-owned target;
test services get scoped synthetic/masked application access; reviewers receive
aggregate receipts, not the private source-key map or row data. Disable external
egress and all cron/provider adapters; disallow public object ACLs; separate DB,
object namespace and logs from staging's human login path. Encrypt storage and
any explicitly approved transport. Masked data remains restricted data.

Proposed retention for approval: raw working material never leaves its authorized
source boundary; delete temporary decrypted workspace at run completion, with a
maximum 24-hour window. Masked target expires after **14 days**, earlier on request;
no automatic backup/sync or extension. Remove replicas, volumes, object versions,
temp files, queues, caches, indexes, logs and the surrogate registry. Record purge
time, resource IDs, counts and failure/hold state without content. An unpurgeable
backup or legal hold blocks dataset admission unless its explicit retention is
approved. Logically deleting a document is insufficient physical-purge evidence.
These are proposed durations, not claims of existing policy or deletion guarantees.

### Required proof before import acceptance

1. Inventory closure: every source entity/field/relationship/object family has
   an approved disposition or explicit HOLD; added source fields and unknown
   enum/serialization values fail, not disappear. Resolve all relevant source
   gaps before executing a transfer; a map PR merging does not close them.
2. Reproducibility: identical synthetic seed/clock gives identical canonical
   manifest; second import is a no-op; changed body for one source key conflicts.
   Count entities, nulls, status buckets, edges and objects separately. Do not
   rely only on a total row count.
3. Relational proof: no orphan edge, hierarchy cycle, ambiguous identity or
   owner mismatch. Preserve historical payment snapshots even when current
   profile/company data differs. Reconcile selected-component cardinalities.
4. Business proof: exact per-currency line/batch/invoice sums; work-session/day
   totals by status; note visibility; no accepted pending-profile changes; no
   credential/session/provider-state carryover; no outbound effects.
5. Transaction/failure proof: inject crash after byte staging, before metadata
   commit, after commit/before receipt, during outbox send and between pages.
   Resume by manifest/checkpoint, never “start over and overwrite.” Uncertain
   commit enters reconciliation HOLD. Test with real isolated PostgreSQL
   transactions for the eventual importer, not only an in-memory mock.
6. Boundary proof: fake wrong-target marker/provider endpoint/public ACL blocks
   before write; inspect captured synthetic logs for unique PII sentinels;
   cross-role/cross-person reads fail. A quiet log is not a redaction test.
7. Purge proof: delete the disposable run and verify DB/object/cache/queue
   resources and copies are gone under the approved policy. Preserve only
   non-identifying counts, versions, verdicts and errors.

## Disputes, unknowns and independent verification handoff

| ID | Disposition / remaining requirement |
| --- | --- |
| DM-01 | **DISPUTED authority:** draft inventory or donor-schema counts cannot establish live columns. The 1,336 entries are a source census including 58 annotation-only entries, computed properties and wallet models. Resolve actual schema drift only through a separately authorized schema-only receipt; no live query in SHU-97. |
| DM-02 | **SOURCE-VERIFIED correction:** wallet tables require separate namespace. Their migrations/types/cardinality and active integration state remain UNVERIFIED. No automatic import or account merge. |
| DM-03 | **SOURCE-VERIFIED correction:** company status and chat unread counts are projections; staff salary process has model declarations not covered by this literal migration census. Annotation-only targets HOLD. |
| DM-04 | **DISPUTED receipts:** candidate-web job component line 253 does not exist at its stated pin; actual display logic is at 80–125. Admin `restrictedAccess` is at 602, not the inventory's 562. Corrected receipt does not independently validate every surrounding claim. |
| DM-05 | **UNVERIFIED:** effective FK/index set, SQL-mode/collation/timezone, deployed migration history, live duplicate/overflow/orphan counts, object existence/ACL/lifecycle, external worker inventory and app-store bundles. Source review is sufficient to plan tests, not to assert these facts. |
| DM-06 | **PROPOSED / pending decision:** financial rounding/weekly salary rule, scope of internal HR/finance/discounts, provider-only records, employer access to private candidate documents, inspector/manager grants and physical-retention periods. Existing decisions may be reused only with an exact receipt; recommendations in a draft are not decisions. |
| DM-07 | **SOURCE-VERIFIED gap:** existing private-document union lacks generic/support/assessment/finance attachments. All are mapped here, but executable import must first add reviewed typed ownership/admission contracts or explicitly HOLD them. |
| DM-08 | **UNVERIFIED beyond checked claims:** all 226 frontend inventory rows remain individually traceable; only the limited claims in the frontend table were independently checked in this session. Full frontend parity acceptance is not claimed. |

Draft evidence consulted as leads, at re-fetched heads: PR #50 `f2565189`, #52
`a01a9ae4`, #53 `9b9c6bb6`, #55 `39939395`, #56 `96517ca5`, #58 `25b1f737`,
#59 `67b966e9`, #60 `f6b271f2`, #61 `05ed51ef`, #62 `8d7f749f`, #63 `1f0beb13`.
The merged frontend inventory is pinned by the platform base above. These heads
are **not** verification receipts for this map. In particular, repeated finding
IDs and “zero money tests” wording in the finance draft are not accepted here;
source contains `common/tests/unit/models/TransferCandidateTest.php`.

Reproduce the static artifacts from a clean pinned checkout, without running Yii:

```sh
python tools/parity/data-map-census.py /path/to/pinned-studenthub /tmp/shu97-census
```

Compare all CSV bytes and manifest counts with this directory. The generator is
a deliberately limited lexical reader: it removes comments, preserves string
boundaries, inspects only migration `up/safeUp`, records literal Yii declarations,
and adds scalar model annotations. It does not evaluate conditions, PHP helper
calls, raw SQL, data updates, runtime schema discovery or DB connections. Two
conditional declarations are source possibilities, not proof of application.
Use the exception ledger and manual source receipts to challenge the instrument.

Independent different-family verifier: review the exact PR head, regenerate the census,
challenge wallet/source-key namespaces, financial units, computed fields, missing
attachment types, permission and environment claims. Inspect all unresolved rows
as HOLD rather than accepting coverage counts as truth. Check that the single PR
contains no production access, credentials, data, migration/deployment changes
or dispatch activation. Post **PASS or BLOCK bound to the full head SHA** on the
PR and SHU-97. The author must not self-PASS. The authorized merger may merge only
after that independent PASS and green required checks at the same head; a changed head
requires a new verdict. Approval of a mapping never authorizes executable import.
