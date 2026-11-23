# Orca lane register

An Orca bot works only on a ticket listed here, read fresh from `main`, and only through the poll tool `tools/orca-lane` (HANDOVER B3). A row authorizes work only if it is the ticket's highest generation (`Gen`), its state is `active`, its expiry hasn't passed, and `Dispatch` names the exact id of a comment on that issue that Claude's GitHub App wrote with the header `**Claude → Orca <bot>** · dispatch · #<issue> gen <gen>`. No other comment or mention can start work. Mode `observe` means: report what you see, do no work. Mode `work` means: claim and work. Editing other rows, or a row's expiry, never changes a binding. To stop a ticket, Claude sets its state to `revoked`. When a ticket's PR has merged, Claude sets its state to `done`, which closes it out: its claim never resumes. To restart a stopped ticket, Claude adds a new generation with a new dispatch. Claude maintains this file. The rules are in [HANDOVER.md](HANDOVER.md).

| Issue | Slug | Bot | Gen | Mode | Dispatch | Lease (paths; migrations) | Reviewer | State | Expires (UTC) |
|---|---|---|---|---|---|---|---|---|---|
| #581 | `running-tests-guide` | studenthub-universe | 1 | work | `7048993553` | `docs/runbooks/running-tests.md` only; no migrations | Claude | revoked | 2026-11-22 18:00 |
| #581 | `running-tests-guide` | studenthub-universe | 2 | work | `7051422072` | `docs/runbooks/running-tests.md` only; no migrations | Claude | done | 2026-11-23 18:00 |
| #603 | `fixtures-readme` | studenthub-universe | 1 | work | `7063400979` | `tools/fixtures/README.md` only; no migrations | Claude | done | 2026-11-24 18:00 |
| #604 | `observability-exercise-readme` | studenthub-universe | 1 | work | `7063401402` | `tools/observability/README.md` only; no migrations | Claude | done | 2026-11-24 18:00 |
| #613 | `reconciliation-readme` | studenthub-universe | 1 | work | `7078448038` | `tools/reconciliation/README.md` only; no migrations | Claude | done | 2026-11-29 18:00 |
| #614 | `test-runner-readme` | studenthub-universe | 1 | work | `7078448340` | `tools/test-runner/README.md` only; no migrations | Claude | done | 2026-11-29 18:00 |
| #615 | `actor-assertion-readme` | studenthub-universe | 1 | work | `7078448641` | `packages/actor-assertion/README.md` only; no migrations | Claude | done | 2026-11-29 18:00 |
| #616 | `contracts-readme` | studenthub-universe | 1 | work | `7078448927` | `packages/contracts/README.md` only; no migrations | Claude | done | 2026-11-29 18:00 |
| #638 | `access-readme` | studenthub-universe | 1 | work | `7088634742` | `packages/access/README.md` only; no migrations | Claude | done | 2026-11-30 18:00 |
| #639 | `notifications-readme` | studenthub-universe | 1 | work | `7088635052` | `packages/notifications/README.md` only; no migrations | Claude | done | 2026-11-30 18:00 |
| #640 | `reports-readme` | studenthub-universe | 1 | work | `7088635341` | `packages/reports/README.md` only; no migrations | Claude | active | 2026-11-30 18:00 |
| #641 | `observability-package-readme` | studenthub-universe | 1 | work | `7088635688` | `packages/observability/README.md` only; no migrations | Claude | active | 2026-11-30 18:00 |
| #642 | `exports-readme` | studenthub-universe | 1 | work | `7088636015` | `packages/exports/README.md` only; no migrations | Claude | active | 2026-11-30 18:00 |
| #652 | `notifications-readme-precision` | studenthub-universe | 1 | work | `7091953714` | `packages/notifications/README.md` only; no migrations | Claude | active | 2026-11-30 18:00 |
| #653 | `comms-readme` | studenthub-universe | 1 | work | `7091954000` | `packages/comms/README.md` only; no migrations | Claude | active | 2026-11-30 18:00 |
| #654 | `profile-records-readme` | studenthub-universe | 1 | work | `7091954239` | `packages/profile-records/README.md` only; no migrations | Claude | active | 2026-11-30 18:00 |
| #655 | `recruit-readme` | studenthub-universe | 1 | work | `7091954544` | `packages/recruit/README.md` only; no migrations | Claude | active | 2026-11-30 18:00 |
| #656 | `work-readme` | studenthub-universe | 1 | work | `7091954789` | `packages/work/README.md` only; no migrations | Claude | active | 2026-11-30 18:00 |
| #657 | `reference-catalogue-readme` | studenthub-universe | 1 | work | `7091955067` | `packages/reference-catalogue/README.md` only; no migrations | Claude | active | 2026-11-30 18:00 |
