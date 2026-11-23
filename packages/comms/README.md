# Comms

This directory contains three TypeScript modules for person reminder scheduling,
recruit outbox dispatch orchestration, and staff messages. Consumers import their
source modules directly with `.js` specifiers; there is no package manifest or
barrel entry point here. The root [TypeScript build](../../tsconfig.build.json)
compiles them into `dist` (see the [compiler inputs](../../tsconfig.json)).

## Person reminders

[src/person-reminders.ts](src/person-reminders.ts) exports:

| Export | Contract |
| --- | --- |
| `PersonReminderKind` | `birthday`, `civil_id_expired`, or `civil_id_expiring`. |
| `PersonRemindersPort` | `sendDay(kind, day, at): Promise<number \| null>`; persistence is supplied by the caller. |
| `PERSON_REMINDER_MINUTE` | 810 minutes after midnight, or 13:30 Kuwait time. |
| `CIVIL_ID_EXPIRING_DAYS_OF_MONTH` | The 15th and 28th. |
| `kuwaitMinute(at)` | Minutes since midnight using `Asia/Kuwait`. |
| `dueReminderKinds(now)` | Returns the Kuwait day and ordered due kinds: none before 13:30; birthday and expired from then onward; expiring additionally on the 15th/28th. |
| `queuePersonRemindersThenDeliver(port, deliver, now?)` | Tries each due kind, then calls delivery; returns the delivery count, not the queued count. |

The wrapper captures one clock value for all kinds. A queue failure does not stop
later kinds or delivery. If delivery succeeds, the first queue error is rethrown;
if delivery throws, its error propagates instead. This module does not persist
deduplication, choose recipients, authorize a principal, or start a timer. Its
Kuwait day helper comes from [notifications](../notifications/src/index.ts).

The concrete [PostgresPersonRemindersStore](../db/src/comms/postgres-person-reminders-store.ts)
queues each kind/day once under a transaction and advisory lock, records the run,
and returns the queued count or `null` for a previously recorded run. It requires
a nonblank email and an unpaused account. Birthday eligibility matches the birth
month/day, including February 29 birthdays on February 28 in non-leap years.
Civil ID reminders require an unreleased ID and an assignment with no end date or
an end date on/after the reminder day (the query does not test assignment start).
Expired means expiry equals that day. Expiring means expiry **strictly before
day + 25 days**, including already expired IDs; there is no lower bound.

The [email outbox claim](../db/src/postgres-email-outbox-store.ts) rechecks the
birthday, civil ID, assignment, and pause predicates against the day in the
idempotency key. It reloads the current address but does not recheck the nonblank
email selection rule. For an otherwise eligible reminder within the attempt
limit, a configured production [delivery service](../notifications/src/email-outbox.ts)
records a now-missing (null or empty) address as `failed` with
`address_unavailable`, without suppression or a retry. These are recipient and
delivery rules, not a staff grant check in the scheduling module.

## Recruit dispatch

[src/recruit-dispatch.ts](src/recruit-dispatch.ts) exports
`RECRUIT_DISPATCH_BATCH = 200`, `RecruitDispatchPort` with
`dispatch(limit, at): Promise<number>`, and
`dispatchRecruitThenDeliver(port, deliver, now?)`.

The wrapper dispatches one batch at the supplied clock time, then calls delivery
and returns its count. A dispatch error is saved while delivery is attempted;
after successful delivery the dispatch error is rethrown. A delivery error
propagates instead if delivery also fails. The module does not authenticate a
caller, select recipients, persist events, or enforce email delivery batch size.

The concrete [PostgresRecruitDispatchStore](../db/src/comms/postgres-recruit-dispatch.ts)
accepts integer limits 1–1000 (the wrapper uses 200). It selects undispatched rows
by increasing outbox ID using `FOR UPDATE ... SKIP LOCKED`. Feed insertion,
optional email queueing, and marking the selected events dispatched share one
transaction. It creates `recruit.<event>` feed items for the stored recipient.
Only `invitation.sent` queues an invitation email, and only when the invitation
is `sent`/`seen`, its request is `open`/`filling`, and sanitized position/company
names are nonempty. Those names have control characters replaced and are trimmed
to at most 255 code points. The [email outbox](../db/src/postgres-email-outbox-store.ts)
rechecks the invitation recipient and invitation/request states at each claim.

## Staff messages

[src/staff-messages.ts](src/staff-messages.ts) exports:

