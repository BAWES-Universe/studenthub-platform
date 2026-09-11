# Replacement app screen and navigation contract (SHU-235)

**Contract:** `SHU-235/AC-01..06`  
**Source baseline:** merged PR #77, head `16b34769e5cd0e3674072f298b05e07e23c5e4b0`, merge commit `2bb54c3bca9b2270b501260eb79bf301ffdd8481`  
**Claim evidence:** SHU-235 re-fetched unassigned at Linear revision `updatedAt=2026-09-11T15:37:40.397Z`; claimed and moved to In Progress at `2026-09-11T15:59:42.730Z`; `verifier:opus` reserved  
**Legacy source revisions:** the five revisions fixed in [`ui-journeys.md`](ui-journeys.md)  
**Scope:** target inventory and navigation contract only. This document does not implement routes, screens, endpoints, grants, or production operations.

This is the target-side companion to the five legacy appendices. A legacy screen is not allowed to disappear because several old routes are consolidated into one screen family. Section 6 gives every Section B data row a target or an explicit SHU-213 exclusion. Section 3 names every target screen family, the grant expression that exposes it, the server policy/endpoint family that must enforce the same expression, and its owning delivery slice.

## 1. Normative rules

1. The server returns navigation for one validated active context. The client may request an organization and role, but the server re-resolves that preference from the current grant store on every request. A client-held role integer, cached permission array, token claim, hidden button, or route guard is never authorization.
2. A navigation entry exists if and only if the effective grant expression in section 3 is true. Direct navigation to the route and every query or command used by that route enforce the same expression. A failed or incomplete grant lookup produces no entry and a server denial; it never defaults to allow.
3. Revocation is visible on the next navigation resolution and on the next endpoint request. Open tabs and cached menus confer no continued access.
4. `staff:*` and `admin:*` below are grant-family notation, not wildcard grants. A principal sees only entries backed by the specific grant named in section 3. `admin:platform` does not imply `staff:finance`, and `admin:grant-admin` does not imply access to candidate or organization data.
5. List, detail, create/edit, modal, picker, export, and empty-state routes grouped into a screen family share one primary slice owner. Dependencies are named when the family crosses a slice boundary; they do not create a second implementation owner.
6. The legacy login, permission, and client-side role mechanisms are negative evidence only. Universe through Authentik is the credential authority; the target has one app and one session.

### Active-context response

The app shell consumes a server-produced context/navigation manifest with, at minimum, the effective principal, selected organization/store when applicable, one effective role, granted capability identifiers, permitted navigation IDs from section 3, and a revision/ETag. The manifest contains no legacy role integer or legacy permission-section array. A context switch invalidates the prior manifest, re-resolves the requested context, and replaces—not unions—the visible navigation. If the requested context is no longer granted, the server denies it and returns the context chooser with no protected destination.

## 2. Navigation contract by grant

Entries are ordered as shown. Every section 2 row is an authenticated app context and implicitly includes the shared-shell entries Account (`U-03`) then Notifications (`U-04`) after its context-specific entries and before any explicitly listed Messages (`U-05`) or Support (`U-06`); listings of `U-03` or `U-04` inside a row show that same position and do not duplicate the entries. Child entries appear only when their own expression is satisfied. `capability:*` identifiers below are versioned capability grants owned by the named delivery slice; they do not add members to the closed role union.

| Effective grant/context | Primary navigation | Conditional/additive entries | Context-switch effect |
|---|---|---|---|
| `candidate:self` | Home (`U-01`), Profile (`C-01..05`, `C-15..16`), Discover (`C-06..07`), Invitations (`C-08`), Interviews (`C-09`), Work (`C-10..13`), Pay (`C-14`), Notifications (`U-04`), Messages (`U-05`), Support (`U-06`) | Track (`C-11`) requires `assignment:active`; empty Certificates and Notifications screens remain reachable with their defined empty states | Switching away removes all candidate-only entries; returning re-resolves current assignment and grants |
| `org:member` at organization | Home (`U-01`), Organization (`O-02` read), Team (`O-04` read), Stores (`O-05` read), Candidates (`O-07` scoped), Messages (`U-05`) | No mutation entry is implied by membership alone | Organization switch replaces all scoped counts, records, URLs, and child entries; no cross-org union |
| `org:owner` at organization | `org:member` entries plus Edit organization (`O-03`), Team management (`O-04`), Store management (`O-05`), Notes (`O-06`) | None; organization ownership alone adds no finance or reporting entry | Switching to a member-only context removes edit/manage actions and their endpoints immediately; a separately granted `org:finance` role is a separate active context governed by the `org:finance` row |
| `org:recruiter` at organization | Home, Requests (`O-08`), Suggestions & invitations (`O-09`), Interviews (`O-10`), Candidates (`O-07`), Work review (`O-11`) | Candidate search is `A-09` only when a scoped `staff:recruiter` grant also exists; no client-held HR string | Switching organization re-scopes every request/candidate/query and clears selected records |
| `org:finance` at organization | Home, Contracts (`O-12`), Transfers (`O-13`), Statements (`O-14`) | Audited exports require the P4 capability; reports require the relevant reporting grant | Switching organization clears finance filters/download URLs and re-resolves server scope |
| `store:manager` at store | Overview (`M-01`), Assigned candidates (`M-02`), Time approvals (`M-03`), Assignment changes (`M-04`), Documents (`M-05`), Messages (`U-05`) | No organization-wide team, contract, transfer, candidate-search, or grant-admin entry | Store switch is offered only for another I4 grant; it replaces the entire store-scoped manifest |
| `staff:self` | My work (`A-14`), Account (`U-03`), Notifications (`U-04`), Messages (`U-05`), Support (`U-06`) | No staff administration follows from `staff:self` | Selecting another staff grant replaces the self-only menu with that grant's menu |
| `staff:candidate-admin` | Home, Candidates (`A-01..04`), Candidate work history (`A-12`), Reports only if separately granted | Act as (`A-16`) requires `staff:act-as`; exports require P4 | Organization/store selectors appear only where the selected record and grant are scoped |
| `capability:staff-work-review` in a staff context | Home, Work, Appeals & corrections (`A-13`) | Candidate/store scope is the intersection of this capability and the selected staff context; it does not add candidate administration | Revocation removes `A-13` and denies an already-open appeal/correction route on the next request |
| `staff:recruiter` | Home, Recruiting (`A-08`), Search (`A-09`), Suggestions/jobs (`A-10`), Interviews (`A-11`) | Assign recruiter/lead actions require `staff:recruiting-lead` | Context change removes lead-only commands and clears selected request/story |
| `capability:candidate-evaluation` in a staff context | Home, Recruiting, Candidate evaluations (`A-30`) | Interview evaluation remains governed by `staff:recruiter`; this capability adds only the question-bank/department-report surface | Revocation removes `A-30` and denies direct report/question-bank requests on the next request |
| `staff:finance` | Home, Contracts (`A-17`), Transfers (`A-18`), Bank files (`A-19`), Settled finance (`A-20`) | Exports require P4; org scope is derived from the finance grant | Context change invalidates previews, action tokens, file leases, and download URLs |
| `staff:org-admin` | Home, Organizations (`A-05`), Organization detail (`A-06`), Reference data (`A-07`) | Notes/exports enforce O9/P4 separately | Context change clears selected organization and any pending write preview |
| `staff:support` | Home, Conversations & tickets (`A-21`) | Campaign delivery is not included | Thread/ticket scope is re-resolved on every request |
| `staff:marketing` | Home, Campaigns (`A-22`) | Webhooks (`A-23`) only with its separate capability | Context change clears recipient/query state and pending runs |
| `staff:reporting` | Home, Operational reports (`A-24`), Statistics (`A-25`), Revenue (`A-31`) | Exports (`A-26`) require the explicit export capability and the underlying record grant; reporting never broadens record access | Context change recomputes every aggregate and export scope |
| `admin:read-only` + `finance:read-settled` | Home, read-only Candidates/Organizations, Settled finance (`A-20`), Reports (`A-24..25`, `A-31`) | No create/edit/delete/act-as/grant/platform entry; exports still require the explicit export capability | Removing either grant removes the corresponding entry and denies already-open routes |
| `capability:account-admin` in a staff or admin context | Home, Access, Accounts (`A-15`) | No candidate, organization, finance, grant-catalogue, platform, or act-as entry follows from account administration | Revocation removes `A-15` and denies an already-open account route or mutation on the next request |
| `admin:grant-admin` | Grant catalogue (`G-01`), Assign/revoke (`G-02`), Grant audit (`G-03`) | No business data entries are implied | Target organization and delegable scope are re-resolved before preview and commit |
| `admin:platform` | Configuration & integrations (`A-27`), Operations (`A-28`), Event/consent controls (`A-29`) | Grant administration and act-as require their own grants | Environment/context changes discard unsaved secret-free configuration previews |
| `staff:act-as` or `admin:act-as` | Act-as sessions (`A-16`) plus an action on eligible subject detail screens | Requires reason, bounded target, visible acting-as banner, expiry, and audit; never shown from role possession alone | Ending/switching the act-as context destroys the delegated navigation manifest |

