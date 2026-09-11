# Workspace navigation (SHU-91)

`GET /workspace` lists the signed-in person's effective organization/role pairs.
It starts with no active selection, including when only one pair is available.
Accounts without grants keep access to their own profile and see an empty state.

`GET /workspace?org_id=<id>&role=<role>` selects one pair for that request. Links
carry both fields, so bookmarks, refresh and back/forward requests preserve the
selection. Partial, duplicate and unknown query parameters are rejected. A denied
selection never falls back to another role or organization.

The server reads the persistent login session, establishes its principal, and
calls the existing `resolveActiveContext` against the Postgres authorization
store on each selected request. Options come from `listEffectiveContexts`,
including explicit subtree grants. Neither role selections nor effective grants
are cached across requests. Revocation denies the next request using the old URL.

HTML is opt-in through Accept negotiation, sharing the profile stylesheet and
security headers. JSON returns only `{contexts, active}` on success; each context
contains `{orgId, role, organizationName}`. Responses use `Cache-Control: no-store`
and `Vary: Accept`. Authentication failure is 401, malformed selection 400,
ungranted selection 403, and unavailable dependencies/configuration 503.

This is navigation and a selected-workspace landing page. It grants no business
operations. Future resource handlers must independently authorize their actual
resource organization and operation; opening a workspace is never an authority
token. Applications, scheduling and other business tools remain future slices.
Identity-provider configuration and the existing `/profile` JSON contract are
unchanged.

## Verification

- `npm test`: full application suite, navigation HTTP tests and three mutations.
- `npm run test:web`: profile/browser HTTP tests plus navigation and mutations
  after a build. Mutations prove fabricated session ownership, discarded URL
  selections and cached grants are detected; positive controls pass before and
  after. Temporary copies are removed in `finally`.
- `npm run test:db`: existing real-Postgres suite now also starts the gateway with
  `createRuntimeLoginFromEnv` and verifies three persisted contexts across two
  organizations, forged context denial, committed revocation and logout.
- `npm run dev`: local synthetic preview; `/__preview/workspace` and its
  `org_id`/`role` query show navigation fixtures. These preview aliases inject
  only a synthetic session in the development wrapper, never in the gateway.

Local browser preview was blocked by the browser environment. Automated HTTP
checks are not a claim of visual, live OIDC or staging deployment acceptance.
