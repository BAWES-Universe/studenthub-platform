# Comms and reports lane plan (2026-11-17)

Owner: Claude, thread "Build comms and reports lane". Reviewer: Codex on the box, GPT as fallback. Paths and migration ranges (0353 to 0399 comms, 0600 to 0649 reports) are leased on the desk (PR #393) and in the project reservations ledger. Target: everything below is in the 17 Dec verified release candidate, and live with the full migration on 1 Jan.

What main already has (box cards, landed): notification feed with one kind (`organization.status_changed`), email outbox with one class (`account.notice`), and the export service (P-1) with one export (company directory).

What legacy prod actually uses (SHU-213 counts, 10-04) changes this contract:
- Chat (C-4) and support tickets (C-5) are dead in prod and were dropped by Khalid's 10-04 "Drop all" decision. They are not built. The 10-27 rule (nothing a user can do today is removed) does not bring them back, because nobody uses them today.
- SMS (C-3) has exactly one production use: the candidate password-reset SMS (`Candidate::sendPasswordResetSMS`, called from `candidate/.../AuthController.php`). The SMS slice is that message only, on the outbox, behind a port with a fake; it pairs with the access lane's legacy reset flow.
- Push (C-7) stays with the legacy API, because mobile stays on the legacy candidate API (SHU-212).
- Webhooks (C-6) are decided by data (SHU-210): built only if the staging copy's `webhook` table has rows.

Slices, in order (one PR each):
1. **Feed kinds and staff messages** (C-1 rest): replace the single hard-coded kind with a kind registry (each kind brings its parameter check, subject resolver and renderer, so other lanes add one registration line, not an edit to the feed). First new kinds are the ones with sources on main: legacy types 12 to 14 (staff asks for a profile photo, staff asks for a civil ID, staff free-text message), idempotent by send key (`already_sent` on repeat), types filter validated against the registry, unread count from the same query as the list.
2. **Email classes and staff delivery log** (C-2 rest): class table (transactional vs optional), civil ID result email from the staff decision (SHU-646/647 on main), per-person delivery log for staff with no address or body, the daily volume alert with legacy's threshold bug fixed.
3. **Password-reset SMS** (C-3): with the access lane's reset flow.
4. **Morning summary** (P-2, SHU-211 keeps the email): the twelve legacy counters as a registry. Almost every counter reads assignments, requests or transfers, so each counter is switched on when its lane lands; a counter whose source is missing shows "not available", never 0. Digest via the outbox to staff with the morning-report permission at send time, Asia/Kuwait day boundary.
5. **Revenue roll-ups** (P-4): after the pay lane's transfer types land; legacy's live formula, recomputed not incremented, reconciliation report.
6. **Statistics** (P-3): slice 1 is the staff page `/workspace/statistics`: legacy staff dashboard counters as a registry (shared counters use the morning summary's queries; pay-backed ones show "not available") and the hiring figures from legacy admin (hired, retained after a year, retention ratio, invitations, recruitment yield). Slice 2 adds the overview from legacy admin's list: candidates, assigned today, suggestions, requests sent and delivered (KWD, like active requests), active and all companies through the organizations directory as the viewer, and today's staff attendance through the work lane's `PostgresWorkStaffTimeStore` (no SQL on its table). Unapproved candidates, payable candidates, transfers, staff salary and staff leave show "not available"; "universities to fix" has no equivalent (the catalogue keeps one name). Slice 3 is the firing hit map (`/workspace/statistics/firings`, legacy `FiringHitmap`): placements ended per top-level company (sub-companies rolled up, deleted companies left out) in each of the last 12 months, newest first, counted live from `work_assignments` up to today in Kuwait, with legacy's warning (above the 12-month average) and danger (above twice it) marks; slice 4 is the spike email (migration 0605, class `staff.firing_spike`): once a Kuwait day from 08:00 the email delivery job checks the current month, and each company and month that is marked alerts once (legacy's `is_alerted`) to staff who turned the email on on the hit map page (still staff, not paused, rechecked at every delivery attempt, like the morning summary). Legacy sent it to the operations mailbox; the importer should subscribe the people behind that mailbox. Transfers, revenue and the year report follow as the pay lane's sources land.
7. **Remaining exports onto P-1**: each lane's export button uses the service; this lane checks all seven legacy exports are covered. The check is `apps/gateway/test/legacy-exports-coverage.test.ts`: each of the 17 legacy downloads is mapped to a kind the gateway offers, owed by a named lane, or dropped with evidence, and every offered kind must name the download it replaces.
8. **Webhooks** only if rows exist.

Dependencies: slices 1 and 2 need nothing from other lanes. Slice 3 needs the access lane's reset flow. Slices 4 to 7 consume recruit, work and pay data.

## Slice 1 evidence (legacy `BAWES-Universe/studenthub` @ 55119d3)

- `common/models/CandidateNotification.php`: types 12 `TYPE_PROFILE_PHOTO_REQUEST`, 13 `TYPE_CIVIL_ID_REQUEST`, 14 `TYPE_STAFF_MESSAGE`.
- `common/components/CandidateStaffNotificationService.php`: staff sends document requests and one free-text message (at most 1000 characters); `sendKey` is a UUID and the row id; a repeat for the same person and type returns the existing row (`already_sent`); no email, SMS or push.
- `candidate/modules/v1/controllers/CandidateNotificationController.php`: own rows only; mark one, mark all; unread count header.
- Changed on purpose: legacy stores the rendered text on the notification row. Here the feed row stores only a reference, the staff message keeps what staff wrote, and the line is built at read time (contract C-1). Send keys follow legacy: a lower-case UUID; a repeat for the same person and kind returns `already_sent` even if the text differs; a repeat for another person or kind is refused (`send_key_conflict`, where legacy returns a generic error), and the key is checked before the recipient, so reuse for a person who does not exist is also `send_key_conflict`. The message limit is legacy's 1000 characters.

## Slice 1 build notes

- Kind registry: `packages/notifications/src/notifications.ts` holds `NotificationKindRegistry`. Each kind is one `NotificationKindDefinition` with its subject reference parser, closed parameter check (the same rule as the database CHECK) and a page renderer that reads its subjects once per page. The feed groups a page by kind and asks each definition; it has no kind-specific code. A new kind is one definition plus its payload branch in the migration. The two must accept exactly the same rows (work dates are real calendar dates in both, through `notification_calendar_date` in the database); `COMMS_FEED_DB_PARITY_PG` inserts each edge case and checks the database and the registry agree, so the unread count never counts a row the feed would drop.
- Types filter: `GET /notifications?types=staff.message,work.session_approved` (or repeated `types`). Every entry must be a registered kind, otherwise 400 `invalid_types`; the filter is applied in the stored query, before paging. The unread count stays the whole feed (it drives the bell).
- Staff send: `GET /workspace/people/<person>/message` shows the form (with a fresh send key) and `POST` sends one of the three kinds. Only StudentHub staff (operator staff or admin grant) see either; anyone else, signed out included, gets the same not found. Same-origin posts only. Answers: 201 sent, 200 already sent, 400 invalid with the field, 409 send-key conflict, 404 unknown person. Wired in `apps/gateway/src/comms/wiring.ts`.

## Slice 2 build notes

Legacy evidence (`BAWES-Universe/studenthub` @ 55119d3): `common/models/MailLog.php` (`afterSave`, `mailThreshold` 500 in `common/config/params.php`); no civil ID result email exists in legacy (staff verification only clears `candidate_civil_need_verification`), so that email is new, from contract C-2.

- Class table: `email_classes` (migration 0354) lists every class and whether it is transactional; the outbox, attempts and preferences reference it. A transactional class cannot be switched off (a preference row for it is refused). `EMAIL_TEMPLATES[class].required` says the same; `COMMS_EMAIL_CLASSES_PG` compares them. Classes today: `account.notice` (optional), `civil_id.result` (transactional).
- Civil ID result email: an AFTER INSERT trigger on `civil_id_review_decisions` queues it in the decision's transaction, keyed `civil_id.result:<decision id>`, so each decision is emailed once and a rolled-back decision emails nothing. A rejection carries the staff reason the person already sees on their profile. No change to the civil ID review code.
- Staff delivery log: `GET /workspace/people/<person>/emails` (staff only, same not found for everyone else), 50 per page: class, state, queue and send times, and each attempt's closed outcome and failure code. It never reads the address or the template parameters.
- Daily volume alert: after each `email_delivery` run (also a failed one) the worker counts the Asia/Kuwait day's sent attempts and records `(day, level)` once in `email_volume_alerts`; level n means past n × 500, matching legacy's raised threshold (500, 1000, 1500). The new row raises the closed `email_volume` job alert (runbook `docs/runbooks/alerts.md#email_volume`). A check that finds the day several levels up (500 to 1501 between runs) records and alerts every skipped level, lowest first. A level stays due until its alert has been raised, so a failed alert is raised by the next run; a run that crosses Kuwait midnight also checks its start day, because its sends are stamped with the start time. Legacy's bug (the date check assigned instead of comparing, so a raised threshold leaked into the next day) is gone: each day starts again at level 1.
- Not in this slice: staff resend with a reason, and the person's preferences page for optional classes (only `account.notice` is optional today, and nothing queues it yet).

## Slice 4 build notes (morning summary)

Legacy evidence (`BAWES-Universe/studenthub` @ 55119d3): `console/controllers/CronController.php` (`actionSummary`, cron `0 8 * * *`), the `morning-report` mail view, and the staff `morning-report` permission (recipients: active, not deleted staff with `staff_notification` on and that permission). Subject "Morning Report for F j, Y".

- Counter registry: `packages/reports/src/morning-summary-counters.ts` lists legacy's twelve counters in the email's order (legacy lists "assigned without ID cards" twice; here once). Each counter is `available` or `missing` with what it waits on. A missing counter is `null` everywhere and shows "not available", never 0. An available counter the store does not answer is an error, so nothing is sent with a silent 0.
- Available today, with their queries in `packages/db/src/reports/postgres-morning-summary-store.ts`:
  - `interviewScheduledToday`: scheduled recruit interviews on the Asia/Kuwait day whose request is not filled or closed (legacy: scheduled, today, request not delivered, finished or cancelled).
  - `activeRequests`: recruit requests open or filling (legacy pending, started, re_work, mapped by `legacyRequestStatus`) for companies billed in KWD; no currency means KWD, as legacy's default.
  - `assignedExpiredCivilID`: people with a work assignment that has not ended whose civil ID expired before the day (a released civil ID is not counted).
- Waiting on other lanes: the two payment counters and missing bank info (pay lane transfers; legacy's "idle candidates" query can never match in prod, so it reads 0 there today), ID cards (two counters, no lane holds them), companies without a request in 40 days and follow-ups (company dates and follow-up fields from the importer), incomplete profiles and profile approval (no source). Each switches on with one registry line and its query.
- Email: class `staff.morning_summary` (optional, migration 0600). One email per Asia/Kuwait day from 08:00, queued by the `email_delivery` job before it delivers (`queueMorningSummaryThenDeliver`), so it goes out in the same run. The day's run row, the emails (`staff.morning_summary:<day>:<principal>`) and the counters it carried are written in one transaction under a per-day lock, so a day is sent once however many workers run; a failure sends nothing and the next run tries again. A summary failure does not hold back delivery of other email. The summary and the firing spike email are queued only by a worker that can deliver (production, provider configured; `deliverWithDailyStaffEmails`), because queueing records the day and each alert for good. Until the provider is wired the worker leaves them due.
- Recipients, decided at send time: staff who turned the email on (`morning_summary_subscriptions`, the rebuild's form of legacy's morning-report permission, per SHU-211), who still hold a staff or admin grant over the operator organization's subtree, and whose account is not paused. Legacy sent to the invoice mailbox with staff in CC; here each staff member gets their own copy and nothing goes to a shared inbox. The importer maps legacy's permission holders onto subscriptions. The outbox claim checks the same rule again on every delivery attempt, so someone who turns the email off, loses staff access or is paused after it was queued gets it suppressed, never sent.
- Staff page: `GET /workspace/morning-summary` shows today's counters, fresh at read time, with the same values the email carries, and what each missing counter waits on; `POST` with `email=on|off` turns the email on or off for the staff member themself (same-origin only). Anyone who is not staff gets the same not found. Served by the comms HTTP handler, so no new route line.
- Not in this slice: recruiter productivity (the other half of P-2), which needs the recruit lane's activity events.

## Slice 7: exports audit and the country and university lists (2026-11-19)

The audit of every legacy download is in the project's `contracts/exports-audit.md`. This slice
builds the reports lane's part of family 1 and makes the export seam general, so other lanes add
kinds without touching the routes.

- **How to add an export kind (any lane).** Three additions in one PR:
  1. An `ExportKind` in your package (`packages/<lane>/...` or `packages/exports/src/`): its id,
     its closed `filterKeys`, its `columns` (the row whitelist), `authorize` and `rows`. Register
     it in `apps/gateway/src/wiring/ops.ts`, in the `ExportService` kind list. `authorize` is the
     only access decision; the service calls it at request and again at download.
  2. One entry in `EXPORT_HTTP_KINDS` (`apps/gateway/src/exports-http.ts`): `filters(query)`
     turns the query string into the kind's filters or null (refused before the service is
     reached), `filename` names the download, `noun` names the rows on the result page, and
     optional `forRequester` resolves filters such as account manager "me".
  3. The legacy download it replaces, in `LEGACY_DOWNLOADS`
     (`apps/gateway/test/legacy-exports-coverage.test.ts`): change that row from `owedBy` to
     `kind: "<your kind id>"` (or add a row if it replaces something the audit missed, with the
     count), and record the same in the project's `contracts/exports-audit.md`. The coverage
     test fails while an offered kind names no legacy download.
  The page's button is a form that posts to `/exports/<kind id>?<filters>`. `GET /exports/<id>`
  serves every kind under its own file name.
- **Kinds `catalogue-country` and `catalogue-university`.** Every active catalogue entry of
  the type with how many person profiles point at it (nationality or university). Columns ID,
  Name, Code, Total Candidate. Legacy also had an Arabic name; the catalogue holds one name, so
  that column has no source. Staff only (operator staff or admin grant). No filters: any query
  parameter refuses the request.
- **Page.** `GET /workspace/lists` for staff, with the two Export buttons.
- **A kind's own file format (for pay's bank files).** An `ExportKind` may add
  `serialize(columns, rows, filters)` returning `{bytes, contentType, fileName}`. Only the
  kind's whitelisted columns and rows reach it. The service stores the bytes with their type
  and name (migration 0601: `exports.content_type`, `exports.file_name`, both null for CSV,
  names limited to letters, digits, `.`, `-` and `_`), and `GET /exports/<id>` serves them
  byte for byte with that Content-Type and file name. The row and byte caps, the requester
  binding, the 15-minute expiry, the re-authorization at download and the audit row are the
  same as for CSV. A pay kind still needs its `EXPORT_HTTP_KINDS` entry for the request route.