| Export | Purpose |
| --- | --- |
| `STAFF_MESSAGE_KINDS`, `StaffMessageKind`, `isStaffMessageKind` | Closed kinds: `profile_photo_request`, `civil_id_request`, `message`. |
| `STAFF_MESSAGE_BODY_MAX` | 1000 Unicode code points for a trimmed message body. |
| `StaffMessageInput`, `StaffMessageDraft` | Input and validated draft, including recipient, kind, body and send key; the draft adds the sender. |
| `StaffMessageStore`, `StaffMessageStoreResult` | Persistence port and `sent`/`already_sent` (with ID), `send_key_conflict`, or `recipient_not_found`. |
| `StaffMessageAuthority` | Async `isStaff(principalId)` authorization port. |
| `StaffMessageInvalid`, `StaffMessageResult` | Invalid fields `kind`, `body`, `send_key`, `recipient`; result adds `forbidden` and `invalid` to store outcomes. |
| `validateStaffMessage(sender, input)` | Returns a draft or invalid field; it does not authorize the sender. |
| `StaffMessagesService` | Checks authority before validation or storage in `send(sender, input)`. |
| `renderStaffMessage(kind, body)` | Builds person-facing text and navigation target at read time. |

Validation in that module requires a recipient matching
`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` and a UUID-shaped hexadecimal send key, normalized
to lowercase. Free text is trimmed and must contain 1–1000 code points. Document
requests accept only an absent, `null`, or empty body and store `null`; whitespace
is not accepted as an empty request body. The service returns `forbidden` when
authority returns false; authority/store exceptions are not converted to result
objects.

The [gateway wiring](../../apps/gateway/src/comms/wiring.ts) supplies authority via
[hasOperatorStaffGrant](../../apps/gateway/src/wiring/profile.ts): role `staff` or
`admin`, scope `subtree`, and an organization in `DEFAULT_OPERATOR_ORG_IDS`.
The [HTTP adapter](../../apps/gateway/src/comms/staff-messages-http.ts) exposes
`GET`/`POST /workspace/people/<person>/message`. It requires an authorized session
and staff access, returning the same 404 for unauthenticated/nonstaff callers.
POST requires the configured origin, rejects cross-site requests, and accepts
only a bounded (8192 bytes), URL-encoded form with nonduplicate allowed keys.
Results map to 201 sent, 200 already sent, 400 invalid, 409 key conflict, or 404
recipient missing/forbidden. These HTTP protections belong to the adapter, not
to `validateStaffMessage`.

The [Postgres store](../db/src/comms/postgres-staff-messages-store.ts) writes the
message and recipient's `staff.message` feed entry in one transaction. The same
send key for the same recipient and kind returns the first message unchanged,
even if body or sender differs; another recipient/kind conflicts. Existing keys
are resolved before recipient existence. No email, SMS or push is queued by this
store. Rendering points photo requests to `/profile/documents`, civil ID requests
to `/profile/civil-id`, and free text to `/notifications`.

## Consumers and composition

These are direct production imports, distinguished from structurally compatible
database adapters:

| Module | Direct consumer and use |
| --- | --- |
| Person reminders | [apps/worker/src/email-delivery.ts](../../apps/worker/src/email-delivery.ts) imports the wrapper and port type. It queues reminders only when the supplied delivery service has both `production` and `configured` true. |
| Recruit dispatch | [apps/worker/src/email-delivery.ts](../../apps/worker/src/email-delivery.ts) imports the wrapper and port type; recruit dispatch runs before daily staff emails, person reminders, and email delivery, without the reminder gate. |
| Staff messages | [Gateway wiring](../../apps/gateway/src/comms/wiring.ts) constructs `StaffMessagesService`; the [HTTP adapter](../../apps/gateway/src/comms/staff-messages-http.ts) imports the result type and body limit. |
| Staff messages | [packages/notifications/src/notifications.ts](../notifications/src/notifications.ts) imports `StaffMessageKind`, `isStaffMessageKind`, and `renderStaffMessage` to render stored feed subjects for the recipient. |

[apps/worker/src/index.ts](../../apps/worker/src/index.ts) supplies the database
reminder/recruit stores through [db/comms](../db/src/comms/index.ts). Those store
implementations declare their own compatible shapes; they do not directly import
the comms modules. The worker entry currently constructs an unconfigured email
port with both delivery flags false: the composition's conditional support is
not evidence that production email sending is enabled.

Direct test imports are in the three [comms tests](test/), the
[gateway staff-message test](../../apps/gateway/test/staff-messages-http.test.ts),
and the database [person-reminder](../db/test/postgres-comms-person-reminders.test.ts)
and [recruit-dispatch](../db/test/postgres-comms-recruit-dispatch.test.ts) tests.
The [staff-message mutation suite](test/staff-messages-mutations.mjs) also checks
authorization, body limits, and related feed/HTTP behavior.

## Verification

Run from the repository root with Node 22 or newer. Root commands are defined in
[package.json](../../package.json); test discovery and database separation are in
[tools/test-runner/run.mjs](../../tools/test-runner/run.mjs).

| Command/check | Result for this documentation change |
| --- | --- |
| `npm ci` | Passed. |
| `npm run typecheck` | Passed. |
| `npm test` (includes build) | Passed, including all 10 comms mutation checks. |
| Relative links and source/export inventory | Passed: all 29 links resolve at the PR base; all 24 exports are documented. |
| `npm run test:db` | Not run locally: no disposable PostgreSQL 17 database configured for this documentation task; database execution is left to CI. |

This documents source behavior, not live delivery or production acceptance.
