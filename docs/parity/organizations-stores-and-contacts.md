# Production parity inventory: organizations, stores, contacts and reference data

**Card:** SHU-125 (parent SHU-88). Feeds SHU-98 (organizations contract), SHU-91 (one-app role and organization context), SHU-97 (data map).
**Production source:** `BAWES-Universe/studenthub` at `c2ce255`. Every `path:line` is at that revision; permalink base `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Method:** read-only static inspection. No database, bucket or live-host access. No personal data, credentials or bucket contents.
**Coverage:** 167 of 1,016 functional production actions (`docs/parity/coverage.md`, cluster OR, regenerated at `84ab149`: `staff/CompanyRequest` (company onboarding) and `admin/Staff::actionListCompanies` now belong here; the two `company/Store` assignment-request actions moved to work, matching §OR-18's own hand-off).
**Authentication note:** where an org journey touches login, the legacy mechanism is migration evidence only. Universe through Authentik is the target credential authority (`docs/parity/identity-and-access.md`).

## 1. What this cluster is

The customer side of production: a **company** that hires, its **sub-companies**, its **stores** (physical locations where candidates work), the **contacts** who are its people, the **store managers** who supervise one location, and the shared vocabulary everything else references (brands, malls, areas, countries, currencies, universities, majors, degrees, banks, tags).

Two structural facts drive the platform design:

1. **The hierarchy is exactly one level deep.** `company.parent_company_id` points at a parent; there is no recursion anywhere. Sub-company stores are reached by collecting the parent's id plus its children's ids and querying stores in that set (`company/components/StoreManager.php:40-46`).
2. **Company status is derived, not stored,** unless an operator overrides it. `company_status` is computed at read time from three counters, and `company_status_override` short-circuits it (`common/models/Company.php:253-262` in `fields()`, and again in `getCompany_status() :276-285`). The same logic is duplicated a third time in the employer projection (`company/models/Company.php:33-41`), where it **omits the override**, so an employer and a staff member can see different statuses for the same company.

## 2. Data model

### 2.1 `company` (`console/migrations/m130524_201442_init.php`, 12 later migrations)

| Group | Columns |
|---|---|
| Identity | `company_id`, `company_name`, `company_common_name_en/_ar`, `company_email`, `company_website`, `company_description_en/_ar`, `company_logo`, `commercial_licence` |
| Hierarchy and ownership | `parent_company_id`, `staff_id` (owning account manager), `country_id`, `currency_code` |
| Commercial terms | `company_hourly_rate` (decimal), `company_bonus_commission` (percent) |
| Derived counters | `total_candidate`, `no_of_active_requests`, `is_request_updates_in_30_days`, `last_request_datetime`, `last_payment_datetime` |
| Lifecycle | `company_status` (10 active / 9 under review / 0 inactive), `company_status_override`, `company_approved_to_hire`, `deleted` |
| CRM follow-up | `company_followup` (bool), `company_followup_interval_weeks`, `company_last_followup_datetime`, `company_next_followup_datetime` |
| Legacy credential columns | `company_auth_key`, `company_password_hash`, `company_password_reset_token` from the original init migration; superseded by the `contact` model. Unused by any live login path (identity inventory §2.1 lists no company principal). Confirm as dead before migrating |

Rate inheritance: both `company_hourly_rate` and `company_bonus_commission` fall back to the parent company when null (`admin/models/Company.php:35-45`, `company/models/Company.php:43-48`). A company's rate must not be below any of its candidates' rates (`Company::validateHourlyRate`, `common/models/Company.php:148-158`) — note the error is attached to `candidate_hourly_rate`, an attribute this model does not have.

Worked example in the source comment (`common/models/Company.php:55-62`): company rate 1.5 KWD, bonus commission 20%; a candidate at 1.2 KWD for 2 hours plus a 20 KWD bonus bills the company 23 KWD. The margin between company rate and candidate rate is the revenue, which is what `CompanyStats.total_revenue` accumulates (`CronController.php:actionUpdateCompanyStats :1109-1128`).

### 2.2 Other tables

| Table | Key columns | Delete | DDL |
|---|---|---|---|
| `store` | `store_id`, `company_id`, `store_manager_uuid`, `brand_uuid`, `mall_uuid`, `store_name`, `store_location`, `store_total_candidates` (counter), `store_status`, `deleted` | soft (`deleted`) | `m170223_125009` |
| `contact` | `contact_uuid`, name, email, verification and credential columns, `contact_receive_email/suggestions/notification`, `contact_status`, `deleted` | staff soft-deletes; admin hard-deletes | **not in migrations** (SQL dump only) |
| `company_contact` | `company_contact_uuid` PK; `(company_id, contact_uuid)` unique; `contact_position`, `allow_access` (bool), `created_by` | staff `RemoveFromTeam` and employer `RemoveMember` hard-delete the link; there is no `deleted` column | `m200820_144521` |
| `contact_email`, `contact_phone` | extra addresses and numbers per contact | replaced with `deleteAll` + recreate during contact update | with `contact` |
| `contact_invitation` | `contact_invitation_uuid`, `contact_uuid`, `company_id`, `email_to_invite`, `role`, `otp` | | with `contact` |
| `store_manager` | `store_manager_uuid`, `company_id`, `store_id`, name, email, credentials | with the store | `m240422_190025` |
| `company_request` | `company_request_uuid`, company and contact fields, `requesting_for`, `status` (0 pending / 1 processing / 2 accepted / 3 rejected), `country_id`, `currency_code` | | `m230706_042813` |
| `store_assignment_request` | `sar_uuid`, `candidate_id`, `store_id`, `currency_code`, `status` (pending/accepted/rejected/cancelled) | | |
| `brand` | `brand_uuid`, `company_id`, names en/ar, `brand_logo` | hard delete | `m200818_104012` |
| `mall` | `mall_uuid`, names en/ar | hard delete | `m200911_052307` |
| `area` | `area_uuid`, `country_id`, names, lat/long, created/updated by | | `m200922_070412` |
| `country` | `country_id`, names, nationality names, `country_from_google_map`, `currency_code` | | `m170425_132300` |
| `currency` | `currency_id`, `title`, `code`, `currency_symbol`, `rate`, `decimal_place`, `sort_order`, `status` | | `m240214_084103` |
| `university` | `university_id`, names, `university_data_source` (0 admin / 1 candidate), created/updated by, `deleted` | soft | `m170419_144751` |
| `major` | `major_uuid`, names, `data_source` | | `m240523_133605` |
| `degree`, `degree_group` | names, sort order, `skip_major` | | **not in migrations** |
| `bank` | `bank_id`, `bank_name`, `bank_iban_code`, `bank_swift_code`, `bank_code_abk`, `bank_transfer_type` (local / international / within-bank), `deleted` | soft | `m170303_143806` |
| `tag` | `tag_id`, `tag` | hard delete | `m230510_035749` |
| `note` | `note_uuid`, ten nullable subject FKs (`company_id`, `candidate_id`, `request_uuid`, `interview_evaluation_uuid`, `request_checklist_uuid`, `invitation_uuid`, `suggestion_uuid`, `contact_uuid`, `story_uuid`, `fulltimer_uuid`), `note_type` (Internal Note / Phone Call / Email / Meeting / Interview / Task), `note_text`, `created_by` | | |

**Migration gaps for SHU-97:** `contact`, `degree` and `degree_group` have no `createTable` in `console/migrations`. Same class of gap as the four profile child tables. The live database is the schema authority.

**Note shape:** one table with ten nullable subject foreign keys is a polymorphic attachment. In the platform this should be one note entity with a typed subject reference, not ten columns.

## 3. Visibility: what each role sees of a company

Production defines this by subclassing `common\models\Company` per app and overriding `fields()`.

| | Employer (`company/models/Company.php:16-50`) | Manager (`manager/models/Company.php:16`) | Staff (`staff/models/Company.php:16-40`) | Admin (`admin/models/Company.php:29-67`) |
|---|---|---|---|---|
| Identity, logo, website, descriptions | yes | yes | yes (website normalised to add `http://`) | yes |
| `company_hourly_rate` | **yes**, with parent fallback | yes | yes | yes, with parent fallback |
| `company_bonus_commission` | no | no | no | **yes**, with parent fallback |
| `company_status` | derived, **override ignored** | derived | derived, override applied | derived, override applied |
| `company_status_override` | exposed as a raw field | exposed | exposed | exposed |
| `company_approved_to_hire` | yes | yes | yes | yes |
| Counters (`total_candidates`, `total_subcompanies`, `total_stores`, `total_suggestions`) | no | no | `total_candidates`, `total_suggestions` | all four |
| `deleted` | hidden (unset in base `fields()`) | hidden | hidden | hidden |
| Timestamps | no | no | unset | yes |

