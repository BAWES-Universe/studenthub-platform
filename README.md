# StudentHub × Universe — Platform

The StudentHub platform is a **planned** modular monolith: web/iframe panels, HTTP API, MCP gateway, worker, domain packages, and a PostgreSQL schema. This README separates what **exists** at the current commit from what is **planned** — every row in the table below is checkable against the tree.

**Program:** ratified execution plan v1.2. See the delivery board (Linear, team `StudentHub Universe`) for task contracts.

## What exists (checkable at this commit)

| Claim | Where | Status |
| -- | -- | -- |
| HTTP gateway | `apps/gateway` | ✅ two routes: `GET /health`, `POST /mcp/tools/call` |
| Worker | `apps/worker` (heartbeat) | ✅ |
| Shared contracts incl. authz | `packages/contracts` | ✅ authz store **interfaces** + `InMemoryAuthzStore` test implementation |
| Actor assertions | `packages/actor-assertion` | ✅ Ed25519-signed, verified |
| Migration tools | `tools/legacy-import`, `tools/fixtures`, `tools/reconciliation` | ✅ |
| Search benchmark | `tools/search-bakeoff` | ✅ Meilisearch vs Typesense evidence (SHU-47) |
| ADRs + design docs | `docs/adr` (`ADR-0001-actor-assertion-v1`), `docs/authz-roles.md` | ✅ |
| Donor baseline history | branch `donor/studenthub-codex`, tag `donor/studenthub-codex-5754e424` | ✅ introspection reference only |

## What is planned (not yet in the tree)

| Planned | Card |
| -- | -- |
| Web/iframe panels | zero `.tsx` files today; platform web is unbuilt |
| 7 domain packages (`domain-*`) | none exist |
| PostgreSQL schema + migrations | no SQL, no schema, no migrations — **no persistence yet**; authz grants live in `InMemoryAuthzStore` and are lost on restart → [SHU-55](https://linear.app/bawes/issue/SHU-55/platform-has-no-persistence-authz-grants-live-in-memory-and-are-lost) |
| `packages/`: capabilities, authorization, audit, db, observability, ui | only `contracts` and `actor-assertion` exist today |

Planned layout (target, for orientation):

```text
apps/       web, gateway, worker
packages/   capabilities, contracts, domain-*, authorization, audit, db, observability, ui
tools/      donor-audit, legacy-import, reconciliation, fixtures
docs/       adr, contracts, parity, security, runbooks, evidence
```

Target schema is new PostgreSQL — the donor Prisma schema is introspection reference only.

## Keeping this honest

This table must be updated in the same PR that lands a new package, route, or tool. If you are adding something listed under **planned**, move it to **exists** with its location. If a card's acceptance says "documented in the README," this table is that place. (SHU-56)
