# Production parity inventory: UI journeys and behaviour that exists only in the front end

**Card:** SHU-142 (split from SHU-138, parent SHU-88). Feeds SHU-221 acceptance 1 and 4.
**Front-end sources:** the five applications at the revisions SHU-138 recorded, each verified by `git rev-parse --short HEAD` in a fresh clone.
**Backend source:** `BAWES-Universe/studenthub` at `c2ce255695eabc7e3a0f23b162f5996274234c63` — the same revision the nine cluster inventories and the SHU-88 coverage ledger are anchored on, read from a worktree at that exact commit.
**Method:** read-only inspection of source. Every claim carries `file:line`. No network access to any deployed site, no production data, no credentials, no screenshots, no deployment.

Per-app detail lives in five appendices; this document is the synthesis and the only place that assigns owning layers and cards.

| App | Repo | Revision | Stack | Appendix |
|---|---|---|---|---|
| Candidate web | `studenthub-candidate-react` | `2f0a121` | React 18 + Vite + Ionic React 8 | [`ui-journeys/candidate-web.md`](ui-journeys/candidate-web.md) |
| Staff | `studenthub-staff` | `49ed05c` | Angular 15 + Ionic 6 | [`ui-journeys/staff.md`](ui-journeys/staff.md) |
| Admin | `studenthub-admin` | `c789b17` | Angular 15 + Ionic 6 | [`ui-journeys/admin.md`](ui-journeys/admin.md) |
| Employer | `studenthub-company` | `b9578d5` | Angular 14 + Ionic 6 | [`ui-journeys/employer.md`](ui-journeys/employer.md) |
| Candidate mobile | `studenthub-candidate` | `de3ac8c` | Angular 15 + Ionic 6 + Capacitor 4 | [`ui-journeys/candidate-mobile.md`](ui-journeys/candidate-mobile.md) |

**Evidence class.** Everything here is *source inference at a named revision*. SHU-138 FE-F6 still stands: no deployed bundle was observed, so "the production UI behaves this way" is not established by this card. Section 9 records the three places where the source itself says the deployed build cannot be this revision.

## 1. What the card had to establish, and what changed

Nine backend inventories measured 1,016 functional controller actions. They could not establish what the product does, because a repeated pattern in them is a guard present in one layer and absent in another. SHU-142 was written to resolve four named suspicions from the front end. All four are now settled, and three of them did not resolve the way the card expected:

| Suspicion on the card | Resolution from front-end source |
|---|---|
| Candidate job eligibility (`min_age`, `max_age`, `gender`, availability) is filtered in the front end, because the server filter is commented out (SHU-127 RC-F1) | **Refuted.** Neither client filters. The candidate web app renders `gender` and the availability window as labels and never reads `min_age`/`max_age` (`src/components/app/jobs/job.tsx:253-298`; `src/models/job.ts:22-23` — declared in the type and never read: `grep` over `src/` yields those two declarations only); the mobile app has no job-board screen at all. Ineligible candidates see and can apply to every active job. The rule exists **nowhere**. |
| Applying has no duplicate, eligibility or open-state check server-side (RC-F2) | **Confirmed and narrowed.** Duplicate apply *is* stopped — for jobs at `JobController.php:141-150`, for requests by `RequestApplication::validateUniqueApplication` (`common/models/RequestApplication.php:50,61-85`). Open-state and eligibility are checked in neither layer. The clients only hide the button (`candidate-web` `jobs/[id]/page.tsx:85-87`, `mobile` `request-view.page.html:58`). |
| Every staff and admin permission gate is a front-end decision (SHU-124 F4) | **Confirmed, and now enumerated.** Staff checks exactly seven permission keys, all client-side; `grep` for permission reads across `staff/modules/v1/controllers/*.php` matches only `PermissionSectionController.php` itself. Admin has 126 page-template gates on one login-response boolean against **two** server checks. Details in section 4.1. |
| `request_interview` carries `internal_note` and `interview_note` with no server rule about which is candidate-visible (RC-F6) | **Resolved, and it is a leak.** `RequestInterview` has no `fields()` override (`common/models/RequestInterview.php:128-138` declares only `extraFields`), so `GET /requests/interview-requests` (`candidate/.../RequestController.php:131-169`) serialises `internal_note` and `staff_id` to the candidate. Both candidate clients simply do not render it (`candidate-web` `src/components/app/request.tsx:84`; `mobile` `request-listing.component.html:57`). |

The card predicted that absent backend enforcement would be compensated by front-end enforcement. The dominant finding is the opposite: **where the server does not enforce a rule, usually nothing does.** The front end mostly hides affordances rather than enforcing rules, and hidden affordances are not guards — every endpoint behind them is reachable by direct call with an ordinary session token.

## 2. Scale of the surface

| App | Routes/screens mapped | Frontend-only rows | Journeys with no parity row | Notes |
|---|---:|---:|---:|---|
| Candidate web | 59 route declarations, 26 private | 48 | 9 | 16 logged-in service files |
| Staff | 119 router paths + 12 tab children | 42 | 13 | 982 `.ts` files, 80 providers — the largest app |
| Admin | 126 router paths, 111 guarded | 48 | 12 | 132 page components, 52 services |
| Employer | 40 mapped routes | 42 | 11 | Angular 14, oldest toolchain |
| Candidate mobile | 66 mapped routes | 46 | 11 | Capacitor 4, 16 native plugins |
| **Total** | **~410 screens** | **226** | **56** | |

Twenty-nine call sites are marked `MISSING-BACKEND`: the client calls a path that has no URL rule or no action at `c2ce255`.

## 3. Where the platform should own each rule

Every one of the 226 frontend-only rows carries a recommended owning layer. The distribution is the practical answer to acceptance item 5:

