# Reports

Report services, printable documents and daily staff-email orchestration live here.
[src/index.ts](src/index.ts) re-exports the fourteen source modules described below.
The gateway composes the services with database stores and authorization in
[comms/wiring.ts](../../apps/gateway/src/comms/wiring.ts); the worker calls the daily
email wrapper in [email-delivery.ts](../../apps/worker/src/email-delivery.ts).
This directory has no package manifest: build and test commands belong to the
[repository package.json](../../package.json) and [build configuration](../../tsconfig.build.json).

## Certificates and ID cards

| Source | Behavior and principal exports |
| --- | --- |
| [certificates.ts](src/certificates.ts) | `CertificatesService` reads a `CertificatesStore`: `own` lists the person's started assignments, `staffList` requires staff, and `pdf` allows the assignment owner or staff. Missing, unauthorized and future assignments return `undefined` for PDF requests. The certificate ends at today's Kuwait date for ongoing assignments, otherwise at the recorded end date. |
| [certificate-pdf.ts](src/certificate-pdf.ts) | `experienceCertificatePdf` returns a `Buffer` containing one A4 landscape page (`A4_LANDSCAPE`), with the name, company, store and dates. It uses the shared PDF writer and `longDate` from the card renderer. Unsupported name characters are omitted; this is not Arabic text rendering. |
| [id-cards.ts](src/id-cards.ts) | `IdCardsService` provides staff lists, issue/renew batches, own-card reads, own/staff PDFs, public checks and photos, and counts. `ID_CARD_VALID_MONTHS` is 3, `ID_CARD_BATCH_MAX` is 100, and `ID_CARD_PAGE_SIZE` is 50. Lists use `needs`, `expired`, or `issued`. `kuwaitDay` uses Asia/Kuwait; `addMonths` clamps to the destination month's last day. |
| [id-card-pdf.ts](src/id-card-pdf.ts) | `idCardsPdf` returns front/back pages per card, in input order, at `CARD_WIDTH` × `CARD_HEIGHT` (portrait CR80). `IdCardFace` supplies the details, optional photo and optional QR matrix. The card omits civil ID numbers. `longDate` formats dates and `cardNumberText` pads card numbers to at least six digits. |
| [id-card-verify.ts](src/id-card-verify.ts) | `IdCardVerifier` creates and verifies HMAC-based links under `ID_CARD_VERIFY_PATH` (`/v/`). `parse` distinguishes token shape from a valid signature; `read` accepts only signed tokens. Photo keys are bound to the card token and last `ID_CARD_PHOTO_SECONDS` (60). |

The service copies batch inputs before awaiting authorization and rejects duplicates,
empty batches and batches above the cap. `IdCardsStore.write` requires an atomic
all-or-nothing write; [PostgresIdCardsStore](../db/src/reports/postgres-id-cards-store.ts)
implements issuance/renewal and supplies certificate history as well as card reads.
The service's own-card `valid` flag checks expiry; its public `check` additionally
requires a current assignment and uses the earlier of printed and current expiry.
Without a verifier, printed cards have no QR and verification is unknown; a QR also
needs an origin. These distinctions are in [id-cards.ts](src/id-cards.ts).

For printing, unreadable or unsupported photos leave the placeholder and the card
still prints. Public photos require a valid card, valid short-lived photo key,
configured public-photo source and correctly shaped client hash. The source port
requires an audited read; returned bytes pass through `publicPhoto` before delivery.
See [id-cards.ts](src/id-cards.ts), the document-source wiring in
[comms/wiring.ts](../../apps/gateway/src/comms/wiring.ts), and the public HTTP adapter
in [id-cards-http.ts](../../apps/gateway/src/reports/id-cards-http.ts).

## QR, photos and shared PDF primitives

| Source | Behavior and limits |
| --- | --- |
| [qr.ts](src/qr.ts) | `qrModules` returns a boolean matrix (true means dark), using UTF-8 byte mode, correction level M, and versions 1–10, capped by `QR_MAX_BYTES` at 213 bytes. It selects the lowest-penalty mask unless one is supplied. The matrix excludes the quiet zone; the card renderer supplies the white border. Lower-level exports include `reedSolomon`, `formatBits`, `versionBits`, `codewords` and `penalty`. |
| [public-photo.ts](src/public-photo.ts) | `publicPhoto` dispatches JPEG/PNG sanitization; unsupported input returns `null`. `cleanJpeg` rebuilds allowed image segments and discards metadata/trailing bytes, with `PUBLIC_JPEG_MAX_PIXELS` set to 24 million. It preserves image pixels, so EXIF orientation is lost. `cleanPng` rebuilds an RGB PNG through the bounded PDF-image decode path. |
| [pdf.ts](src/pdf.ts) | `PdfPage` and `buildPdf` write PDF 1.4 with rectangles, circles, text and images. `encodable`, `textWidth` and `fitText` support layout. Text uses standard Helvetica fonts and WinAnsi; unsupported characters are dropped, with no embedded-font Arabic shaping. `readImage`, `readJpeg` and `readPng` return an image or `null`. PNG input is capped at `PNG_MAX_PIXELS` (one million), flattened onto white and downscaled to `PHOTO_MAX_SIDE` (320 pixels). |

