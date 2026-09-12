# Production parity inventory: communication, support, notifications and clients

**Card:** SHU-129 (parent SHU-88). Feeds SHU-94 (communication contract), SHU-138 (live client revisions), SHU-97 (data map).
**Production source:** `BAWES-Universe/studenthub` at `c2ce255`. Permalink base `https://github.com/BAWES-Universe/studenthub/blob/c2ce255/`.
**Method:** read-only static inspection. No database, provider console or live-host access. No message contents, addresses, phone numbers or personal data.
**Coverage:** 133 of 1,016 functional production actions (`docs/parity/coverage.md`, cluster CM, regenerated at `84ab149`: the two `Story::actionChangeStoryStatus` recruiter transitions moved to recruit).

## 1. What this cluster is

Every channel through which StudentHub talks to a person: in-product chat between candidates, employers and staff; a support ticket system; an in-app notification feed; push notifications through OneSignal; transactional and campaign email; SMS; outbound webhooks; and a telephony call-recording integration. Plus the notes that staff attach to almost every record, and the marketing attribution that links a sign-up back to a campaign.

It is also where the **existing API clients** live for SHU-138: this cluster carries the push channel that any mobile client depends on.

## 2. Channels and their data

### 2.1 Chat

`chat` is a conversation keyed by a combination of participants: `candidate_id`, `company_id`, `parent_company_id`, `store_id`, `contact_uuid`, `staff_id` — six nullable participant columns on one row, with three duplicate scalar columns (`staff`, `candidate`, `contact`) alongside the relations. `chat_message` carries `message_index`, `from` (one of `candidate`, `contact`, `staff` — `common/models/ChatMessage.php:30-32`), `message`, and `status` (0 sent / 1 received / 2 read).

Three apps implement essentially the same nine actions: `List`, `Messages`, `NewMessages`, `UnreadCount`, `SendMessage`, `MarkRead`, `View`, `StartChat`, and on staff additionally `StartClientChat`. That is 28 endpoints implementing one journey three times — the clearest collapse candidate in the whole system.

`NewMessages` and `UnreadCount` alongside `Messages` is a polling shape: clients ask repeatedly rather than receiving pushes.

### 2.2 Support tickets

`ticket`: `candidate_id`, `staff_id`, `ticket_detail`, `ticket_status` (0 pending / 1 in progress / 10 completed), `ticket_started_at`, `ticket_completed_at`, and two derived service-level columns, `response_time` and `resolution_time`. `ticket_comment` threads the conversation; `ticket_attachment` and `ticket_comment_attachment` link to the shared `attachment` table.

Candidate side: `List`, `Create`, `Comment`, `Comments`, `View` (6 actions). Staff side adds `Stats` and `Assign` (8). No employer-facing ticket path exists — employers use chat instead.

### 2.3 In-app notification feed

`candidate_notification` is a typed feed with **eleven notification types** (`common/models/CandidateNotification.php:47-58`): invitation, assignment, unassigned, work approved, work rejected, transfer initiated, transfer paid, transfer unpaid, work session approved, work session rejected, job interest shortlisted. Each row carries a nullable foreign key per subject (work history, working date, working hour, invitation, request, transfer candidate, work-log feedback, company, store, staff, job, appeal, job interest) plus `is_new` and a rendered `message`.

The same polymorphic-by-many-columns shape as `note`: thirteen nullable subject columns. And the message text is **rendered and stored**, so a wording change does not apply to history and a translation cannot be re-rendered per reader.

`staff_notification` is the internal equivalent.

### 2.4 Push

`common/models/MobileNotification.php` wraps OneSignal with `notifyCandidate($heading, $data, $filters, $subtitle, $content)` and sibling helpers, sending through a filter-based audience selection rather than explicit device tokens held by StudentHub.

### 2.5 Email

- **Transactional**: Yii mailer throughout, with an ElasticMail IP-pool header set on several paths. `mail_log` records `from`, `to`, `subject`, `app` and timestamps — a delivery log, not a content log.
- **Campaigns**: `email_campaign` with `subject`, `message`, `progress`, `trigger_date_time`, `last_trigger_date_time`, `is_recurring`, `trigger_period`, `target` (`part-timer`, `full-timer`, `both`) and `status` (0 draft / 1 in progress / 2 completed / 3 ready). `email_campaign_filter` adds arbitrary `param`/`value` pairs that select the audience. `cron/process-campaign` runs **every minute**, finds every campaign in status ready whose trigger time has passed, and calls `process()` on each (`CronController.php` `actionProcessCampaign`).
- Admin and staff both expose `EmailCampaignController` (8 actions each).

