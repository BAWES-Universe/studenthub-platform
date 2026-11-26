# Production parity inventory: communication, support, notifications and clients

**Card:** SHU-129 (parent SHU-88). Feeds SHU-94 and its implementation cards SHU-186 through SHU-190; related evidence is in SHU-138, SHU-142, SHU-210, SHU-213 and SHU-233.

**Production authority:** `BAWES-Universe/studenthub@c2ce255695eabc7e3a0f23b162f5996274234c63`.

**Platform baseline reviewed:** current `main` at `e825ff5aa9f28bade60079ac039ad8d9aeb15d83`.
**Method:** read-only static inspection of production source, the SHU-142 client journeys on current `main`, and SHU-138's frontend/deployment inventory at `1f0beb1`. The coverage generator from `a01a9ae` was rerun against the production commit. No database, provider console, live host, message content, identity or personal data was accessed.

## 1. Coverage reconciliation

The generator reports `functional=1016`, `hooks=171`, `controllers=195`, `seven=941`, and assigns **133 functional controller actions** to CM. The 133 are all represented below, including 22 discount/perk actions and two Jira support-integration actions omitted by the earlier inventory. Eleven Story actions remain counted in CM by the ledger but are routed to the recruit cluster.

Reproduction:

```text
node tools/parity/generate-coverage-ledger.mjs \
  /path/to/BAWES-Universe/studenthub@c2ce255 \
  /tmp/shu129/coverage.md
PASS: functional=1016 hooks=171 controllers=195 seven=941
```

| App | Controller action counts | CM actions |
|---|---|---:|
| admin | Campaign 5; Discount 5; DiscountCategory 5; EmailCampaign 7; MailLog 3; Note 5; Story 4; Webhook 6; Yeaster 3 | 43 |
| candidate | Campaign 1; CandidateNotification 3; Chat 8; Discount 1; DiscountCategory 1; Ticket 5 | 19 |
| company | Campaign 1; Chat 8; Note 5 | 14 |
| staff | Chat 9; Discount 5; DiscountCategory 5; EmailCampaign 7; Jira 2; Note 5; Story 7; Ticket 7; Webhook 5; Yeaster 3 | 55 |
| console | Cron 2 (`ProcessCampaign`, `MidMonth`) | 2 |
| **Total** |  | **133** |

The controller ledger is not the whole communication inventory: model hooks, components, queued or scheduled sends and client polling/push behavior are also included in the following sections.

## 2. Channel inventory and authorization

### 2.1 Chat

`chat` represents a conversation with nullable `candidate_id`, `company_id`, `parent_company_id`, `store_id`, `contact_uuid` and `staff_id` participants. `chat_message` contains `message_index`, sender role, message text and one shared status (`sent`, `received`, `read`). Candidate and company expose eight actions each; staff exposes nine, for **25 actions**, not 28.

| Actor | Effective server-side scope | Inputs and state changes | Client surfaces / failure behavior |
|---|---|---|---|
| candidate bearer | list/view are scoped to `candidate_id` | start, send, list messages, mark read | candidate web and mobile; unread polling is 3 s web / 1 s mobile, mobile new-message polling 5 s |
| company contact bearer | list/view are scoped to `contact_uuid`; start validates candidate membership through the company manager | same eight-action conversation flow | employer web; new-message polling 5 s; unread polling is commented out |
| staff bearer | list/view are scoped to `staff_id` | same flow plus `StartClientChat` | staff has a chat service but no calling page in the source-bound UI inventory |

Important failure and transition semantics:

- Read state is one message-level value, not a per-participant cursor. One reader can clear another participant's unread state.
- `message_index` is allocated with a global `MAX + 1`, without an atomic allocator; uniqueness is validated only within a chat.
- `staff/ChatController::actionStartChat` places the authenticated staff UUID into `contact_uuid` and does not set `staff_id`; that is an inconsistent participant binding. `StartClientChat` accepts a client/contact and sets access directly.
- The four Angular clients retry mutating HTTP verbs up to three times without an idempotency key. Chat sends can therefore be duplicated despite the replacement contract added by SHU-233.

### 2.2 Support tickets, comments and attachments

