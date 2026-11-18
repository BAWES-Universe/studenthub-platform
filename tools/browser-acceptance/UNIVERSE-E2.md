# Synthetic E2 browser integration

This slice is based on #507 at `460a5e25294620196f5341f97fe7355165c8857f`.
It adds eight separately named evidence cases to the existing runner: four English/
Arabic mobile sign-in → callback → native tab return → own-profile cases, a copied
URL case, unsupported cross-site startup refusal, and English/Arabic cancel → retry recovery. Existing E1 cases remain.

The fixture uses the actual gateway, E2 browser script, Postgres login states,
sessions, identities, embed instances, handoffs and leases. OIDC transport/JWKS,
pusher and the profile data port are synthetic. OIDC still uses signed ID tokens,
PKCE, real callback validation and native browser cookies; pusher attestations
still traverse the real challenge/identity endpoint. No tokens or cookie values
are retained in evidence. The profile reader explicitly verifies that the requested
person equals the synthetic login identity. This is not real provider, E3 Universe
pusher integration or E4 live-host acceptance.

Fixture hostnames are `parent.browser.test`, `embed.browser.test`, and
`provider.browser.test`. The existing disposable TLS preparation adds these SANs;
the runner maps them to loopback, without disabling TLS or CSP. This does not
select or configure any real StudentHub host. Database use requires the explicitly
provided loopback `BROWSER_ACCEPTANCE_DATABASE_URL` and PostgreSQL 17; each fixture
gets a private random schema which is dropped afterward. No database fallback to
production configuration is used.

## Run

Use the existing Profile browser acceptance workflow's pinned Node, Playwright,
Chromium and PostgreSQL preparation. Its normal command picks up these cases:

```
node tools/browser-acceptance/run.mjs
```

Build first for the non-browser registration/topology tests:

```
npm run build
node --test tools/browser-acceptance/universe-embed-e2.test.mjs
```

All cases initialize NOT_RUN. Do not turn setup failures into PASS. The browser
journey waits for native return to restore the profile without a reload or a
synthetic visibility event. A stuck waiting state must fail instead of being
hidden by a test workaround. A Chromium viewport case is not mobile Safari proof.

## Local verification for this patch

- Build passed.
- Three new non-browser tests passed, including the actual production startup
  refusal path.
- Existing E2 service suite passed, 13 tests.
- JavaScript syntax and diff whitespace checks passed.
- Browser integration remains NOT_RUN: this execution environment denied Chromium
  process-singleton socket creation. No workaround or permission change was used.
  CI must execute the real Postgres/native-cookie fixture before claiming E2 proof.

Repeated login, BFCache, background revocation, failed renewal
and cookie-path negative-control cases from the larger proposed matrix are not
claimed by this minimal slice.

## Cancel/retry increment

Based on published draft #515 at `198821ff5f2794c0bd7acd253f4343ce40b33688`.
The synthetic provider holds the first authorization on a visible page, without
issuing a code or callback. The browser focuses and closes that native tab, then
returns to the unchanged parent. Recovery must reveal Sign in again without
reload, script event injection or API calls from the test. The second normal
sign-in must complete and reveal only the synthetic person's profile.

The fixture separately checks no callback, exchange, profile read or session on
the canceled attempt, then exactly one callback/exchange/session after retry.
Real PostgreSQL handoff rows must finish with one superseded and one consumed
handoff. All counts are sanitized; no state, cookie or token values are recorded.

Local syntax, four non-browser tests, and whitespace checks passed. Both new
browser cases remain NOT_RUN under the already observed Chromium socket denial;
no sandbox workaround was attempted. Static source review alone does not prove
that cancel/retry is broken: the real script revalidates on visible return, but
its waiting state suppresses periodic polling. Native focus/visibility behavior
is exactly what CI must exercise rather than assuming success or failure.

## Isolated launch correction after CI run 44288442101

Artifact `14420262195`, candidate `21d63b92c76107a747cdb3fd29aa7e01b8db092a`,
reported `blockedStage: compare-isolated-bfcache-launch`. The baseline language
cases passed; BFCache, E1 and E2 cases remained NOT_RUN. E2 fixture DNS/proxy
arguments had been added only to the baseline browser, violating the existing
assertion that the paired BFCache process differs solely by removing
`--disable-back-forward-cache`.

The baseline and BFCache launches are now restored unchanged. A separate pinned
Chromium process owns E2's fixture-specific resolver and no-proxy options, runs
after E1, and is closed in a finally block even after matrix or version failures.
The paired-launch comparison and its acceptance criteria are not weakened.
`e2-browser-process.test.mjs` pins both old launches, argument isolation and
cleanup on success/failure. These non-browser tests do not establish a successful
CI rerun or native-cookie proof.