## S8: ID cards and certificates (2026-11-19)

**Done 2026-11-20:** #555, #558, #559, #560 and #561 are merged. The optional ID card list export (item 5) is skipped: legacy's Excel was never reachable in production (orchestrator agreed 11-20).

Handed to this lane by the orchestrator; no other lane holds it. Spec: project contract
`queue15-16-people-staff.md`, "S8 ID cards and certificates". Legacy: staff
`CandidateIdCardController` (list, generate, renew, list expired, total expired), the
`candidate_id_card` table (one card per candidate, expiry date, three months from generate or
renew), the card view rendered to PNG by headless Chromium, the `verification/` app behind the
QR code, and the staff and candidate appreciation (experience) certificate PDFs.

Planned PRs, in order (migrations 0602 to 0609):
1. **Cards and the staff page** (this PR, migration 0602). `id_cards` (one per person, card
   number, expiry, issuing staff member or legacy row id) and the append-only `id_card_events`.
   `GET/POST /workspace/id-cards`: who is assigned and has no card, whose card has expired,
   every card; issue or renew a batch of up to 100, all or nothing, each valid three calendar
   months from today in Asia/Kuwait (30 Nov gives 28 Feb). Issuing again re-issues, as legacy
   does. Only people with an assignment that has not ended can be given or renew a card (legacy
   `filterAssigned`). `GET /profile/id-card`: the person's own card with name, card number,
   legacy employee ID, company, store and valid-until date. Company and store are read from the
   work lane's assignments when the card is shown (the one running today, else the next), so a
   move shows without a new card. The morning summary's two ID card counters ("expired ID
   cards" and "assigned without ID cards") switch on with the same queries.