`ticket` has candidate and assignee identifiers, free-text detail, status (`0` pending, `1` in progress, `10` completed), timestamps, `response_time` and `resolution_time`. Candidate has five actions; staff has seven.

| Journey | Authorization and inputs | State / output | Failure behavior |
|---|---|---|---|
| candidate list/view/comment | ticket lookup is owner-scoped by `candidate_id` | creates ticket/comments and returns threaded records | comment notification mail is sent before attachment processing |
| candidate create/comment with attachments | caller supplies S3 temporary object keys | hooks copy objects to permanent storage and create attachment links | no server-side proof of uploader ownership, content type or size; copy/save exceptions are swallowed and the API can report success |
| staff list/view/stats | any authenticated staff bearer; lookup is only by ticket UUID | exposes all tickets and their free-text content | no assignee or lead scope |
| staff assign | any staff bearer can submit an arbitrary `staff_id` | overwrites assignee | no eligibility or transition check |
| staff comment/resolve | any staff bearer can submit `status` with the comment | any integer accepted by the model can replace status | no state-machine or assignee/lead enforcement |

`ticket_comment_attachment.ticket_comment_uuid` is unique, so an array of supplied attachment keys can conflict with the effective one-link-per-comment model. Employers have no ticket journey; their only support-like surface is chat.

The SLA columns are elapsed timestamps, not timers. First transition to in-progress records `ticket_started_at` and response elapsed from creation; returning to in-progress resets the start. Completion records elapsed from the current start, or zero if no start exists. There is no breach threshold, pause policy, timer job or escalation.

### 2.3 Notification feeds

`candidate_notification` has **12 constants**, values 0 through 11: invitation, assignment, unassigned, work approved/rejected, transfer initiated/paid/unpaid, work-session approved/rejected, job-interest shortlisted and job-interest rejected. It holds many nullable subject FKs, `is_new`, and already-rendered `message` text.

Candidate list/mark-read/mark-all-read are owner-scoped. Rendering at write time freezes copy and language in history. Client mappings drift: mobile explicitly renders values 0 through 9 and falls back for later values; candidate web has a mapping for rejected job interest. Replacement must define an event schema and unknown-type behavior rather than copy either client table.

`staff_notification` is **not a staff feed**. It stores a staff UUID plus a permission and is maintained through staff administration as an email/permission subscription. No staff notification controller or staff feed UI was found.

### 2.4 Push and device registration

`MobileNotification` sends OneSignal requests selected by client-maintained filters/tags. StudentHub stores no authoritative device installation/token registry, ownership proof, revocation state or per-device delivery record. Native mobile and candidate PWA initialize OneSignal; candidate web also has PWA push code.

The server disables TLS peer verification for the OneSignal cURL request, discards the provider response and records no status, retry or audit row. Audience membership and notification copy are partly client-owned, so the server cannot establish exactly which installation was targeted or received a push.

### 2.5 Transactional email, SMS, consent and delivery logs

Transactional email is sent from model hooks, controllers, cron jobs and services through Yii mailer. Some paths set an ElasticMail pool header. Existing consent is partial and channel-specific:

- suggestion email filters verified contacts using `contact_receive_email` and `contact_receive_suggestions`;
- transfer receipt mail consults `contact_receive_email`;
- employer UI exposes contact email/suggestion/notification flags;
- candidate `language_pref` is updated by mobile, while candidate web only changes local language / request headers and never calls the preference endpoint;
- no server-side push-device consent registry exists, and no general SMS consent check was found.

`mail_log` stores from/to/subject/app and timestamps, usually before the send. It has no provider message ID, accepted/delivered/bounced state, response, error or attempt number. It is a send-intent metadata log, not evidence of delivery.

`SMSComponent` calls a fixed HTTP (not HTTPS) provider endpoint using credentials embedded in source. It has no centralized consent, retry, attempt or delivery log. Credential values are deliberately not reproduced here.

### 2.6 Campaigns

Admin and staff expose seven EmailCampaign actions each. Status is draft 0, in-progress 1, completed 2, ready 3. `actionRun` sets ready without constraining the prior state. The per-minute processor selects due ready rows and `process()` sets in-progress before batching recipients.

`processed` restarts at zero on each invocation, exceptions skip recipients, and progress is attempted-batch percentage rather than a recipient checkpoint. A crash can restart from the beginning and duplicate sends. Recurrence is calculated from execution time. Subject/message validation is not an adequate delivery contract. Admin polls campaign status every second; staff also has campaign UI.

