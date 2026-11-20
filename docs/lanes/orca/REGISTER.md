# Orca lane register

An Orca bot works only on a GitHub issue listed here with state `active` and an expiry that hasn't passed, read fresh from `main` before it starts, resumes, pushes or publishes. Claude maintains this file. To stop a ticket, Claude sets its state to `revoked`. The rules are in [HANDOVER.md](HANDOVER.md).

| Issue | Slug | Bot | Lease (paths; migrations) | Reviewer | State | Expires (UTC) |
|---|---|---|---|---|---|---|

No tickets are registered yet. The pilot starts only after the stage 0 launch gates in HANDOVER.md, Part D.
