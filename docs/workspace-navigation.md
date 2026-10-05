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

Workspace HTML alone loads `/assets/workspace-history.js` under a same-origin
`script-src 'self'` policy (no inline scripts or eval). On pagehide it conceals
the outgoing document; a persisted pageshow reloads before revealing that
snapshot. This handles browser back/forward caches that might otherwise restore
a revoked context without making a request. It does not grant client authority.
Other pages retain their existing CSP. Already open pages do not poll for grant
changes; every subsequent request and restored workspace revalidates.

This is navigation and a selected-workspace landing page. It grants no business
operations. Future resource handlers must independently authorize their actual
resource organization and operation; opening a workspace is never an authority
token. Applications, scheduling and other business tools remain future slices.
Identity-provider configuration and the existing `/profile` JSON contract are
unchanged.

The current-main integration retains the typed approved-data own-profile
projection and mounted private-document routes. Context selection cannot add
profile fields, configure document storage or confer document access. This is the
SHU-91 chooser/selected-context slice of
`docs/parity/target-screen-navigation-contract.md`, not completion of all its
future capability panels, revisioned manifest, localization or iframe contracts.

## Verification

- `npm test`: full application suite, navigation HTTP tests and six mutations.
- `npm run test:web`: profile/browser HTTP tests plus navigation and mutations
  after a build. Mutations prove fabricated session ownership, discarded URL
  selections and cached grants are detected; three additional mutations remove
  history concealment, reload or script loading. Each must fail a named
  `SHU91_HISTORY` assertion. Positive controls pass before and after; temporary
  copies preserve the full compiled runtime layout (including private documents)
  and are removed in `finally`.
- `npm run test:db`: existing real-Postgres suite now also starts the gateway with
  `createRuntimeLoginFromEnv` and verifies three persisted contexts across two
  organizations, forged context denial, committed revocation and logout.
- `npm run dev`: local synthetic preview; `/__preview/workspace` and its
  `org_id`/`role` query show navigation fixtures. These preview aliases inject
  only a synthetic session in the development wrapper, never in the gateway.

Local browser preview was blocked by the browser environment. Automated HTTP
checks are not a claim of visual, live OIDC or staging deployment acceptance.

### Remaining browser acceptance (Hermes's eligible verifier)

Run `npm run build` then
`node tools/fixtures/src/web-preview.mjs --navigation-journey --port 4173` in a
checkout accessible to the browser. This explicit local wrapper injects a fake
session; it cannot prove real IdP/cookie behavior and rejects production mode.

1. Open `/workspace` at desktop and 320px widths. Check visible focus with
   keyboard-only navigation, readable organization/role labels, no horizontal
   overflow, and no selected role until chosen.
2. Choose Example Company / Staff, then Example Campus / Recruiter; refresh,
   bookmark, Back and Forward. The URL and selected label must agree each time.
3. In another tab open `/__preview/controls` and revoke the synthetic staff
   grant. Refresh/revisit the old staff URL and restore its history entry:
   access must be denied, never silently changed to Candidate or Recruiter.
4. Follow My profile and confirm the approved snapshot fields remain present.
   Capture viewport screenshots and browser console/network evidence at the
   reviewed SHA. Restart the fixture process to restore synthetic grants.

This browser run remains an acceptance blocker until actual evidence is posted;
the Node VM history-event test is an executable control, not a visual pass.
