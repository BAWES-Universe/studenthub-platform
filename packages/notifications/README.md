# Notifications

This directory contains the in-app feed model and the email outbox service,
templates, delivery port and daily volume checks. The root
[build configuration](../../tsconfig.build.json) compiles it; consumers import
relative source paths. The [email barrel](src/index.ts) exports
`email-templates`, `email-port`, `email-outbox` and `email-volume`.
The feed API is imported separately from [notifications.ts](src/notifications.ts).

## In-app feed

[notifications.ts](src/notifications.ts) defines `NotificationEvent`: an id,
recipient principal, kind, subject reference, closed parameters, creation time
and nullable read time. Rows retain references rather than rendered feed text.
`NotificationKindRegistry` validates kinds, references and parameters, rejects
duplicate definitions, and validates/deduplicates type filters.
`recordNotification` checks that registry before calling a `NotificationRecordPort`.

The same file registers these kinds in `NOTIFICATION_REGISTRY`:

| Kind | Subject and rendering |
| --- | --- |
| `organization.status_changed` | Organization reference and status; current name, live organization and current direct/subtree grant visibility are checked at read time. |
| `staff.message` | Staff-message reference and empty parameters; recipient-scoped subject lookup supplies the message kind and body for the comms renderer. Missing messages are omitted. |
| `work.session_approved`, `work.session_rejected` | Work-session reference and real calendar `workDate`; line links to that day's hours history. |
| `recruit.<event>` | Recruit-outbox reference and empty parameters; recipient-scoped lookup supplies the current request title and company. Missing or mismatched events are omitted. |

`RECRUIT_EVENTS` in [notifications.ts](src/notifications.ts) lists invitation sent,
accepted, declined and withdrawn; interview scheduled and cancelled; application
shortlisted and rejected; and request-application received, accepted and rejected.

`NotificationsService.list` requests 25 rows with an offset for a positive page
number, applies the validated kinds filter before paging through the store,
groups accepted rows by kind and renders subjects in batches. Invisible rows can
leave a short page. Its `unreadCount` counts visible unread items on that page.
`count` uses the store's optional `countVisibleUnread` for the whole feed, falling
back to page one otherwise. Read operations delegate with the recipient id.
These behaviors are implemented in [notifications.ts](src/notifications.ts).

The persistence adapter is
[PostgresNotificationsStore](../db/src/postgres-notifications-store.ts): it scopes
lists and read updates to the recipient, sorts newest first, deduplicates inserts
by recipient/key, and implements subject lookups and the whole-feed unread count.
The [gateway HTTP adapter](../../apps/gateway/src/notifications-http.ts) derives the
recipient from the session, refuses unknown type filters, and replaces the page
count with `service.count`. The
[login runtime](../../apps/gateway/src/login-runtime.ts) wires the service and
store; [web-ui.ts](../../apps/gateway/src/web-ui.ts) renders the feed and bell.

## Email outbox and port

[email-outbox.ts](src/email-outbox.ts) exports `enqueueTransactionalEmail`.
It validates parameters, inserts through the caller's `EnqueueClient` and returns
the existing id on an idempotency-key conflict. The caller owns the transaction;
this function does not invoke a delivery provider.

`EmailOutboxService` uses an `EmailOutboxStore` and `EmailPort`. Its
`processDue(limit = 25, now)` claims a batch, handles each row independently and
returns the number claimed, rather than the number successfully sent. Its default
maximum is five attempts. The processing order in
[email-outbox.ts](src/email-outbox.ts) is:

1. Fail attempts beyond the maximum with `retry_limit`.
2. Suppress optional classes when their effective preference is disabled.
3. Record `not_sent` with `non_production` outside production, or
   `delivery_not_configured` when configuration is disabled.
4. Fail an unavailable address; otherwise validate and render the template and
   invoke the port. A successful port result records `sent`.
