# Actor assertions

`@bawes/actor-assertion` signs and verifies destination-bound actor assertions.
The public API is exported from [src/index.ts](src/index.ts); the package's ESM
entry points and scripts are declared in [package.json](package.json).

## Wire format and claims

[src/sign.ts](src/sign.ts) serializes claims as JSON and produces
`bawes-aa.v1.<base64url payload>.<base64url signature>`. The signature covers
`bawes-aa.v1.<base64url payload>`, including the version. Verification uses the
original encoded payload, not reserialized claims ([src/verify.ts](src/verify.ts)).

[src/types.ts](src/types.ts) defines `ActorAssertionClaims`:

| Field | Meaning |
| --- | --- |
| `v` | Format version, exactly `1`. |
| `iss` | Issuer identifier used for public-key resolution. |
| `kid?` | Optional signing-key identifier for rotation. |
| `aud` | Exact destination scope, described as service/action. |
| `sub` | Actor subject, checked against the caller's subject policy. |
| `iat`, `exp` | Issued-at and expiry times in epoch seconds. |
| `jti` | One-use identifier, scoped to the issuer for replay protection. |
| `act?` | Optional `ActorAssertionAct` with `org?` and `role?` selection preferences. |

`act` is not proof of a grant. The gateway re-derives the effective context
from its grant store ([authz-middleware.ts](../../apps/gateway/src/authz-middleware.ts)).
The decoder accepts absent or empty `act`, rejects malformed known members,
and drops unknown members; the signature still covers the raw payload
([src/verify.ts](src/verify.ts)).

## Signing, keys and verification interfaces

- `signAssertion(claims, privateKeyPem): Promise<string>` signs using Node's
  crypto API. It serializes the supplied typed claims without runtime claim
  validation; key parsing/signing errors can reject the promise
  ([src/sign.ts](src/sign.ts)).
- `generateEd25519KeyPair(): Promise<Ed25519KeyPair>` returns `publicKeyPem`
  (SPKI) and `privateKeyPem` (PKCS8). The helper generates Ed25519 keys; it
  does not persist or distribute them ([src/keys.ts](src/keys.ts)).
- `KeyResolver(issuer, keyId?): Promise<string | undefined>` supplies the
  public key. The interface requires unknown or retired keys to resolve to
  `undefined`, without fallback ([src/types.ts](src/types.ts)). The gateway's
  `registryKeyResolver` accepts only active registry keys; without `kid`,
  exactly one active key must exist
  ([authz-middleware.ts](../../apps/gateway/src/authz-middleware.ts)).
- `verifyAssertion(token, resolvePublicKey, replayStore, options)` returns
  `Promise<VerifyResult>`: either `{ ok: true, claims }` or
  `{ ok: false, code, reason }`. `VerifyOptions` requires `expectedAudience`
  and `subjectPolicy`; `expectedSubject` optionally adds exact subject
  equality ([src/types.ts](src/types.ts), [src/verify.ts](src/verify.ts)).

Callers must supply a valid `SubjectPolicy`; the implementation directly uses
its `humanSubjectPattern.test` method. `USER_EMAIL_SUBJECT_POLICY` checks email
shape, while `HASHED_USER_ID_SUBJECT_POLICY` checks 32–128 lowercase hex
characters. `UNIVERSE_SUBJECT_POLICY` currently aliases the email policy in
source. These are shape checks, not evidence of address ownership or identity
stability ([src/types.ts](src/types.ts)).

## Freshness and replay

Without `maxLifetimeSeconds`, verification uses the legacy path: a single
time snapshot (`now` or the current time, rounded down), expiry rejection at
`exp <= now`, and a default future-`iat` skew allowance of 300 seconds. It
does not impose the strict lifetime bound or asynchronous deadline below
([src/verify.ts](src/verify.ts)).

Supplying `maxLifetimeSeconds` enables strict verification. It must be an
integer from 1 through 3600; skew must be an integer from 0 through 300.
Strict mode requires `exp > iat` and `exp - iat <= maxLifetimeSeconds`, ignores
fixed `now`, and uses fresh `wallClock` and `monotonicClock` calls. It rechecks
freshness after key resolution, signature verification and successful replay
consumption, with one ten-second deadline across the verification. Clock
failures/regressions deny access. Timing out never undoes replay consumption
([src/verify.ts](src/verify.ts), [src/types.ts](src/types.ts)).