## 3. Target screen inventory

`Policy / endpoint family` is normative: every member of the family, including downloads and background-triggering commands, enforces the listed grant expression server-side. Names describe the target contract; delivery slices may choose concrete HTTP paths without weakening the pairing.

### 3.1 Shared shell

| ID | Target route / screen | Navigation | Grant expression | Policy / endpoint family | Primary owner | Legacy origin |
|---|---|---|---|---|---|---|
| `U-01` | `/app` — context home | Home | any authenticated effective grant | `context.resolve`, grant-scoped home digest | SHU-91 app shell; P1/P2 provide cards | Five legacy dashboards/tab roots |
| `U-02` | `/sign-in`, `/auth/callback` — Universe sign-in | outside app | anonymous or no active session | Authentik OIDC session only | I2 / SHU-151 | Five login/reset/verification funnels are replaced, not ported |
| `U-03` | `/account` — account and local session security | Account | authenticated principal | `account.self.read`, local sign-out/session revoke | I2 / SHU-151 | Candidate, staff, employer account/password screens |
| `U-04` | `/notifications` — event feed | Notifications | authenticated principal | `notifications.self.list/read`; event rows remain participant/grant filtered | C3 / SHU-188 | Candidate activity/badges and app-shell polling |
| `U-05` | `/messages`, `/messages/:id` — conversations | Messages | typed participant grant for the thread | `chat.list/view/send` | C1 / SHU-186 | Candidate, employer, staff chat routes |
| `U-06` | `/support`, `/support/:id` — tickets | Support | ticket participant or `staff:support` | `ticket.list/view/create/comment/assign/resolve` | C2 / SHU-187 | Candidate/staff ticket routes; employer support remains an explicit product decision |
| `U-07` | `/error/:kind`, wildcard — accessible failure states | none | none; protected data omitted | no business endpoint; retry re-enters `context.resolve` | SHU-91 app shell | All offline/server/not-found/app-error/wildcard routes |
| `U-08` | context chooser in app shell | context control | authenticated principal with one or more resolvable grants | `context.available/select`; selection is preference only | I1/I3/I4, coordinated by SHU-91 | Employer company selector; legacy role/permission switches are negative references |

### 3.2 Candidate surface