2. **The card as a PDF.** `GET /profile/id-card.pdf` for the person, `GET
   /workspace/id-cards/print?person=...` (up to 100) for staff, linked from the result page
   after issuing or renewing (legacy's generate returned a zip of front and back PNGs per
   person). Two bank-card-size pages per card: front with the photo, name, card number,
   employee ID, company, store and valid-until date; back with where to return a found card.
   Legacy printed the civil ID number on the back; the new card does not (F10). The PDF writer
   (`packages/reports/src/pdf.ts`) has no dependencies: standard Helvetica fonts in WinAnsi, so
   the card prints the Latin name only (Arabic needs an embedded font and shaping), and JPEG or
   PNG images (PNG transparency is flattened onto white). The photo comes from a
   `IdCardPhotoSource` port, wired in production to the personal-photo source on the same
   document storage as civil ID reads (`DOCUMENT_*` env). Each read that returns bytes is first
   audited in `staff_person_views` as `id_card_render` (viewer: the person, or the staff member
   printing); if the audit fails, no photo is used. The card shows a plain circle only when the
   photo is absent, refused (two photos, wrong type, over 2 MB or PNG_MAX_PIXELS) or unreadable.
3. **Verification.** The QR on the card opens a signed, expiring public page with name, photo,
   company and validity only. Legacy's page also showed the civil ID number (finding F10); the
   new one never shows it or the phone. The QR code (`packages/reports/src/qr.ts`, no
   dependencies, checked module for module against a reference encoder) holds
   `/v/<card number>.<printed date>.<signature>`, an HMAC with `ID_CARD_VERIFY_KEY` (canonical
   base64 for 32 bytes; unset means no QR and every link shows not found). The page shows name,
   company and whether the card is valid, in English and Arabic, with no-store and noindex. A
   link stops being valid on the date printed on that card, even after a renewal (the renewed
   card is a new print), and before then it is not valid if the card was shortened or the
   holder is no longer assigned. A forged link, a changed number and a missing card all show
   the same not found. Each client address (read behind GATEWAY_TRUSTED_PROXIES like the abuse
   gate, held only as an HMAC) may check 30 links a minute per gateway process, then gets a 429
   before any card is looked up. A valid card's page shows the holder's photo through
   `/v/<token>/photo?k=<key>`, where the key is an HMAC for that link that lasts 60 seconds. The
   photo is never sent as uploaded: a PNG is decoded through the card's downscale path and
   written anew (IHDR, IDAT, IEND only); a JPEG is rebuilt from an allow list of segments
   (tables, frame, scans) with a fresh JFIF header, so EXIF, GPS, XMP, ICC, IPTC, comments and
   trailing data are all dropped, and anything off the list refuses the photo. Each read is
   recorded first in the append-only `id_card_public_views` (migration 0604: card, photo
   version, time, keyed hash of the client address). Unknown, forged, expired and revoked
   cards, stale keys and missing photos all get the same empty 404, and every link shaped like
   a token is looked up whether or not it is signed, so they take the same work.