| Recommended owner | Rows | Meaning |
|---|---:|---|
| Server only | 133 | The rule is a real business or safety rule and the client is not a reliable place for it |
| Both | 28 | Server enforces; client keeps the rule for immediate feedback |
| Client, UX only | 46 | Presentation, labels, ordering, optimistic updates — correctly client-side, nothing to port |
| Drop / hygiene | 8 | Dead screens, dead gates, committed secrets |
| Mixed | 11 | Split responsibilities, described per row |

Of the rows that state a verdict in the form the appendices use, **50 read "server does not enforce"**, 26 "partial", 25 "enforced". The remaining rows carry a prose verdict naming the specific server behaviour.

The single rule that follows from this: **a hidden button is not a control.** Sections 4 and 5 list the cases where the platform must add the server-side rule, and the cases where the client rule is merely convenience.

## 4. The frontend-only register

These are the cross-app findings that change platform contracts. Each has an ID the implementation cards cite. Per-app rows (`CAND-FO-nn`, `STAFF-FO-nn`, `ADMIN-FO-nn`, `EMP-FO-nn`, `MOB-FO-nn`) are in the appendices; the IDs in brackets point there.

### 4.1 Authorization computed in the client (the largest class)

| ID | Finding | Evidence | Owning layer | Card |
|---|---|---|---|---|
| **FE-J1** | **Staff permissions are a client-side per-company deny-list with a fail-open branch.** The staff app checks exactly seven keys: `Company/company-stats`, `company-contracts`, `company-transfers`, `company-activity`, `company-notes`, `company-contact-login`, `Candidate/candidate-financials` (verified: `grep -ohE "hasPermission\('[^']+'"` over `src/app` yields these seven and no others). Each hides a tab, column or button. Every corresponding endpoint (`GET /contracts`, `/transfers`, `/notes`, `/candidates/transfers/{id}`, `POST /company-contacts/login/{id}`) serves any authenticated staff. `hasPermission` **returns `true`** when a section is company-specific and the company is *absent* from that section's `companies` list (`permission.service.ts:36-41`: `if (_check) return flattened[key] ?? false; else return true;`) — so the permission list acts as a per-company deny-list and an unlisted company is allowed. A failed permission fetch yields an empty map (`catchError(… , [])`, `:74,79`), which makes the gates evaluate false and *hide* UI — fail-closed, but silently. One gate is inverted: holding `company-activity` *removes* notes whose text contains "transfer" (`shouldShowActivity`, `:50-55`). | `staff` appendix STAFF-FO-01..09; backend: `grep -rl` for permission reads over `staff/modules/v1/controllers/` matches only `PermissionSectionController.php` | server | **SHU-150 (I1)** |
| **FE-J2** | **Admin "limited access" is 126 template conditions against two server checks.** `admin_limited_access` comes from the login response and hides create/edit/delete across admin, staff, inspector, company, candidate, transfer, reference-data, webhook, blocked-IP, currency and permission pages: 126 occurrences in `.html` under `src/app/pages`, 139 including the component-side redirects, 147 across all of `src/app`. Server-side, `grep -rn admin_limited_access admin/modules/v1/controllers admin/models` finds enforcement at exactly two places — `CandidateController.php:372` (delete) and `TransferController.php:2227` (invoice PDF before receipt) — plus the two setters in `AdminController.php:105,154`, the login echo at `AuthController.php:274`, and two **commented-out** checks (`AdminController.php:193`, `FulltimerController.php:123`). Every other mutation, including all transfer state changes, account CRUD and permission-section writes, accepts any bearer admin. A second gate, `restrictedAccess()`, unconditionally `return true` with its allow-list commented out (`auth.service.ts:562-571`), so the staff-salary and suggestion gates it guards are dead. | `admin` appendix ADMIN-FO-01..06 | server | **SHU-150 (I1)** |
| **FE-J3** | **Permission administration exists and is enforced nowhere.** Both staff and admin apps administer permission sections and sub-sections (`assign-permission.page.ts:109-115`); the server stores and returns them (`PermissionSectionController.php:243-290`, `:357-374`); no feature controller in either app reads `PermissionUser`. SHU-124 F4 is confirmed independently in two apps. The admin app does not even consume the `permissions` it expands on staff records — zero gating uses in templates. | ADMIN-FO-06, STAFF-FO-02 | server (new grant catalogue) | **SHU-150 (I1)** |
| **FE-J4** | **Impersonation is one un-gated click in four places, with no reason and no audit row.** Admin impersonates candidate, staff, company contact and store manager (`candidate-view.page.ts:376-391` and three siblings); staff impersonates candidate, contact and store manager, and only the contact button carries a client permission gate — the other two have none. The server regenerates a short auth key and returns it inside a redirect URL; both candidate clients accept `?auth_key=` from a query string and exchange it for a full session with no "acting as" indication. | ADMIN-FO-30, STAFF-FO-04, CAND-FO-47, MOB-FO-32 | server (audited act-as) or drop | **SHU-156 (I7)**, decision **SHU-201** |
| **FE-J5** | **Employer role vocabulary is client-invented.** The invite modal offers `Owner / HR / Finance / Other` as free text (`invitation-permission.page.html:19-40`); the server stores whatever arrives with no allowed-list. The only server-side role check in the employer app, `remove-member`, reads `identity->currentUserRole`, **a property defined nowhere** in `company/` or `common/` — so member removal cannot succeed even if its route were registered. Commercial terms (`hourly_rate`, `bonus_commission`, `currency_code`, `approved_to_hire`) are writable by any staff with no capability check. | EMP-FO-06/07, STAFF-FO-11 | server | **SHU-152 (I3)**, **SHU-162 (O4)**, **SHU-163 (O5)** |
| **FE-J6** | **Route guards check for a stored token, never its validity or the actor's grants.** All five apps: the guard reads a persisted session object and returns true. Twelve routes across admin and employer have no guard at all. This is correct as UX (the server rejects on 401) and must not be mistaken for access control in the replacement app. | STAFF-FO-01, ADMIN-FO-08, EMP-FO-42, CAND-FO-25 | client, UX only | **SHU-151 (I2)** |