| ID | Target route / screen | Navigation | Grant expression | Policy / endpoint family | Primary owner | Legacy origin |
|---|---|---|---|---|---|---|
| `C-01` | `/profile` — own profile projection/completion | Profile | `candidate:self` | `profile.self.read`, completion derived server-side | S1 / SHU-92 | Candidate profile, dashboard profile cards, complete-profile funnels |
| `C-02` | `/profile/edit` — safe self edits | Profile › Edit | `candidate:self` | `profile.self.preview/update` | S2 / SHU-143 | Name, phone, DOB, gender, nationality, location, objective, preferences, bank identity fields |
| `C-03` | `/profile/history` — education, experience, skills, links | Profile › Experience | `candidate:self` | `profile.history.*:self` | S3 / SHU-144 | Education/experience/skill/link routes and modals |
| `C-04` | `/profile/documents` — private files | Profile › Documents | `candidate:self` | `documents.self.list/upload/deliver/delete` | S4 / SHU-145 | Photo, resume, video, civil images; R2-only new uploads, never browser-held cloud keys |
| `C-05` | `/profile/civil-id` — civil verification state | Profile › Civil ID | `candidate:self` | `civil.self.submit/status` | S5 / SHU-146 | National-id, civil expiry and ID-card forms |
| `C-06` | `/discover`, `/discover/:jobId` — job board | Discover | `candidate:self` | `jobs.list/view` with server eligibility | R5 / SHU-180 | Candidate jobs plus mobile requests catalogue |
| `C-07` | `/applications`, `/applications/:id` — applications/request detail | Discover › Applications | `candidate:self` | `applications.self.list/view/apply/withdraw` | R5 / SHU-180 | Candidate request/application routes |
| `C-08` | `/invitations`, `/invitations/:id` | Invitations | `candidate:self` | `invitations.self.list/view/accept/reject` | R4 / SHU-179 | Both candidate invitation lists/details/feedback |
| `C-09` | `/interviews`, `/interviews/:id` | Interviews | `candidate:self` | `interviews.self.list/view/respond` with shared/internal projection | R6 / SHU-181 | Both candidate interview lists/details |
| `C-10` | `/work/assignment`, `/work/assignment/:id` | Work › Assignment | `candidate:self` | `assignments.self.current/history` | W1 / SHU-169 | Candidate assignment/current-company screens |
| `C-11` | `/work/track` — clock/manual session | Work › Track | `candidate:self` + `assignment:active` | `sessions.self.start/stop/manual`; current grant and assignment rechecked | W2 / SHU-170 | Track, end-session, manual-log routes |
| `C-12` | `/work/history`, `/work/history/:date` | Work › History | `candidate:self` | `work.self.days/hours` | W3 / SHU-171 | Log-date/hour lists and work-history cards |
| `C-13` | `/work/appeals`, `/work/appeals/:id` | Work › Appeals | `candidate:self` | `appeals.self.list/view/create/comment` | W5 / SHU-173 | Candidate appeal route and status feed |
| `C-14` | `/pay`, `/pay/:id` | Pay | `candidate:self` | `pay.self.list/view` with private bank projection | F4 / SHU-185 | Payments, transfer detail, candidate salary views |
| `C-15` | `/profile/bank` | Profile › Bank | `candidate:self` | `bank.self.read/preview/update` | S2 / SHU-143 (F1 validation dependency) | Candidate bank/update-bank screens |
| `C-16` | `/profile/certificates`, `/profile/certificates/:id` | Profile › Certificates | `candidate:self` | `certificates.self.list/view/download` | S8 / SHU-148 | Work history and appreciation-certificate downloads |

### 3.3 Organization surface

| ID | Target route / screen | Navigation | Grant expression | Policy / endpoint family | Primary owner | Legacy origin |
|---|---|---|---|---|---|---|
| `O-01` | `/organization/onboarding` — registration/review status | outside/Onboarding | invited principal or `org:owner` pending activation | `org.onboarding.submit/status` | O3 / SHU-161 | Employer register, activate, under-review |
| `O-02` | `/organization/:orgId` — overview/read model | Organization | `org:member` at `orgId` | `org.read` projection | O1 / SHU-159 | Employer/staff/admin company view/list |
| `O-03` | `/organization/:orgId/edit` | Organization › Edit | `org:owner` at `orgId` | `org.profile.preview/update` | O2 / SHU-160 | Employer company-edit and authorized staff/admin forms |
| `O-04` | `/organization/:orgId/team` — members/invitations | Team | read: `org:member`; mutate: `org:owner` | `membership.list/invite/grant/revoke/remove` | O4 / SHU-162 (I3 dependency) | Employer contacts/invitations and staff/admin contact screens |
| `O-05` | `/organization/:orgId/stores`, `/stores/:storeId` | Stores | read: `org:member`; mutate: `org:owner` | `stores.list/view/preview/update` | O7 / SHU-165 | Store lists/views/forms, brand/mall assignment |
| `O-06` | `/organization/:orgId/notes` | Organization › Notes | `org:owner` or authorized `staff:org-admin` | `org.notes.list/view/write/export` | O9 / SHU-167 | Company notes/files/follow-up notes |
| `O-07` | `/organization/:orgId/candidates`, `/candidates/:id` | Candidates | `org:member` with candidate relationship at org/store | `candidate.org.list/view` field projection | S7 / SHU-158 | Employer roster/detail/assignment and store candidate views |
| `O-08` | `/organization/:orgId/requests`, `/requests/:id` | Requests | `org:recruiter` | `requests.org.list/view/preview/write` | R1 / SHU-176 | Employer request tabs/forms/detail/request-sent |
| `O-09` | `/requests/:id/matches` — suggestions/invitations | Recruiting › Matches | `org:recruiter` | `suggestions.org.*`, `invitations.org.*` | R4 / SHU-179 | Employer suggestion/invite components and candidate match lists |
| `O-10` | `/organization/:orgId/interviews` | Recruiting › Interviews | `org:recruiter` | `interviews.org.list/view/schedule/reject` | R6 / SHU-181 | Employer request-interview screens |
| `O-11` | `/organization/:orgId/work` — work logs/decisions | Work review | `org:recruiter` for scoped reads; `store:manager` for store decisions | `work.org/store.read`, `work.store.decide/undo` | W4 / SHU-172 (W3 read dependency) | Employer work-log filters, day/hour lists, approve/reject/undo |
| `O-12` | `/organization/:orgId/contracts` | Finance › Contracts | `org:finance` | `contracts.org.list/view/preview/write` | F1 / SHU-182 | Employer contract list/view and transfer contract picker |
| `O-13` | `/organization/:orgId/transfers`, `/transfers/:id` | Finance › Transfers | `org:finance` | `transfers.org.list/view/preview/write` | F2 / SHU-183 | Employer transfer list/forms/import/detail |
| `O-14` | `/organization/:orgId/statements` | Finance › Statements | `org:finance`; reporting fields require reporting capability | `finance.org.statements/invoices`, audited export | F4 / SHU-185 | Employer transfer summaries and organization reports |

### 3.4 New store-manager surface (no legacy manager UI)

This surface is deliberately designed, not inferred from the unfinished `studenthub-manager` app. It exposes only the selected store. Organization-wide finance, membership, candidate search, grant administration, and unrelated stores never enter its manifest.

| ID | Target route / screen | Navigation | Grant expression | Policy / endpoint family | Primary owner | Origin/design |
|---|---|---|---|---|---|---|
| `M-01` | `/store/:storeId/overview` | Overview | `store:manager` at `storeId` | `store.manager.digest` | I4 / SHU-153 | New; counts limited to the selected store |
| `M-02` | `/store/:storeId/candidates`, `/store/:storeId/candidates/:id` | Assigned candidates | `store:manager` at `storeId` | `candidate.store.list/view` | S7 / SHU-158 | New replacement for fragments previously embedded in employer store views |
| `M-03` | `/store/:storeId/time-approvals`, `/:sessionId` | Time approvals | `store:manager` at `storeId` | `work.store.read/decide/undo` | W4 / SHU-172 | New complete approve/reject/undo queue with explicit state |
| `M-04` | `/store/:storeId/assignment-changes` | Assignment changes | `store:manager` at `storeId` | `assignments.store.request/list/cancel` | W1 / SHU-169 | New complete request/status screen replacing scattered employer/staff fragments |
| `M-05` | `/store/:storeId/candidates/:id/documents` | Documents | `store:manager` at `storeId` plus authorized candidate relationship | `documents.store.deliver` with S7 field projection | S7 / SHU-158 (S4 delivery dependency) | New; expiring delivery only, no object key or bucket access |