4. **Experience certificates** from work history, as PDFs (legacy appreciation certificate:
   name, company, store, from and to dates). Made on demand from one of the person's
   `work_assignments` rows (read-only), as legacy made it from `candidate_work_history`;
   nothing is stored. The person lists and downloads their own at `/profile/certificates`;
   StudentHub staff list anyone's at `/workspace/certificates?person=<id>` and download them
   (legacy staff `appreciation-certificate/<id>/<wid>`). The dates run from the start date to
   the end date, or to today while the assignment runs (legacy printed "now"); an assignment
   that has not started has no certificate. Someone else's assignment, a missing one and one
   not yet started all give the same not found, and the staff paths answer not found to anyone
   who is not staff before anything is read. A4 landscape, laid out after legacy's page, signed
   "Khalid Almutawa, CEO - StudentHub" as legacy's was. Legacy's stored staff certificates
   (`candidate_certificate`, with staff-chosen dates; its list, update and delete have no UI)
   are a later slice if still wanted.
5. **The ID card list export**, if still wanted: legacy's `CandidateIdCard::createExcel` is
   only called from `createZip`, which nothing calls, so production does not produce that
   Excel today (checked at legacy @ 55119d3).

Legacy cards carry over through `id_cards.legacy_ref` (the legacy row id); the importer owns
that copy.