### 2.6 SMS

`common/components/SMSComponent.php`, an HTTP API client whose endpoint is an environment value. Used for two-step codes and password resets (identity cluster) and for notifications elsewhere.

### 2.7 Webhooks

`webhook`: `event`, `endpoint`, `method`, created and updated by staff. Dispatched from `common/components/EventManager.php:390`, which looks up every webhook registered for an event and calls it. Managed by `WebhookController` in staff (6) and admin (7).

This is a **staff-configurable outbound HTTP call to an arbitrary URL**, carrying whatever the event payload contains. Finding CM-F4.

### 2.8 Telephony

`common/components/Yeaster.php` plus `YeasterController` in staff and admin (4 actions each: list, view, download). Call recordings, downloadable by staff.

### 2.9 Notes and stories

`note` attaches to eleven entity types with a type vocabulary (Internal Note, Phone Call, Email, Meeting, Interview, Task) — the organizations inventory covers its shape. `story_activity` and `request_activity` are the per-record feeds. `NoteController` exists in admin (6), staff (5) and company (5), the only communication surface with real test coverage.

### 2.10 Marketing attribution

`campaign` holds UTM parameters, `no_of_signups`, `no_of_clicks`, `investment` and `total_revenue`; `utm_uuid` is stamped on `candidate`, `contact` and `company_request` at sign-up.

## 3. Parity rows

| ID | Journey | Actor / grant | Legacy routes | Tests | Disposition | Slice |
|---|---|---|---|---|---|---|
| CM-01 | Chat with a counterpart | candidate, org member, staff | 28 endpoints across three apps | none | REQUIRED, **collapse three implementations into one** | C1 |
| CM-02 | Unread counts and new-message polling | same | `UnreadCount`, `NewMessages` | none | REQUIRED, ADAPT to push or long-poll | C1 |
| CM-03 | Staff starts a chat with a client | staff | `StartClientChat` | none | REQUIRED | C1 |
| CM-04 | Raise a support ticket with attachments | candidate, self | candidate `TicketController` (6) | none | REQUIRED | C2 |
| CM-05 | Work a ticket: assign, comment, complete, stats | staff | staff `TicketController` (8) | none | REQUIRED | C2 |
| CM-06 | Employer support | org member | **does not exist**; employers use chat | none | Decision D-CM3 | — |
| CM-07 | In-app notification feed, eleven types | candidate, self | `CandidateNotificationController` (4) | none | REQUIRED, **ADAPT: store the event, render at read time** | C3 |
| CM-08 | Push notification on those events | candidate, self | `MobileNotification` → OneSignal | none | REQUIRED | C3 |
| CM-09 | Staff notification feed | staff | `StaffNotification` | none | EXCLUDE-PENDING-OWNER (internal, pairs with D-WK4) | — |
| CM-10 | Transactional email | system | Yii mailer, `mail_log` | none | REQUIRED | C4 |
| CM-11 | Email campaigns with audience filters, recurrence | staff, admin | `EmailCampaignController` ×2 (16), `cron/process-campaign` | none | **EXCLUDE-PENDING-OWNER** (D-CM1) | — |
| CM-12 | SMS | system | `SMSComponent` | none | REQUIRED (identity owns the auth codes) | C4 |
| CM-13 | Notification preferences | candidate, contact, staff | `contact_receive_email`, `_suggestions`, `_notification`; `staff_notification`; candidate `language_pref` | none | REQUIRED, **ADAPT: one consent model across channels (CM-F3)** | C4 |
| CM-14 | Outbound webhooks configured by staff | staff, admin | `WebhookController` ×2 (13), `EventManager.php:390` | none | REQUIRED, **ADAPT: allow-list, signing, retry, audit (CM-F4)** | C5 |
| CM-15 | Call recordings | staff, admin | `YeasterController` ×2 (8) | none | EXCLUDE-PENDING-OWNER (D-CM2) | — |
| CM-16 | Notes on records | staff, admin, org member | `NoteController` ×3 (16) | `admin NoteCest` 8, `staff` 7, `company` 7 | REQUIRED (organizations O9 owns the entity) | — |
| CM-17 | Story and request activity feeds | staff, org member | `StoryController`, `RequestActivityController` | `staff StoryCest` 8 | OTHER-CLUSTER (recruit) | — |
| CM-18 | Marketing attribution | system, admin | `CampaignController` candidate (2), company (2), admin (6) | none | OTHER-CLUSTER (reporting SHU-137) | — |
| CM-19 | Bulk suggestion mail, CV email reschedule | staff | recruit controllers | none | REQUIRED as templated sends | C4 |
| CM-20 | Payroll email to company contacts | staff | `PayrollEmail` | none | REQUIRED as a templated send | C4 |
| CM-21 | Mail log | admin | `MailLogController` (4) | none | REQUIRED as delivery observability | C4 |

