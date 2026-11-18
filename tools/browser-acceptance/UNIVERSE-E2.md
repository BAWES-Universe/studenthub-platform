# Synthetic E2 browser integration

This slice is based on #507 at `460a5e25294620196f5341f97fe7355165c8857f`.
It adds six separately named evidence cases to the existing runner: four English/
Arabic mobile sign-in → callback → native tab return → own-profile cases, a copied
URL case, and unsupported cross-site startup refusal. Existing E1 cases remain.

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

Cancellation/retry, repeated login, BFCache, background revocation, failed renewal
and cookie-path negative-control cases from the larger proposed matrix are not
claimed by this minimal slice.