### 3.5 Staff/admin capability surfaces

| ID | Target route / screen | Navigation | Grant expression | Policy / endpoint family | Primary owner | Legacy origin |
|---|---|---|---|---|---|---|
| `A-01` | `/people/candidates`, `/:id` | Candidates | `staff:candidate-admin`, or `admin:read-only` for list/view only | `candidate.staff.list/view`; mutation policies remain absent from read-only manifest | S6 / SHU-147 | Staff/admin candidate list/detail/fulltimer views |
| `A-02` | `/people/candidates/:id/lifecycle` | Candidates › Lifecycle | `staff:candidate-admin` | `candidate.staff.approve/restore/merge/warn/tag` | S9 / SHU-149 (S6 UI dependency) | Review queues, warnings, tags, merge/delete/restore |
| `A-03` | `/people/candidate-documents/:id` | Candidates › Documents | `staff:candidate-admin` | `documents.staff.deliver/manage` | S4 / SHU-145 | Admin/staff document views/uploads without public URLs |
| `A-04` | `/people/id-cards` | Candidates › ID cards | `staff:candidate-admin` | `idcards.staff.queue/regenerate/delete`, certificates | S8 / SHU-148 | ID-card request/generate/expired queues and certificate PDF |
| `A-05` | `/organizations` | Organizations | `staff:org-admin`, or `admin:read-only` for list/view only | `org.staff.list/search`; `org.staff.create` requires `staff:org-admin` | O5 / SHU-163 | Staff/admin company lists, registration queues, sub-org creation |
| `A-06` | `/organizations/:orgId/admin` | Organizations › Admin | `staff:org-admin` | `org.staff.status/manager/lifecycle/member/store/note` | O6 / SHU-164 (O4/O7/O9 dependencies) | Staff/admin company/contact/store/detail forms and follow-up |
| `A-07` | `/reference-data/:catalogue` | Reference data | `staff:org-admin` with catalogue capability | `reference.<catalogue>.list/view/preview/write` | O8 / SHU-166 | Banks, countries, currencies, universities, majors, degrees, tags, brands, malls |
| `A-08` | `/recruiting/requests`, `/recruiting/requests/:id`, `/stories/:id` | Recruiting | `staff:recruiter`; lead-only commands require `staff:recruiting-lead` | `requests.staff.*`, `stories.staff.*` | R2 / SHU-177 | Staff/admin request/story dashboards, checklists and assignment |
| `A-09` | `/recruiting/search` | Recruiting › Search | scoped `staff:recruiter` | `candidate.search` server-side and grant-scoped | R3 / SHU-178 | Staff candidate/fulltimer search; no client-held index key |
| `A-10` | `/recruiting/matches`, `/recruiting/jobs` | Recruiting › Matches & Jobs | `staff:recruiter` | `suggestions.staff.*`, `invitations.staff.*`, `jobs.staff.*` | R4 / SHU-179 (R5 job dependency) | Suggestions, invitations, job forms/interests/backlog |
| `A-11` | `/recruiting/interviews`, `/evaluations` | Recruiting › Interviews | `staff:recruiter` | `interviews.staff.*`, internal/shared evaluation projection | R6 / SHU-181 | Interview requests/evaluations; candidate question-bank/report feature remains SHU-234-owned |
| `A-12` | `/work/assignments`, `/work/logs` | Work | relevant `staff:candidate-admin` or scoped work grant | `assignments.staff.*`, `work.staff.read` | W3 / SHU-171 (W1 dependency) | Staff/admin assigned-history, day/hour logs, store assignment review |
| `A-13` | `/work/appeals`, `/work/corrections` | Work › Appeals | `capability:staff-work-review` in a staff context | `appeals.staff.*`, `work.staff.correct/reconcile` | W5 / SHU-173 (W6 dependency) | Appeal list/detail/status/contact/manual correction |
| `A-14` | `/me/work` — standup, leave, expense, session | My work | `staff:self` | `staff.self.session/standup/leave/expense` | W3 / SHU-171 (P1/F4 dependencies) | Staff my-work, leave, expenses, standup, work-session routes |
| `A-15` | `/access/accounts` | Access › Accounts | `capability:account-admin` in a staff or admin context | `accounts.list/view/invite/deactivate/recover` | I5 / SHU-154 | Admin/staff/inspector account CRUD minus excluded inspector identity |
| `A-16` | `/access/act-as` | Access › Act as | `staff:act-as` or `admin:act-as` | `actas.preview/start/end/audit` | I7 / SHU-156 | Seven legacy login-by-key entry points, redesigned rather than ported |
| `A-17` | `/finance/contracts` | Finance › Contracts | `staff:finance` | `contracts.staff.list/view/preview/write` | F1 / SHU-182 | Staff/admin contract screens and rate selection |
| `A-18` | `/finance/transfers`, `/:id` | Finance › Transfers | `staff:finance` | `transfers.staff.list/view/preview/write` | F2 / SHU-183 | Transfer, suspicious-transfer, bulk-import and rate screens |
| `A-19` | `/finance/bank-files` | Finance › Bank files | `staff:finance` | `bankfiles.list/export/lease/reconcile/notify` | F3 / SHU-184 | Payables, bank advice, transfer files, imports and payment search |
| `A-20` | `/finance/settled` | Finance › Settled | `staff:finance` or (`admin:read-only` + `finance:read-settled`) | `finance.settled.list/view/invoice/salary/expense` | F4 / SHU-185 | Invoices, balances, statements, salary and expense views |
| `A-21` | `/service` — conversations, tickets, voicemail records | Service | `staff:support` | `chat.staff.*`, `ticket.staff.*`, authorized delivery-log reads | C2 / SHU-187 (C1 dependency) | Staff/admin support, notes, chat, voice-mail routes |
| `A-22` | `/communications/campaigns` | Communications | `staff:marketing` | `campaigns.list/view/preview/run/log` | C4 / SHU-189 | Email/UTM campaign lists/forms/status |
| `A-23` | `/communications/webhooks` | Communications › Webhooks | explicit webhook-admin capability | `webhooks.list/view/preview/write/test` | C5 / SHU-190 | Admin webhook list/form/test |
| `A-24` | `/reports/operations` | Reports | `staff:reporting` or `admin:read-only`; inspector-style users receive a read-only reporting grant, not a new identity | `reports.morning/productivity` | P1 / SHU-193 | Staff dashboard, assigned-candidate, standup and productivity views |
| `A-25` | `/reports/statistics` | Reports › Statistics | `staff:reporting` or `admin:read-only` | `statistics.read` with field-level finance gates | P2 / SHU-194 | Admin dashboard/stats/year/hitmap views |
| `A-26` | `/reports/exports` | Reports › Exports | explicit reporting export capability plus underlying record grant | `exports.preview/create/status/download` | P4 / SHU-196 | Seven ad-hoc export/download families |
| `A-27` | `/platform/integrations` | Platform › Integrations | `admin:platform` | `config.integrations.read/preview/write` | X1 / SHU-197 | Settings, import/integration register; no live secrets in the UI contract |
| `A-28` | `/platform/operations` | Platform › Operations | `admin:platform` | `operations.jobs/mail/cron/alerts.read` | X2 / SHU-198 | Cron/mail logs and operational status; no HTTP cache flush |
| `A-29` | `/platform/events` | Platform › Events | `admin:platform` with consent/event capability | `events.policy/read/preview/write` | X3 / SHU-199 | Analytics/attribution/event-bus; not raw cross-product tracking keys |
| `A-30` | `/candidate-evaluations` | Recruiting › Evaluations | `capability:candidate-evaluation` in a staff context | `candidate-evaluations.*` | SHU-234 | Admin/staff question bank, department reports and PDFs; named owning card because PR #77 found no parity slice |
| `A-31` | `/reports/revenue` | Reports › Revenue | `staff:reporting` or `admin:read-only`; source finance fields still require finance projection | `revenue.rollups.read/reconcile` | P3 / SHU-195 | Admin revenue and transfer roll-ups; no unreconciled stored aggregate |