The PDF writer is also used outside reports by the gateway's
[invoice-pdf.ts](../../apps/gateway/src/billing/invoice-pdf.ts).
The helper is not a general HTML-to-PDF renderer: its drawing API is defined by
[PdfPage](src/pdf.ts), and both report renderers construct pages directly.

## Statistics and scheduled reports

[statistics.ts](src/statistics.ts) exports `StatisticsService`,
`STAFF_STATISTICS_COUNTERS`, `STATISTICS_OVERVIEW`, and helpers including `percent`,
`invitationMonths`, `invitationsByMonth`, `emailDays` and `emailsByDay`.
`page` requires staff and combines store counters, hiring figures, company-directory
counts and staff attendance. Missing sources yield `null` plus `waitsOn`; an invalid
available count throws instead of becoming zero. Ratios with no denominator are
`null`. Invitation history covers the twelve complete months before the current
Kuwait month, oldest first; email history covers fourteen Kuwait days including
today and marks sent counts above the notifications volume threshold. Missing
months/days are filled with zero, while duplicate or unexpected buckets are rejected.

[morning-summary-counters.ts](src/morning-summary-counters.ts) defines the twelve
ordered `MORNING_SUMMARY_COUNTERS`, their source availability, `MORNING_SUMMARY_KEYS`
and `MORNING_SUMMARY_HIDDEN_AT_ZERO`. The latter names the interview and overdue
company-payment rows. [morning-summary.ts](src/morning-summary.ts) supplies
`completeCounts`, `MorningSummaryService`, `kuwaitHour`, `sendMorningSummaryIfDue`
and `queueMorningSummaryThenDeliver`. Missing sources remain `null`; available
counts must be nonnegative safe integers. Staff can view today's counters and
change their own subscription. From `MORNING_SUMMARY_HOUR` (08:00 Kuwait), the
send helper asks `MorningSummaryStore.sendDay` to queue that day's summary;
the store determines whether it was already sent. The queue wrapper still attempts
delivery after a summary failure, then rethrows that failure if delivery succeeded.

[firing-hit-map.ts](src/firing-hit-map.ts) exports `lastTwelveMonths`, `firingLevel`,
`buildFiringHitMap` and `FiringHitMapService`. It produces twelve columns including
the current month, newest first, fills absent company/month totals with zero and
sorts companies by ended-placement total, then name/id. A cell is `danger` strictly
above twice the twelve-month average, `warning` strictly above the average, otherwise
unmarked. The service requires staff and optionally exposes subscription state.
The supplied [PostgresStatisticsStore](../db/src/reports/postgres-statistics-store.ts)
reads ended assignments up to the Kuwait day and rolls sub-companies into parents.

[firing-spike.ts](src/firing-spike.ts) reuses the hit map for `firingSpikes`, selecting
marked cells in the current month. `sendFiringSpikesIfDue` runs from
`FIRING_SPIKE_HOUR` (08:00 Kuwait); `FiringSpikeStore.sendDay` owns daily and
company/month deduplication and email queueing. The implementation is
[PostgresFiringSpikeStore](../db/src/reports/postgres-firing-spike-store.ts).
`queueFiringSpikesThenDeliver` attempts delivery even if the check fails.
`deliverWithDailyStaffEmails` queues summary and spikes only when the delivery
service is both production and configured; otherwise it calls delivery directly.
These functions do not install a timer: the actual consumer is the worker's
[emailDeliveryWork](../../apps/worker/src/email-delivery.ts).

[recruiter-activity.ts](src/recruiter-activity.ts) exports `RecruiterActivityService`,
`RECRUITER_ACTIVITY_COLUMNS`, `RECRUITER_ACTIVITY_MAX_DAYS`, `calendarDay` and
`rangeProblem`. Staff can request inclusive Kuwait-day ranges of at most 366 days,
ending no later than today; the default is today. Rows include all current operator
staff, zero-fill absent counts, and total placements, requests, suggestions, notes,
invitations and their accepted/declined subsets. Ordering uses the sum of the five
primary activity counts, then name/id. Invalid dates, reversed/oversized ranges and
non-integer counts are refused. SQL counting belongs to
[PostgresStatisticsStore](../db/src/reports/postgres-statistics-store.ts); the UI is
[statistics-http.ts](../../apps/gateway/src/reports/statistics-http.ts).

## Actual import consumers

These are production-source imports at this README's base, distinguished from
database implementations that are passed into the services. All modules are also
re-exported by [index.ts](src/index.ts).

