# Shared contracts

`@studenthub/contracts` supplies TypeScript contracts and reference helpers for
authorization, candidate search, health responses and MCP calls. Its only public
package entry is `@studenthub/contracts`: [package.json](package.json) maps it to
the compiled JavaScript and declarations, while [src/index.ts](src/index.ts)
re-exports authorization, search and version exports. There are no package
dependencies; [tsconfig.build.json](tsconfig.build.json) builds `src` into the
package's `dist` directory.

## Authorization model

The exports below are available through the root entry point via
[src/authz/index.ts](src/authz/index.ts).

| Source | Contract and behavior |
| --- | --- |
| [principal.ts](src/authz/principal.ts) | `Principal` represents one acting entity with zero or more platform business user UUIDs (`pbuuids`). `createPrincipal` rejects blank IDs, deduplicates UUIDs and freezes the result. Grants belong to the principal; a client-provided UUID is a lookup key, not identity proof. |
| [organization.ts](src/authz/organization.ts) | `Organization` has an optional `parentOrgId`. `createOrganization` rejects blank IDs/names and self-parenting. `indexOrganizations`, `ancestorOrgIdsIncludingSelf`, `descendantOrgIdsIncludingSelf` and `isSameOrDescendantOf` provide tree traversal; the store supplies cycle validation. |
| [roles.ts](src/authz/roles.ts) | `ROLES` defines the closed `Role` union: `candidate`, `staff`, `admin`, `org-owner`, `recruiter`, `finance`. `ROLE` provides named accessors and `isRole` checks values. |
| [grants.ts](src/authz/grants.ts) | `RoleGrant` binds principal, organization, role and scope. `self` applies only at the named organization; `subtree` also reaches descendants. `normalizeGrantEntry` trims the organization ID, validates role/scope and defaults omitted scope to `self`. `RevokeEntry` identifies an organization/role pair regardless of scope. |
| [store.ts](src/authz/store.ts) | `AuthzStore` combines `GrantsStore`, `OrganizationStore` and `PrincipalStore`. `InMemoryAuthzStore` implements them, optionally seeded with organizations and principals. `grantMany` merges assignments with the widest scope winning; `revokeMany` ignores unknown targets; `clearGrantsForPrincipal` removes all grants. Registration removes obsolete UUID mappings and rejects UUIDs owned by another principal before mutation. Organization construction/upsert rejects cycles. |
| [registry.ts](src/authz/registry.ts) | `IssuerKeyRegistry` stores `IssuerKeyDescriptor` records by issuer/key ID. Supported algorithm names are `EdDSA`, `ES256`, `RS256`; statuses are `active` and `retired`. `InMemoryIssuerKeyRegistry.registerKey` is idempotent for an existing pair. Its `retireIssuerKey` implementation retires the **named key**, retaining its row; it does not retire every other key. Unknown lookups return `undefined`. Public-key material is opaque here; this module does no signature verification. |

[src/authz/context.ts](src/authz/context.ts) resolves the active organization and
role server-side. `resolvePrincipalId` maps an already authenticated
`RequestIdentity` to the directory. `resolveActiveContext` re-reads grants on each
call; `ContextSelection` is only a preference. A direct grant takes precedence
over an inherited grant for the same role, and the nearest ancestor wins among
inherited subtree grants. Parentage alone grants no access, and grants do not
flow upward.

With an explicit organization, an unknown organization or absent grant is denied;
an ungranted role is denied; multiple effective roles require selection. Without
an organization, exactly one effective organization/role pair resolves
automatically; more than one returns `ambiguous_context`, and zero returns
`unknown_principal` (including a known principal with no effective contexts).
`listEffectiveContexts` lists the available pairs, preferring direct rows and
then the nearest inherited row. These are the actual resolver branches in
[context.ts](src/authz/context.ts), exercised by
[test/authz.test.ts](test/authz.test.ts).

[src/authz/assertion.ts](src/authz/assertion.ts) is an adapter for **already
verified** `VerifiedActorClaims`: `claimsToRequestIdentity` maps `sub` to a UUID
lookup, and `claimsActToContextSelection` maps optional `act` fields to selection
preferences. These helpers perform no cryptographic or authorization check.
The caller in [gateway authz-middleware.ts](../../apps/gateway/src/authz-middleware.ts)
uses the separate actor-assertion verifier, resolves registry keys, then calls
the adapter and grant resolver. This package does not define another signed
assertion envelope.

## Search contract

[src/search.ts](src/search.ts) defines `CandidateSearchAdapter.search`, taking a
`CandidateSearchRequest` and returning a `Promise<CandidateSearchResult>`.
The request requires `scope`, either `all` or an explicit `candidate-ids` list;
the type makes callers supply their authorization scope but does not itself
authorize that choice. Optional inputs cover query, filters, status/approval
constraints, page/page size, sort and an abort signal.