## 4. Existing API clients (input to SHU-138)

| Client | Backend | Evidence at this revision | Status |
|---|---|---|---|
| `studenthub-candidate-react` | candidate v1 | repository pushed 2026-09-04 | **unresolved** which is deployed |
| `studenthub-candidate-next` | candidate v1 | pushed 2026-08-19 | unresolved |
| `studenthub-candidate` (Cordova) | candidate v1 | pushed 2026-07-06 | unresolved |
| Employer, staff, admin, manager, inspector front ends | respective v1 modules | separate repositories, not inventoried here | unresolved |
| OneSignal push audience | candidate | `MobileNotification` filter-based sends | active in code |
| `studenthub-mcp` | candidate read API | SHU-34 records a live bridge | active per that card |
| Staff-registered webhooks | any | `webhook` rows, contents unknown without the database | unresolved |

Retirement treatment: any client that authenticates against a legacy credential store stops working at the Universe cutover unless it is updated. That set is the three candidate clients plus five internal front ends. Sequencing them is SHU-138's job; this inventory names them so none is missed.

## 5. Tests and fixtures

Only notes are covered: `admin/NoteCest.php` (8), `staff/NoteCest.php` (7), `company/NoteCest.php` (7). There is no chat, ticket, notification, push, campaign, SMS, webhook or telephony test anywhere, and no fixture for any of them.

**Untested behaviour, explicitly:** the entire chat surface in all three apps; ticket creation, assignment, commenting and the service-level timers; all eleven notification types and their triggers; every push send; campaign audience filtering, recurrence and the per-minute processor; SMS delivery; webhook dispatch; call recording access; notification preferences being honoured.

## 6. Findings

