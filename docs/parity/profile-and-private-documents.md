# Production parity inventory: profile and private documents

**Card:** SHU-123 (parent SHU-88). Feeds SHU-92 (first typed own-profile projection) and SHU-106 (full contract and slices).
**Production source:** `BAWES-Universe/studenthub` at `c2ce255` (Yii2 monolith, serving production). Every `path:line` below is at that revision; permalink base `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Method:** read-only static inspection of models, controllers, routes, components, cron, migrations, fixtures and tests. No database, bucket, or live-host access. No profile contents or credentials appear in this document.
**Donor note:** `bawes/studenthub-codex` is a failed-donor lessons source, not parity authority. Nothing here is taken from it.

## 1. What this cluster is

A candidate's profile in production is one wide row (`candidate`, 60+ columns) plus eight child tables, edited through roughly 45 single-purpose endpoints in the candidate app and viewed or edited by four other apps (staff, admin, company, manager) under different field projections. Documents (personal photo, resume, civil ID front and back, video) are S3 objects whose keys live in profile columns.

The one-app grant model collapses this to **one profile aggregate** and **one set of journeys** whose visible fields and permitted writes are decided by the caller's grant, not by which app they logged into. The matrix in section 6 is written in that shape.

## 2. Data model

### 2.1 `candidate` (profile columns, grouped)

Created in `console/migrations/m130524_201442_init.php`; columns added across 35 later migrations (list in Appendix A). Groups below are by meaning, not by migration.

| Group | Columns | Notes |
|---|---|---|
| Identity (identity cluster owns) | `candidate_id`, `candidate_uid` (20), `candidate_email` (unique among non-deleted), `candidate_new_email`, `candidate_email_verification`, `candidate_limit_email`, `candidate_password_hash`, `candidate_password_reset_token`, `candidate_auth_key` (32), `enable_two_step_auth` | `candidate_uid` generated on first save (`Candidate.php:1235`); it is the public QR identity on ID cards |
| Personal | `candidate_name`, `candidate_name_ar`, `candidate_gender` (1/2/3), `candidate_birth_date`, `candidate_phone` (20), `candidate_objective` (100), `candidate_intro` (text), `candidate_preferred_time` (100), `candidate_language_pref` (en/ar), `profile_url` (225) | `profile_url` is a vanity slug |
| Affiliation | `university_id`, `country_id` (nationality), `candidate_mom_kuwaiti`, `candidate_driving_license` (1 yes / 2 no), `utm_uuid` (campaign) | `university_id` and `country_id` are `required` (`:148`) |
| Location | `candidate_address_line1` (default "Kuwait"), `candidate_area_uuid`, `candidate_latitude`, `candidate_longitude` | |
| Civil ID (sensitive) | `candidate_civil_id` (unique among non-deleted, `:422-431`), `candidate_civil_expiry_date`, `candidate_civil_photo_front`, `candidate_civil_photo_back`, `candidate_civil_need_verification` | Photos are S3 keys |
| Media (sensitive) | `candidate_personal_photo`, `candidate_video`, `candidate_video_job_id`, `candidate_video_processed`, `candidate_resume` | S3 keys; see section 5 |
| Work status | `candidate_job_search_status` (0/1/2), `candidate_job_search_updated_at`, `candidate_committed` (0/1), `candidate_hourly_rate` (7,3), `store_id`, `currency_code` (3) | `hourly_rate`, `store_id` belong to work/finance clusters |
| Bank (finance cluster owns) | `bank_id`, `candidate_iban` (70), `bank_account_name` (35) | IBAN validated only for KWD (`:214-216`) |
| Lifecycle | `candidate_status` (0 pending / 1 ready / 10 active), `approved`, `deleted` (int), `is_duplicate`, `is_incomplete_profile`, `candidate_pending_profile` (CSV of missing fields), `candidate_created_at`, `candidate_updated_at` | `deleted` is a soft flag; `notDeleted()` scope at `CandidateQuery.php:331` |

### 2.2 Child tables

| Table | Columns (from model docblocks) | Delete convention | DDL location |
|---|---|---|---|
| `candidate_education` | `education_uuid` PK, `candidate_id`, `university_id`, `degree_uuid`, `major_uuid`, `graduation_year`, `is_currently_studying`, `education_type` ENUM(standard, custom_university, studying_abroad, not_studying), `custom_institution_name`, `custom_major`, timestamps | **hard delete** (`CandidateEducationController.php:345`) | not in migrations; only in `railway/staging/studenthub.sql` |
| `candidate_experience` | `candidate_experience_id`, `candidate_id`, `experience` (128), `employer` (128), `start_year`, `end_year`, `deleted`, created_at | model has `deleted`; controller **hard deletes** (`:187`); cron bulk `deleteAll` (`CronController.php:505`) | `m200729_094528` |
| `candidate_skill` | `candidate_skill_id`, `candidate_id`, `skill` (128), `deleted`, created_at | bulk replace via `update-skills` | `m200729_094528` |
| `candidate_link` | `cl_uuid` PK, `candidate_id`, `title`, `url`, timestamps | **hard delete** (`CandidateLinkController.php:138`) | not in migrations; SQL dump only |
| `candidate_certificate` | `certificate_uuid` PK, `certificate_type` (0 experience / 1 exam), `candidate_id`, `candidate_work_history_id`, `exam_uuid`, `store_id`, `company_id`, `parent_company_id`, `staff_id`, `start_date`, `end_date`, `is_deleted`, timestamps | `is_deleted` (third convention) | SQL dump only |
| `candidate_tag` | `candidate_tag_id`, `candidate_id`, `tag`, `reason`, `deleted`, `created_at`, `created_by` (staff) | `deleted` | `m230504_083255`, `m230521_161132` |
| `candidate_id_card` | `id`, `candidate_id`, `expiry_date`, `deleted`, timestamps | `deleted` | `m170502_143647` |
| `candidate_id_request` | `cir_uuid`, `candidate_ids` (CSV), `status`, `created_by`, `updated_by`, timestamps | hard delete (`CandidateIdRequestController.php:121`) | SQL dump only |
| `candidate_video_log` | `candidate_id`, `ip_address`, `created_at` | append-only | `m201105_122925` |

**Migration finding (for SHU-97/SHU-103):** four of the nine tables have no `createTable` in `console/migrations`. The live database, not the migration history, is the schema authority for this cluster.

### 2.3 Validation invariants (`common/models/Candidate.php`)

| Rule | Where | Behaviour |
|---|---|---|
| Age 16–25 | `validateAge` (`:141`, body `:~460`) | error on `candidate_birth_date` outside range |
| Required on save (default scenario) | `:148-150` | `university_id`, `country_id`, `candidate_email`, `candidate_birth_date`, `candidate_personal_photo`, `currency_code`; civil photos required except `staffUpdate` |
| Full name ≥ 2 words | `validateFullName` (`:527-541`) | applies to `candidate_name`, `candidate_name_ar`, `bank_account_name`; **always attaches the error to `candidate_name`** (`:540`) regardless of attribute (bug; do not replicate) |
| Email unique among non-deleted | `validateEmail` (`:~560`) | checks both `candidate_email` and `candidate_new_email`, excludes `deleted = 1` rows, so a deleted account's address can be re-registered |
| Civil ID unique among non-deleted | `validateCivilIdNumber` (`:422-431`) | |
| Civil ID not expired | `validateCivilExpiry` | error if `candidate_civil_expiry_date < today` |
| Civil ID OCR | `validateCivilID` (`:~440-475`) | when both photos set and changed: Textract reads `photos/<front>`; sets `candidate_civil_expiry_date` and `candidate_civil_id` from OCR; rejects expired; silently continues on OCR failure |
| IBAN | `validateIban` (`:~500-520`) | KWD only; must contain a known `bank_iban_code`; exactly 30 alphanumerics |
| Hourly rate | `validateHourlyRate` | > 0 and ≤ company (or parent company) rate; finance cluster |
| Enumerations | `:229-236` | gender 1/2/3; job search 0/1/2; committed 0/1; language en/ar |
| Temporary-bucket existence | `S3FileExistValidator` rules `:250-305` | per scenario: personal photo, video, resume, civil front, civil back must exist in the temporary bucket before save |
| Signup IP throttle | `beforeSave` `:1255-1275` | > 10 signups from one forwarded IP → error |

### 2.4 Profile completeness

`isInCompleteProfile()` (`:3405-3480`) marks a profile incomplete if any of: `candidate_uid`, `country_id`, `candidate_name`, `candidate_name_ar`, gender, objective, personal photo, email, phone, birth date, civil ID number, civil expiry, civil front, civil back, driving licence, location (lat/long or area). University is commented out. The missing-field names are persisted as CSV in `candidate_pending_profile` (`:1251`) and surfaced as `pendingField` and `isProfileCompleted` in every API projection (`fields()`, `:~4200`).

## 3. Who sees what: per-role projection

Each app overrides `fields()` on a subclass of `common\models\Candidate`. This is the production visibility rule.

| Field group | Candidate (self) `candidate/models/Candidate.php:45-80` | Staff `staff/models/Candidate.php:22-44` | Admin `admin/models/Candidate.php:19-31` | Company `company/models/Candidate.php:18-77` | Manager `manager/models/Candidate.php:17-70` |
|---|---|---|---|---|---|
| Personal, affiliation, location, work status, completeness | yes | yes | yes | yes | yes |
| Email, phone | yes | yes | yes | **never** (unset unconditionally `:44-45`) | never |
| Civil ID number, expiry, `civilExpired` | yes | yes | yes | yes | yes |
| Civil ID photos (keys) | yes | yes | yes | **only if candidate's `store_id` is one of the employer's managed stores** (`:49-63`) | only for own store |
| Resume key, lat/long, `ip_address` | yes | yes | yes | only for managed stores | resume hidden always; lat/long as company |
| Bank (`bank_id`, IBAN, account name), hourly rate | yes | yes | yes | never (`bank` forced to `[]`) | never |
| `candidate_uid`, `employee_id` | `uid` hidden (`:~4230`) | yes | yes | never | never |
| `approved`, `deleted`, `candidate_status`, timestamps | hidden | yes | yes (`deleted` re-exposed) | never | never |
| Auth key, password hash, reset token | never | never | never | never | never |
| Derived extras | `bank_account_needed`, `working_hour_count`, `totalInterviewScheduled` | `candidate_personal_photo_url` | | `is_our_employee` | |

**Scope of the lookup, separate from the projection:**

- Candidate: every own-profile endpoint loads `Candidate::findOne(Yii::$app->user->getId())`; child controllers scope `findModel` to the caller's `candidate_id` (`CandidateEducationController.php:372-384`, `CandidateExperienceController.php:214-226`, `CandidateLinkController.php:167-179`). No cross-person read path found in the candidate app.
- Company: `GET v1/candidates/<id>` resolves any id (`company/.../CandidateController.php:731-740` via `filterById`, `CandidateQuery.php:293-296`, which adds only `candidate_id = ?`). This is the recruitment marketplace: employers may view any candidate at the projection above. Sensitive keys appear only when the candidate is in a managed store.
- Manager: `view` and `list` are scoped to the manager's own `store_id` (`manager/.../CandidateController.php:40-47`).
- Staff and admin: unscoped by design.

## 4. External effects and jobs

| Effect | Component | Trigger | Data leaving the perimeter |
|---|---|---|---|
| Object storage, two buckets | `common/components/S3ResourceManager.php` | every document write | objects written with `ACL: public-read` (`:111`, `:123`, `:147`); URLs from `getObjectUrl(..., $expires=null)` (`:198`) are permanent and unsigned (SHU-54) |
| Client-side upload credentials | `candidate/.../AwsController.php:64-73` (`GET v1/aws/config`) | any authenticated candidate | **returns the temporary bucket's AWS access key id and secret to the client**, with the comment `//todo: key with expiry`. See finding F1 |
| Civil ID OCR | `IdExpiryDateExtractor.php` (AWS Textract `:38`, `detectDocumentText` `:55`) | civil photo change; cron | civil ID image sent to Textract |
| Video transcoding | `MediaConvert.php:153-169` | `POST v1/account/video` | output to `candidate-video/` with `CannedAcl: PUBLIC_READ` (`:165`); completion via unauthenticated `POST video-by-webhook` (`AccountController.php:57`, `:229`) |
| Image CDN | `CloudinaryManager.php`; legacy `photos/` personal photos served through Cloudinary (`Candidate.php:2798-2810`) | read; one-off cron `resource/s3-to-cloudinary` (`ResourceController.php:18-44`) migrates then deletes the S3 object | profile photos |
| Search index | `Candidate::updateAlgoliaIndex` (`:3613-3655`) | most profile saves except language/email/password scenarios (`:860-883`); removed when `deleted` or not looking (`:893-905`) | profile fields to Algolia (discover/recruit cluster owns the index; this cluster owns the trigger) |
| Product analytics | `EventManager.php` (Segment, SQS, webhooks `:5-8`) | insert in prod (`Candidate.php:906-920`) | `Candidate Profile Created` with name, email, age, gender, university, country |
| Email | Yii mailer | staff-created account gets a temporary 5-character password (`staff/.../CandidateController.php:176`, `:202`); email change starts verification (`AccountController.php:513-556`) | |
| Internal note | `Note` model | ID card generation writes an internal note (`CandidateIdCardController.php:250-254`) | |