The same file defines `CandidateSearchDocument` (identity/contact fields,
country/university/company, skills, profile/assignment/document flags, status,
approval, score and update epoch). `CANDIDATE_SEARCH_FACETS` lists country,
university, company, skill, gender, profile, assignment and document. Sort values
are relevance, score ascending, score descending and updated descending.
Results contain hits, total, pagination and facet options with count/active
flags; facet counts are disjunctive, excluding their own active filter.
These are data and adapter contracts; the implementation is in
[search/src/typesense.ts](../search/src/typesense.ts), with document publication
in [search/src/typesense-indexer.ts](../search/src/typesense-indexer.ts).

## Versions, health and MCP

[src/versions.ts](src/versions.ts) maintains independent `CONTRACT_VERSIONS`
slots: health `1.1.0`, authz `1.0.0`, identity `1.0.0` and search `1.0.0`.
`ContractName` is the slot-name union; `contractVersion(name)` returns its value
as `ContractVersion` (`string`). `AUTHZ_CONTRACT_VERSION` in
[authz/index.ts](src/authz/index.ts) and `SEARCH_CONTRACT_VERSION` in
[search.ts](src/search.ts) expose their own slots.

[src/index.ts](src/index.ts) keeps `PLATFORM_CONTRACT_VERSION` as an alias of
the **health** slot. `createHealthResponse` freezes a `HealthResponse` containing
status, gateway/worker component, contract version, supplied revision (default
`null`) and ISO timestamp; its optional clock supports deterministic tests in
[test/contracts.test.ts](test/contracts.test.ts). The same entry file defines
`McpToolCall`, `McpToolResult` (text content plus `ok`) and the asynchronous
`McpAdapter.callTool` interface.

## Consumers and call sites

These source links show actual imports and uses, rather than inferred
dependencies. This map covers the authorization/search/health consumers in the
non-pay source reviewed for this guide; it is not an inventory of every test.

| Consumer | Imported contracts and use |
| --- | --- |
| [gateway entry](../../apps/gateway/src/index.ts) | `createHealthResponse` for health output and MCP call/result/adapter types. |
| [gateway authorization](../../apps/gateway/src/authz-middleware.ts), [context navigation](../../apps/gateway/src/context-navigation.ts) | Registry and store contracts, verified-claim adapters and request-time context resolution; context navigation uses the effective-context list. |
| [worker entry](../../apps/worker/src/index.ts) | `createHealthResponse` and `HealthResponse` for the worker heartbeat. |
| [db authz store](../db/src/postgres-authz-store.ts) | `PostgresAuthzStore` implements `AuthzStore` using the shared principal, organization, role, grant and validation contracts. Persistence is implemented here, outside this package. |
| [access grant catalogue](../access/src/grant-catalogue.ts), [grant changes](../access/src/grant-change.ts), [invitation service](../access/src/invitation-service.ts) | Role/scope types and guards for grant choices and changes; invitation service imports `GrantScope`. |
| [organizations types](../organizations/src/types.ts), [reference catalogue types](../reference-catalogue/src/types.ts) | Shared `Role` type. |
| [profile projection](../profile/src/profile.ts) | `PrincipalStore` directory interface. |
| [private documents](../private-documents/src/index.ts) | Relative source import of identity/context resolution and `AuthzStore`/`RequestIdentity`. |
| [billing accounts](../billing/src/account.ts) | `resolveActiveContext`, `AuthzStore`, `RequestIdentity` and `ActiveContext` for account authorization. |
| [notifications](../notifications/src/notifications.ts) | `AuthzStore` and `RoleGrant` types. |
| [Typesense adapter](../search/src/typesense.ts), [indexer](../search/src/typesense-indexer.ts) | Search adapter/request/result/facet types and candidate documents. |
| [fixture preview](../../tools/fixtures/src/web-preview.mjs), [browser fixture](../../tools/browser-acceptance/fixture.mjs) | Compiled contracts import for synthetic in-memory authorization setup. |

## Verification

Run from the repository root with Node 22 or newer (the engine in the root
[package.json](../../package.json)). The root scripts define typecheck, build,
unit tests and database tests; the package's own
[package.json](package.json) defines only its build script. The runner and suite
inventory are [run.mjs](../../tools/test-runner/run.mjs) and
[baseline.json](../../tools/test-runner/baseline.json).

The documentation verification results below were recorded on 2026-11-22:

| Command | Result |
| --- | --- |
| `npm ci` | Passed in the isolated documentation worktree. |
| `npm run typecheck` | Passed in the isolated documentation worktree. |
| `npm test` | Pending verification; builds the repository and runs the unit suites. |
| `npm run test:db` | Not run locally: no disposable PostgreSQL 17 instance was provisioned for this documentation task. |

The contracts suites cover health responses, role/grant validation, hierarchy,
context selection and revocation, assertion adaptation, registry behavior,
version slots and principal mapping safety. See
[contracts.test.ts](test/contracts.test.ts) and [authz.test.ts](test/authz.test.ts).