### 4.2 State machines decided in the client

The pattern is identical in every app: the UI shows the buttons it thinks are legal, picks the target status as a literal, and posts it. The server validates the *value* (sometimes) but not the *transition* (mostly). This is SHU-127 RC-F4 and SHU-126 WK-F4 confirmed from the other side, in six separate workflows.

| ID | Workflow | Client decides | Server checks | Card |
|---|---|---|---|---|
| **FE-J7** | Request lifecycle (`pending → started → re_work → finished_by_recruitment → delivered / cancelled`) | Staff app sets each target status per button (`company-request-view.page.ts:544-1054`) | `in range` only (`common/models/Request.php:92`); cancel/deliver additionally require feedback and no active suggestions | **SHU-177 (R2)** |
| **FE-J8** | Suggestion accept/reject | Both staff and employer set 2/3 locally and require a reason in the prompt | No current-status precondition (`SuggestionController` accept/reject); reason may be empty | **SHU-179 (R4)** |
| **FE-J9** | Interview schedule/reject | Staff sets `status=2` on reject; employer requires `internal_note` and a future date | No precondition on current status; no min-date; both notes plain strings | **SHU-181 (R6)** |
| **FE-J10** | Work-session approve / reject / undo | Employer posts `status:1/2` and resets to 0 for undo; reason chips and a 1–5 rating are required client-side | `status` and `rating` are `integer` with no range, no required, no state machine (`common/models/CandidateWorkLogFeedback.php:55-60`); a settled session can be re-decided regardless of transfer state | **SHU-172 (W4)** |
| **FE-J11** | Appeal status (`submitted → awaiting → in-progress → resolved`) | Staff picks any of the four from a select (`appeal-view.page.html:13-18`) | Rule is `integer` with a default and **no `in range`** (`common/models/CandidateWorkingHourAppeal.php:44-56`) | **SHU-173 (W5)** |
| **FE-J12** | Ticket status, email-campaign run, staff expense and leave approval | Client shows transitions by current value | Status written from the body; `EmailCampaignController::actionRun` re-runs a completed campaign unconditionally | **SHU-187 (C2)**, **SHU-189 (C4)** |
| **FE-J13** | **Counter-example: transfers are correctly server-owned.** Lock, cancel, unlock, delete, payment-sent and mark-paid all throw on the wrong state (`common/models/Transfer.php:1031-1147`, `admin/models/Transfer.php:76-125`), and totals and rates are recomputed server-side from the contract rather than from the payload. The client gates are genuinely UX. One mismatch: the admin UI offers **delete on a cancelled transfer**, which the server rejects. | ADMIN-FO-15/16, STAFF-FO-13/14, EMP-FO-28 | client, UX only | **SHU-183 (F2)** |

FE-J13 matters for planning: the money path is the one workflow where the legacy backend already owns its state machine, so F2/F3 inherit a working contract while W4, R2 and C2 must build theirs.

### 4.3 Rules that exist only in a form validator

Client validation is frequently *stricter* than the server, which means the replacement server must add the rule rather than copy the legacy model.

