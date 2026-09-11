# StudentHub × Universe — Platform

## Universe login runtime (SHU-29)

The gateway exposes `GET /login/universe`, `GET /login/callback`, `GET /profile`,
and `POST /logout` only when the complete login configuration is present. Run
the database migrations first; login state, sessions, and immutable
issuer/subject bindings are PostgreSQL-backed and shared across processes.

Required variables are `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `OIDC_CALLBACK_URL`, `OIDC_AUTHORIZATION_URL`,
`OIDC_TOKEN_URL`, `OIDC_JWKS_URL`, and comma-separated exact
`LOGIN_ALLOWED_RETURN_URLS`. All OIDC/browser URLs must be HTTPS. Partial
configuration fails startup; absent configuration leaves every login route
disabled. Tokens and client secrets never enter browser responses.

The StudentHub platform is a **planned** modular monolith: web/iframe panels, HTTP API, MCP gateway, worker, domain packages, and a PostgreSQL schema. This README separates what **exists** at the current commit from what is **planned** — every row in the table below is checkable against the tree.

**Program:** ratified execution plan v1.2. See the delivery board (Linear, team `StudentHub Universe`) for task contracts.

## What exists (checkable at this commit)

| Claim | Where | Status |
| -- | -- | -- |
| HTTP gateway | `apps/gateway` | ✅ health, MCP, and optional PostgreSQL-backed Universe login/profile/logout routes |
| First browser surface | `apps/gateway/src/web-ui.ts` | ✅ HTML welcome page, session-bound own-profile view and browser sign-out; no client JavaScript or external assets |
| Worker | `apps/worker` (heartbeat) | ✅ |
| Shared contracts incl. authz | `packages/contracts` | ✅ authz store **interfaces** + `InMemoryAuthzStore` test implementation |
| Actor assertions | `packages/actor-assertion` | ✅ Ed25519-signed, verified |
| PostgreSQL data layer | `packages/db`, `packages/db/migrations` | ✅ persistent authz, OIDC state, sessions, and issuer/subject bindings |
| Login contract | `packages/login-contract` | ✅ executable OIDC conformance and mutation harness |
| Source-connection contract | `packages/source-connection-contract` | ✅ executable Discord/Google import contract; candidates and conflicts only, no I/O |
| Private documents | `packages/private-documents` | ✅ private synthetic filesystem storage, scoped metadata, signed expiring delivery and opt-in HTTP handler; [contract and limits](docs/contracts/private-documents.md); not mounted in the live gateway |
| Search adapter | `packages/search` | ✅ Typesense adapter and indexer |
| Migration tools | `tools/legacy-import`, `tools/fixtures`, `tools/reconciliation` | ✅ |
| Search benchmark | `tools/search-bakeoff` | ✅ Meilisearch vs Typesense evidence (SHU-47) |
| ADRs + design docs | `docs/adr` (`ADR-0001-actor-assertion-v1`), `docs/authz-roles.md` | ✅ |
| Donor baseline history | branch `donor/studenthub-codex`, tag `donor/studenthub-codex-5754e424` | ✅ introspection reference only |

## What is planned (not yet in the tree)

| Planned | Card |
| -- | -- |
| Full role-aware web/iframe workspace | First server-rendered profile exists; capability panels, context switching and iframe integration are still unbuilt |
| 7 domain packages (`domain-*`) | none exist |
| Remaining `packages/` capabilities | domain packages, observability, and UI are not built yet |

Planned layout (target, for orientation):

```text
apps/       web, gateway, worker
packages/   capabilities, contracts, domain-*, authorization, audit, db, observability, ui
tools/      donor-audit, legacy-import, reconciliation, fixtures
docs/       adr, contracts, parity, security, runbooks, evidence
```

Target schema is new PostgreSQL — the donor Prisma schema is introspection reference only.

## First browser experience (SHU-89)

`GET /` serves the public welcome page. Its Universe link uses the exact
same-origin `/profile` URL only when it is already present in
`LOGIN_ALLOWED_RETURN_URLS`, deriving the origin from the validated
`OIDC_CALLBACK_URL`, never request Host/forwarded headers. Missing configuration
shows an unavailable message; this change does not expand the login allowlist.

`GET /profile` renders HTML only when `Accept` explicitly prefers `text/html`.
JSON, wildcard and missing Accept headers preserve the existing JSON body.
The HTML path first calls the existing login application's session-bound profile
authorization, then reads that exact principal's stored display name/email.
A mismatched/missing principal fails closed. This is **not legacy-data parity**:
applications, work history, documents and editing are not provided by this slice.
The `self` profile access marker is not presented as a business role/grant.

HTML has `no-store`, `Vary: Accept`, a restrictive CSP and no external assets.
It is intentionally not frameable yet; approved Universe embedding is future
scope. Browser logout is a native POST with an exact configured-origin check,
followed by a 303 to `/`; non-browser logout retains its 204 response. Rejected
and unavailable login/profile flows render generic retry/sign-in pages, not raw
errors or tokens.

Run `npm test` for HTTP, profile-isolation and escaping regressions. For **local
synthetic visual QA only**, `npm run dev` builds and runs the fixture preview;
`/__preview/profile` shows the synthetic account and `/profile` shows the
unauthenticated state. The preview never connects to a database/real provider,
refuses `NODE_ENV=production` and is not a deployment entrypoint. Real OIDC,
PostgreSQL and public-URL human acceptance must be recorded separately.

UI publication and independent/human browser acceptance are SHU-93, not a
consequence of merging this code. SHU-91/92 own multi-grant navigation and the
production-grounded profile projection; SHU-84/102 own the approved safe action.

## Keeping this honest

This table must be updated in the same PR that lands a new package, route, or tool. If you are adding something listed under **planned**, move it to **exists** with its location. If a card's acceptance says "documented in the README," this table is that place. (SHU-56)