**Scheduled jobs touching this cluster** (`console/controllers/CronController.php`):

| Action | Line | Behaviour | Disposition |
|---|---|---|---|
| `fill-civil-id-expiry-date` / `-not-assigned` | `:96`, `:116` | Textract every candidate with both civil photos and no expiry; writes expiry | ADAPT as an async verification job |
| `validate-civil-id` | `:137` | re-validates | ADAPT |
| `remove-duplicate` | `:489-511` | if a candidate's skill list equals their experience list, **hard-deletes all their experiences** and re-indexes | **CONSTRAINT: never replicate**; data-loss heuristic with no audit |
| `update-candidate-stats` | `:1049` | recomputes `candidate_stats` | work cluster |
| `resource/s3-to-cloudinary` | `ResourceController.php:18` | one-off migration | DISCARD after migration inventory |

## 5. Document lifecycle

1. Client calls `GET v1/aws/config`, receives region, bucket, **access key id and secret** (`AwsController.php:69-72`), and uploads directly to the temporary bucket.
2. Client posts the object key to a profile endpoint. The model's `S3FileExistValidator` rule confirms the key exists in the temporary bucket (`Candidate.php:250-305`).
3. On save the object is copied to the permanent bucket with `public-read`:
   - personal photo → `candidate-profile-photos/` for new uploads (`:117`), legacy `photos/` (`:120`); promotion at `:2878-2905`
   - civil ID front/back → `civil-id/<file>` by `_moveTemporaryFilesToPermanentBucket` (`:125-129`, `:1170-1186`), while `normalizeCivilIdPermanentS3Key` (`:2760-2780`) maps `candidate-civil-id/…` and bare names to `photos/…`, and OCR reads `photos/<front>` (`:~445`). **Three prefixes for one document type; the live key layout must be inventoried before migration.**
   - resume → `candidate-resume/` (`:2361-2380`)
   - video → temporary bucket → MediaConvert → `candidate-video/` (`:2422-2445`)
