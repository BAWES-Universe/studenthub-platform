# ADR-0001 — Actor assertion format v1 (destination-bound, Ed25519)

Status: Draft for SHU-0031 implementation · Risk: R3 (identity/authorization)
Date: 2026-09-02 · Author: Hermes (implementer, SHU-0031) · Verifiers: Codex + Opus (pending)

## Context

Every protected `tools/call` on the StudentHub × Universe MCP gateway must
receive a caller assertion that is (a) bound to a specific destination
(service + action), (b) bound to a subject the server has already verified
via OIDC `userinfo.sub` (see SHU-0020 for where that binding lands — this
ADR defines the format, not the wiring), and (c) verifiable offline with
asymmetric keys so no shared-token lookup is involved.

## Format v1

Compact envelope, header-less (algorithm is fixed to Ed25519 — no alg-confusion surface):

```
bawes-aa.v1.<base64url(claimsJson)>.<base64url(ed25519sig)>
```

Signature input: the literal string `bawes-aa.v1.<base64url(claimsJson)>`.
Claims (all required):

| claim | meaning |
|---|---|
| `v` | format version, `1` |
| `iss` | issuer identifier (key resolved via resolver by `iss`) |
| `aud` | exact destination: `<service>/<action>` scope, e.g. `studenthub/tools/call:candidate.prepare` |
| `sub` | verified actor subject (Authentik `userinfo.sub`). Must NOT be `guest`/`anonymous`/empty |
| `iat` | epoch seconds |
| `exp` | epoch seconds |
| `jti` | one-use random id (replay protection until `exp`) |

## Verification rules (fail closed)

1. Parse envelope; wrong prefix/parts/base64/JSON → `MALFORMED`.
2. `v === 1`; every claim present and typed → `MALFORMED`.
3. Signature valid for `iss`'s public key (resolver) → else `BAD_SIGNATURE` / `UNKNOWN_ISSUER`.
4. `exp <= now` → `EXPIRED`. `iat > now + 300s` → `FUTURE_IAT` (clock skew bound).
5. `aud !== expectedAudience` → `AUD_MISMATCH` (destination binding).
6. `sub` empty/`guest`/`anonymous` → `GUEST_SUBJECT`.
7. `expectedSubject` provided and `sub !== expectedSubject` → `WRONG_SUBJECT`.
8. `jti` already seen (replay store retains until `exp`, then prunes) → `REPLAYED`.

## Key lifecycle

- Ed25519 keypair per issuer; private key never leaves the issuer.
- Verifiers hold only public keys, supplied via a `KeyResolver(iss)`.
- Test keys are generated in-memory; no key material is committed.

## Out of scope (explicit)

- Production issuer cutover, deployment, real key distribution.
- Wiring into live `tools/call` — requires SHU-0020 trace receipts
  (where `sub` binds to the active connection) and the Lane A skeleton.
  This PR ships the versioned contract, verification library, and the
  negative-test corpus only, per the SHU-0031 contract's allowed paths.