5. For an explicit failure result, schedule a retry only when marked
   `safeToRetry` and below the attempt maximum, using exponential delays starting
   at one second, capped at one hour. `delivery_not_configured` is instead
   recorded as `not_sent` without retry.

A malformed row before sending is closed as failed without retry. An unexpected
exception after sending starts (including a failed completion write) leaves the
row in `sending` for claim-lease recovery; it cannot prove whether delivery
occurred. The [PostgreSQL store](../db/src/postgres-email-outbox-store.ts) can
reclaim it after its 900-second lease expires, incrementing the attempt. This
path can deliver again without any `safeToRetry` result, subject to the same
processing checks above; attempts beyond the maximum fail without another send.
Typed `EmailSendError` values become closed
failure codes and safe-retry decisions. Processing continues through other rows;
internal delivery errors produce the generic batch error `email delivery failed`.
See [email-outbox.ts](src/email-outbox.ts) and its
[tests](test/email-outbox.test.ts).

[email-port.ts](src/email-port.ts) defines `EmailPort.send` with recipient,
subject and body, plus `EmailSendResult`, `EmailSendError` and
`EMAIL_FAILURE_CODES`. `FakeEmailPort` captures messages in memory for tests;
`UnconfiguredEmailPort` returns a non-retryable `delivery_not_configured` result.
Neither implementation provides an external email transport.

[PostgresEmailOutboxStore](../db/src/postgres-email-outbox-store.ts) claims due
pending or expired sending rows with `FOR UPDATE SKIP LOCKED`, increments the
attempt and gives it a 900-second lease. Completion checks the current attempt
and sending state, then records the outcome atomically. Claiming rechecks optional
recipient eligibility for staff summaries/spikes, invitations and person
reminders; an absent preference otherwise defaults to enabled. Its delivery-log
projection reads states and attempts without reading addresses or template data.

The actual [worker entrypoint](../../apps/worker/src/index.ts) constructs
`EmailOutboxService` with `UnconfiguredEmailPort`, `production = false` and
`configured = false`. Its current wiring does not enable real delivery.
[emailDeliveryWork](../../apps/worker/src/email-delivery.ts) dispatches recruit
events, wraps delivery with staff-email and person-reminder queueing, and checks
volume. Staff-email and reminder queueing is gated on delivery capability.
This README records source behavior and local synthetic checks, not a real send.

## Templates

[email-templates.ts](src/email-templates.ts) defines `EMAIL_CLASSES`,
`EmailTemplateParameters`, `EMAIL_TEMPLATES` and `validateTemplateParameters`.
Validation requires the exact parameter shape and applies the class-specific
date, count and text checks before rendering a subject/body pair.

| Class | Required | Parameters and content |
| --- | --- | --- |
| `account.notice` | No | `heading`, `message`; used directly as subject/body. |
| `civil_id.result` | Yes | Confirmed decision, or rejected decision with a bounded reason; explains the result and next step. |
| `staff.morning_summary` | No | `day`, `counters`; uses the reports counter registry, displays null as unavailable and hides designated zero counters. |
| `staff.firing_spike` | No | `company`, `month`, `level`, `total`, `twelveMonthTotal`; validates the warning/danger level against the counts. |
| `recruit.invitation` | No | `position`, `company`; invitation to apply. |
| `person.birthday` | No | `name`; birthday greeting, allowing an empty first name. |
| `person.civil_id_expired` | No | `name`; request to update the expired civil ID. |
| `person.civil_id_expiring` | No | `name`, `expiry`, `status`; expiring or already-expired reminder. |

The required flag bypasses optional-preference suppression in
[EmailOutboxService](src/email-outbox.ts); production, configuration and address
checks still apply. The template source imports the
[morning-summary counter definitions](../reports/src/morning-summary-counters.ts).

## Daily email volume