`ReplayStore.consume(issuer, jti, expiresAt, now, constraints?)` may be synchronous
or asynchronous. Legacy boolean results mean `true` = replay, `false` = newly
recorded. Explicit `ReplayOutcome` values are `consumed`, `replayed`, `expired`
and `future_iat`; strict mode supplies `ReplayConstraints` with `issuedAt` and
`maxIatSkewSeconds` ([src/types.ts](src/types.ts)). Replay recording occurs only
after signature, audience and subject checks succeed
([src/verify.ts](src/verify.ts)).

`MemoryReplayStore` keeps issuer-scoped identifiers in one in-memory map and
lazily prunes expired entries. It is not shared durable storage
([src/verify.ts](src/verify.ts)). The separate
[PostgresReplayStore](../db/src/assertions/postgres-replay-store.ts) implements
the interface structurally, delegates consumption to PostgreSQL with database
time, and offers bounded pruning retaining expired tombstones for ten minutes.

## Rejection results

The codes are declared in [src/types.ts](src/types.ts); the conditions and
ordering below come from [src/verify.ts](src/verify.ts). With valid caller
options, malformed tokens and key/replay dependency failures produce typed
denials. This is not a runtime validator for arbitrary caller configuration.

| Code | Rejection condition |
| --- | --- |
| `CONFIG` | Invalid strict lifetime/skew configuration or non-function strict clock options. |
| `MALFORMED` | Non-string token, wrong envelope part count/prefix/version, invalid JSON or claim schema (including malformed `kid` or `act`). |
| `LIFETIME` | Strict mode: nonpositive lifetime or lifetime above the configured maximum. |
| `EXPIRED` | Expiry reached, including a fresh-clock check or explicit replay-store expiry denial. |
| `FUTURE_IAT` | Issued-at exceeds allowed skew, including an explicit replay-store denial. |
| `UNKNOWN_ISSUER` | Resolver supplies no public key (also used for unknown/retired key IDs). |
| `BAD_SIGNATURE` | Public-key parsing/signature verification throws or the signature does not verify. |
| `AUD_MISMATCH` | Audience differs from `expectedAudience`. |
| `SUBJECT_FORMAT` | Subject fails the supplied positive format rule. |
| `WRONG_SUBJECT` | Subject differs from the optional `expectedSubject`. |
| `REPLAYED` | Replay store reports the issuer/identifier pair already consumed. |
| `UNAVAILABLE` | Key/replay dependency throws, replay outcome is invalid, freshness clock fails, or strict freshness/deadline checks fail. |

## Consumers in this repository

- Gateway [authz-middleware.ts](../../apps/gateway/src/authz-middleware.ts)
  calls `verifyAssertion` with audience and subject policy (legacy freshness
  mode), then resolves grants. Authentication denials become 401 and grant
  denials become 403. [index.ts](../../apps/gateway/src/index.ts) and
  [catalogue-http.ts](../../apps/gateway/src/catalogue-http.ts) read the
  `x-actor-assertion` header for their authorization paths.
- Gateway [universe/host-identity.ts](../../apps/gateway/src/universe/host-identity.ts)
  calls the strict verifier with a 60-second maximum lifetime and five-second
  skew. It hashes the challenge (`jti`) before passing it to replay storage,
  then requires the configured attestor issuer and no `act` claim.
  [wiring/universe.ts](../../apps/gateway/src/wiring/universe.ts) supplies a
  registry-backed key resolver and `PostgresReplayStore`. These are StudentHub
  call sites, not evidence of an external provider's deployment or behavior.
- Contracts [authz/assertion.ts](../contracts/src/authz/assertion.ts) consumes
  already-verified claims structurally: `claimsToRequestIdentity` adapts `sub`,
  and `claimsActToContextSelection` adapts `act`. It performs no cryptographic
  verification and has no runtime dependency on this package.
- Database [assertions/index.ts](../db/src/assertions/index.ts) exports
  `PostgresReplayStore`, the structural replay-store implementation described
  above. Gateway [authz-audit.ts](../../apps/gateway/src/authz-audit.ts) uses
  `AssertionErrorCode` to represent authentication denial reasons.

## Local validation

Run commands from the repository root. Scripts are defined in the root
[package.json](../../package.json). The assertion corpus in
[test/actor-assertion.test.ts](test/actor-assertion.test.ts) covers valid and
invalid assertions, optional context/key IDs, subject policies, dependency
failures, issuer-scoped replay, and strict freshness/deadline behavior.

Checks run for this documentation change on Node 22:

| Command | Result |
| --- | --- |
| `npm ci` | Passed. |
| `npm run typecheck` | Passed. |
| `npm run test:assertion` | Passed: 72 tests. |
| `npm run test:db` | Not run locally: no disposable PostgreSQL database configured for this documentation task. |

Full-suite and CI results are recorded in the PR's Evidence section. No live
provider or database acceptance is implied.
