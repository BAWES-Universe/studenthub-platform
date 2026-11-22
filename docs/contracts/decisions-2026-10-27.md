# Decisions recorded 2026-10-27 (Kuwait 12:40)

Khalid, 2026-10-27 09:37Z: "do whats best practice and dont break anything. use prod code as benchmark with no regressions." Production hosting: "we go to it when we need". Comparison on the production copy: "sure as long as it doesnt compromise the orchestrator product or slow things down".

**Rule applied to every open decision:** legacy production behaviour is the benchmark. Nothing a user can do today is removed. Security fixes are allowed only where they keep the same capability (the same people can still see or do the same thing, more safely). New behaviour that legacy never had stays out of release.

| Card | Decision |
|---|---|
| SHU-105 parity data | Approved. The box may compare old and new systems on the production copy already loaded on staging. It runs at low priority, off the card-run path, so it never holds the box. Rules: no emails, SMS or push; no legacy writes; no production credentials in workers. This approves testing a copy only, not migrating production |
| SHU-200 D1 employer view | Keep legacy visibility. Employers still see the civil-ID images, CV and coordinates of candidates in their stores, but only through authorized, time-limited, audited links, never public object keys (fixes the SHU-54 class without removing anything) |
| SHU-201 D2 act-as | Keep it, as an audited act-as (option 1). Staff keep "login as candidate"; the 4-character URL key is replaced, every action records actor and subject, sessions are short-lived, and act-as can't write finance or grants |
| SHU-202 D6 deletes | Follow legacy. Deleting an account hides and deactivates it, and the rows are kept. A document replaced or removed by its owner is deleted when it is replaced or removed, as today. No new purge timer. Staff can restore a deleted account |
| SHU-203 D-OR1 company sign-up | Staff approve before activation (legacy) |
| SHU-204 D-WK1 clock-in location | Location is required (both apps require it today) and shown to the approver. There is no geofence (legacy has none). The start and stop locations are both kept (fixes the overwrite). Late submissions are accepted as in legacy and flagged to the approver |
| SHU-205 D-WK2 ratings | Keep legacy: employer ratings stay visible to other employers in search |
| SHU-206 D-WK3 hour corrections | Staff can still correct approved hours without re-approval (legacy). Additive: a reason is required, and history is kept. No new notifications. A correction after month-end is allowed, as today, and appears to finance as an adjustment |
| SHU-207 D-RC1/4 job board | Keep the job board as it works today (staff post jobs, people browse and apply). Criteria stay informational (legacy never filtered by them); no gender filtering. Fixed: closed or draft jobs can't be applied to |
| SHU-208 D-FI2/3 pay math | Reproduce legacy results to the fils. Weekly auto-payout keeps salary ÷ 4; rounding and rate selection (contracts overlapping the period) follow legacy, and the manual-pay path stays. The 12-month replay against legacy output is the acceptance test |
| SHU-209 D-FI1 money switch | Split. Everything except money switches first. Money switches on a month boundary after the platform reproduces 12 months of legacy transfers and bank files with zero KWD difference and one live month runs side by side with zero difference. Legacy pays until then. The box's replay report is the evidence; Khalid's go/no-go stays |
| SHU-210 D-CM4 webhooks | Decided by the data: if the staging copy's `webhook` table has live rows, keep webhooks, allow-listed and signed (C5); if it is empty, drop them. The box checks this during the replay |
| SHU-211 D-RP2 morning summary | Keep the email, with the same eleven counters, to the same recipients as legacy's list |
| SHU-212 D-FE1 mobile | Web first. The mobile app keeps working on the legacy candidate API (SHU-218), so mobile users lose nothing at the switch |
| Individual hirers (R-8) | Not in legacy, so not in release; later |
| Production hosting | Set up when the switch needs it (about 20 Nov); not an ask now |

## Added 2026-11-17 (Khalid 15:35Z: "yes to everything as long as all runs fine and we reveal nothing private. hermes is there to assist")

| Item | Decision |
|---|---|
| Daily legacy refresh on staging (extends SHU-105) | Approved. The staging production copy may be refreshed from legacy once a day, read-only, to feed the December payroll shadow month and the importer rehearsals. Conditions: read-only against legacy (no legacy writes); no emails, SMS, push or webhooks from staging; real personal data never leaves staging (not in PRs, CI logs, Linear, desk comments, chat or fixtures; reports carry counts, ids and fils differences only); no production credentials in card workers; it runs off the card-run path and never holds the box. Owner: importer lane ("Build importer and release matrix"), set up on the box through a Hermes card |