The employer projection is a hand-written whitelist, not `parent::fields()` minus unsets, which is why the override-ignoring status duplicate exists there and nowhere else.

**Scope of the lookup** (separate from the projection):

- Employer: `getSubCompanies()`, `getStores()`, `getSubCompanyStores()` all resolve from the authenticated contact's company (`company/models/Company.php:103-130`). `StoreManager::getManagedStores()` caches "stores of my company plus my sub-companies" behind a `DbDependency` (`company/components/StoreManager.php:30-50`).
- Manager: one store, one company; `getSubCompanies` exists but the manager app exposes only `ListChild` and `View` (`manager/modules/v1/controllers/CompanyController.php`, 2 actions).
- Staff and admin: unscoped. Staff has an `AssignedList` for companies where `staff_id` is the caller (`staff/.../CompanyController.php:152`).
- `status` app: read-only reporting projections over companies, requests, transfers (reporting cluster, RP).

## 4. Lifecycle journeys

### 4.1 Company onboarding

Two paths converge on the same shape.

**Self-service** (`company/modules/v1/controllers/AuthController.php:585-640`, mirrored in the manager app): creates a `contact`, a `company_request` with status pending, and a `company` with `company_approved_to_hire = false` and `company_status_override = STATUS_UNDER_REVIEW`. The password handling here is legacy and out of scope per the identity inventory.