| ID | Finding | Evidence | Severity | Action |
|---|---|---|---|---|
| **CM-F1** | One chat journey is implemented three times, 28 endpoints, with no shared service | §2.1 | Design (this is the cluster's whole collapse opportunity) | C1 |
| **CM-F2** | Notification messages are rendered and stored as text, so wording and language are frozen at send time and history cannot be re-rendered | `candidate_notification.message` | Medium (blocks Arabic and any copy change) | C3 |
| **CM-F3** | Preferences are scattered and channel-blind: three boolean columns on `contact`, one on `staff`, a language column on `candidate`. **Corrected after independent audit:** some send paths do consult them — suggestion emails filter verified contacts on `contact_receive_email` and `contact_receive_suggestions` (`common/models/Suggestion.php:452-457`, `:482-487`) and transfer receipts on `contact_receive_email` (`common/models/Transfer.php:748`, `:778`); no path was found that consults the SMS/push columns | §2.5, §3 CM-13; evidence cited | Medium (consent is partial, not absent) | C4 must preserve the existing recipient rules while unifying the policy |
| **CM-F4** | Staff can register a webhook to an arbitrary URL and the event manager calls it with the event payload; no allow-list, signing, retry or audit is visible | `common/components/EventManager.php:390`; `webhook` table | **High** (a staff account becomes a data-exfiltration channel) | C5, and D-CM4 |
| **CM-F5** | `cron/process-campaign` runs every minute. `EmailCampaign::process()` does set `STATUS_IN_PROGRESS` and save before sending (`common/models/EmailCampaign.php:311-325`), but `processed` restarts at zero, send exceptions are skipped and `progress` is a percentage of attempted batches (`:211-228`), and recurrence is scheduled from the current execution time (`:328-338`) — a persisted percentage is not a per-recipient delivery checkpoint | `CronController.php` `actionProcessCampaign`; `EmailCampaign.php:211-228`, `:311-338` | Medium (a crash mid-campaign resends from the start) | C4: per-recipient delivery log and lease |
| **CM-F6** | `chat` carries six nullable participant columns plus three duplicate scalars; `candidate_notification` carries thirteen nullable subject columns | §2.1, §2.3 | Design | C1, C3: typed participants and one subject reference |
| **CM-F7** | Zero tests across every channel that reaches a real person | §5 | High for migration confidence | specify test-first |
| **CM-F8** | No employer-facing support path exists; employers are pushed into chat | §3 CM-06 | Product gap | D-CM3 |
| **CM-F9** | Push audience is selected by OneSignal filters rather than a device registry StudentHub controls | §2.4 | Medium (no server-side proof of who was notified) | C3 |
| **CM-F9** | Chat read state is shared, not per recipient: reading marks every non-candidate (or non-contact) message read, and unread counts use that single status, so in a multi-party chat one reader clears another's unread count | `candidate/.../ChatController.php:206-220`; `company/.../ChatController.php:259-273`; `common/models/Chat.php:194-227` | Medium | C1: per-participant read cursor |
| **CM-F10** | `message_index` is allocated as a global `MAX+1` across all chats with no atomic allocator; uniqueness is validated on `chat_uuid` only | `common/models/ChatMessage.php:89-90`, `:48` | Medium (ordering/cursor collisions under concurrent sends; not reproduced) | C1: per-conversation sequence |
| **CM-F11** | A ticket comment sends its mail, then copies attachments; attachment copy/save failures are swallowed and the caller reports success | `common/models/TicketComment.php:105-111`, `:198-223`; `candidate/.../TicketController.php:140-150` | Medium (partial success with no retry or cleanup) | C2: attachments before notification, explicit result |
| **CM-F12** | Ticket lifecycle events send the free-text `ticket_description` to analytics with ticket and person ids | `common/models/Ticket.php:146-154`, `:165-173`, `:180-188` | Medium (support text is PII) | X3 whitelist; C2 emits ids only |

## 7. Classification of prior findings

| Source | Claim | At `c2ce255` |
|---|---|---|
| SHU-34 | MobileNotification / OneSignal is a live client integration | **Production-supported**; §2.4 and §4 |
| SHU-34 | `studenthub-mcp` is a live bridge to the candidate read API | Recorded on that card; not re-verified here (needs deployment evidence, SHU-138) |
| SHU-39 | Chat and ticket attachments use the shared attachment table | **Production-supported** |
| SHU-39 | Notification and mail behaviour is largely untested | **Production-supported**, and stronger than stated: it is entirely untested |

## 8. Bounded slices for SHU-94

| Slice | Scope | Depends on | Points |
|---|---|---|---|
| C1 | One chat service: typed participants, grant-scoped access, unread state, one implementation for every role | SHU-91, organizations O1 | 8 |
| C2 | Support tickets: raise with attachments, assign, comment, resolve, service-level timers | C1, profile S4 (attachments) | 5 |
| C3 | Notification feed and push: store the event and render at read time, one subject reference, a device registry StudentHub owns | work W4, finance F3 (event sources) | 5 |
| C4 | Delivery: transactional email and SMS templates, one consent model consulted by every send, leased campaign processing, delivery log | C3 | 5 |
| C5 | Outbound webhooks: allow-listed endpoints, signed payloads, retry with backoff, full audit | SHU-59 | 3 |

Cluster total: **26 points** (18 if D-CM1 drops campaigns), against the 8-point placeholder.

**All seven original clusters are now sized: profile 40, organizations 46, work 31, recruit 36, finance 26, communication 26, identity 30. Total 235 points against the 56-point placeholder — a factor of 4.2.** Reporting (SHU-137), platform and operations (SHU-139) and live front ends (SHU-138) remain.

## 9. Decisions for Khalid

| ID | Decision | Recommended default | Cost of waiting |
|---|---|---|---|
| D-CM1 | Keep email campaigns in the product (CM-11), or move marketing email to a dedicated tool? | Move it out. It is 16 endpoints plus a per-minute processor, and every marketing platform does it better | Removes 8 points and a duplicate-send risk. Blocks nothing |
| D-CM2 | Keep call recordings (CM-15)? | Drop unless the sales team relies on it; recordings carry consent obligations we would inherit | Low |
| D-CM3 | Employers have no support channel except chat (CM-F8). Give them tickets too? | Yes, one ticket system for every role, which is nearly free once C2 exists | Blocks nothing; decide before C2 is built rather than after |
| D-CM4 | Staff-configured webhooks to arbitrary URLs (CM-F4). Keep, with controls, or drop? | Keep but allow-list destinations and sign payloads; if nothing currently consumes them, drop entirely | Blocks C5. Worth checking the `webhook` table for live rows before building anything |

## 10. Not established

- Whether the SMS and push paths consult any preference column (email paths do; CM-F3).
- Which webhooks are registered in production, and to where.
- Which candidate client is deployed, and whether any still ships a Cordova build (SHU-138).
- Message and ticket volumes, which size C1 and C2.
