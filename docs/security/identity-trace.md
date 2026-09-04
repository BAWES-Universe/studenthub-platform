# Identity trace: where a user's identity flows through the platform

**Card:** SHU-28 · **Owner:** Hermes · **Verifier:** Opus (independent)
**Commit traced:** `main` @ `8fce8a19` (SHU-49 authz + SHU-47 bakeoff + SHU-56 README merged)

This document traces a verified human identity from the wire to every
authorization decision, file-and-line, and lists every point where it could be
forged or lost.

---

## 1. The path, end to end

### 1.1 Entry — gateway request gate

`apps/gateway/src/index.ts`

- `POST /mcp/tools/call` is the only protected route (:95). `GET /health` is
  intentionally unauthenticated and returns no data (:89-93).
- The raw `x-actor-assertion` header is read **before the body** (:101-102) and
  passed untouched to `authorizeRequest` (:109). The signature covers the raw
  wire bytes; nothing re-serializes claims.
- A dependency failure (escaping rejection) becomes `503 authz_unavailable` —
  the adapter is never reached (:110-113).
- Any denial short-circuits with `401 unauthorized` (authn failures) or
  `403 forbidden` (authz failures) and the typed reason (:115-123).
- Only after an `allow` is the body read (:126), parsed (:138), shape-checked
  (:145-149), and dispatched to the adapter (:153). Adapter failure → 502 (:157-159).
- The server binds `127.0.0.1` only (:172). TLS is assumed terminated by a
  proxy in front; this process never exposes plaintext to a network.

### 1.2 Gate logic — authorizeRequest

`apps/gateway/src/authz-middleware.ts`

- `authorizeRequest` (:102-135):
  1. Missing/empty assertion → deny 401 `missing_assertion` (:106-108). There
     is no guest path and no anonymous route.
  2. `verifyAssertion` over the raw wire value (:110-118). Any non-ok result →
     deny 401 with the typed code.
  3. Server-side context re-derivation from grants (:122-126): the verified
     subject maps to a principal, and the org+role resolve from the store —
     never from claims. Denied → 403 with reason.
  4. Allow carries only `subject`, `orgId`, `role` — the minimal triple the
     route needs (:129-134).
- `createDenyAllAuthzMiddleware` (:148-156) is the default for an unconfigured
  gateway: empty key registry + empty grants store + `unconfigured://deny-all`
  audience, so nothing ever reaches a route until a real store and registry
  are injected. There is no fail-open configuration (`createGatewayServer` has
  no `authz = undefined` case, :79-83).
- `registryKeyResolver` (:65-74): resolves a key only when the (issuer, kid)
  exists **and** is `active`. No `kid` → resolves only when the issuer has
  exactly one active key. Unknown/retired → `undefined` → `UNKNOWN_ISSUER`.

### 1.3 Authentication — verifyAssertion

`packages/actor-assertion/src/verify.ts`

- Envelope `bawes-aa.v1.<payload>.<sig>` (:70-74); unknown prefix/version →
  MALFORMED.
- Claims schema validation (:76-77) requires `v=1`, non-empty `iss/aud/sub/jti`,
  finite `iat/exp` (:19-56). Optional `act` is shape-checked; unknown members
  dropped — signature covers raw bytes so dropping never invalidates (:33-46).
- Time checks (:79-83): `exp` in the past → EXPIRED; `iat` more than 300s in
  the future → FUTURE_IAT.
- Key resolution via the injected resolver (:88-94); resolver throw →
  UNAVAILABLE, no key → UNKNOWN_ISSUER.
- Ed25519 verification over `bawes-aa.v1.<payloadB64>` (:96-104); failure →
  BAD_SIGNATURE.
- **Destination binding**: `aud` must equal the gateway's exact
  `expectedAudience` (:106-110) → AUD_MISMATCH. An assertion minted for any
  other destination is rejected here.
- **Positive subject policy** (:117-121): after authenticity, `sub` must match
  the issuer's registered human-subject pattern (`UNIVERSE_SUBJECT_POLICY`).
  This is a positive allowlist of the issuer's format — no denylist, and it
  runs post-signature so subject shapes cannot be probed unauthenticated.
- Optional expected-subject pin (:123-127) → WRONG_SUBJECT.
- **Replay protection** (:131-137): `replayStore.consume(issuer, jti, exp, now)`.
  Scoped per issuer (NUL-separated key, :147-149); store failure → UNAVAILABLE
  (accepting an unrecorded jti would silently disable replay protection).

### 1.4 Claim mapping — adapter only, no security of its own

`packages/contracts/src/authz/assertion.ts`

- `claimsToRequestIdentity` (:34-36): verified `sub` → `{ kind: "pbuuid", pbuuid: sub }`.
  Under `sub_mode=user_email` the verified subject is the email-as-pbuuid; it
  is used **only** as a store lookup key, never as proof of role.
- `claimsActToContextSelection` (:44-55): the optional `act` claim becomes a
  **selection preference**; absent/empty → `undefined`. It is re-validated
  against grants in the resolver.

### 1.5 Authorization — resolveActiveContext

`packages/contracts/src/authz/context.ts`

- `resolvePrincipalId` (:79-89): principal-kind → `getPrincipal`; pbuuid-kind →
  `findPrincipalByPbuuid` (server-side lookup through the store's pbuuid
  index). Unknown → null.