### 3.6 New grant-catalogue administration surface (no legacy target to port)

The old permission-section pages are evidence of what failed: unversioned strings, default-allow scoping, client-only evaluation, and no reliable endpoint enforcement. None of their evaluator semantics are carried forward.

| ID | Target route / screen | Navigation | Grant expression | Policy / endpoint family | Primary owner | Origin/design |
|---|---|---|---|---|---|---|
| `G-01` | `/access/grants/catalogue` — roles, capabilities, scopes, versions | Grant catalogue | `admin:grant-admin` | `grants.catalogue.read`; server returns delegable subset | I1 / SHU-150 | New; read-only catalogue with role/capability descriptions and scope rules |
| `G-02` | `/access/grants/assign` — principal/org/store search, effective preview, assign/revoke | Assign & revoke | `admin:grant-admin` plus allowed target scope | `grants.preview/assign/revoke`; commit is audited and transactional | I1 / SHU-150 | New; cannot self-escalate or delegate from mere role possession |
| `G-03` | `/access/grants/audit` — effective grants, provenance, history, next-request result | Grant audit | `admin:grant-admin` | `grants.effective/audit`; private fields minimized | I1 / SHU-150 | New; exposes revocation result and why access is/is not effective |

## 4. Presentation contract (SHU-235/AC-03)

Every screen family in section 3 must pass the same presentation bar:

- Empty, loading, stale/retrying, forbidden/not-found, validation, conflict, and unexpected-error states are distinct. A missing grant is never rendered as an empty data set.
- All primary journeys operate at a 320 CSS-pixel viewport without hidden required actions or horizontal page scrolling. Tables may become labelled record lists; no data field may lose its label.
- Every action, context switch, modal, disclosure, filter, and error is usable by keyboard with visible focus, logical focus return, programmatic labels, and no focus trap.
- Arabic and English are complete for navigation, forms, validation, state labels, receipts, and server-returned event templates. Arabic sets document direction to RTL while numbers, identifiers, and mixed-direction values remain readable.
- Server instants are transported with an offset/zone and displayed in the user's selected IANA timezone. Date-only business values remain date-only. No target code hard-codes Kuwait's UTC offset.
- Monetary values carry currency and exact minor-unit/decimal semantics from the owning finance contract. The formatter never infers currency from locale and never sums only the loaded page.
- Destructive or externally visible writes use the shared preview/confirm/action-token/receipt contract. Loading and retry states never duplicate a write.

## 5. Explicit SHU-213 exclusions and replacements

An exclusion is not approved by this document. These rows are the required input to SHU-213; until SHU-213 approves them, they remain open parity gates.

| Exclusion ID | Legacy surface/affordance | Source rows | Target disposition and reason |
|---|---|---|---|
| `EX-01` | Candidate perks/discounts plus admin discount/category CRUD | MOB-B005; WEB-B047..048; ADM-B052..055 | No target screen. Route to SHU-213: exclude unless a live partnership commitment is established. Admin CRUD has no product purpose if the catalogue is excluded. |
| `EX-02` | Wallet | MOB-B020; WEB-B046 | No target screen. Route to SHU-213: disabled integration already marked discard; remove the still-live entry points. |
| `EX-03` | Inspector identity CRUD / separate status-app persona | ADM-B029..031 | No target identity or login. Route to SHU-213: an inspector-style user, if required, receives a read-only reporting grant and `A-24..25`; SHU-141 settles live reachability. |
| `EX-04` | Cache flush over HTTP on admin dashboard | ADM-B008 sub-action | Dashboard maps to `A-25`; the cache-flush button/endpoint has no target. Route to SHU-213 because it is an operational hazard, not a user journey. |
| `EX-05` | Direct legacy password, OTP, Google, Apple, Auth0, and auth-key login mechanisms | ADM-B006..007; MOB-B054..062,064..065; WEB-B003..007,069; EMP-B005..011,050 | Their screens map to `U-02` or `A-16`, but the mechanisms are excluded. Preserve only linkage/import evidence under I8; Universe/Authentik is the target authority. |
| `EX-06` | MOCI civil-ID scraper | MOB-B050 sub-action; WEB-B068 dead service | No target call. Route to SHU-213: unreachable, brittle government-site scraping; civil verification is `C-05`. |
| `EX-07` | Plugn external menu link | EMP-B051 dead-link register | No StudentHub target screen. Route to SHU-213 for explicit confirm/drop; cross-product launch belongs to Universe navigation, not this app. |

