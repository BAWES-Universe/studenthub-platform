# Production parity inventory: identity and access

**Card:** SHU-124 (parent SHU-88). Feeds SHU-99 (access administration contract), SHU-130 and SHU-131 (subject keying), SHU-91 (one-app role and organization context).
**Production source:** `BAWES-Universe/studenthub` at `c2ce255`. Every `path:line` is at that revision; permalink base `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Method:** read-only static inspection. No database, provider console, or live-host access. No credentials, tokens, keys, or personal data appear here.
**Coverage:** 125 of 1,016 functional production actions (`docs/parity/coverage.md`, cluster ID, regenerated at `84ab149`). `cron/daily` purges six token tables as a secondary effect and is recorded as such in the ledger.

## 1. What this cluster is

Production has **six separate credential stores**, one per application, each with its own table, token table, password hash, reset token, and login controller. Which table a person's row is in decides which app they can use; that is the coarsest and most reliable authorization rule in the system. Inside an app, authorization is a handful of hard-coded checks. A permission model exists in the database and in the admin UI but is enforced nowhere on the server.

In parallel, the candidate app dual-writes new sign-ups to Auth0, and a console job once bulk-exported candidate and staff password hashes into Auth0's import format. These legacy Auth0, Google, Apple, password, OTP and email-verification mechanics are migration and security evidence only, not target parity requirements. Universe through Authentik is the sole target credential and verification authority; StudentHub retains principal links, grants and product-level account state.

## 2. Data model

### 2.1 Principal tables

| Principal | Table, key | Credential and status columns | Created by | Deleted how |
|---|---|---|---|---|
| Candidate | `candidate.candidate_id` | `candidate_email` (unique among non-deleted), `candidate_password_hash` (nullable since social login), `candidate_auth_key` (32, used as a 4-char impersonation key), `candidate_password_reset_token`, `candidate_email_verification`, `candidate_new_email`, `candidate_limit_email`, `candidate_limit_sms`, `enable_two_step_auth`, `approved`, `candidate_status`, `deleted`, `is_duplicate` | self (signup, Google, Apple, Auth0), staff (`staff/.../CandidateController.php:172`) | soft: `deleted = 1`, email renamed with date prefix, phone and civil ID nulled (profile inventory PD-29) |
| Staff | `staff.staff_id` | `staff_email`, `staff_password_hash`, `staff_auth_key`, `staff_password_reset_token`, `staff_role` (number), `staff_status`, `enable_two_step_auth`, `deleted`; also `staff_gmail_username`, `staff_gmail_password` (reversibly encrypted, see F3) | admin (`admin/.../StaffController.php:298-330`, password supplied in the request body) | soft: `deleted = 1`, `staff_status = 0`, email prefixed `deleted at <ts>-` (`common/models/Staff.php:1076-1080`); `RecoverAccount` reverses it (`StaffController.php:550-565`) |
| Admin | `admin.admin_id` | `admin_email`, `admin_password_hash`, `admin_auth_key`, `admin_password_reset_token`, `admin_status`, `admin_limited_access`, `enable_two_step_auth` | admin (`AdminController.php`, password in request) | `Status` toggle; `Delete` |
| Contact (employer user) | `contact.contact_uuid` | `contact_email`, `contact_password_hash`, `contact_auth_key`, `contact_otp`, `contact_email_verification`, `contact_email_verified_by`, `contact_new_email`, `contact_limit_email`, `contact_status` (10 active / 0 inactive), `contact_receive_email/suggestions/notification`, `deleted` | self (company sign-up), staff or admin (`CompanyContactController.php`, password in request `:184`), or `AddToTeam` for an existing contact | staff/admin `Delete` is a **hard delete** with `ContactEmail`/`ContactPhone` `deleteAll` (`staff/.../CompanyContactController.php:362-363`, `:414`); `RemoveFromTeam` sets `deleted` on the link (`:453`) |
| Company ↔ contact link | `company_contact (company_id, contact_uuid)` unique | `allow_access` boolean, `contact_position`, `created_by` | staff/admin | the link row |
| Store manager | `store_manager.store_manager_uuid` | `email`, `password_hash`, `new_email`, `email_verification`, `phone_number`, `limit_email`, `company_id`, `store_id` | staff, as a side effect of creating or updating a store (`staff/.../StoreController.php:128-131`, `:260-265`; `company_id` is the parent company when one exists) | with the store |
| Inspector | `inspector.inspector_uuid` | `inspector_email`, `inspector_password_hash`, `inspector_auth_key`, `inspector_password_reset_token`, `inspector_status`, `inspector_deleted`, `enable_two_step_auth` | admin (`InspectorController.php`) | `inspector_deleted` |
| Wallet user | `wallet_user` in a **separate database** (`WalletUser::getDb()` → `walletDb`, `common/models/WalletUser.php:39-41`) | `username`, `email`, `password_hash`, `auth_key`, `verification_token`, `status` | unknown; the wallet integration was disabled 2025-11-30 (SHU-39) | unknown |

`contact` itself has no `createTable` in `console/migrations`; it exists only in the SQL dump. `company_contact` was added in `m200820_144521`, `store_manager` in `m240422_190025`.

### 2.2 Token tables (six, one shape)

`admin_token`, `candidate_token`, `contact_token`, `inspector_token`, `manager_token`, `staff_token` (created in `m170209_151757_create_token_tables.php` for the first four): `token_value`, `token_device`, `token_device_id` (user agent, 250 chars), `token_status` (1 active / 0 inactive / 5 expired), `token_last_used_datetime`, `token_expiry_datetime`, `ip_address`, `otp`, `total_attempt`, `token_created_datetime`.

### 2.3 Permission tables (`m221017_131312_permission.php`)

`permission_section (permission_uuid, section_name)`, `permission_sub_section (…, sub_section_slug, permission_uuid)`, `permission_user (permission_user_uuid, admin_id | staff_id, permission_sub_section_uuid)`. Managed through `admin/.../PermissionSectionController.php` (11 actions) and read back by `staff/.../PermissionSectionController.php` (3) and `Staff::getPermissions()` (`common/models/Staff.php:1351`). **No other reference in the codebase** (`grep` over all controllers, modules and models for `PermissionUser`, `getPermissions(`, `sub_section_slug`, `hasPermission`, `checkPermission` returns only those). See finding F4.

### 2.4 Other identity tables

`blocked_ip (ip_uuid, ip_address, note)`; `candidate_email_verify_attempt (ceva_uuid, code, candidate_email, ip_address, created_at)` and `contact_email_verify_attempt` (same shape, `email`), neither with an expiry column.

## 3. Authentication mechanisms

### 3.1 Password login

`GET v1/auth/login` in every app with HTTP Basic credentials (`candidate/.../AuthController.php:47-56`; same pattern in the other five) and a `g-recaptcha-response` header verified against Google (`common/components/ReCaptcha.php:49`). On success a per-device token is issued (§3.2). Candidate login is refused until the email is verified and returns an `unVerifiedToken` for the verification screen instead (`:17-22` of `actionLogin`). `approved` is returned in the login payload but does not block login.

Password hashes are Yii `generatePasswordHash` (bcrypt; `$2y$13` prefixes are rewritten to `$2b$13` for Auth0 in `CentralDbController.php:33`). Minimum length is enforced only in `change-password` (5 characters, per the message asserted in `AccountCest`). **No server-side login-attempt throttle exists** beyond reCAPTCHA (no attempt counter on any principal or IP; `grep` for `login_attempt`, `failed_attempt`, `TooManyRequests` finds nothing).

### 3.2 Tokens and sessions

`getAccessToken()` (`Candidate.php:1952-1990`, equivalents in `Staff.php:~1000`, `Admin.php:~210`, `Contact.php:~430`, `StoreManager.php:~150`, `Inspector.php:~355`): reuse an existing unexpired token of the requested status for this device, else create one with a random 32-character value (`CandidateToken::generateUniqueTokenString`, `common/models/CandidateToken.php:103`), the device and user agent, the client IP, and `token_expiry_datetime = now + 1 month` (`Candidate.php:1984`, all six models).

`findIdentityByAccessToken()` (`Candidate.php:1899-1935`) resolves a bearer token only if its status matches and `token_expiry_datetime IS NULL OR > NOW()`, then updates `last_used`. Logout (`DELETE v1/account/discard-session`) deletes **all** of the caller's tokens (`AccountController.php:1894`). A daily cron purges expired or null-expiry tokens from all six tables (`CronController.php:247-263`).

### 3.3 Two-step verification

Per-principal flag `enable_two_step_auth`. When set, login issues the token with status **inactive** and sends a 4-character OTP by SMS (`Candidate.php:2009`, `Staff.php:1030`; `generateRandomString(4)` over a 64-symbol alphabet; `smsComponent->sendSms` at `Candidate.php:1728`). `POST login-two-step` presents token + OTP; a mismatch increments `total_attempt` and **the third failure deletes the token** (`Candidate.php:1914-1920`). Google, Apple and Auth0 logins skip two-step (`actionLoginByGoogle`, comment "no need 2 step on google auth").

### 3.4 Social and federated login

| Provider | Route | How the assertion is checked | Account match | Auto-create? |
|---|---|---|---|---|
| Google | `POST login-by-google` (candidate, staff, company, admin, manager) | server calls `https://www.googleapis.com/oauth2/v3/tokeninfo?id_token=…` and requires a non-empty `email` (`candidate/.../AuthController.php:957-965`). **No `aud` or `azp` check anywhere** | by email, non-deleted | candidate: yes, `signupGoogle`, `approved = 1`, email verified (`:970-995`); others: "No account found" |
| Apple | `POST login-by-apple` (candidate only) | `Yii::$app->jwt->decode($identityToken)` (`:1058`): `common/components/JWT.php:67-140` fetches Apple's public keys from `appleid.apple.com/auth/keys` and verifies the signature (`:137`); the `allowed_algs` check is commented out (`:94-96`); **no `aud`, `iss` or `exp` check** in the component or the controller | by email, non-deleted (`:1063`) | yes, `signupAuth0`, `approved = 1` |
| Auth0 | `POST login-auth0` (candidate, staff, company, admin, manager) | server calls Auth0 `/userinfo` with the access token (`common/components/Auth0.php:41-56`) | by email, non-deleted | candidate: yes; others: "No account found" |

**Every federated login keys on the email address.** This is the production ancestor of SHU-131: an email reassigned at the provider lands in the previous holder's account.

### 3.5 Auth0 shadow store

- Candidate self sign-up also calls Auth0 `dbconnections/signup` with the **plaintext password**, name, and `user_metadata {app, user_id}` (`candidate/.../AuthController.php:87-94`; `Auth0.php:64-75`, connection `Username-Password-Authentication`).
- `console/controllers/CentralDbController.php` bulk-inserts candidates (`actionIndex :16-45`) and staff (`actionStaff :47-75`) into a `users` table in a second database (`Yii::$app->db2`) with columns `user_id, name, nickname, email, password, email_verified, user_metadata`, the Auth0 bulk-import shape, rewriting bcrypt prefixes. `actionAgent` and `actionProvider` reference `Agent` and `Provider` models that **do not exist** in `common/models` and would fatal if run.
- `actionIndex` embeds a hard-coded list of twelve personal email addresses as an exclusion list (`:21`). Not reproduced here.

Consequence for migration: production credentials exist in two places (legacy tables and Auth0), but Authentik replaces both as the target authority. The platform imports identity links, never password hashes. Legacy verification flags are migration evidence only; SHU-130/SHU-131 owns how a legacy principal is linked to an Authentik subject.

### 3.6 Email verification and email change

Sign-up sends a verification code; `POST verify-email` checks it, limited to a number of failed attempts per IP in the last hour via `candidate_email_verify_attempt` (`AuthController.php:539-566`); success activates the token. `update-email` sets `candidate_new_email` and re-verifies; `candidate_limit_email` throttles resends (`Candidate.php:1662`). Contacts and store managers have the same flow (`contact_email_verify_attempt`, `contact_limit_email`, `limit_email`). Staff can mark a contact's email verified by hand (`CompanyContactController.php:505`).

### 3.7 Password reset

Email link with `candidate_password_reset_token = random + '_' + time` (`Candidate.php:1866-1871`), valid 3600 s (`common/config/params.php:11`, `isPasswordResetTokenValid :1783-1790`); `PATCH update-password` consumes it and marks the email verified (`AuthController.php:actionUpdatePassword :18-25`). Candidates can also reset by SMS OTP (`actionSMSResetPassword`, throttled by `candidate_limit_sms`). Admin can reset a staff password to a value supplied in the request or to a random 5-character string (`StaffController.php:actionResetPasswordDirect :612-628`).

### 3.8 Impersonation

Staff and admin obtain a candidate session by regenerating the candidate's 4-character `auth_key` and redirecting to the candidate app with it in the query string (profile inventory F2). Admin does the same for staff (`admin/.../StaffController.php:80-92`, 32-character key), and staff for store managers (`staff/.../StoreController.php` `Login`) and contacts (`CompanyContactController.php:77`). Each `login-by-key` consumes the key once. The only record is a `Yii::info` line.

### 3.9 Request gates common to all apps

`BlockedIp` is checked in every module's `beforeAction` (`admin/modules/v1/Module.php:65`, `candidate …:73`, `company …:78`, `inspector …:65`, `manager …:72`, `staff …:65`). Sign-up is refused after more than ten registrations from one forwarded IP (`Candidate.php:1255-1275`). `GET locate` returns the caller's country from ipstack (`AuthController.php:actionLocate`).

## 4. Authorization model

| Scope | How production decides | Evidence |
|---|---|---|
| Which app | which principal table the credential is in | six `findIdentityByAccessToken` implementations |
| Candidate | own row only; child resources scoped by `candidate_id` | profile inventory §3 |
| Staff | unscoped; `staff_role` is checked in **one** live place (`staff/.../RequestController.php:429`, `ROLE_SALE`) and two commented ones; `Staff::ROLE_ENGINEER = 2` is the only named constant (`Staff.php:44`) | |
| Admin | unscoped; `admin_limited_access` gates two actions (`admin/.../CandidateController.php:372` delete, `TransferController.php:2227`) | |
| Contact (employer) | one company per session: `_loginResponse` picks `$contact->getManagedCompanies()->one()` (`company/.../AuthController.php:_loginResponse :1-3`) and returns its `company_id`; managed stores = stores of that company plus its sub-companies (`company/components/StoreManager.php:40-46`); `company_contact.allow_access` decides membership | |
| Store manager | one store, one company (parent company when nested) | `manager/.../CandidateController.php:40-47` |
| Inspector | can only log in; no feature endpoints exist in this repository (`inspector/modules/v1` has Auth, Account, Aws, Ping). `inspector_uuid` is indexed on `mall` (`m200911_052307_mall_table.php:34`) | role mapping stays open per SHU-124 |
| Permission sections | declared, assigned, returned to the UI, never enforced server-side | §2.3 |

Hierarchy that the platform must reproduce as grants: **company → sub-companies → stores**, contacts many-to-many with companies with a per-link access flag, one manager per store.

## 5. Journeys (parity rows)

| ID | Journey | Actor | Legacy route(s) | Effects | Legacy tests | Disposition | Target |
|---|---|---|---|---|---|---|---|
| ID-01 | Candidate self sign-up | anonymous | `POST v1/auth/register` (`candidate/.../AuthController.php:actionSignup`) | row with `approved = 0`, unverified; IP throttle; verification email; Auth0 dual-write | `AuthCest::tryToRegister` asserts JSON | REPLACED by Universe sign-up + StudentHub identity link (SHU-29 done); the *approval* step survives as a grant | I5 |
| ID-02 | Company self sign-up | anonymous | `POST v1/auth/create-account` company and manager apps (`:585-640`) | contact + `company_request` + company `STATUS_UNDER_REVIEW`, `approved_to_hire = false` | `company AuthCest::tryToSignup` | REPLACED (Universe) for identity; org onboarding stays in the organizations cluster | OR |
| ID-03 | Password login, all six apps | any | `GET v1/auth/login` | token per device, +1 month | login tests in all six suites (candidate and company assert JSON; staff and admin assert 200) | REPLACED by Universe OIDC (done) | — |
| ID-04 | Two-step login | any with flag | `POST login-two-step` | inactive token → active on OTP; 3 failures delete token | candidate, company, staff, admin, inspector tests | REPLACED by Authentik MFA; no legacy OTP parity | — |
| ID-05 | Google / Apple / Auth0 login | any | `login-by-google`, `login-by-apple`, `login-auth0` | email-keyed match or candidate auto-create | none | REPLACED by Authentik connections; legacy provider behavior creates no parity obligation. Subject linking remains SHU-130/131. | — |
| ID-06 | Email verification and change | candidate, contact, manager | `verify-email`, `is-email-verified`, `update-email`, `resend-verification-email` | attempt limits per IP and per principal | 4 candidate, 4 company tests | Authentik owns identity verification; StudentHub keeps `email` only where the product needs it as a mutable contact attribute | — |
| ID-07 | Password change and reset (email, SMS) | any | `change-password`, `request-reset-password`, `sms-reset-password`, `update-password` | 1 h reset token; SMS OTP | 7 password tests assert messages | REPLACED by Authentik; no password or reset-token parity | — |
| ID-08 | Logout / revoke sessions | any | `DELETE discard-session` | deletes all own tokens | none | REPLACED by Authentik session management; StudentHub only invalidates its local OIDC session | I2 |
| ID-09 | Token expiry and purge | system | cron `daily` (`CronController.php:247-263`) | purge | none | REPLACED by Authentik; local OIDC session TTL remains under the existing Universe login contract | I2 |
| ID-10 | Staff account CRUD, status, recover, reset | admin | `admin/.../StaffController.php` (14) | password chosen by admin; soft delete renames email | `admin StaffCest` 9 methods | REQUIRED as grant management + invitation; no passwords | I1, I5 |
| ID-11 | Admin account CRUD, status, limited access | admin | `AdminController.php` (8) | | `AdminCest` 9 | REQUIRED as grants | I1 |
| ID-12 | Inspector account CRUD | admin | `InspectorController.php` (7) | | none | OPEN until the inspector product is evidenced (D-ID2) | — |
| ID-13 | Contact create, add to team, remove, delete, verify | staff, admin, company | `CompanyContactController.php` in three apps | hard delete of contact rows | `admin CompanyContactCest` 10, `staff` 11 | REQUIRED as org membership grants with `allow_access` | I3 |
| ID-14 | Store manager create with store | staff | `StoreController.php:128-131` | | `staff StoreCest` 17 (200-only) | REQUIRED as store-scoped grant | I4 |
| ID-15 | Permission sections and assignment | admin | `PermissionSectionController.php` (11 + 3) | not enforced | none | REPLACED by the platform grant model; the section list is input to the capability catalogue | I1 |
| ID-16 | IP block list | admin | `BlockedIpController.php` (6); checked in every module | | none | REQUIRED at the edge (platform level), not per app | I6 |
| ID-17 | Impersonation (candidate, staff, contact, manager) | staff, admin | §3.8 | one-time keys, `Yii::info` only | none | EXCLUDE pending D2; if kept, audited act-as | I7 |
| ID-18 | Locate by IP | anonymous | `GET locate` | ipstack call | none | EXCLUDE (front-end concern) | — |
| ID-19 | Auth0 dual-write and bulk export | system | §3.5 | | none | DISCARD; identities imported once, credentials never | I8 |

## 6. External effects

| Effect | Where | Data leaving |
|---|---|---|
| reCAPTCHA verification | all six auth controllers → `common/components/ReCaptcha.php` | client token + secret to Google |
| Google tokeninfo | five auth controllers | the ID token |
| Apple public keys | `JWT.php:~95` | none (fetch) |
| Auth0 userinfo and signup | `Auth0.php:41`, `:64` | access token; at sign-up **email, plaintext password, name, user id** |
| SMS OTP and reset | `common/components/SMSComponent.php` (HTTP API, vendor configured by `apiEndpoint`) | phone number, OTP |
| Email | Yii mailer with an ElasticMail IP-pool header (`CronController.php:~1017`) | verification codes, reset links, temporary passwords |
| ipstack | `common/components/Ipstack.php` | client IP |
| Second database `db2` (Auth0 import) and `walletDb` | `CentralDbController.php`, `WalletUser.php` | user rows with hashes |

## 7. Legacy test coverage

| Suite | Methods | Establishes |
|---|---|---|
| `candidate/tests/functional/AuthCest.php` | 15 | login, wrong password, two-step token and wrong OTP, update-password, email-check, register, reset, verified check, update-email, resend, verify; 9 assert JSON |
| `company/tests/functional/AuthCest.php` | 14 | same shape for contacts; 8 assert JSON |
| `staff` and `admin` `AuthCest` | 8 each | HTTP 200 only |
| `admin/tests/functional/StaffCest.php`, `AdminCest.php` | 9 each | CRUD returns 200 with partial JSON |
| Permission, blocked IP, impersonation, token purge, social login | 0 | untested |

## 8. Findings not previously recorded

| ID | Finding | Evidence | Severity | Recommended card |
|---|---|---|---|---|
| **F1** | Google login has no audience check: any Google ID token for the email, issued to any OAuth client, is accepted | `candidate/.../AuthController.php:957-965` and the four other apps | Medium–High, live | legacy security card (decision, SHU-54 shape) |
| **F2** | Apple login verifies the signature but not `aud`, `iss` or `exp`; algorithm allow-list commented out | `JWT.php:94-96`, `:137`; `AuthController.php:1058-1063` | Medium, live | same card as F1 |
| **F3** | Staff Gmail passwords stored reversibly (AES-128-CTR, `Staff::encryptPass :~160`) and **decrypted into admin API responses** | `admin/models/Staff.php:49-52`; set at `StaffController.php:303`, `:398` | High (third-party credentials at rest and in transit) | legacy card + decision D-ID4 |
| **F4** | Permission model declared and administered but enforced nowhere on the server | §2.3 | Design: the platform must define capabilities fresh; nothing to port | input to SHU-99 |
| **F5** | Admin sets staff and contact passwords in plaintext request bodies; `ResetPasswordDirect` falls back to a random 5-character password; staff-created candidates receive a 5-character temporary password by email | `StaffController.php:298`, `:612-628`; `CompanyContactController.php:184`; `staff/.../CandidateController.php:176`, `:202` | Medium | replaced by invitation; note for migration |
| **F6** | Impersonation keys are single-use but short (4 characters for candidates) and travel in URLs; no audit record | §3.8 | Medium | D2 |
| **F7** | No login-attempt throttle other than reCAPTCHA; OTP lockout only after three wrong codes on one token | §3.1, §3.3 | Medium | platform edge rate limiting (I6) |
| **F8** | Auth0 receives the plaintext sign-up password; a second credential store exists outside the repository's control | §3.5 | Migration risk | D-ID1 |
| **F9** | `CentralDbController` embeds twelve personal email addresses in source and references two models that do not exist | `CentralDbController.php:21`, `:77-135` | Low (dead code, PII in source) | remove in legacy; never port |
| **F10** | Federated logins key on email in all apps; deleted accounts free their email for re-registration | §3.4, profile inventory validateEmail | Design | SHU-131 evidence |

## 9. Classification of prior findings

| Source | Claim | At `c2ce255` |
|---|---|---|
| SHU-34 | Email+password login as identity path → DISCARD | Production-supported; replaced by Universe (SHU-29 done) |
| SHU-34 | Token tables are legacy identity anchors; data source for linking, never the auth spine | Production-supported; plus the Auth0 shadow store, which no prior ledger recorded |
| SHU-34 | `studenthub-inspector` dormant | Consistent: the inspector API has no feature endpoints |
| SHU-39 (corrected) | Token expiry exists, NULL means purge | Production-supported: +1 month on issue, daily purge across six tables |
| SHU-39 | OTP stored in-band on token rows; verify-attempt tables without expiry | Production-supported; OTP is 4 characters |
| SHU-131 | Email is the identity key | Production-supported at every federated login and every account match |

## 10. Platform mapping (input to SHU-99 and SHU-91)

Universe through Authentik is the only target credential and verification authority. StudentHub keeps `principals`, Authentik subject links and `grants`. To reproduce production scopes the grant catalogue needs at least:

| Production scope | Platform grant | Notes |
|---|---|---|
| Candidate self | `candidate` role, `self` scope (exists) | |
| Staff | `staff` role, `subtree` on the StudentHub org (exists) | capabilities per permission section defined fresh; production enforces none |
| Admin, limited admin | `admin` role; a `limited` capability flag | two production checks become capability checks |
| Employer user | `org-owner` or `recruiter` on a company org; inheritance to sub-company orgs; membership flag = grant presence | replaces `company_contact.allow_access` |
| Store manager | store-scoped grant (new scope value, or a store-level org) | decision in SHU-91 |
| Inspector | none until evidenced | D-ID2 |

Bounded slices for SHU-99:

| Slice | Scope | Points |
|---|---|---|
| I1 | Grant catalogue and admin UI: assign/revoke roles and capabilities per org, audit on every change (SHU-59 exists) | 5 |
| I2 | OIDC session integration: local sign-out and Authentik revocation behavior; no legacy token-table parity | 3 |
| I3 | Organization membership: invite contact, per-company access flag, sub-company inheritance | 5 |
| I4 | Store-scoped grant for managers | 3 |
| I5 | Account lifecycle: invitation instead of passwords, deactivate, recover, soft delete with email release rule | 3 |
| I6 | StudentHub edge controls: IP block list and product abuse limits; authentication and MFA throttling remain Authentik-owned | 3 |
| I7 | Audited act-as (only if D2 keeps impersonation) | 3 |
| I8 | Identity import: link legacy principals to Authentik subjects using the SHU-130/131 decision; import no passwords, hashes or legacy tokens | 5 |

Cluster size after slicing: **30 points** (27 without I7), against the 8-point placeholder on the corresponding delivery card.

## 11. Resolved auth boundary and remaining product decisions

The target auth architecture is already decided; legacy provider behavior is not a parity requirement.

| ID | Status | Rule or decision |
|---|---|---|
| R-ID1 | Resolved | Authentik is authoritative for credentials and verification. Legacy and Auth0 flags are migration evidence only. |
| R-ID5 | Resolved boundary | Social providers are configured in Authentik; legacy Google/Apple behavior does not require matching providers or flows. |
| R-ID6 | Resolved boundary | MFA policy and enforcement belong to Authentik, not StudentHub. |
| D-ID2 | Open product decision | Keep inspector only if a live inspector journey is evidenced; otherwise drop. |
| D-ID3 | Open product decision | Drop the separate wallet identity unless the finance inventory proves a live dependency. |
| D-ID4 | Open product decision | Drop stored staff Gmail credentials; if mail-as-staff is needed, use delegated OAuth. |

## 12. Not established

- Which SMS and mail vendors are configured (component endpoints are environment values).
- The IAM and Auth0 tenant configuration; whether the Auth0 connection is still active.
- Whether any inspector accounts have logged in recently (requires the database).
- Live nginx routing for the five unrouted controllers named in the coverage ledger, one of which is `status/Account`.