- `resolveActiveContext` (:213-268), deny-by-default:
  - Unknown principal → 403 `unknown_principal` (:218-219).
  - Org targeted: org must exist (:222-223); effective grants for that org
    (:224-225); claimed role must actually be granted (:227-228, :200-207);
    direct rows win over inherited (:230-233).
  - No org targeted: authorize only when the principal has exactly **one**
    effective context; several → `ambiguous_context` (:249-253).
- Org hierarchy: subtree grants fan out to descendants; nearest ancestor wins;
  direct always beats inherited (`effectiveGrantsForOrg` :96-127,
  `listEffectiveContexts` :130-189). Dangling grant orgs are ignored (:155).
- Nothing is cached across requests — grants are re-read from the store on
  every call (:213 header comment).

### 1.6 Store — persistence seam and integrity rules

`packages/contracts/src/authz/store.ts`

- The resolver and middleware depend only on `GrantsStore`,
  `OrganizationStore`, `PrincipalStore` (:11-37) — enforcement never touches
  storage.
- `InMemoryAuthzStore` (:49-199) is the reference implementation: principals
  Map + pbuuid index + grants-by-principal (:50-54).
- `#registerPrincipal` (:94-112) enforces, **before any mutation**:
  1. **Cross-principal theft rejection** — a pbuuid owned by another principal
     cannot be registered (CWE-863 class; under email-as-pbuuid this is
     "claim another person's account by registering it") (:95-103).
  2. **Stale-mapping removal** — re-registering detaches pbuuids no longer
     present, so `findPrincipalByPbuuid` never resolves a revoked identity to
     a principal that still holds grants (:107-111).
- `grantMany` (:155-185) is many-at-once with idempotent merge (subtree is
  strictly wider than self); `revokeMany` (:187-194) and `clearGrantsForPrincipal`
  (:196-198) complete the write surface.

### 1.7 Issuer key registry

`packages/contracts/src/authz/registry.ts`

- Keys are ACTIVE or RETIRED only (:23-24). Retire keeps the row for audit and
  in-flight verification; deletion would strand sessions (:16-19).
- `registerKey` is idempotent for an existing (issuer, kid) (:108-109);
  unknown issuer/kid is a hard deny at the middleware (:20-21 comment).
- The registry holds opaque public-key material (`publicKey?`, :39); real
  crypto lives in `@bawes/actor-assertion`.

---

## 2. Where identity could be forged

| # | Point | File:line | Verdict |
| -- | -- | -- | -- |
| F1 | Assertion minting | outside this repo (issuer signs) | Assertions are minted by the issuer holding the private key. The gateway only ever sees the public key via the registry. Forgery requires the issuer's private key or a registry write. |
| F2 | Issuer key registration | `registry.ts:92-123` | A caller able to `registerKey` for a fake issuer can mint valid-looking assertions. Registry writes must be privileged and audited; today only the in-memory impl exists and nothing in the gateway path writes to it. |
| F3 | `act` claim trust | `context.ts:227`, `assertion.ts:44-55` | A client-supplied role is a preference only and is re-validated against grants. Not forgeable past the resolver. |
| F4 | Subject format | `verify.ts:117-121` | Positive pattern check post-signature; unrecognized shapes rejected. Not forgeable without a valid signature. |
| F5 | Audience | `verify.ts:106-110` | Assertion is destination-bound; a token minted for another service is rejected at this gateway. |

## 3. Where identity could be lost

| # | Point | File:line | Verdict |
| -- | -- | -- | -- |
| L1 | **Store persistence** | `store.ts:49-54` | The only `AuthzStore` implementation keeps every principal, pbuuid binding, org and grant in process-heap `Map`s. Restart, redeploy or a second replica loses all of it; the gateway then fails closed on everything. **This is SHU-55.** |
| L2 | **Replay store persistence** | `verify.ts:143-160`, `authz-middleware.ts:148-156` | `MemoryReplayStore` prunes lazily in-process. After a restart, a captured assertion still inside its `exp` window could be replayed (jti forgotten). Requires a shared store in production. |
| L3 | **Issuer key registry persistence** | `registry.ts:70-136` | Same class: in-memory only. Rotations/retirements vanish on restart. |
| L4 | Registry population gap | `authz-middleware.ts:148-156` | The deny-all default has an empty registry: until keys and grants are actually seeded, everything denies. Seeding is the SHU-55 bootstrap question. |
| L5 | Gateway is single-process | `index.ts:172` | Binds 127.0.0.1, no replica story. Correct for now; SHU-55's "where it runs" decision determines the real deployment shape. |

## 4. Bottom line

- **Authentication** (stages: presence → envelope → time → key → signature →
  audience → subject policy → replay) is verified, typed, and fail-closed at
  every stage. No forgery path found inside this repo's code.
- **Authorization** re-derives org+role from the store on every request;
  client claims are preferences, never proof. The store's registration rules
  close the stale-mapping and cross-principal-theft classes (CWE-863).
- **The entire trust boundary sits on in-memory state.** Nothing persists:
  grants, principal↔pbuuid bindings, issuer keys, and replay state all die
  with the process. The design is right and the enforcement is right; the
  missing half is a durable store (SHU-55) and a seeding/bootstrap path.
- Risk concentration: **registry write access** (F2) and **shared replay
  storage** (L2) are the two things a production deployment must get right
  beyond SHU-55 itself.

*Trace performed 2026-09-04 by Hermes (owner), against the exact commit above.
Independent verification by Opus requested per card label `verifier:opus`.*