## 6. Complete legacy disposition ledger

The key `APP-Bnnn` means the nth data row, top to bottom, in section B of the named PR #77 appendix at the source baseline above. Markdown header/separator rows are not data rows. This includes modals, child components, app-shell rows, and dead-service rows where the appendix deliberately placed them in section B. A grouped legacy row maps every route/component named in that row. These ranges are a complete, gap-free partition: ADM 1–105, MOB 1–66, WEB 1–69, EMP 1–51, STAFF 1–91. That is 382 audited row groups representing the approximately 410 route/screen declarations. No row is silently omitted.

### 6.1 Admin appendix (`ui-journeys/admin.md`)

| Source rows | Legacy screen group | Target/disposition |
|---|---|---|
| ADM-B001 | root redirect | `U-01` |
| ADM-B002..005 | offline/server/not-found/app-error | `U-07` |
| ADM-B006..007 | login and two-step | `U-02`; mechanisms `EX-05` |
| ADM-B008..010 | dashboard/quicks/stats/revenue | `A-25`, `A-31`; cache-flush sub-action `EX-04` |
| ADM-B011..016 | admin/staff account list/view/form | `A-15`; staff login-as sub-action `A-16` |
| ADM-B017..020 | staff salary/import/register | `A-20` and `A-19` for bank-file import |
| ADM-B021..023 | staff expense and leave decisions | `A-14` read, `A-20` expense settlement, `A-13` decision boundary |
| ADM-B024..028 | staff work sessions and standup questions/answers | `A-14`, `A-24` |
| ADM-B029..031 | inspector list/view/form | `EX-03` |
| ADM-B032..036 | candidate list/review/detail and work-log dates/hours | `A-01..03`, `A-12` |
| ADM-B037..040 | evaluation question/report screens | `A-30` |
| ADM-B041..042 | fulltimer list/view | `A-01` |
| ADM-B043..051 | company/contact/brand/store screens and forms, including organization year report | `A-05..07`, `O-04..05`, `O-14` |
| ADM-B052..055 | discount/category list/view/form | `EX-01` |
| ADM-B056..061 | transfer/suspicious/import/paid screens | `A-18` |
| ADM-B062..070 | payables, payment search, transfer files/advice, bank transactions/sync | `A-19`, with settled results in `A-20` |
| ADM-B071..073 | expense list/view/form | `A-20` |
| ADM-B074..080 | request/story/checklist/assigned-candidate | `A-08`, `A-10`, `A-24` |
| ADM-B081..084 | email and UTM campaign screens | `A-22` |
| ADM-B085..086 | webhook list/view/form/test | `A-23` |
| ADM-B087 | blocked-IP list/form | `A-28` (I6 server boundary) |
| ADM-B088 | settings | `A-27` |
| ADM-B089..090 | mail and voice-mail logs | `A-28`, `A-21` |
| ADM-B091 | import | `A-27` (I8 import ownership) |
| ADM-B092..093 | permission-section/assign-permission | replaced wholesale by `G-01..03` |
| ADM-B094..099 | bank/currency/country/university/major/degree/tag catalogues | `A-07` |
| ADM-B100 | wildcard | `U-07` |
| ADM-B101 | staff/company/candidate pickers | embedded in `A-01`, `A-05`, `A-08`; same grants as parent screen |
| ADM-B102 | upload-file modal | embedded in `A-03` or `A-06`; S4/O2 policy follows parent resource |
| ADM-B103 | company-note modal | embedded in `A-06` / `O-06` |
| ADM-B104 | candidate/fulltimer components | embedded in `A-01` |
| ADM-B105 | image-upload component | embedded in `A-03` or `A-06`; no browser cloud credential |

### 6.2 Candidate mobile appendix (`ui-journeys/candidate-mobile.md`)

| Source rows | Legacy screen group | Target/disposition |
|---|---|---|
| MOB-B001..002 | tab root/dashboard | `U-01` |
| MOB-B003 | payments | `C-14` |
| MOB-B004 | track tab | `C-11` |
| MOB-B005 | discounts/detail | `EX-01` |
| MOB-B006 | profile tab | `C-01` |
| MOB-B007 | requests tab | `C-07` |
| MOB-B008..009 | invitation list/detail | `C-08` |
| MOB-B010..011 | interview list/view | `C-09` |
| MOB-B012..013 | request detail/list | `C-06..07` |
| MOB-B014..015 | work-log date/hour | `C-12` |
| MOB-B016..018 | manual/end/track work | `C-11` |
| MOB-B019 | assignment detail | `C-10` |
| MOB-B020 | wallet | `EX-02` |
| MOB-B021 | activity | `U-04` |
| MOB-B022..023 | chat list/view | `U-05` |
| MOB-B024..026 | support ticket list/form/view | `U-06` |
| MOB-B027..042 | profile completion, personal fields, objective/preferences/profile URL | `C-01..02` |
| MOB-B043..045 | skill/experience/education | `C-03` |
| MOB-B046..049 | photo/resume/video/civil documents | `C-04..05` |
| MOB-B050 | ID-card form | `C-05`; scraper sub-action `EX-06` |
| MOB-B051 | location | `C-02` |
| MOB-B052 | bank modal | `C-15` |
| MOB-B053 | work-history/company/invitation-feedback/options/date-time components | embedded in `C-08`, `C-10`, `C-12`, `C-16`, `U-03` under parent grants |
| MOB-B054..056 | change password/email/reset link | `U-03` or `U-02`; mechanism disposition `EX-05` |
| MOB-B057..062 | landing/email/password/forgot/register/verify | `U-02`, then `C-01`; mechanisms `EX-05` |
| MOB-B063 | error routes | `U-07` |
| MOB-B064 | auth-key and campaign query entry points | `A-16` for audited act-as; campaign attribution `A-29`; mechanism `EX-05` |
| MOB-B065 | app shell polling/push/auth bootstrap | `U-01`, `U-04`; direct legacy auth `EX-05` |
| MOB-B066 | pre-screen AWS initializer | private upload delivery belongs to `C-04`; browser cloud credential is not ported (X1/S4) |

### 6.3 Candidate web appendix (`ui-journeys/candidate-web.md`)