The 22 Discount/DiscountCategory actions expose the perks catalogue in admin/staff/candidate clients. They are in CM coverage but are a product-content surface, not message delivery; retention/exclusion belongs to SHU-213.

### 2.7 Webhooks and other outbound integrations

`webhook` holds event, endpoint and HTTP method. Admin has six actions including `Test`; staff has five. The model has no destination scheme/host allow-list. Dispatch is synchronous, unsigned and has no retry/dead-letter/audit record. Admin UI permits arbitrary endpoint, method and test JSON. Staff has backend routes but no calling UI in the reviewed client source.

`EventManager` also fans events to analytics/queue/HTTP integrations. Those effects require an explicit payload allow-list; ticket lifecycle currently sends free-text ticket description with person/ticket identifiers to analytics.

The two `staff/JiraController` actions remove the bearer authenticator. `/issues` proxies Jira query results; `/users` joins Jira users with local staff and returns staff salary/currency fields. No staff UI caller was found. This is an unauthenticated support-integration and sensitive-field exposure, not a safe client-only permission.

`Yeaster` retrieves PBX call records/downloads through an HTTP service using an embedded bearer credential. Admin and staff each expose list/view/download. No call-recording consent proof or application delivery audit was found. Credential values are not reproduced.

### 2.8 Notes, stories and attribution

`NoteController` has five actions in each of admin, staff and company. Notes attach to many entity types and accept a client-chosen free-text note type. This is the only CM controller family with functional tests.

Eleven Story actions are counted in CM but routed to recruit. Candidate/company campaign click actions and admin campaign CRUD stamp/report UTM attribution; candidate web, candidate mobile and employer web capture UTM values. These flows must remain visible even if marketing campaigns are excluded from the communication replacement.

## 3. Every known client surface

Deployment status below is repository/CI evidence from SHU-138 and SHU-142, not a live-host assertion.

| Client source revision | Status evidence | Communication/support behavior | Cutover / retirement treatment |
|---|---|---|---|
| `studenthub-candidate-react@2f0a121` | active-in-CI inference | chat, 3 s unread polling, activity feed, OneSignal PWA, local-only language change, UTM; no ticket UI found | migrate bearer contract, notification schema and push ownership; reconcile language preference |
| `studenthub-candidate@de3ac8c` | current mobile source; store version and production bucket unresolved | chat, 1 s unread / 5 s message polling, tickets and attachments, activity feed, native/PWA OneSignal, language preference, UTM; Angular write retries | identify shipped store build, then migrate or retire it explicitly |
| `studenthub-company@b9578d5` | active-in-CI inference | chat, 5 s new-message polling, unread polling disabled, contact preferences, UTM; no ticket UI | migrate chat/preferences; decide employer ticket support |
| `studenthub-staff@49ed05c` | active-in-CI inference | ticket, campaigns, notes and voice-mail UI; chat service without a calling page; no webhook UI; Angular write retries | migrate required surfaces and remove unreachable legacy routes |
| `studenthub-admin@c789b17` | active-in-CI inference | campaign, webhook/test, mail-log, notes and voice UI; campaign polling 1 s | backend authorizes almost all routes as any admin bearer; UI `limitedAccess` is not authorization and must not be preserved as such |
| `studenthub-manager@41c3293` | host unrouted; user evidence says unfinished | source includes legacy API client behavior; no supported communication target established | retire; do not create a replacement target without a product decision |
| `studenthub-inspector` (last pushed 2021) | unmaintained; status host unrouted; inspector API exposes only auth/account/AWS/ping | no communication/support surface found | retire or formally exclude |
| `studenthub-candidate-next@7c57b58` | abandoned; no deployment target | no authoritative production journey | retire |
| `studenthub-mcp` | live bridge recorded by SHU-34; not reverified here | candidate read API consumer | SHU-138 must confirm cutover owner and exact deployed revision |
| OneSignal audience and stored webhook rows | active code paths; production registrations/rows unknown without prohibited access | external client/device and callback surfaces | migrate only with explicit ownership, destination and revocation evidence |

## 4. Scheduled communication jobs