**Staff approval** (`staff/.../CompanyRequestController.php` `Approve` → `CompanyRequest::approve()`, `common/models/CompanyRequest.php:267-330`): sets request status accepted, creates the `Contact`, creates the `Company` with `company_approved_to_hire = true`, creates the `company_contact` link with `allow_access = true`, and creates `contact_phone` rows. The line that would activate the company is **commented out** (`:312`), so an approved company keeps whatever `company_status_override` it was created with. Worth confirming against live data during migration.

**Direct creation** by staff or admin (`staff/.../CompanyController.php` `Create`, `admin/.../CompanyController.php` `Create`): 17 body parameters including `parent` (making it a sub-company), `hourly_rate`, `bonus_commission`, `approved_to_hire`, `logo`, `commercial_licence`, `currency_code` (defaulting to a `Currency` request header then `"KWD"`, `admin/.../CompanyController.php:238-242`). Scenario is `newAccount` or `newSubAccount`; the sub-account scenario requires only the hourly rate (`common/models/Company.php:99-102`).

### 4.2 Status and approval

- `ChangeStatus` (staff `:330`, admin) writes `company_status_override` under scenario `updateStatus` and logs a `Yii::info` line.
- Setting the override to **under review** triggers an email to `company_email` copied to every other contact of the company, plus a Segment event (`common/models/Company.php:508-540`). No other status transition notifies anyone.
- `Activate` (`company/.../CompanyController.php:228-325`) is excluded from bearer authentication and accepts `contact_auth_key`, contact email, company id, an optional password, logo and commercial licence. It marks the contact email verified and sets `company_status_override = STATUS_ACTIVE`. **This is an anonymous legacy invitation/activation flow, not an authenticated org-owner action, and it has no staff review step.** Authentik replaces its identity mechanics; D-OR1 decides the surviving business approval rule.
- `company_approved_to_hire` is set at creation and by staff/admin `Update`; it gates listing filters (`filterByApprovedToHire`) and has no separate transition route.