| ID | Rule enforced only in the client | Server at `c2ce255` | Card |
|---|---|---|---|
| **FE-J14** | Manual work log: `end > start`, date within 1980..today, note required (mobile `log-time-manually.page.ts:47-52`; the web client's `start < end` refine is **commented out**) | No range, no future-date, no overlap check, and the open-session guard is commented out (`CandidateWorkingHourController.php:166-178`); `total_time = end_time − start_time` can be negative (`:197`). The date handling is a live data bug: the mobile time picker emits a bare `'hh:mm a'` string (`components/time-picker/time-picker.component.ts:19`), and the server `strtotime()`s `start_time` and `end_time` independently of `date` (`:183-187`), so both resolve against the server's *current* date while `date` keeps the day the user chose (`:197`). Any manual entry for a day other than today is stored with `start_time` on the wrong date | **SHU-170 (W2)** |
| **FE-J15** | Civil ID 12-digit format (staff `custom.validator.ts:11-16`), phone 8-digit (mobile `phone.page.ts:58`), expiry ≤ +10y (web) / ≤ +20y (mobile) | Both patterns are **commented out** in `common/models/Candidate.php:196-207`; only uniqueness among non-deleted rows and a strict date parse survive. The mobile `id-card` screen sends an empty expiry, which the server always rejects — the screen cannot succeed | **SHU-146 (S5)** |
| **FE-J16** | Blocked-IP address format, university name, expense amount, email-campaign subject/body, standup question, UTM fields, staff salary — all `Validators.required` client-side | Server `rules()` lack `required` or format for each (`BlockedIp.php:36-41` accepts any 45-char string as an IP; `University.php:46-48` has no required rule; `EmailCampaign.php:55-65` no subject/message) | **SHU-166 (O8)**, **SHU-155 (I6)**, **SHU-189 (C4)** |
| **FE-J17** | Skills capped at 40 with client-side de-duplication (mobile `skill-form.page.ts:25,143-148`) | `actionUpdateSkills` rejects only an empty list; no cap, no de-duplication | **SHU-144 (S3)** |
| **FE-J18** | Rating 1–5 required, rejection reason from a fixed vocabulary (employer approve/reject modals) | `rating` integer, unbounded, optional; `reason` free string ≤255, optional | **SHU-172 (W4)**, decision **SHU-205** |
| **FE-J19** | Age 16–25 (web `dob/page.tsx:39-45`) — **the one case where the server is authoritative and the client mirrors it correctly** (`validateAge`, `Candidate.php:647-652`). The mobile client gets it wrong in the other direction, allowing up to ~46 | server authoritative | **SHU-143 (S2)** |

### 4.4 Client-held credentials and the document boundary

| ID | Finding | Evidence | Card |
|---|---|---|---|
| **FE-J20** | **`GET /aws/config` is unauthenticated and every app builds a browser S3 client from it.** `AwsController` removes the authenticator and never restores it, with the bearer block commented out, then returns `aws_temp_access_key_id` / `aws_temp_secret_access_key` and a `//todo: key with expiry` (candidate, staff, admin, company copies). All five clients fetch it — the mobile app in an `APP_INITIALIZER` **before login** — and upload with `ACL: public-read` to a bucket named in client config. This is **wider than SHU-134 records**: not "every logged-in candidate" but every anonymous caller, from five apps. Client-side size caps (5/10/18 MB) are the only upload limits; one of them compares `file.type == 'image'` against a MIME type and never fires. | CAND-FO-19, MOB-FO-34, STAFF-FO-32, ADMIN-FO-36, EMP-FO-30 | **SHU-134** (widen), **SHU-145 (S4)**, **SHU-197 (X1)** |
| **FE-J21** | **Private documents are rendered from public permanent-bucket URLs.** Civil-ID front and back images are built as `permanentBucketUrl + 'photos/' + key` in the candidate web app, the admin candidate view and the employer candidate view. The server's employer projection does strip civil photos, resume and coordinates for candidates outside a managed store (`company/models/Candidate.php:44-63`) — but `candidate_civil_id`, `candidate_civil_expiry_date`, `candidate_birth_date` and `candidate_video` are returned for **any** candidate id because `findModel` has no company scope (`company/.../CandidateController.php:730-741`). | CAND-FO-18, ADMIN-FO-48, EMP-FO-19/20 | **SHU-145 (S4)**, **SHU-158 (S7)**, decision **SHU-200** |
| **FE-J22** | **Staff hold a non-expiring Algolia key and query the index from the browser.** `GET /algolia/key` restricts indices and adds facet filters, but `validUntil` is commented out, so the key never expires (`AlgoliaController.php:68-102`); the client caches it in memory until a 400. The employer app has the same service and a `CandidateSearchPage` that is **unrouted** in this build, so the secured-key search path is dead there. | STAFF-FO-31, EMP-FO-18 | **SHU-178 (R3)** |
| **FE-J23** | **Signing material and CI credentials are committed to two front-end repositories.** Candidate web and mobile both contain an Android release keystore, `private_key.pepk`, a Google Play service-account JSON with its private key, and (web) an unencrypted TLS private key, a Sentry auth token and a Redis dump. The mobile `README.md:44-48` prints the keystore password. `.gitignore` excludes none of them. | CAND-FO-38, MOB-FO-46 | **SHU-197 (X1)** — rotate and purge |
| **FE-J24** | reCAPTCHA v3 runs on nine screens across candidate web, mobile and employer with a shared hard-coded site key; every `reCaptcha->verify` call in the candidate and company `AuthController`s is **commented out**. The token is read and discarded. Client-side login-attempt counters change the alert copy; there is no server-side throttle or lockout anywhere. | CAND-FO-22/23, MOB-FO-31, EMP-FO-01, ADMIN-FO-42 | **SHU-155 (I6)** |

### 4.5 Data-integrity behaviour that exists only as client convention

| ID | Finding | Card |
|---|---|---|
| **FE-J25** | **All four Angular apps retry POST, PATCH and DELETE.** `genericRetryStrategy` retries three times with 1/2/3 s backoff on any status except 400/401/404/500 while online, and it is wired into the write helpers. No endpoint accepts an idempotency key. A 502, 503 or timeout on `POST /transfers`, `POST /candidate-work-log-feedbacks`, `POST /requests/apply/{id}`, `POST /tickets`, `POST /chats/send-message` or `POST /invitations` can therefore duplicate the write. Admin is the partial exception (GET/PATCH one retry, POST/DELETE none). | **new card — see section 7** |
| **FE-J26** | **Geolocation is required by the UI and optional on the server.** Both candidate clients refuse to send a clock-in or clock-out without coordinates and show "Location permission required"; the web client fails silently. `lat`/`long` are optional unvalidated parameters, so a direct call without them succeeds, and clock-out **overwrites the start coordinates** (`AccountController.php:1841-1842`) — WK-F1 confirmed from the client side, which has no way to preserve the start location. No geofence exists in either layer. | **SHU-170 (W2)**, decision **SHU-204** |
| **FE-J27** | **"Profile complete" has two different definitions.** The server requires 17 fields including both civil photos, civil expiry, an education row and a skill (`Candidate.php:3410-3505`). The candidate web client computes its own next-step algorithm requiring `candidate_intro` and `candidate_preferred_time` — which the server does not — and omitting civil photos, expiry and the Kuwaiti-mother flag. The mobile client is worse: it sets `isProfileCompleted = true` **locally** and persists it, and no endpoint gates on the server value. | **SHU-92 (S1)**, **SHU-143 (S2)** |
| **FE-J28** | Money and hour totals are summed client-side over the loaded page in four admin screens (`payable-candidates`, `log-hour-list`, `staff-work-session-list`, per-line bonus math), so they are wrong across pagination, and `payable-candidates` disagrees with the server's own stats endpoint. | **SHU-184 (F3)**, **SHU-171 (W3)** |
| **FE-J29** | Open-session state is cached on the device and the server's `getIsWorking()` ignores `store_id` while start/stop/discard filter by it — a candidate reassigned with an open session sees "working" and cannot stop it. `discard` physically deletes the open session with no audit. | **SHU-170 (W2)**, **SHU-174 (W6)** |
| **FE-J30** | Polling in place of push: unread-count every **1 s** (mobile) and every **3 s** (web, in a comment claiming one minute), invitation count every 30 s, chat messages every 5 s, admin campaign status every 1 s, staff statistics every 60 s. No server-side rate limit on those reads. | **SHU-186 (C1)**, **SHU-188 (C3)** |
| **FE-J31** | Notification copy for eleven types is rendered and stored server-side as text and mapped to components by integer in both candidate clients, so wording and language are frozen at send time — CM-F2 confirmed as a client dependency that render-at-read-time must replace. | **SHU-188 (C3)** |
| **FE-J32** | Session tokens and the **entire profile** (IBAN, civil ID number, phone, coordinates, S3 keys) are persisted in `localStorage['state']` (web) and plaintext Capacitor Preferences (mobile, admin, staff, employer). The web client's logout nulls the token but leaves the profile object. The mobile app additionally stores `unVerifiedToken`, a live session token for an unverified account. | **SHU-151 (I2)** |
| **FE-J33** | XSS surface: 18 sites render server-supplied HTML through `dangerouslySetInnerHTML` in the candidate web app (job descriptions, compensation, note text, interview notes, company descriptions) and `[innerHtml]` in mobile; no server-side sanitisation is visible on those fields. | **SHU-181 (R6)**, **SHU-167 (O9)** |

## 5. Screen → endpoint → parity-slice map

The per-app appendices carry the full table: one row per route, with the screen component, its guards, every backend endpoint it calls with the verb and path, the parity rows it serves, and the owning slice. That is the deliverable for acceptance item 1 and it is too large to restate here (≈410 rows). This section states how to read it and what it shows in aggregate.

**Coverage against the nine inventories.** Every parity row family is reachable from at least one app, with these exceptions, which no front end exercises at `c2ce255`:

| Parity rows with no UI in any audited app | Where the journey actually lives |
|---|---|
| OR-21 store-manager assignment *acceptance*; the whole store-manager journey | The `studenthub-manager` app, which SHU-138 established is not routed and was never completed. The employer app can only *request* a change (`store-assignment-request`); the staff app wires **reject** but never `accept` — the action exists server-side and no screen calls it |
| WK-16 month-end attendance confirmation | No employer UI exists |
| WK-17 / OR-32 firing hit map, OR-30/33 company revenue and year report, RP-03/04 business statistics | Admin only; the employer app fetches no statistics screens |
| CM-06 employer support | No employer ticket path exists in either layer — employers are pushed into chat (CM-F8 confirmed) |
| RP-01/02 morning summary and recruiter productivity | Email and counters only; the staff dashboard polls `/statistic` |
| FI-17 Xero, FI-18 wallet | Admin drives Xero page-by-page from the browser; the mobile app still has a live wallet screen for an integration the finance inventory marks DISCARD |

**Endpoints the UI calls that do not exist at `c2ce255`** (29 sites; the significant ones):

| App | Call | Consequence |
|---|---|---|
| Employer | `GET /invitations/by-otp/{otp}`, `POST /invitations`, all `/invitations/*` | The entire team-invitation journey is unroutable — the URL rules are commented out (`company/config/main.php:357-370`) |
| Employer | `DELETE /company-contacts/{uuid}` | Member removal 404s; and the action would throw on an undefined `currentUserRole` |
| Employer | `PATCH /requests/cancel`, `PATCH /requests/deliver` | No URL rule; the client's transition code is dead |
| Employer | `POST /auth/login-by-apple` | Apple sign-in has no company endpoint |
| Admin | `GET /staff/view-salary/{id}` | URL rule exists, no action — 404 |
| Admin | `DELETE /campaigns/delete/{id}` | Action exists, no URL rule |
| Candidate web | `GET /discounts/{id}`, `GET /discount-categories/{id}` | Routed screens are stubs behind missing endpoints |
| Staff | `PATCH /staff-expenses/{id}` | Expense edit has no backend route |

Four of these are in the employer app and cover one coherent feature — team management. Either the deployed employer build is **not** `b9578d5`, or employer team management is broken in production. Section 9 records this as the sharpest limit on this card's evidence class.

## 6. Role-specific flows expressed as grants

Acceptance item 4 asks what each app shows that the others do not, expressed as the grant that would replace it. The per-app appendices give the detail; this is the consolidated mapping, and it is the input SHU-221 needs to check that no required journey is unreachable in the one-app model.

| Grant | Replaces | Today's mechanism |
|---|---|---|
| `candidate:self` | Candidate web and mobile in full: onboarding, profile, documents, education/experience/skills/links, job board, applications, invitations, interviews, own hours, appeals, salary, bank details, chat, notification feed | A candidate bearer token; no roles, no permission arrays, no role switch in either client |
| `candidate:self` + `assignment:active` | The Track tab (clock in/out, manual log, sessions) | Both clients show it on a cached `store_id`; the server has no explicit gate and fails by validation error instead |
| `org:member` on a selected organization | Everything in the employer app | Bearer token plus a `Company-ID` header the client selects; `CompanyManager::getCompany()` rejects unmanaged ids, so the *scope* is enforced but the *context switch* is entirely client-driven |
| `org:owner` | Company profile edit, invite, remove member, activation | Only `remove-member` distinguishes an owner, via an undefined property |
| `org:recruiter` | Raise/track requests, accept/reject suggestions, invite candidates, schedule interviews | Any org member; `company_approved_to_hire` is the only server-side gate, and only on invitations |
| `org:finance` | Create/lock/cancel transfers, invoices, contracts | Any org member |
| `store:manager` | Approve/reject/undo sessions, request store-assignment changes, see assigned candidates' documents | The employer app's store-scoped views; `storeManager->getManagedStores()` server-side. The dedicated manager app is not a target deployment (SHU-138 FE-F2) |
| `staff:candidate-admin` | Candidate CRUD, tags, merge, warnings, ID cards, work-log review, appeals, corrected sessions | Any staff token |
| `staff:recruiter` / `staff:recruiting-lead` | Requests, stories, invitations, suggestions, interviews, evaluations, jobs. Assign-to-recruiter is gated on a client-held `role == 1` | Client integer from storage; no server role check on assign or update |
| `staff:finance` | Contracts, transfers, bank files, invoices, candidate salary, company stats | Four client-side permission keys; no server check |
| `staff:org-admin` | Companies, contacts, teams, stores, managers, brands, malls, reference data | Any staff token |
| `staff:support` / `staff:marketing` | Tickets, campaigns, notes, voice mail | Any staff token |
| `staff:self` | Own work session, standup, leave, expenses | Scoped to the caller server-side (the one staff area that is) |
| `staff:reporting` | Dashboards, counters, exports, cron log, analytics | Any staff token |
| `admin:read-only` + `finance:read-settled` | The "limited admin" persona | 126 page-template gates, 2 server checks (FE-J2) |
| `admin:grant-admin` | Permission-section administration | Replaced wholesale by the grant catalogue; nothing to port |
| `admin:platform` | Settings, cache flush, webhooks, mail log | Any admin token; cache flush should be discarded |
| `staff:act-as` / `admin:act-as` | Impersonation of candidate, staff, contact, store manager | Un-audited auth-key exchange (FE-J4) |

Two grants in the target model have **no** legacy UI to port and must be designed rather than migrated: `store:manager` (the app was never finished) and the grant-catalogue administration that replaces permission sections.

## 7. Journeys with no corresponding backend parity row

Fifty-six UI journeys across the five apps map to no row in the nine inventories. They are listed per app in the appendices. Reporting them to the inventories is not sufficient under the SHU-142 execution audit, so each is dispositioned here: **row-only** (the inventory row text needs correcting or extending, no new implementation scope), **slice** (an existing implementation card must absorb it), or **new card**.

### 7.1 Row corrections for the owning cluster inventories

| Journey | Inventory | Correction |
|---|---|---|
| Company switcher / multi-org session | SHU-125 OR-18 | OR-18 says organization switching "does not exist in legacy". The employer app implements it via `Company-ID` header selection with server-side validation of managed companies. The row text is wrong and O4's scope is larger than stated |
| Candidate creates university rows during onboarding | SHU-125 OR-26 | Both candidate clients let a candidate create arbitrary universities; O8 mentions moderated submissions but OR-26 lists reference-data CRUD as staff/admin only |
| Candidate self-download of appreciation certificates | SHU-123 PD-39 | PD-39 is staff-side; both candidate clients download the PDF, mobile via Filesystem + FileOpener |
| Candidate-side open-session discard | SHU-126 WK-03/04 | `DELETE /account/discard-session` physically deletes an open session with no audit; not a listed journey, relates to WK-F3 |
| Two-step self toggle with no step-up | SHU-123 PD-28 | One click, no confirmation, no password, server flips unconditionally |
| Video intro pipeline (3 s status polling + MediaConvert webhook) | SHU-139 | No OP row covers the transcode pipeline |
| Geo-locate for registration defaults | SHU-124 ID-18 | ID-18 excludes IP location as a front-end concern; the employer registration form depends on it for country and currency defaults |
| Language preference as a product concern | SHU-129 CM-13 | The candidate web app never calls `POST /account/language-pref`, so the server's `candidate_language_pref` — which drives mail and SMS — drifts permanently from the UI language |
| Web push for the PWA (`safari_web_id`) | SHU-129 CM-08 | CM-08 assumes mobile push; the PWA path is separate infrastructure |
| Client-side marketing attribution capture | SHU-129 CM-18 | UTM capture, `PATCH /campaigns/click/{utm_id}` and Mixpanel "From Campaign" happen in all three consumer clients |
| Side-effecting `GET /companies/payroll-email/{id}` | SHU-125 OR-31 | A GET that sends mail |
| Request `update-interval` | SHU-125 OR-10 | OR-10 covers company follow-up; the request-level interval has no row |
| Candidate "committed" flag with a typed note | SHU-123 PD-14 | The note-with-type payload is not described |
| Staff leave via two different models | SHU-126 WK-20 | `POST /daily-standup/leave-request` and `POST /staff-leave` are two implementations of one journey |

### 7.2 Journeys an existing implementation card must absorb

| Journey | Owning card |
|---|---|
| Staff-authored candidate warnings (`warn-candidate`, `update-warning`, `candidate-warnings`) — disciplinary records distinct from CM-16 notes | **SHU-147 (S6)** |
| Candidate ID-card **request queue** with regenerate and delete | **SHU-148 (S8)** |
| Transfer bank-advice register (serial-numbered advice records) | **SHU-184 (F3)** |
| Suspicious-transfer review queue ("wrong hourly") | **SHU-185 (F4)** |
| Replace the payee candidate on a payable line (rewrites `candidate_id`, bank and IBAN) | **SHU-184 (F3)** |
| Payment search by transfer-candidate id / confirmation id | **SHU-184 (F3)** |
| Transfer Excel template, `create-by-excel`, `edit-by-excel` bulk import | **SHU-183 (F2)** |
| Approved-hours preview before creating a transfer | **SHU-175 (W7)** |
| Job-interest shortlist and reject (story job-board management) | **SHU-180 (R5)** |
| Under-review holding screen and its (unenforced) gate | **SHU-161 (O3)** |
| Assigned-candidate report and admin daily-standup question catalogue | **SHU-193 (P1)** |
| Employer work-log Excel export (three variants, unaudited) | **SHU-196 (P4)** |

### 7.3 Genuinely unowned scope — new cards

Three journeys are neither a row correction nor absorbable into an existing slice. They are created as bounded cards and linked to SHU-221:

1. **Write idempotency and client retry safety** (FE-J25). Cross-cutting: four apps retry writes, no endpoint accepts an idempotency key, and the concrete duplicate risks are in the money and hours paths. Neither the safe-write contract (SHU-82, done) nor any cluster slice owns retry semantics.
2. **Candidate evaluation question bank and department reports.** A complete feature — ten backend actions in `CandidateEvaluationController`, an admin question catalogue with department assignment, a staff report form with a hardcoded five-department list in the client, and a PDF — with no parity row anywhere. Distinct from RC-14/R6 interview evaluation, which is scoped to `request_interview`.
3. **Replacement app screen and navigation contract per grant.** Acceptance item 1 produced ~410 screens across five apps. No implementation card owns the target information architecture: which screens the one app ships, what each grant sees in navigation, and the empty/error/loading, mobile-width, keyboard and Arabic/English requirements SHU-221 item 4 verifies. Without it, SHU-221 has nothing to verify against.

Candidate-facing perks/discounts is **not** given a card: the screens are stubs behind missing endpoints in the web client and live only in mobile, and FI-16 covers the admin side. It is referred to SHU-213 as an exclusion candidate.

## 8. Decisions this card informs

None of these are decided here. Each is an existing decision card that this audit gives new evidence for:

| Decision | New evidence from the front end |
|---|---|
| **SHU-207** (D-RC1/D-RC4: does the job board survive, may age and gender filter) | The criteria are enforced in **no** layer. If the board survives, eligibility is new work in R5, not a port. The employer request form has no age or availability controls at all, so RC-F1 is confined to the `job` table |
| **SHU-204** (D-WK1: is location required to clock in) | The UI already treats it as mandatory and fails closed on denial; the server treats it as optional. Making it required server-side matches existing user-visible behaviour. The start-location overwrite must be fixed either way |
| **SHU-200** (D1: may employers see civil-ID images, resume, coordinates) | The employer UI renders all three for candidates in managed stores, and civil ID number, expiry, birth date and video for **any** candidate id. Coordinates are in the model but never rendered |
| **SHU-201** (D2: keep staff "login as candidate") | Four impersonation paths in admin, three in staff, both candidate clients accept `?auth_key=` with no "acting as" indication, no reason capture, no audit row |
| **SHU-205** (D-WK2: keep public employer ratings) | Rating 1–5 is required by the employer UI, `is_public` defaults to **true**, and the server validates neither |
| **SHU-212** (D-FE1: ship mobile at cutover) | Two hard facts: the mobile client has no production deploy job in CircleCI (dev and staging buckets only, consistent with SHU-138 §3), and **two-step auth is unimplemented in it** — a candidate who enables 2FA in the web client receives an inactive token and cannot use the mobile app at all. Mobile also carries a live Auth0 "Login with Bawes" path the cutover must keep or replace |
| **SHU-213** (approve parity exclusions) | Candidate perks/discounts, the wallet screen (integration disabled 2025-11-30 but still routed in mobile), the MOCI civil-ID scraper (dead code with a hardcoded ASP.NET `__VIEWSTATE`), and the `Plugn` cross-product menu link are exclusion candidates |
| **SHU-141** (is `status.studenthub.co` live) | Extend the same probe to `GET /aws/config` on all five API hosts — FE-J20 makes that the highest-value single request anyone with network access can make |
| **SHU-131** / **SHU-130** (identity keying) | All five apps key the session on email + password and persist the full profile client-side; the mobile app re-sends Apple-provided name and email from a cached `appleUserDetail` because Apple returns them once |

## 9. Not established

- **No deployed bundle was observed.** SHU-138 FE-F6 stands unchanged. Everything here is source at a named revision.
- **The employer app cannot be running `b9578d5` against `c2ce255`.** It calls `/invitations/*`, `DELETE /company-contacts/{id}`, `PATCH /requests/cancel|deliver` and `POST /auth/login-by-apple`, none of which exist at that backend revision. Either the deployed pair is not this pair, or employer team management and request cancellation are broken in production. This is the one place where the two revisions on the card are demonstrably inconsistent, and it needs either CircleCI history or one authenticated probe to settle.
- **Whether the mobile builds in the stores are `de3ac8c`.** The repo declares Android `versionName 1.4` / `versionCode 5` and iOS `1.0.1` / build 2, and has no production deploy job. SHU-138 follow-up 2 still open.
- **IAM scope of the static AWS key** behind `GET /aws/config`, and whether the permanent bucket is in fact world-readable. Both need infrastructure access; SHU-54 and SHU-134 own them.
- **Whether `PermissionUser.companies` is populated in production**, which decides whether FE-J1's fail-open branch is reachable in practice.
- **Whether `admin_limited_access` accounts exist**, and what the persona is for.
- **Server-side sanitisation** of the HTML fields listed in FE-J33 was not audited.
- **Whether reCAPTCHA is verified in the staff and admin apps** — only the header read was confirmed; the candidate and company verify calls are demonstrably commented out.
- **Whether the Google Maps browser key is referrer-restricted**, and whether Hotjar, GTM and GA are still live accounts.
- Apple `state` and `nonce` are client constants; server-side handling was not read in full.

## 10. Findings

| ID | Finding | Severity | Action |
|---|---|---|---|
| **FE-J1/J2/J3** | Role and permission enforcement is a client-side concern in staff and admin, with two fail-open defaults and one inverted gate; the server has 2 checks against 136 UI gates | **High** — every staff and admin capability boundary is currently advisory | SHU-150 owns the grant catalogue; treat the legacy permission tables as data to import, never as a model to port |
| **FE-J20** | `GET /aws/config` is unauthenticated in four API apps and hands a long-lived AWS key to any caller; five clients upload `public-read` with it | **High** — wider than SHU-134 records | Widen SHU-134; SHU-145 replaces it with short-lived object-scoped credentials |
| **FE-J4** | Impersonation: 7 un-audited entry points, key in a URL, no reason, no audit row, no "acting as" indication | **High** | SHU-156 or drop per SHU-201 |
| RC-F6 | `internal_note` is serialised to candidates; only the client hides it | **High** — resolves a "not established" row as a live leak | SHU-181 must add the `fields()` boundary; verifier spot-check named in section 11 |
| **FE-J7..J12** | Six workflows decide their own state transitions in the client; the server validates values, not transitions | **High** for hours and requests | R2, R4, R6, W4, W5, C2, C4 |
| **FE-J25** | All four Angular apps retry writes with no idempotency keys anywhere | **High** — duplicate transfers and duplicate approvals are reachable | New card, section 7.3 |
| **FE-J14** | Manual work log has no validation in either layer, and the server stores the entry on today's date regardless of the date chosen | **High** — silent wrong-day payroll data | SHU-170 |
| **FE-J21** | Private documents on public URLs; civil ID number, expiry, birth date and video returned for any candidate id to any employer | **High** | SHU-145, SHU-158, SHU-200 |
| **FE-J23** | Release keystores, a Play service-account key, a TLS private key and a Sentry token committed to two repositories | **High** | Rotate and purge; SHU-197 |
| **FE-J24** | reCAPTCHA decorative in three apps; no login throttle anywhere | Medium | SHU-155 |
| **FE-J26/J29** | Clock-in location required by UI only; clock-out destroys the start location; open-session state disagrees across store reassignment; discard hard-deletes | Medium–High | SHU-170, SHU-174, SHU-204 |
| **FE-J27** | Two incompatible definitions of "profile complete", and the mobile client asserts its own | Medium | SHU-92, SHU-143 |
| **FE-J32** | Session token plus full profile including IBAN and civil ID persisted in plaintext client storage, not cleared on logout | Medium | SHU-151 |
| **FE-J5** | Employer role vocabulary is client free text and the only server-side owner check reads an undefined property | Medium | SHU-152, SHU-162 |
| **FE-J22** | Non-expiring Algolia key held in the browser | Medium | SHU-178 |
| **FE-J30** | 1 s and 3 s polling loops in the consumer clients, unthrottled server-side | Medium (cost, not correctness) | SHU-186, SHU-188 |
| **FE-J13** | **Positive finding:** the transfer state machine and all money arithmetic are already server-owned and recomputed from the contract; client gates there are genuinely UX | — | F2/F3 inherit a working contract |
| **FE-J28/J31/J33** | Page-scoped client totals, frozen notification copy, unsanitised HTML rendering | Medium | F3, W3, C3, R6, O9 |
| §5 | 29 client call sites have no backend route; 4 of them are one coherent employer feature | Medium | Section 9; settles the deployed-revision question |
| §7 | 56 UI journeys have no parity row: 14 row corrections, 12 absorbed by existing slices, 3 new cards, 1 exclusion candidate | Method | Section 7 |

## 11. Verification

Author ≠ verifier; the SHU-142 card names `verifier:codex`. The rows a verifier should spot-check first are the ones that change platform contracts and were *not* simply confirmations of an existing inventory finding:

1. **RC-F6 leak** — that `RequestInterview` has no `fields()` override and `GET /requests/interview-requests` returns `internal_note` to a candidate token. `common/models/RequestInterview.php:128-138`, `candidate/modules/v1/controllers/RequestController.php:131-169`.
2. **FE-J20 unauthenticated `aws/config`** — that the authenticator is removed and not restored in all four app copies of `AwsController`, and that each client fetches it without a bearer token (mobile: before login, in an `APP_INITIALIZER`).
3. **FE-J1 fail-open `hasPermission`** — `staff/.../permission.service.ts:35-41` returning true for a company absent from a company-specific section, and `:74,79` logging in with an empty map on fetch error.
4. **FE-J2 count** — 126 `admin_limited_access` gates in page templates against exactly two server-side checks.
5. **FE-J14 manual-log date bug** — that `strtotime` on a bare time string resolves against the server's current date, so `start_time` diverges from the chosen `date`.
6. **Job eligibility enforced nowhere** — that neither client reads `min_age`/`max_age` and the server filter is commented out.
7. **§9 employer/backend inconsistency** — that the four employer endpoints named do not exist at `c2ce255`.

Claims 1, 2, 5 and 7 are the four that can be checked from source in minutes and that most change what the implementation cards must build.

All seven were re-checked against the worktree at `c2ce255` and the five clones before publication, and three subagent citations were corrected in the process: the staff permission fetch-error path is fail-**closed** for gates (only the unlisted-company branch fails open), the admin gate count is 126 page-template occurrences rather than 129, and the candidate web client's `min_age`/`max_age` declarations are at `src/models/job.ts:22-23`. Re-verification by the author is not independent verification; the card's `verifier:codex` reservation stands.
