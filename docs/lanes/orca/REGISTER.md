# Orca lane register

An Orca bot works only on a GitHub issue listed here with state `active` and an expiry that hasn't passed, read fresh from `main` before it starts, resumes, pushes or publishes. Only a `**Claude → Orca studenthub-universe** · dispatch` comment on the ticket issue, created after the latest commit that changed that ticket's own row, can start work; earlier comments and mentions never can, and edits to other rows don't affect it. The bot finds dispatches by polling this file and the listed issues every 15 minutes (HANDOVER B3). Claude maintains this file. To stop a ticket, Claude sets its state to `revoked`. The rules are in [HANDOVER.md](HANDOVER.md).

| Issue | Slug | Bot | Lease (paths; migrations) | Reviewer | State | Expires (UTC) |
|---|---|---|---|---|---|---|
| #581 | `running-tests-guide` | studenthub-universe | `docs/runbooks/running-tests.md` only; no migrations | Claude | active | 2026-11-22 18:00 |

