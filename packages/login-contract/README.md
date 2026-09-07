# StudentHub login conformance contract

`@studenthub/login-contract` is the executable SHU-60 contract for the SHU-29
OIDC login implementation. It contains ports and a reusable conformance runner;
it does not contain a production login route.

An implementation supplies a `LoginApplicationFactory` and runs:

```ts
const report = await runLoginConformance(realLoginFactory);
assert.equal(report.ok, true, JSON.stringify(report.results, null, 2));
```

The runner creates a deterministic, synthetic environment: an Ed25519 test key
and local JWKS resolver, fake OIDC transport, injected clock and entropy source,
and in-memory state, session, identity, and authorization stores. All origins and
identities use reserved `.invalid` names or synthetic values.

The repository test suite also runs a conforming reference adapter and thirty-two
deliberately broken variants. Each broken variant must fail the scenario that
names its disabled control. The reference adapter lives under `test/` and must
never be wired into the gateway.

The contract covers server-side code exchange and browser secrecy, CSPRNG and
session-bound one-time state, PKCE S256, nonce verification, exact redirect
allowlisting, ID-token signature and claim validation, Universe subject policy,
issuer/subject identity binding without profile matching, server-derived
authorization, profile isolation, secure cookies, and server-side logout.