| Source rows | Legacy screen group | Target/disposition |
|---|---|---|
| WEB-B001..007 | root/landing/login/two-step/reset/verify | `U-02`; mechanisms `EX-05` |
| WEB-B008..015 | name/email/phone/DOB/gender/nationality/area/personal completion | `C-01..02` |
| WEB-B016..019 | education/skills/experience/completion | `C-03` |
| WEB-B020 | driving licence | `C-02` |
| WEB-B021 | personal photo | `C-04` |
| WEB-B022..024 | about/objective/video | `C-02`, `C-04` |
| WEB-B025 | civil ID | `C-05` |
| WEB-B026..029 | preferred time/profile URL/complete/contact | `C-01..03` |
| WEB-B030..031 | errors and wildcard | `U-07` |
| WEB-B032 | home | `U-01` |
| WEB-B033 | layout on every authenticated page | shared shell `U-01`, `U-04`, `U-08` |
| WEB-B034 | app bootstrap | `U-01`, `U-02`, `U-04`; legacy auth mechanisms `EX-05` |
| WEB-B035 | activity | `U-04` |
| WEB-B036..037 | invitation list/detail | `C-08` |
| WEB-B038..039 | interview list/detail | `C-09` |
| WEB-B040..041 | jobs list/detail | `C-06` |
| WEB-B042..043 | request/application list/detail | `C-07` |
| WEB-B044..045 | payments list/detail | `C-14` |
| WEB-B046 | wallet | `EX-02` |
| WEB-B047..048 | discounts list/detail | `EX-01` |
| WEB-B049 | profile | `C-01` |
| WEB-B050 | bank | `C-15` |
| WEB-B051 | change password | `U-03` |
| WEB-B052..053 | chat list/detail | `U-05` |
| WEB-B054 | work history | `C-12`, `C-16` |
| WEB-B055 | assignment | `C-10` |
| WEB-B056..058 | track/date/hour | `C-11..12` |
| WEB-B059 | appeal | `C-13` |
| WEB-B060 | unused ticket service functions | no legacy screen; endpoint family is `U-06` |
| WEB-B061 | unused statistics function | no legacy screen; digest target `U-01` |
| WEB-B062 | unused transfer function | no legacy screen; candidate projection `C-14` |
| WEB-B063 | unused mark-as-viewed | no legacy screen; notification read target `U-04` |
| WEB-B064 | unused applications function | no legacy screen; target `C-07` |
| WEB-B065 | unused discount detail/category functions | no target; `EX-01` |
| WEB-B066 | unused validate-password | no screen; session security target `U-03` |
| WEB-B067 | unused language preference | no screen; account target `U-03` and presentation contract §4 |
| WEB-B068 | unused civil-ID lookup/scraper | no target; `EX-06` |
| WEB-B069 | unused direct-auth/mobile/location function group | no screen; `U-02`, `C-02`; legacy auth mechanisms `EX-05` |

### 6.4 Employer appendix (`ui-journeys/employer.md`)

| Source rows | Legacy screen group | Target/disposition |
|---|---|---|
| EMP-B001 | tab-shell redirect | `U-01` |
| EMP-B002 | store/candidate staffing tab | `O-05`, `O-07`, `M-04` |
| EMP-B003 | requests tab | `O-08` |
| EMP-B004 | transfers tab and finance summary | `O-13..14` |
| EMP-B005..011 | login/two-step/register/reset/verify/activate | `U-02`, `O-01`; mechanisms `EX-05` |
| EMP-B012..013 | password/account | `U-03` |
| EMP-B014 | company edit | `O-03` |
| EMP-B015..016 | child-company list/view | `U-08`, `O-02` |
| EMP-B017..018 | store list/view | `O-05` |
| EMP-B019..021 | contacts plus invite/accept modals | `O-04`; free-text roles are replaced by grants |
| EMP-B022..023 | candidate detail and invite modal | `O-07`, `O-09` |
| EMP-B024 | candidate assignment | `O-07`, `M-04` |
| EMP-B025..031 | work-log list/filter/date/hour, approve/reject modals and work-log component | `O-11`, `M-03` |
| EMP-B032..034 | request view and suggestion/interview components | `O-08..10` |
| EMP-B035 | request-interview orphan | consolidated into `O-10` |
| EMP-B036 | request create/edit | `O-08` |
| EMP-B037..038 | chat list/view | `U-05` |
| EMP-B039..040 | contract list/view | `O-12` |
| EMP-B041..044 | transfer detail/forms/fixed/monthly/import | `O-13` |
| EMP-B045..046 | commented candidate search/list | carried forward into scoped `O-07`; not a client-held search-key path |
| EMP-B047 | under-review | `O-01` |
| EMP-B048 | unmounted request-sent | consolidated into `O-08` |
| EMP-B049 | error routes | `U-07` |
| EMP-B050 | app bootstrap/context/auth/AWS behavior | `U-08`, `U-04`, private document delivery; auth mechanism `EX-05` |
| EMP-B051 | dead links | functional journeys map to the families above; Plugn menu link is `EX-07`; dead legacy URLs gain no target route |

### 6.5 Staff appendix (`ui-journeys/staff.md`)