| Schedule / entry point | Communication effect | State and retry concern | Replacement owner |
|---|---|---|---|
| every minute `cron/process-campaign` | campaign email batches | no recipient lease/checkpoint; rerun duplicates possible | C4 if retained; otherwise SHU-213 exclusion |
| every minute `cron/every-minute` | suggestion and full-timer candidate notifications | model-driven email/feed/push effects; no unified delivery record | C3/C4 |
| every minute `process-transfer-files` | transfer-processing mail on relevant paths | effect mixed with file processing | finance producer + C4 delivery |
| daily early-morning payable/summary jobs | candidate/contact mail | schedule comments and cron time disagree on one summary job; delivery state not durable | finance producer + C4 |
| daily 13:30 `cron/daily` | transfer-success email and push, then flag save | send-before-final-state-save leaves a duplicate window | finance producer + C3/C4 |
| mid-month / end-of-month | missing-bank/civil-expiry notifications, attendance requests and recruiter report mail | grouped business jobs; partial retries are not per-recipient | profile/work/recruit producers + C3/C4 |
| PBX sync/process references | call-record ingestion | referenced outside the monolith cron list; operational schedule unresolved | D-CM2 / SHU-139 |
| `check-daily-attendance` | attendance communication | cron line is commented out; not active by source evidence | work decision; do not assume active |

The ledger's `Cron::actionMidMonth` is one of the 133 CM actions; the table includes the additional communication effects whose controller action is owned by another cluster.

## 5. Parity rows

| ID | Journey and required contract | Legacy evidence / scope | Disposition | Slice |
|---|---|---|---|---|
| CM-01 | typed-participant chat with grant-scoped access | Chat 25 actions | REQUIRED | C1 / SHU-186 |
| CM-02 | per-participant unread cursor and atomic conversation sequence | poll/read/message-index behavior | REQUIRED, adapt | C1 |
| CM-03 | staff starts an authorized client chat | `StartChat`, `StartClientChat`; inconsistent staff/contact binding | REQUIRED, correct | C1 |
| CM-04 | candidate raises ticket with owned, validated attachments | candidate Ticket 5 | REQUIRED | C2 / SHU-187 |
| CM-05 | authorized assignee/lead assigns, comments and resolves through a state machine | staff Ticket 7; currently any staff | REQUIRED, correct | C2 |
| CM-06 | employer support | absent; employer uses chat | DECISION D-CM3 | C2 if retained |
| CM-07 | typed candidate event feed, 12 legacy types, rendered per reader | CandidateNotification 3 | REQUIRED, adapt | C3 / SHU-188 |
| CM-08 | owned/revocable device registration and de-duplicated push | filter-based OneSignal component | REQUIRED, adapt | C3 |
| CM-09 | staff permission subscriptions | `staff_notification`; not a feed | REQUIRED only as authorization/subscription data | identity/C4 |
| CM-10 | transactional email with templating, consent and idempotent delivery | distributed Yii sends | REQUIRED | C4 / SHU-189 |
| CM-11 | audience campaigns with leased per-recipient processing | EmailCampaign 14 + per-minute cron | EXCLUDE-PENDING-OWNER, D-CM1 / SHU-213 | C4 if retained |
| CM-12 | transactional SMS with consent and delivery attempts | `SMSComponent` | REQUIRED for retained SMS | C4 |
| CM-13 | unified channel consent and language policy | contact flags, staff subscriptions, candidate language | REQUIRED, preserve existing filters | C4 |
| CM-14 | allow-listed, signed, retried and audited webhooks | Webhook 11 + EventManager | REQUIRED only if D-CM4 retains | C5 / SHU-190 |
| CM-15 | call-record listing/download with consent and authorization | Yeaster 6 | EXCLUDE-PENDING-OWNER, D-CM2 | — |
| CM-16 | polymorphic record notes with server-owned type vocabulary | Note 15 | REQUIRED; organization entity owner | organizations O9 |
| CM-17 | story/activity feeds | Story 11 | OTHER-CLUSTER | recruit |
| CM-18 | UTM click/signup attribution | Campaign 7 plus client capture | OTHER-CLUSTER | reporting |
| CM-19 | suggestion/CV/recruit bulk mail | recruit controllers/models and cron | REQUIRED as producer-specific templates | C4 |
| CM-20 | payroll/transfer mail to company contacts | finance models and cron | REQUIRED as producer-specific templates | C4 |
| CM-21 | immutable send attempts and provider outcomes | MailLog 3; current log is intent only | REQUIRED, replace semantics | C4 |
| CM-22 | candidate perks catalogue | Discount/DiscountCategory 22 | EXCLUDE-PENDING-OWNER, SHU-213 | — |
| CM-23 | Jira support proxy and staff-user join | Jira 2; unauthenticated and exposes salary/currency | BLOCKED unsafe; remove or redesign with explicit grants | C2 or exclusion |

