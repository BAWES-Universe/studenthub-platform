# StudentHub × Universe — Platform

Modular monolith: web/iframe panels, HTTP API, MCP gateway, worker, 7 domains, PostgreSQL schema, migration/reconciliation tools.

**Program:** ratified execution plan v1.2. See the delivery board for task contracts.

## Layout

```text
apps/       web, gateway, worker
packages/   capabilities, contracts, domain-*, authorization, audit, db, observability, ui
tools/      donor-audit, legacy-import, reconciliation, fixtures
docs/       adr, contracts, parity, security, runbooks, evidence
```

## Donor baseline

History preserved from `BAWES/studenthub-codex@5754e424` on branch `donor/studenthub-codex`, tagged `donor/studenthub-codex-5754e424`. Target schema is new PostgreSQL — the donor Prisma schema is introspection reference only.