### 4.3 Deletion

- Company: soft delete, refused when the company still has stores (`admin/.../CompanyController.php:370-395`).
- Store: soft delete, refused when candidates are still assigned (`staff/.../StoreController.php` `Delete`).
- Contact and membership use three different paths: staff `Delete` soft-deletes the `contact` row (`deleted = true`, `staff/.../CompanyContactController.php:432-459`); admin `Delete` hard-deletes the contact (`admin/.../CompanyContactController.php:383-400`); staff `RemoveFromTeam` and employer `RemoveMember` hard-delete only the `company_contact` membership link (`staff/...:399-425`; `company/...:73-104`). The `ContactEmail::deleteAll` / `ContactPhone::deleteAll` calls replace child rows during update, not account deletion.
- Brand, mall, tag: hard delete with no dependency check.

### 4.4 Team membership

`Create` a contact with a company id, or `AddToTeam` an existing contact, both writing a `company_contact` row with `allow_access` (`staff/.../CompanyContactController.php:242`, `:286-292`). `RemoveFromTeam` hard-deletes that link (`:399-425`). One contact can belong to several companies; `getManagedCompanies()` goes through the links that have access (`common/models/Contact.php:319-341`). At login the session picks **the first** such company (`company/.../AuthController.php` `_loginResponse`), and nothing in the legacy API switches it afterwards. The target decision is already made in SHU-91: show the current organization and allow explicit context switching.

### 4.5 Stores and managers

`Create` a store takes name, company, location, brand and mall, and optionally creates a `StoreManager` in the same request (`staff/.../StoreController.php:128-140`). The manager's `company_id` is set to the **parent** company when one exists (`:130-131`), so a manager of a sub-company store is recorded against the parent. `UpdateManager` and `RemoveManager` maintain it; `Login` mints a manager impersonation key (identity inventory §3.8).

`StoreAssignmentRequest` lets an employer ask for a candidate to be assigned to one of its stores (`company/.../StoreController.php:StoreAssignmentRequest`), with a four-state status. The assignment itself belongs to the work cluster (SHU-126).

### 4.6 Follow-up (account management CRM)

`company_followup`, `company_followup_interval_weeks`, `company_last_followup_datetime`, `company_next_followup_datetime`, a `Followups` listing in both staff and admin apps, and `AddFollowupNote` writing a `Note` against the company. This is CRM inside the product. Decision D-OR3 asks whether it moves to Attio rather than being rebuilt.

## 5. Reference data: who owns the vocabulary

| Entity | Admin | Staff | Employer | Candidate |
|---|---|---|---|---|
| University | full CRUD + excel export | list, view | — | **list, create, is-exists** (`candidate/.../UniversityController.php:109` sets `university_data_source = FROM_CANDIDATE`) |
| Major, degree, degree group | full CRUD | — | — | read through the education endpoints |
| Country | CRUD + export | list, view | list | list |
| Currency | CRUD | list | list | — |
| Bank | CRUD | list | — | — |
| Tag | CRUD | list, view | — | — |
| Brand | CRUD | CRUD + per-company list | — | — |
| Mall | — | CRUD | — | — |
| Area | — | — | — | read via Google Maps lookup |

Two things to carry forward: candidates can create universities, so the table contains unmoderated user input (`university_data_source` distinguishes it, and nothing consumes that flag); and brands and malls are staff-owned but scoped per company only for brands.

Currency carries a `rate` column with no code path that updates it — no exchange-rate provider call exists anywhere in the repository. Rates are maintained by hand or stale. Decision D-OR4.

## 6. External effects