| Source rows | Legacy screen group | Target/disposition |
|---|---|---|
| STAFF-B001 | tab root | `U-01` |
| STAFF-B002 | tasks/standup | `A-14`, `A-24` |
| STAFF-B003 | candidate search | `A-09` |
| STAFF-B004..006 | email campaigns | `A-22` |
| STAFF-B007 | fulltimer search | `A-09` |
| STAFF-B008 | company list | `A-05` |
| STAFF-B009 | request dashboard | `A-08` |
| STAFF-B010 | report list | `A-24..26` |
| STAFF-B011 | feedback backlog | `A-10` |
| STAFF-B012 | story list | `A-08` |
| STAFF-B013 | my work | `A-14` |
| STAFF-B014..016 | login/two-step/reset | `U-02`; mechanisms `EX-05` |
| STAFF-B017..023 | candidate form/list/incomplete/bank/detail/expired/generate ID | `A-01..04` |
| STAFF-B024 | country list/view | `A-07` |
| STAFF-B025..028 | store form/list/view/manager form | `A-06`, `O-05`, manager grant assignment via `G-02`/I4 |
| STAFF-B029 | university list/view | `A-07` |
| STAFF-B030 | error routes | `U-07` |
| STAFF-B031..032 | company view/form | `A-05..06` |
| STAFF-B033 | candidate review | `A-02` |
| STAFF-B034 | company follow-up note | `A-06`, `O-06` |
| STAFF-B035 | company request form | `A-08` |
| STAFF-B036 | brand view | `A-07` |
| STAFF-B037 | mall forms/list/view | `A-07` |
| STAFF-B038..040 | company request list/forms/detail | `A-08` |
| STAFF-B041..042 | assigned-expired/idle and committed candidate | `A-01..02`, `A-24` |
| STAFF-B043 | team list/view/productivity | `A-15`, `A-24` |
| STAFF-B044 | fulltimer detail/form/notes/suggestions | `A-01`, `A-10`, `O-06` |
| STAFF-B045 | company follow-up list | `A-06` |
| STAFF-B046..048 | company contacts/list/detail/form | `A-06`, `O-04` |
| STAFF-B049 | note view | `A-06`, `O-06` |
| STAFF-B050 | suggestion view | `A-10` |
| STAFF-B051 | story view | `A-08`, `A-10` |
| STAFF-B052 | job form/interest filter | `A-10` |
| STAFF-B053..056 | transfer list/view/forms/import/rates/chart | `A-17..20` |
| STAFF-B057 | candidate notes | `A-01`, `O-06` |
| STAFF-B058 | candidate suggestions | `A-10` |
| STAFF-B059 | bank catalogue | `A-07` |
| STAFF-B060 | candidate invitations | `A-10` |
| STAFF-B061 | candidate update-email dead screen | target mutation lives in `C-02`/`A-02`; no dead route is ported |
| STAFF-B062 | staff picker | embedded in `A-08`, same grant as parent |
| STAFF-B063 | velocity/analytics | `A-24..25` |
| STAFF-B064 | voice-mail list/empty view | `A-21`; empty legacy stub is not a separate target |
| STAFF-B065 | client-feedback backlog | `A-10` |
| STAFF-B066 | invitation list | `A-10` |
| STAFF-B067 | change password | `U-03` |
| STAFF-B068 | candidate salary | `A-20` |
| STAFF-B069 | store/mall option sheets | embedded in `A-06..07` |
| STAFF-B070 | assigned history/export | `A-12`, `A-26` |
| STAFF-B071 | work-log date/hour | `A-12` |
| STAFF-B072 | candidate assignment modal | `A-12` |
| STAFF-B073 | leave request/forms/list/view | `A-14`, decision processing in `A-13` |
| STAFF-B074 | candidate evaluation report list/form/view | `A-30` |
| STAFF-B075 | staff expenses | `A-14`, settlement in `A-20` |
| STAFF-B076 | candidate tags | `A-02` |
| STAFF-B077 | candidate warnings | `A-02` |
| STAFF-B078 | company candidates | `A-01` with S7-scoped projection |
| STAFF-B079 | company registration request list/view | `A-05` / O3 |
| STAFF-B080 | update staff account | `U-03` |
| STAFF-B081 | store-assignment request list/empty view | complete target `M-04` and staff review in `A-12` |
| STAFF-B082 | request-interview list/form | `A-11` |
| STAFF-B083 | support/ticket form/view | `A-21` |
| STAFF-B084 | firing hit map | `A-25` |
| STAFF-B085 | interview evaluation form/view/list | `A-11`; question-bank/report portion `A-30` |
| STAFF-B086 | company contract form/view/list | `A-17` |
| STAFF-B087 | appeals/contact/manual correction | `A-13` |
| STAFF-B088 | candidate ID request detail/list | `A-04` |
| STAFF-B089 | cron log | `A-28` |
| STAFF-B090 | invite/suggest/upload/location/profile/org child components | embedded in `A-01..13` according to parent resource; uploads use `A-03`, org files `A-06`, invite/suggest `A-10` |
| STAFF-B091 | wildcard | `U-07` |

## 7. Required parity-contract test and mutation specification

The future executable test title is exactly **`SHU-235/parity-contract`**. It is owned by the app-shell/navigation delivery work and must be runnable against the integrated server plus browser path; this documentation card does not implement it.

The fixture matrix contains one principal/context for each of the 21 rows in section 2: candidate; organization member, owner, recruiter, and finance; store manager; staff self, candidate-admin, recruiter, finance, org-admin, support, marketing, and reporting; staff-context `capability:staff-work-review`; staff-context `capability:candidate-evaluation`; staff-or-admin-context `capability:account-admin`; read-only admin plus settled finance; grant admin; platform admin; and act-as. Candidate has variants with and without `assignment:active`. For each fixture the test:

1. asks the server for the active-context/navigation manifest and asserts exact ordered equality with section 2—no missing and no extra IDs;
2. opens one representative route for that grant, calls one read endpoint behind it, and for mutation-capable grants completes a harmless fixture write through preview/confirm/receipt;
3. revokes the decisive grant, then on the very next requests asserts that the navigation entry is absent, direct browser navigation cannot render protected data, and the previously successful endpoint is denied by the server;
4. starts with no grant for a target screen and reaches its URL directly, asserting server refusal rather than a router-only redirect;
5. switches organization/store/role and asserts that old scoped entries, selected records, cached counts, action tokens, and download URLs cannot be reused;
6. checks representative Arabic/RTL, mobile-width, keyboard, timezone, currency, loading, empty, and error states from section 4.

**Required mutation:** derive one navigation entry from a client-held legacy role (or permission array) instead of the server-resolved grant manifest. The revoke-then-next-request assertion in step 3 must fail. A mutation that only changes a label or route guard is insufficient: the test must prove the entry and its endpoint cease to work together.

Additional completeness mutation for the inventory contract: delete or duplicate any one source ordinal from the five gap-free partitions in section 6. The contract validator specified for the delivery lane must fail before browser execution, proving that a legacy row cannot disappear by silence.

## 8. Acceptance trace

| SHU-235 acceptance | Evidence in this contract |
|---|---|
| AC-01 target inventory, legacy/new origin, owner and grants | Sections 3 and 6 |
| AC-02 navigation per grant and context switching | Sections 1 and 2 |
| AC-03 cross-cutting presentation | Section 4 |
| AC-04 hidden affordance is not control; paired endpoint enforcement | Sections 1 and 3, `Policy / endpoint family` |
| AC-05 two no-legacy grant surfaces designed | Sections 3.4 and 3.6 |
| AC-06 no silent drops; exclusions routed to SHU-213 | Sections 5 and 6 |
| Required named test/mutation | Section 7 |

Authoring this contract does not PASS its correctness, approve SHU-213 exclusions, or claim that any target screen exists. Independent verification must bind its verdict to the exact PR head.