## 6. Falsification findings

| ID | Reproduced finding | Risk / required correction |
|---|---|---|
| CM-F1 | Three chat controllers implement 25 actions | collapse to one contract; do not carry divergent role behavior |
| CM-F2 | notification copy is persisted and client type maps diverge | store typed events and render with defined unknown-type behavior |
| CM-F3 | consent is scattered; some email paths honor it, push/SMS lack one central policy | preserve existing suppression and centralize channel consent |
| CM-F4 | webhook destination/method/test payload are configurable without allow-list/sign/retry/audit | SSRF/exfiltration surface; SHU-190 controls are mandatory if retained |
| CM-F5 | campaign rerun starts recipient processing at zero and `Run` is unconditional | lease and checkpoint each recipient or exclude campaigns |
| CM-F6 | chat participants and notification subjects are polymorphic nullable-column sets | replace with typed, constrained references |
| CM-F7 | no functional tests cover chat, tickets, notifications, push, campaign, SMS, webhook or PBX | contract tests are a migration prerequisite |
| CM-F8 | no employer ticket path exists | decide rather than invent parity |
| CM-F9 | OneSignal audience is client-tag-owned; no backend device registry | server cannot prove target ownership/revocation/delivery |
| CM-F10 | chat read state is shared | one participant can clear another's unread state |
| CM-F11 | chat sequence is non-atomic global `MAX + 1` | concurrent sends can race; use per-conversation atomic sequence |
| CM-F12 | ticket mail precedes attachment copy and copy/save errors are swallowed | partial success is reported as success; stage attachments first |
| CM-F13 | any staff bearer can read, assign and set arbitrary ticket status | missing server-side assignment/transition authorization |
| CM-F14 | attachment temp keys are unbound/unvalidated; comment link uniqueness conflicts with arrays | object theft/content risk and partial multi-attachment behavior |
| CM-F15 | backend defines 12 notification types while clients have different mappings | schema/version and fallback contract required |
| CM-F16 | push disables TLS peer verification and discards provider response | transport and delivery outcome are unverifiable |
| CM-F17 | Jira actions disable authentication and `/users` returns salary/currency | unauthenticated sensitive-data exposure; remove or secure before cutover |
| CM-F18 | four Angular clients retry write verbs three times without idempotency | duplicate chat/ticket/comment/campaign mutations possible |
| CM-F19 | staff chat start binds staff identity as a contact | unsafe/inoperable identity association |
| CM-F20 | mail log is usually written before send and has no outcome/attempt | it is not a delivery log |
| CM-F21 | web/mobile language preference, push setup, UTM and polling differ by client | these are migration journeys, not incidental UI details |
| CM-F22 | SLA fields reset on re-entry to in-progress and no breach timer exists | define SLA clock/state semantics explicitly |
| CM-F23 | SMS and PBX integrations use plaintext HTTP and source-embedded credentials | rotate externally, move to secret storage and require TLS; values must never enter migration docs |
| CM-F24 | ticket free text is sent to analytics with identifiers | emit allow-listed event fields only |

## 7. Tests and evidence limits

Only notes have functional coverage: admin `NoteCest` (8), staff `NoteCest` (7), and company `NoteCest` (7). No functional test or fixture was found for chat, ticket, notification, push, campaign, SMS, webhook, Jira or PBX behavior. Findings above are source-reproduced; concurrency races and provider outcomes were not triggered against production.

Production database facts remain unknown: registered webhook destinations, device tags, campaign state, ticket/message volumes and delivery outcomes. Likewise, exact deployed browser/mobile revisions were not asserted from source/CI evidence. Those unknowns must not be converted into implementation assumptions.