| Effect | Where | Notes |
|---|---|---|
| Company logo, commercial licence, brand logo | temporary bucket then permanent copy, same mechanism as profile documents (`common/models/Company.php:118-140`, `common/models/Brand.php setLogo`) | public-read objects (SHU-54); commercial licences are business documents on unsigned URLs |
| Status-change email | `common/models/Company.php:508-540` | to the company address, copied to all other contacts; ElasticMail pool header |
| Segment tracking | same block, `:537` | company status transitions |
| Payroll email | `staff/.../CompanyController.php:365-390` | sends payroll summary to company contacts |
| Excel exports | `admin/.../CompanyController.php:829` `DownloadCandidatesExcel`, `:860` `DownloadListExcel`, `University` export | **bulk personal data leaves the system as spreadsheets with no audit record** |
| Store counter maintenance | `Candidate::afterSave` adjusts `store_total_candidates` and `Company::updateCandidate` (profile inventory §4) | counters drift, hence the reconciliation cron |
| `cron/check-if-candidate-total-mismatch` | `CronController.php:200-224` | detects counter drift between `store_total_candidates` and reality |
| `cron/update-company-stats` | `:1109-1128` | writes `CompanyStats.total_revenue` from `company_total - candidate_total` per currency |
| Google Maps geocoding | `staff/.../GoogleMapController.php`, area lookup | address to area resolution |

## 7. Parity rows

Actor names are platform grants, not legacy apps. Disposition: REQUIRED, ADAPT, OTHER-CLUSTER, or EXCLUDE-PENDING-OWNER.

