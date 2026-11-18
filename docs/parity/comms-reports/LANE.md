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
6. **Statistics** (P-3): after recruit, work and pay land.
7. **Remaining exports onto P-1**: each lane's export button uses the service; this lane checks all seven legacy exports are covered.
8. **Webhooks** only if rows exist.

Dependencies: slices 1 and 2 need nothing from other lanes. Slice 3 needs the access lane's reset flow. Slices 4 to 7 consume recruit, work and pay data.

## Slice 1 evidence (legacy `BAWES-Universe/studenthub` @ 55119d3)

- `common/models/CandidateNotification.php`: types 12 `TYPE_PROFILE_PHOTO_REQUEST`, 13 `TYPE_CIVIL_ID_REQUEST`, 14 `TYPE_STAFF_MESSAGE`.
- `common/components/CandidateStaffNotificationService.php`: staff sends document requests and one free-text message (at most 1000 characters); `sendKey` is a UUID and the row id; a repeat for the same person and type returns the existing row (`already_sent`); no email, SMS or push.
- `candidate/modules/v1/controllers/CandidateNotificationController.php`: own rows only; mark one, mark all; unread count header.
- Changed on purpose: legacy stores the rendered text on the notification row. Here the feed row stores only a reference, the staff message keeps what staff wrote, and the line is built at read time (contract C-1). Send keys follow legacy: a lower-case UUID; a repeat for the same person and kind returns `already_sent` even if the text differs; a repeat for another person or kind is refused (`send_key_conflict`, where legacy returns a generic error), and the key is checked before the recipient, so reuse for a person who does not exist is also `send_key_conflict`. The message limit is legacy's 1000 characters.

## Slice 1 build notes

- Kind registry: `packages/notifications/src/notifications.ts` holds `NotificationKindRegistry`. Each kind is one `NotificationKindDefinition` with its subject reference parser, closed parameter check (the same rule as the database CHECK) and a page renderer that reads its subjects once per page. The feed groups a page by kind and asks each definition; it has no kind-specific code. A new kind is one definition plus its payload branch in the migration.
- Types filter: `GET /notifications?types=staff.message,work.session_approved` (or repeated `types`). Every entry must be a registered kind, otherwise 400 `invalid_types`; the filter is applied in the stored query, before paging. The unread count stays the whole feed (it drives the bell).
- Staff send: `GET /workspace/people/<person>/message` shows the form (with a fresh send key) and `POST` sends one of the three kinds. Only StudentHub staff (operator staff or admin grant) see either; anyone else, signed out included, gets the same not found. Same-origin posts only. Answers: 201 sent, 200 already sent, 400 invalid with the field, 409 send-key conflict, 404 unknown person. Wired in `apps/gateway/src/comms/wiring.ts`.