4. A thumbnail is generated for photo uploads (`:1183`, `_generateThumbnail :1195`).
5. Replace or remove: DB commit first, then best-effort S3 delete of the old key with structured error logging (`AccountController.php:418-435`, `:483-500`; resume `Candidate.php:2337`). 
6. Account delete (self or admin) **does not touch objects**: `Candidate` has no `beforeDelete`/`afterDelete` and `deleted=1` triggers no storage call (SHU-54, confirmed at this revision).
7. Retention: none defined anywhere in the cluster.

## 6. Parity matrix: journeys

Columns: **Actor / grant** in the one-app model; **Legacy route(s)**; **Writes**; **Invariants and effects**; **Legacy tests** (what the Codeception suite actually asserts); **Disposition** (REQUIRED / ADAPT / EXCLUDE-PENDING-OWNER / OTHER-CLUSTER); **Slice** (section 7).

### 6.1 Read

| ID | Journey | Actor / grant | Legacy route(s) | Reads | Legacy tests | Disposition | Slice |
|---|---|---|---|---|---|---|---|
| PD-01 | View own profile | person, `self` | `GET v1/account/profile` (`AccountController.php:80`) | full self projection §3 + `expand` of any `extraFields` | `AccountCest::tryToGetProfile` asserts 200 and own `candidate_id` | REQUIRED | S1 (SHU-92) |
| PD-02 | View own education / experience / skills / links | person, `self` | `GET v1/candidate-educations`, `…-experiences`, `…-links`; skills inline | owner-scoped lists | none | REQUIRED | S3 |
| PD-03 | Staff views any candidate | staff, `subtree` | `GET v1/candidates/<id>` staff app; `list`, `assigned`, `not-assigned` (`:86`, `:1131`, `:1205`) | staff projection (everything except secrets) | `staff CandidateCest` list/search assert 200 only | REQUIRED | S6 |
| PD-04 | Admin views / searches / review queue | admin | `search` (`admin/.../CandidateController.php:76`), `report-search :151`, `total-to-review :199`, `view :342` | admin projection incl. `deleted` | `admin CandidateCest` 8 methods, 200 + partial JSON | REQUIRED | S6 |
| PD-05 | Employer views a candidate | org-owner / recruiter, org scope | `GET v1/candidates/<id>` company app (`:691`), `search :25`, `list :83` | company projection §3; any id | `company RequestCest` etc. 200-only (per GPT's sample) | REQUIRED, with decision D1 | S7 |
| PD-06 | Store manager views own store's candidates | manager, store scope | `manager/.../CandidateController.php:19-48` | manager projection, store-scoped | none | REQUIRED | S7 |
| PD-07 | Public ID verification page | anonymous | QR target `v.studenthub.co/<candidate_uid>` (`CandidateIdCardController.php:100-113`) | not in this repo (separate host) | none | UNRESOLVED: target app not inventoried | S8 |

### 6.2 Self-service writes (all `Candidate::findOne(user id)`, scenario-gated; all return `operation: success|error`)

| ID | Journey | Legacy route | Scenario / fields | Invariants and effects | Legacy tests | Disposition | Slice |
|---|---|---|---|---|---|---|---|
| PD-10 | Update names | `POST update-name`, `update-names`, `update-name-ar` (`:983`, `:951`, `:1045`) | `updateName` / `updateNameAr` | ≥ 2 words | `tryUpdateName`, `tryUpdateNameAR` (200 + success) | REQUIRED | S2 |
| PD-11 | Gender, birth date, objective, intro, preferred time, language, profile URL | `update-gender :1225`, `update-birth-date :1593`, `update-objective :1194`, `update-intro :1163`, `update-preferred-time`, `language-pref :639`, `update-profile-url :1014` | one scenario each | age 16–25; enum checks | one 200-test each except intro/profile-url | REQUIRED (D4 for age) | S2 |
| PD-12 | Nationality, university, driving licence, Kuwaiti-mother flag | `update-nationality :820`, `update-university :1256`, `update-driving-license :851`, `update-kuwaiti-national`, `update-nationality-with-kuwaiti-status` | | FK existence | 200-tests | REQUIRED | S2 |
| PD-13 | Location | `update-location :1074`, `GET area-by-location :1112` | lat/long/area | area FK; Google Maps lookup | `tryUpdateLocation`, `tryGetAreaByLocation` | REQUIRED | S2 |
| PD-14 | Job-search status, committed | `POST job-search-status :679`, `GET :663`; committed via staff `toggle-committed` | `updateJobSearchStatus` sets `candidate_job_search_updated_at`; not-looking removes from Algolia (`Candidate.php:893-897`) | | `tryToGetJobStatus`, `tryToUpdateJobStatus` assert value | REQUIRED | S2 |
| PD-15 | Phone | `update-phone` | | ≤ 20 chars; no format rule (commented out `:203`) | `tryUpdatePhone` | REQUIRED | S2 |
| PD-16 | Email change | `update-email :513` | `updateEmail`: sets `candidate_new_email`, starts verification | uniqueness among non-deleted | `tryUpdateEmail` | OTHER-CLUSTER (identity, SHU-124): profile owns the trigger only | — |
| PD-17 | Skills (bulk replace) | `update-skills :163` | deletes and recreates `candidate_skill` rows; re-index | | `tryUpdateSkills` | REQUIRED, ADAPT to soft delete + audit | S3 |
| PD-18 | Experiences (bulk replace) | `update-experiences :88` | as skills | | `tryUpdateExperiences` | REQUIRED, ADAPT | S3 |
| PD-19 | Education CRUD | `candidate-educations` list/save/create/update/delete/view (`:71-384`); reference lists major/degree-group/degree | owner-scoped; custom institution required for custom/abroad types | hard delete | **none** | REQUIRED, ADAPT (soft delete) | S3 |
| PD-20 | Experience CRUD (itemised) | `candidate-experiences` (`:68-226`) | owner-scoped | hard delete | none | REQUIRED, ADAPT | S3 |
| PD-21 | Links CRUD | `candidate-links` (`:68-179`) | owner-scoped | hard delete | none | REQUIRED, ADAPT | S3 |
| PD-22 | Personal photo set / remove | `profile-photo :922`, `DELETE remove-photo :356` | `candidate_personal_photo`, `changeProfilePhoto` | temp-bucket existence; promotion §5; thumbnail | `tryUpdateProfilePhoto`, `tryRemovePhoto` | REQUIRED, ADAPT (private storage, scoped upload credential) | S4 |
| PD-23 | Resume set / remove | `update-resume :1287`, `remove-resume :1335` | `updateResume` | promotion to `candidate-resume/`; old key deleted | `tryUpdateResume` | REQUIRED, ADAPT | S4 |
| PD-24 | Civil ID photos set / remove | `update-civil-photo-front :1414`, `-back :1362`, `DELETE remove-civil-photo-front :447`, `-back :382` | `updateCivilPhotoFront/Back` | OCR on change (expiry + number extracted); expired rejected; DB-first then best-effort object delete | five tests incl. BH/KW variants (200-only) | REQUIRED, ADAPT | S4 + S5 |
| PD-25 | Civil ID number and expiry (manual) | `update-civil-id :1130`, `update-civil-expiry-date :1467`, `update-civil-id-expiry-date :1518` | `updateCivilId` sets `candidate_civil_need_verification`; `updateCivilExpiryDateAndCivilID` | uniqueness; not expired | three tests | REQUIRED | S5 |
| PD-26 | Video set / remove / status | `video :880`, `remove-video :331`, `GET video-status :216`, webhook `:229` | `tmpVideo`, `changeVideo` | MediaConvert, public output, unauthenticated completion webhook | four tests | EXCLUDE-PENDING-OWNER (D3) | — |
| PD-27 | Bank details | `update-bank-detail :557` | `updateBankDetail`; syncs open transfers (`Candidate.php:839-856`) | IBAN rules | `tryUpdateBankDetail` | OTHER-CLUSTER (finance, SHU-128) | — |
| PD-28 | Password, two-step auth, sessions | `change-password :758`, `toggle-two-step-auth :138`, `discard-session`, `validate-password` | | | seven password tests assert messages | OTHER-CLUSTER (identity) | — |
| PD-29 | Delete own account | `DELETE remove-candidate-profile` (`:~1880-1900`) | `deleteCandidate`: email → `deleted_<date>_<email>`, phone and civil ID → null, `deleted = 1`; Algolia delete; all tokens deleted | objects retained | none | REQUIRED, ADAPT (retention D6, object cleanup) | S9 |

### 6.3 Staff and admin on a candidate

| ID | Journey | Legacy route | Fields / effects | Legacy tests | Disposition | Slice |
|---|---|---|---|---|---|---|
| PD-30 | Staff creates candidate | `POST v1/candidates` staff (`:172-250`) | 27 body params → columns; random 5-char temporary password emailed (`:176`, `:202`) | `restCallToCreateCandidate` | REQUIRED, ADAPT: invitation through Universe, no password | S6 |
| PD-31 | Staff updates candidate | `PATCH v1/candidates/<id>` (`:252-340`) | `staffUpdate` scenario, 26 attributes (`Candidate.php:318-326`); civil photos not required | `restCallToUpdateCandidate` (200) | REQUIRED | S6 |
| PD-32 | Tags with reason | `add-tag :343`, `update-tags :375` | `candidate_tag` rows with `created_by`; re-index | none | REQUIRED | S6 |
| PD-33 | Staff sets job-search status, email, civil expiry | `:395`, `:431` (deletes candidate tokens `:448`), `:459` | scenarios `updateJobSearchStatus`, `updateCandidateEmail`, `updateCivilExpiryDate` | none | REQUIRED | S6 |
| PD-34 | Hourly rate, assign / unassign to store, transfer cost | `:497`, `:544`, `:822`, `:521` | | assign/unassign 200 | OTHER-CLUSTER (work SHU-126, finance SHU-128) | — |
| PD-35 | Mark duplicate / mark not deleted / merge | `:1170`, `:1014`, `:1713-1730` → `Candidate::merge` (`Candidate.php:3369-3395`) | merge re-points child rows and deletes source tokens | `restCallToMergeAccounts` (200) | REQUIRED, ADAPT: audited, reversible | S9 |
| PD-36 | Admin approve / delete / restore / reset password | `:249` (`approved = 1`), `:370` (`deleted = 1`, Algolia delete), `:290`, `:419` | | `tryToApprove` asserts JSON | REQUIRED (approve, delete, restore); reset-password → identity | S6, S9 |
| PD-37 | **Login as candidate** (impersonation) | staff `:1107-1121`, admin `:223-237` | regenerates `candidate_auth_key` as a **4-character** random string (`Candidate.php:1847-1850`), redirects to `candidateAppUrl?auth_key=…`; consumed once by `login-by-key` (`AuthController.php:159-184`), which clears it | none | EXCLUDE-PENDING-OWNER (D2); see F2 | — |
| PD-38 | ID cards: generate, renew, list expired, view | `CandidateIdCardController.php` generate `:190` (expiry +3 months `:231`, internal note `:250`), renew `:363`, lists `:147`, `:167`, `:342`, `:436`, view `:90` | view is HTML with QR to `v.studenthub.co/<uid>`; authenticated by **bearer token in the URL path** (`:90-93`) | `CandidateIdCardCest` 7 methods, 200-only | REQUIRED, ADAPT (signed short-lived link) | S8 |
| PD-39 | Certificates (experience / exam) and PDFs | `CertificateController.php` list `:64`, create `:111`, from-work-history `:188`, update `:241`, delete `:274`, PDF `:147`; candidate downloads own appreciation certificate (`candidate/.../CandidateController.php:115-160`, mPDF) | `is_deleted` flag; PDF rendered on demand, not stored | none | REQUIRED; data from work cluster | S8 |

## 7. Bounded slices for SHU-106 (each PR-sized; none is a mega-PR)

| Slice | Scope | Depends on | Reuses | Points (initial) |
|---|---|---|---|---|
| **S1 — Own-profile read projection** (= SHU-92) | Typed projection of the safe field set: names, gender, birth date and age, nationality, university, objective, intro, preferred time, language, location (area), driving licence, job-search status, committed, completeness (`isProfileCompleted`, `pendingField`), employee id, civil-expiry boolean. **Excludes** civil ID number and photos, resume, bank, video. Rendered in the existing `/profile` page. | none | `authzStore.getPrincipal`, web-ui | 3 |
| S2 — Safe self-edits | PD-10 to PD-15 as preview → confirm → receipt writes with the invariants in §2.3 | S1, SHU-84 | safe-write contract (SHU-82) | 5 |
| S3 — Education, experience, skills, links | Owner-scoped CRUD with soft delete and audit; reference lists (degree, major) | S1 | safe-write | 5 |
| S4 — Private documents | Personal photo, resume, civil photos: direct upload with **short-lived, object-scoped credentials** (no static key), private-by-default objects, authorized time-bounded retrieval, replace/remove with object GC | SHU-101 | | 8 |
| S5 — Civil ID verification | Async OCR job (Textract or replacement) writing expiry and number with `need_verification`; uniqueness among non-deleted; expiry gate | S4 | | 3 |
| S6 — Staff and admin on a candidate | PD-03, PD-04, PD-30 to PD-33, PD-36: full projection, `staffUpdate` field set, tags with reason, approve, invitation instead of temporary password | S1, S2, grants `subtree` | authz grants | 5 |
| S7 — Employer and manager projections | PD-05, PD-06: org- and store-scoped visibility per §3, with decision D1 applied | S1 | authz `org_id` scope | 3 |
| S8 — ID cards and certificates | PD-38, PD-39: generate with 3-month expiry, renew, PDF, public verify page by signed link | S4 (photo) | | 5 |
| S9 — Lifecycle | PD-29, PD-35, PD-36 delete/restore: soft delete, retention policy, object cleanup, audited merge; **no duplicate-heuristic deletion** | S4 | audit (SHU-59) | 3 |

Out of this cluster by decision or ownership: PD-16, PD-28, reset-password (identity, SHU-124/SHU-98); PD-27, PD-34 rate/transfer (finance, SHU-128/SHU-100); assign/unassign (work, SHU-126/SHU-95); Algolia/Meilisearch index (discover/recruit, SHU-125/SHU-99); PD-26 video and PD-37 impersonation pending D3/D2.

## 8. Findings not previously recorded

| ID | Finding | Evidence | Severity | Recommended card |
|---|---|---|---|---|
| **F1** | `GET v1/aws/config` returns a long-lived AWS access key id and secret to every authenticated candidate, with `//todo: key with expiry`. Whoever holds a candidate login can write to the temporary bucket directly and, depending on the IAM policy attached to that key, possibly more. | `candidate/modules/v1/controllers/AwsController.php:64-73`; route `candidate/config/main.php:43-50` | **High**, legacy, live | New legacy security card, same shape as SHU-54: read-only check of the key's IAM policy first, then decide fix-now vs accept-until-cutover (D7) |
| F2 | Impersonation uses a 4-character random `auth_key`, passed in a URL query string, exchangeable for a full session by `POST login-by-key` on any non-deleted candidate. Only a `Yii::info` line records it. | `Candidate.php:1847-1850`; `staff/.../CandidateController.php:1107-1121`; `admin/.../CandidateController.php:223-237`; `candidate/.../AuthController.php:159-184` | Medium–High (brute-force space 64^4 if the endpoint is unthrottled; not verified) | Identity cluster (SHU-124); platform replaces with audited act-as or drops (D2) |
| F3 | Staff bearer token travels in the URL path of the ID card view page | `CandidateIdCardController.php:67`, `:90-93` | Medium | S8 replaces with signed short-lived link |
| F4 | Cron `remove-duplicate` hard-deletes every experience row of a candidate whose skills equal their experiences | `CronController.php:489-511` | Medium (data loss, no audit) | CONSTRAINT in S9; migration must not run it |
| F5 | Employers see civil ID photo keys, resume key and coordinates for candidates in their managed stores; with public-read objects (SHU-54) those images are readable by anyone with the key | `company/models/Candidate.php:49-63` | Decision | D1 |
| F6 | Profile creation sends name, email, age, gender to Segment in prod | `Candidate.php:906-920` | Decision | D5; P4 telemetry (SHU-90/SHU-104) |
| F7 | Three key prefixes for civil ID photos (`civil-id/`, `candidate-civil-id/`, `photos/`); OCR path assumes `photos/` | `Candidate.php:125-129`, `:1170-1186`, `:2760-2780`, `:~445` | Migration risk | SHU-97 data map must inventory real keys |
| F8 | Four child tables have no migration DDL | §2.2 | Migration risk | SHU-97 |
| F9 | `validateFullName` mis-targets its error | `Candidate.php:540` | Low | do not replicate |

## 9. Classification of prior donor findings

| Source | Claim | Classification at `c2ce255` |
|---|---|---|
| SHU-34 ledger | Profile data model (Candidate + skills/education/work_history/links) → ADAPT | **Production-supported**; this document is the evidence |
| SHU-34 | Three candidate UI generations, which is live unverified | **Unresolved**. Repos: `studenthub-candidate-react` (pushed 2026-09-04), `-next` (2026-08-19), `-candidate` Cordova (2026-07-06). UI parity is not covered here; the API surface above is what any of them consumes |
| SHU-34 | `studenthub-codex` deleted | Stale (corrected on the card) |
| SHU-39 / SHU-54 | `ACL => public-read`, permanent unsigned URLs | **Production-supported**, lines re-confirmed; live bucket policy still unverified (SHU-54 item 1) |
| SHU-39 | Hard deletes without audit | **Production-supported** in this cluster: education, experience, link controllers and the duplicate cron |
| SHU-39 | Inconsistent soft-delete conventions | **Production-supported**: `deleted` int on candidate/skill/experience/id_card/tag, `is_deleted` on certificate, none on education/link |
| SHU-39 | Algolia receives candidate PII on a cron | **Production-supported** and also on most saves (`:860-883`) |
| SHU-39 | Watermarking absent | Confirmed absent in this cluster |
| SHU-39 | Local-disk storage fallback; 74 cascade relations | **Donor-only** (codex). Legacy is S3-only; child cleanup is explicit `deleteAll`, not FK cascade |
| SHU-39 | Token expiry cleanup cron | Identity cluster; not re-examined here |
| SHU-46 correction | Xero DEFER | Not this cluster |
| SHU-54 | `Candidate` lacks delete hooks; five explicit S3 deletes on replace/remove | **Production-supported**, both confirmed |

## 10. Decisions needed from the owner (batched)

| ID | Decision | Default if undecided |
|---|---|---|
| D1 | May employers see civil ID images, resume and coordinates of candidates in their stores? | Hide images and coordinates; keep resume behind authorized time-bounded retrieval |
| D2 | Keep staff "login as candidate"? | Replace with audited act-as (actor + subject both recorded) or drop |
| D3 | Keep candidate intro video? | Exclude from parity until asked |
| D4 | Is the 16–25 age gate still policy? | Keep as configurable rule |
| D5 | Send profile PII to analytics? | Only with consent and only identifiers, in P4 telemetry work |
| D6 | Retention after delete: documents, profile rows | Documents purged after a grace period; row soft-deleted and audited |
| D7 | F1 static AWS credential in the legacy app: fix now or accept until cutover? | Read the key's IAM policy first, then decide, same as SHU-54 |

## 11. Not established

- Live bucket policy and whether objects are actually public (SHU-54 item 1).
- The IAM policy attached to the credential returned by `v1/aws/config`.
- Which candidate UI production users are on, and any behaviour that lives only in those UIs.
- Real row counts, real key prefixes in the bucket, and any data not reachable from the code.
- The `v.studenthub.co` verification app (QR target) is a separate deployment not in this repository.

## Appendix A: `candidate` column migrations

`m170219_151757` (name_ar, birth_date, civil fields, hourly_rate), `m170223_132254` (store_id), `m170303_134250` (approved), `m170306_112515` (bank_id, iban), `m170307_121642` (phone, bank_account_name), `m170420_125428` (university_id), `m170425_134445` (country_id), `m170427_123738` (personal_photo), `m170529_071050` (address_line1), `m200722_135609` (language), `m200724_100421` (new_email, email_verification, limit_email; nullable birth/civil/rate/auth_key), `m200729_094528` (driving_license, resume, gender, objective; creates skill and experience tables), `m200807_134023` (job_search), `m200907_135723` / `m201009_153032` / `m201019_103154` (video, processed, job id, webhook), `m200922_070412` (area, lat, long), `m201105_063330` (committed), `m201106_074724` (mom_kuwaiti), `m211123_120542` (pending_profile), `m230406_110939` (profile_url), `m230113_065332` (intro), `m230504_083255` (tags), plus `is_duplicate`, `is_incomplete_profile`, `utm_uuid`, nullable password hash.

## Appendix B: legacy test coverage for this cluster

| Suite | Methods | What they establish |
|---|---|---|
| `candidate/tests/functional/AccountCest.php` | 44 | one per account endpoint; almost all assert HTTP 200 plus `operation: success`; 12 assertions commented out; password tests assert messages; job-status tests assert the value |
| `candidate/tests/functional/CandidateCest.php` | 2 | work-history list and certificate PDF return 200 |
| `staff/tests/functional/CandidateCest.php` | ~16 | create, update, assign, unassign, merge, reset-password return 200 |
| `staff/tests/functional/CandidateIdCardCest.php` | 7 | all endpoints return 200, including token-in-URL view |
| `admin/tests/functional/CandidateCest.php` | 8 | list/search/approve/view with partial JSON |
| Education, experience, link CRUD | **0** | no legacy tests exist |
| Fixtures | `common/fixtures/Candidate*.php` + `data/candidate*.php` | synthetic rows for candidate, experience, skill, id_card, token, video_log, work_history, email_verify |

The fixtures are reusable as-is for platform synthetic tests. The tests are a route inventory more than a behaviour oracle; porting them gives coverage of "endpoint exists and does not 500", not of the invariants in §2.3, which must be written fresh.