| Module(s) | Direct consumers and use |
| --- | --- |
| Certificates, ID cards, verifier, morning summary, statistics, hit map, recruiter activity | [gateway comms/wiring.ts](../../apps/gateway/src/comms/wiring.ts) imports the service classes through the barrel and constructs them with stores and staff authorization. |
| Certificates | [certificates-http.ts](../../apps/gateway/src/reports/certificates-http.ts) imports `CertificateEntry` as a type. |
| Certificate PDF | [certificates.ts](src/certificates.ts) calls `experienceCertificatePdf`; no separate external production import was found. |
| ID cards | [id-cards-http.ts](../../apps/gateway/src/reports/id-cards-http.ts) imports limits, views and types; [certificates.ts](src/certificates.ts), [statistics.ts](src/statistics.ts), [firing-hit-map.ts](src/firing-hit-map.ts) and [recruiter-activity.ts](src/recruiter-activity.ts) import `kuwaitDay`; the certificate and card PDF modules also use card types. |
| ID-card PDF | [id-cards.ts](src/id-cards.ts) calls the renderer; [certificate-pdf.ts](src/certificate-pdf.ts), [certificates-http.ts](../../apps/gateway/src/reports/certificates-http.ts), [invoice-pdf.ts](../../apps/gateway/src/billing/invoice-pdf.ts) and [invoices-http.ts](../../apps/gateway/src/billing/invoices-http.ts) import `longDate`. |
| Verification | [id-cards.ts](src/id-cards.ts) imports the verifier type; [id-cards-http.ts](../../apps/gateway/src/reports/id-cards-http.ts) imports the verification path. Runtime construction is in the gateway wiring above. |
| QR | [id-cards.ts](src/id-cards.ts) calls `qrModules`; no separate external production import was found. |
| Public photo | [id-cards.ts](src/id-cards.ts) calls `publicPhoto`; [id-cards-http.ts](../../apps/gateway/src/reports/id-cards-http.ts) imports its result type. |
| PDF helper | [id-card-pdf.ts](src/id-card-pdf.ts), [certificate-pdf.ts](src/certificate-pdf.ts) and [invoice-pdf.ts](../../apps/gateway/src/billing/invoice-pdf.ts) draw PDFs; [id-cards.ts](src/id-cards.ts) reads images and [public-photo.ts](src/public-photo.ts) uses `readPng`. |
| Statistics, hit map, recruiter activity | [statistics-http.ts](../../apps/gateway/src/reports/statistics-http.ts) imports page types and recruiter column/range exports; [firing-spike.ts](src/firing-spike.ts) imports hit-map builders and types. |
| Morning-summary counters | [morning-summary.ts](src/morning-summary.ts) reads the registry; [notifications/email-templates.ts](../notifications/src/email-templates.ts) imports the registry, keys, hidden-at-zero list and counts type for rendering/validation. |
| Morning summary, firing spikes | [firing-spike.ts](src/firing-spike.ts) imports summary orchestration; [worker/email-delivery.ts](../../apps/worker/src/email-delivery.ts) imports `deliverWithDailyStaffEmails` through the barrel. |

The database's [reports/index.ts](../db/src/reports/index.ts) exports stores with
structurally compatible ports; those store source files do not import this package.
The concrete compositions are in [gateway wiring](../../apps/gateway/src/comms/wiring.ts).
The notification template dependency runs both ways: reports imports notification
validation/volume constants while notification templates import the counter registry
([morning-summary.ts](src/morning-summary.ts), [firing-spike.ts](src/firing-spike.ts),
[statistics.ts](src/statistics.ts), [email-templates.ts](../notifications/src/email-templates.ts)).

## Validation

Run commands from the repository root. Script definitions are in
[package.json](../../package.json); test discovery and the database/non-database
split are in [run.mjs](../../tools/test-runner/run.mjs) and
[baseline.json](../../tools/test-runner/baseline.json).

| Command | Result for this documentation change |
| --- | --- |
| `npm ci` | Passed in the coordinator's Windows checkout before this worker started. |
| `npm run build` | Passed in that same authorized run before dispatch to this worker. |
| `npm run typecheck` | Passed with Windows Node 24.11.0 on the unchanged source base. |
| `npm test` | Build passed; runner self-tests stopped the command (14 passed, 8 failed): seven workflow-parser assertions on the Windows CRLF checkout and one `EPERM` creating a symlink. The full application suite did not run locally. See [ci-workflow.test.mjs](../../tools/test-runner/test/ci-workflow.test.mjs) and [run.test.mjs](../../tools/test-runner/test/run.test.mjs). |
| `node --test dist/packages/reports/test/*.test.js` | Passed: all 60 report tests, zero failures or skips, using Windows Node after the build. |
| `npm run test:db` | Not run locally: no disposable PostgreSQL 17 instance was provisioned for this documentation-only task. Database CI is assessed on the PR. |

The focused source tests are [certificates.test.ts](test/certificates.test.ts),
[id-cards.test.ts](test/id-cards.test.ts), [id-card-verify.test.ts](test/id-card-verify.test.ts),
[pdf.test.ts](test/pdf.test.ts), [qr.test.ts](test/qr.test.ts),
[public-photo.test.ts](test/public-photo.test.ts), [statistics.test.ts](test/statistics.test.ts),
[morning-summary.test.ts](test/morning-summary.test.ts),
[firing-hit-map.test.ts](test/firing-hit-map.test.ts) (including spikes), and
[recruiter-activity.test.ts](test/recruiter-activity.test.ts).
They exercise synthetic fixtures; this README does not claim live acceptance.