[email-volume.ts](src/email-volume.ts) sets `EMAIL_VOLUME_THRESHOLD` to 500.
This is an alert threshold, not a send cap or rate limiter. `kuwaitDay` uses the
Asia/Kuwait calendar; `volumeLevel` is zero through 500, one at 501 through 1000,
two at 1001 through 1500, and so on. `checkEmailVolume` asks an `EmailVolumeStore`
to record crossings and return alerts still due.

`deliverAndCheckVolume` checks volume even after delivery fails, and checks both
start and end days when a run crosses Kuwait midnight. It raises each alert
before marking it alerted, leaving failed alerts due until a later check of
their own Kuwait day. A later run checking only a newer day does not retry
those older alerts. These rules are in [email-volume.ts](src/email-volume.ts). The
[PostgreSQL store](../db/src/postgres-email-outbox-store.ts) counts `sent` attempts,
records every crossed level once per day and returns unalerted levels in order.
The [worker](../../apps/worker/src/index.ts) emits the closed `email_volume` job
alert; operational guidance is in the [alerts runbook](../../docs/runbooks/alerts.md).

## Direct consumers

These production source files import this directory directly. Database adapters
implement compatible ports using their own types rather than importing this
package, as seen in the two adapter files linked above.

| Consumer | Import and use |
| --- | --- |
| [Gateway login runtime](../../apps/gateway/src/login-runtime.ts) | `NotificationsService` from `notifications.ts`, wired to PostgreSQL and authorization. |
| [Gateway HTTP adapter](../../apps/gateway/src/notifications-http.ts), [UI](../../apps/gateway/src/web-ui.ts) | Feed service/page types from `notifications.ts`. |
| [Worker entrypoint](../../apps/worker/src/index.ts) | `EmailOutboxService`, `UnconfiguredEmailPort` from `index.ts`. |
| [Worker delivery job](../../apps/worker/src/email-delivery.ts) | `deliverAndCheckVolume` and volume types from `index.ts`. |
| [Comms person reminders](../comms/src/person-reminders.ts) | `kuwaitDay` from `index.ts`. |
| [Reports morning summary](../reports/src/morning-summary.ts), [firing spike](../reports/src/firing-spike.ts) | `kuwaitDay`, `validateTemplateParameters`, `EmailTemplateParameters` from `index.ts`. |
| [Reports statistics](../reports/src/statistics.ts) | `EMAIL_VOLUME_THRESHOLD` directly from `email-volume.ts`. |

Synthetic coverage lives in [notifications.test.ts](test/notifications.test.ts),
[email-outbox.test.ts](test/email-outbox.test.ts) and
[email-classes.test.ts](test/email-classes.test.ts), with mutation probes beside
them. Cross-package tests also import these APIs, including
[reports tests](../reports/test/morning-summary.test.ts) and
[PostgreSQL email tests](../db/test/postgres-email-outbox.test.ts).

## Verification for the original README addition

The results below record the original README addition. Commands were run from
the repository root; scripts are defined in
[package.json](../../package.json). The code checks use the clean base checkout
at the same commit as this documentation branch's base; the sole branch change
is this Markdown file.

| Command/check | Result |
| --- | --- |
| `npm ci` | Passed on the base checkout. |
| `npm run build` | Passed on the base checkout. |
| `npm run typecheck` | Passed on the base checkout. |
| `npm test` | Failed on the unchanged base before application suites: seven CI-workflow parsing checks failed and the runner-entry test hit Windows `EPERM` creating a symlink (14 passed, 8 failed). |
| `node --test dist/packages/notifications/test/notifications.test.js dist/packages/notifications/test/email-outbox.test.js dist/packages/notifications/test/email-classes.test.js` | Passed: 33 tests, no failures, on the built base checkout. |
| `npm run test:db` | Not run: this documentation task does not provision or connect a disposable PostgreSQL instance. |
| Relative links and changed-path scope | Passed: every relative target exists; only this README is added. |

No worker delivery command was run; verification does not establish external
delivery or live acceptance.