### Reproduction anchors at the production commit

| Claim family | Source anchors |
|---|---|
| chat grants, read state and sequence | `candidate/modules/v1/controllers/ChatController.php`; `company/modules/v1/controllers/ChatController.php`; `staff/modules/v1/controllers/ChatController.php`; `common/models/Chat.php`; `common/models/ChatMessage.php` |
| ticket grants, lifecycle and attachment ordering | `candidate/modules/v1/controllers/TicketController.php`; `staff/modules/v1/controllers/TicketController.php`; `common/models/Ticket.php`; `common/models/TicketComment.php`; `common/models/TicketAttachment.php`; `common/models/TicketCommentAttachment.php` |
| feed types and ownership | `common/models/CandidateNotification.php`; `candidate/modules/v1/controllers/CandidateNotificationController.php`; `common/models/StaffNotification.php` |
| push/device behavior | `common/models/MobileNotification.php`; source-bound OneSignal rows in current-main `docs/parity/ui-journeys.md` and its per-client files |
| mail, campaign, SMS and delivery log | `common/models/EmailCampaign.php`; both `EmailCampaignController.php` files; `common/models/MailLog.php`; `common/components/SMSComponent.php`; `console/controllers/CronController.php`; `cron/cronlist` |
| webhooks, analytics and external calls | `common/models/Webhook.php`; both `WebhookController.php` files; `common/components/EventManager.php`; `staff/modules/v1/controllers/JiraController.php`; `common/components/Yeaster.php` |
| client behavior and deployment inference | SHU-138 head `1f0beb1:docs/parity/live-frontends-and-clients.md`; current-main `docs/parity/ui-journeys.md` and `docs/parity/ui-journeys/{admin,candidate-mobile,candidate-web,employer,staff}.md` |

## 8. Bounded slices for SHU-94

| Slice | Scope | Dependencies | Points |
|---|---|---|---:|
| C1 / SHU-186 | one chat service: typed participants, grants, per-participant cursors, atomic sequence | SHU-91; organizations O1 | 8 |
| C2 / SHU-187 | owner-scoped ticket attachments; assignee/lead lifecycle; defined SLA clock; employer decision | profile S4 attachment contract; **not C1** | 5 |
| C3 / SHU-188 | typed event feed, render-at-read, device registry, push de-duplication | producer contracts in work/finance are related inputs, not blockers | 5 |
| C4 / SHU-189 | transactional mail/SMS, consent, immutable attempts/outcomes, leased processing; campaigns only if retained | producer templates and D-CM1 | 5 |
| C5 / SHU-190 | destination allow-list, signing, bounded retry and audit | SHU-59 plus D-CM4 / SHU-210 | 3 |

Nominal total is **26 points**; it drops if campaigns or webhooks are excluded. SHU-186 through SHU-190 are the implementation cards and take precedence over this estimate where their accepted contracts are more precise.

## 9. Open owner decisions

| ID | Decision | Safe default |
|---|---|---|
| D-CM1 | retain email campaigns or move marketing email to a dedicated system | exclude from Universe until an owner explicitly accepts consent, lease and delivery obligations (SHU-213) |
| D-CM2 | retain PBX call recordings | exclude unless a named owner supplies need, retention, consent and authorization rules |
| D-CM3 | add employer tickets | do not infer legacy parity; decide before C2 implementation |
| D-CM4 | retain configurable webhooks | disable/drop unless SHU-210 approves explicit destinations and SHU-190 controls |
| D-CM5 | retain Jira proxy | remove the unauthenticated routes; rebuild only from a minimum-data, grant-scoped requirement |

## 10. Integration readiness

This inventory is ready to feed SHU-94 only when review is anchored to its exact PR head and the following remain explicit gates:

1. no frontend `limitedAccess`, hidden page or absent UI is treated as server authorization;
2. no push tag, webhook row, delivery outcome or deployed client revision is assumed from source alone;
3. SHU-213 resolves campaigns/perks and SHU-210 resolves webhooks before those surfaces enter a build slice;
4. each active client is migrated or explicitly retired; manager, inspector and candidate-next are not implicit targets;
5. replacement behavior uses SHU-233 idempotency even though legacy Angular clients do not.