| ID | Journey | Actor / grant | Legacy routes | Legacy tests | Disposition | Slice |
|---|---|---|---|---|---|---|
| OR-01 | View own organization | org member | `company/.../CompanyController.php` `View`, `List` | `company CompanyCest` 9 methods, 6 JSON | REQUIRED | O1 |
| OR-02 | View sub-organizations | org member | `ListChild` (employer, manager) | in the above | REQUIRED | O1 |
| OR-03 | Update own organization profile | org owner | `Update`, `UpdateLogo`, `RemoveLogo`, `UpdateLicence` | 1 | REQUIRED (through safe-write) | O2 |
| OR-04 | Complete legacy invitation and activate a company | anonymous invitee holding contact auth key | `Activate` (`company/.../CompanyController.php:228`) | none | Identity mechanics REPLACED by Authentik; company approval remains **EXCLUDE-PENDING-OWNER** (D-OR1) | — |
| OR-05 | Staff/admin list, search, filter organizations | staff, admin | staff `List`, `AssignedList`, `Followups`; admin `List`, `SubCompanies`, `Followups` | `admin CompanyCest` 17 (11 JSON), `staff CompanyCest` 12 (0 JSON) | REQUIRED | O5 |
| OR-06 | Create organization or sub-organization | staff, admin | staff/admin `Create` | 2 | REQUIRED | O5 |
| OR-07 | Update commercial terms (rate, commission, currency) | admin | admin `Update` | 1 | REQUIRED, admin-only capability | O5 |
| OR-08 | Change status / approve to hire | staff, admin | `ChangeStatus`, `Update` | 1 | REQUIRED, with the notification | O5 |
| OR-09 | Assign account manager | admin | `UpdateStaff` (`admin/.../CompanyController.php:655`) | none | REQUIRED | O5 |
| OR-10 | Follow-up flag, interval, note | staff, admin | `UpdateFollowup`, `UpdateFollowupInterval`, `AddFollowupNote`, `Followups` | none | **EXCLUDE-PENDING-OWNER** (D-OR3) | — |
| OR-11 | Delete organization | admin | admin `Delete` (blocked while stores exist) | 1 | REQUIRED | O6 |
| OR-12 | Company sign-up request and approval | anonymous → staff | `create-account`, `CompanyRequestController` `List`/`View`/`Approve`/`Reject` | `company AuthCest::tryToSignup` | REQUIRED (identity part is Universe's) | O3 |
| OR-13 | List, view team members | org member | `company/.../CompanyContactController.php` `List`, `View`, `ViewCompanyContact` | `admin CompanyContactCest` 10, `staff` 11 | REQUIRED | O4 |
| OR-14 | Invite / add a person to the organization | org owner, staff, admin | `Create`, `AddToTeam`, `contact_invitation` | 4 | REQUIRED as a grant invitation | O4 |
| OR-15 | Set or revoke a member's access | org owner, staff, admin | `allow_access` on the link; `RemoveFromTeam` | 2 | REQUIRED as grant presence | O4 |
| OR-16 | Remove a membership or deactivate a person | org owner, staff, admin | `RemoveFromTeam` / `RemoveMember` hard-delete a membership; staff `Delete` soft-deletes a contact; admin `Delete` hard-deletes it | 2 | REQUIRED, **ADAPT to audited grant revocation and soft account deactivation** | O4, O6 |
| OR-17 | Contact extra emails and phones | staff, admin | maintained with the contact | none | REQUIRED | O4 |
| OR-18 | Switch which organization I am acting for | org member with several orgs | **does not exist in legacy** | none | REQUIRED (new); explicit context switching is already selected and implemented by SHU-91 | O4 |
| OR-19 | List, view stores | org member, manager, staff, admin | `StoreController` in four apps | `staff StoreCest` 17 (0 JSON), `admin` 5, `company` 8 | REQUIRED | O7 |
| OR-20 | Create, update, delete a store | staff | staff `Create`, `Update`, `Delete` | in the above | REQUIRED | O7 |
| OR-21 | Assign, change, remove a store manager | staff | `UpdateManager`, `RemoveManager` | none | REQUIRED as a store-scoped grant | O7 |
| OR-22 | Request a candidate for a store | org member | `StoreAssignmentRequest`, `CancelStoreAssignmentRequest` | none | OTHER-CLUSTER (work, SHU-126); org owns the store scope only | — |
| OR-23 | Brands: list, create, update, delete | staff, admin | `BrandController` (staff 7, admin 6) | `staff BrandCest` 9 (0 JSON), `admin` 7 (5 JSON) | REQUIRED | O8 |
| OR-24 | Malls | staff | `MallController` 7 | `staff MallCest` 8 (2 JSON) | REQUIRED | O8 |
| OR-25 | Countries, currencies, banks, tags | admin write, others read | four controllers × up to five apps | none | REQUIRED, one catalogue service | O8 |
| OR-26 | Universities, majors, degrees, degree groups | admin write; **candidate create for universities** | admin CRUD; `candidate/.../UniversityController.php` `Create` | none | REQUIRED, ADAPT: candidate submissions become moderated suggestions | O8 |
| OR-27 | Notes on companies and contacts | staff, admin | `NoteController` in three apps | none | REQUIRED as one typed note entity | O9 |
| OR-28 | Excel exports of candidates and lists | admin | `DownloadCandidatesExcel`, `DownloadListExcel`, university export | none | REQUIRED, **ADAPT: authorized, audited, time-bounded** | O9 |
| OR-29 | Counter reconciliation | system | `cron/check-if-candidate-total-mismatch` | none | ADAPT: derive counts rather than store them | O10 |
| OR-30 | Company revenue statistics | system | `cron/update-company-stats` | none | OTHER-CLUSTER (reporting SHU-137, finance SHU-128) | — |
| OR-31 | Payroll email to company contacts | staff | `PayrollEmail` | none | OTHER-CLUSTER (finance) | — |
| OR-32 | Firing chart / hit map per company | staff | `FiringChart`, `cron/gen-hit-map` | none | OTHER-CLUSTER (work SHU-126) | — |
| OR-33 | Year report | admin | `YearReport` | none | OTHER-CLUSTER (reporting SHU-137) | — |

## 8. Legacy tests and fixtures mapped

| Suite / fixture | Methods | Journeys it touches | What it establishes |
|---|---|---|---|
| `admin/tests/functional/CompanyCest.php` | 17 (11 JSON) | OR-05, 06, 07, 08, 09, 11 | list, view, create, update, status, delete return 200 with some field assertions |
| `staff/tests/functional/CompanyCest.php` | 12 (0 JSON) | OR-05, 06, 08 | HTTP 200 only |
| `company/tests/functional/CompanyCest.php` | 9 (6 JSON) | OR-01, 02, 03 | employer self-view and update |
| `admin/CompanyContactCest.php` | 10 (8 JSON) | OR-13, 14, 15, 16 | contact CRUD and team membership |
| `staff/CompanyContactCest.php` | 11 (5 JSON) | same | |
| `staff/StoreCest.php` | 17 (0 JSON) | OR-19, 20, 21 | every store endpoint returns 200 |
| `admin/StoreCest.php` | 5 (2 JSON) | OR-19 | |
| `company/StoreCest.php` | 8 (1 JSON) | OR-19, 22 | |
| `staff/BrandCest.php` | 9 (0), `admin/BrandCest.php` 7 (5) | OR-23 | |
| `staff/MallCest.php` | 8 (2) | OR-24 | |
| Fixtures | `CompanyFixture`, `CompanyContactFixture`, `ContactFixture`, `ContactEmailFixture`, `ContactPhoneFixture`, `ContactInvitationFixture`, `StoreFixture`, `StoreManagerFixture`, `BrandFixture`, `MallFixture`, `BankFixture`, `CountryFixture`, `UniversityFixture` + matching `data/*.php` | | reusable as synthetic seeds for platform tests |

**Untested behaviour in this cluster, explicitly:** company self-activation (OR-04); every follow-up endpoint (OR-10); account-manager assignment (OR-09); store manager assign, change, remove (OR-21); store assignment requests (OR-22); every reference-data endpoint except brands and malls (OR-25, OR-26); notes (OR-27); all Excel exports (OR-28); both cron jobs (OR-29, OR-30); the status-change email and its Segment event; rate inheritance from parent company; and the `validateHourlyRate` rule. Company and store fixtures exist, so these are cheap to cover on the platform — they were simply never written.

## 9. Findings

| ID | Finding | Evidence | Severity | Action |
|---|---|---|---|---|
| **OR-F1** | The anonymous legacy activation route accepts a contact auth key and can move the linked company to active with no staff review | `company/modules/v1/controllers/CompanyController.php:228-325`; auth exception at `:24` | Medium (business control) | Authentik replaces the key/password flow; D-OR1 decides staff approval |
| **OR-F2** | The employer projection recomputes `company_status` **ignoring** `company_status_override`, so employer and staff can see different statuses for the same company | `company/models/Company.php:33-41` vs `common/models/Company.php:253-262` | Medium (data integrity) | fix by construction in O1: one derivation, one place |
| **OR-F3** | A contact belonging to several companies is silently bound to whichever the query returns first, with no way to switch | `company/.../AuthController.php` `_loginResponse`; `Contact::getManagedCompanies` | High for the one-app model | OR-18; resolved in SHU-91 with explicit context switching |
| **OR-F4** | Deletion semantics conflict by actor: staff soft-deletes contacts, admin hard-deletes contacts, and staff/employer hard-delete membership links; none produces an audit receipt | §4.3 | Medium | O4, O6 |
| **OR-F5** | Bulk candidate data leaves through Excel exports with no authorization record | `admin/.../CompanyController.php:829`, `:860` | Medium (privacy) | O9, and P4 telemetry |
| **OR-F6** | `currency.rate` exists but no code updates it; no exchange-rate provider anywhere | `common/models/Currency.php`; repo-wide grep for rate providers finds nothing | Medium (money correctness) | D-OR4 |
| **OR-F7** | `CompanyRequest::approve()` has the company-activation line commented out, so approved companies keep their under-review override | `common/models/CompanyRequest.php:312` | Low–Medium | verify against live data in SHU-97 |
| **OR-F8** | Candidates can create university rows; `university_data_source` marks them but nothing consumes the flag | `candidate/.../UniversityController.php:109` | Low (data quality) | OR-26 |
| **OR-F9** | Store managers of sub-company stores are recorded against the **parent** company id | `staff/.../StoreController.php:130-131` | Low, but it will distort a naive grant import | note in SHU-97 |
| **OR-F10** | Company logos and commercial licences are public-read objects on unsigned URLs, same as profile documents | §6; SHU-54 | Medium | folded into SHU-54 / slice O2 |
| **OR-F11** | `Company::validateHourlyRate` attaches its error to `candidate_hourly_rate`, an attribute the Company model does not have, so the message is likely never surfaced | `common/models/Company.php:148-158` | Low | do not replicate |
| **OR-F12** | The `company` table still carries `company_auth_key`, `company_password_hash`, `company_password_reset_token` from the original migration | `m130524_201442_init.php` | Low | confirm dead, exclude from migration |

## 10. Classification of prior findings

| Source | Claim | At `c2ce255` |
|---|---|---|
| SHU-34 ledger | Company/store/contact hierarchy is reusable structure → ADAPT | **Production-supported**; the hierarchy is one level, not arbitrary depth |
| SHU-39 | Inconsistent delete conventions | **Production-supported** here too: soft on company, store, university, bank; hard on contact, brand, mall, tag |
| SHU-39 | Public-read S3 objects | **Production-supported**, extends to company logos and commercial licences |
| SHU-39 | Counters denormalised and drifting | **Production-supported**: `total_candidate`, `store_total_candidates`, `no_of_active_requests`, plus a cron that exists only to detect the drift |
| SHU-46 | Xero DEFER | Not this cluster (finance) |
| SHU-51 | Marketplace expansion is an open decision | Untouched; nothing in this inventory presumes it |

## 11. Bounded slices for SHU-98

| Slice | Scope | Depends on | Points |
|---|---|---|---|
| O1 | Organization read model: one company entity, one status derivation (fixing OR-F2), parent/child in one level, per-grant projection | SHU-91 | 5 |
| O2 | Organization profile writes: name, descriptions, website, logo, commercial licence through preview → confirm → receipt, with private document storage | SHU-84, SHU-101 | 5 |
| O3 | Onboarding: sign-up request, staff review, approve/reject, organization creation with explicit initial status | O1 | 3 |
| O4 | Membership and context: invite, grant, revoke, remove, extra contacts, **and organization switching (OR-18)** | O1, identity I3 | 8 |
| O5 | Staff and admin administration: list/search/filter, create incl. sub-organization, commercial terms as an admin-only capability, status change with notification, account-manager assignment | O1 | 5 |
| O6 | Lifecycle and retention: soft delete everywhere, dependency guards, audited member removal | O1, SHU-59 | 3 |
| O7 | Stores: CRUD, brand and mall association, store-scoped manager grant | O1, identity I4 | 5 |
| O8 | Reference-data catalogue: countries, currencies, banks, tags, brands, malls, universities, majors, degrees and degree groups, with moderated candidate submissions | — | 5 |
| O9 | Notes and exports: one typed note entity; authorized, audited, time-bounded exports | O1, SHU-59 | 5 |
| O10 | Derived counters: compute rather than store, or reconcile with an audit | O1 | 2 |

Cluster total: **46 points**, against the 8-point placeholder on the delivery card. Running total for the two clusters sized so far: profile 40, organizations 46.

## 12. Decisions for Khalid

| ID | Decision | Recommended default | Cost of waiting |
|---|---|---|---|
| D-OR1 | After Authentik invitation/verification, may a company become active from its own onboarding submission, or must staff approve it? | Staff review. Activation is a business control the applicant should not hold | Blocks O3 only; O1 and O2 proceed |
| D-OR3 | Rebuild the follow-up CRM (OR-10) in StudentHub, or move account management to Attio? | Move to Attio; StudentHub keeps notes attached to records | Nothing blocked now; deciding late means building it twice |
| D-OR4 | Currency rates have no source (OR-F6). Fix rates per contract, or integrate a rate provider? | Fix per contract, since billing is per-company and per-currency already | Blocks nothing until multi-currency invoicing; wrong answer is expensive to unwind |

## 13. Not established

- Whether any company currently sits in a state that `CompanyRequest::approve()` left inconsistent (OR-F7) — needs the database.
- Real counts of sub-companies, stores per company, contacts per company, and how many contacts belong to more than one company — the last one sizes the impact of OR-18.
- Whether `company_auth_key` and its siblings hold values.
- The employer, staff, admin and manager front ends, which live in other repositories (SHU-138).
