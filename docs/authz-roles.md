# Roles + Authorization Contract (SHU-49)

The first contract step of the StudentHub platform — and the reference seam for
every business that hooks into Universe.

## North star framing

Ratified decision (Khalid, 2026-09-03): **one verified account per human; login
with Universe is the identity standard.** Once logged in to Universe, the
account works for every hooked business — StudentHub first (the reference
consumer), then Plugn stores/ecommerce, delivery, Tamr, any startup — with
shared account data (address, wallet, capabilities) available **by consent**
through versioned extensions of this standard.

"One login, then it's over" — the login/link is a one-time invisible event.
This module is the authorization half of that promise.

## Model

- **Principal** — one human. May link multiple pbuuids (Discord source,
  Google source, …) after the Option-A decision: Universe guarantees ONE
  account per human, so in practice a principal carries one primary pbuuid;
  the type still allows N links so the registry can represent legacy drift
  until reconciliation.
- **Organization** — hierarchical: parent + sub-companies. Access to a
  sub-company's data is **grant-based, never hardcoded inheritance**: a parent
  org sees a sub-company's invoices only where a grant says so.
- **Role** — closed, versioned union: `candidate | staff | admin | org-owner |
  recruiter | finance`. One human holds many grants at once (candidate AND
  staff AND admin AND owner of orgs they hire for AND recruiter for other
  orgs).
- **RoleGrant** — principal × org × role, scope `self | subtree`,
  many-at-once, idempotent.
- **Active context** — the org+role a request is authorized to act as.
  **Re-derived server-side from the grants store on EVERY request.** A
  client-supplied role/org is at most a *selection preference*, granted only
  when a matching grant exists. Never trusted from a token or claims.

## Resolution rules (deny by default)

- unknown principal → denied
- no grant at the target org → denied
- claimed role not granted → denied (`role_not_granted`)
- several roles possible, none claimed → denied (client must select)
- several orgs possible, none targeted → denied (`ambiguous_context`)
- direct grants always beat inherited (subtree) grants for the same
  (org, role)
- among inherited subtree grants covering the same org, the **nearest
  ancestor wins** (most specific grant)
- revocation takes effect on the very next resolution — no caching

## Actor-assertion standard (`bawes-aa.v1`) — the four amendments

There is exactly ONE actor-assertion format: `bawes-aa.v1`, defined in
`packages/actor-assertion`. It carries the destination binding (`aud`), expiry
(`exp`), one-use replay id (`jti`) and the Ed25519 signature over the raw
envelope bytes. `packages/contracts/src/authz/assertion.ts` holds no envelope,
no parser and no crypto — only an adapter from already-verified claims onto the
resolver's inputs.

*(SHU-49 first shipped a second, parallel format in `contracts` with none of
those properties. Opus's R3 review of PR #13 blocked it; this is the corrected
shape.)*

1. **Optional `act` claim** — `{ org, role }` on the assertion, so an actor can
   express "Khalid, acting as owner of Org A, hiring for Org B." Genuinely
   wire-compatible: the field is optional, assertions minted before it existed
   verify unchanged, and it is covered by the signature like every other claim.
   It is a **selection preference only** — `resolveActiveContext` re-derives the
   effective context from grants and honours `act` only when a grant backs it.
2. **Positive subject assertion** — the guest/anonymous denylist is gone. Each
   issuer declares the format a *human* principal's `sub` takes
   (`SubjectPolicy.humanSubjectPattern`), and a subject is usable only if it
   matches. There is no default: an unconfigured verifier rejects everything.
   This is checked **after** signature verification, so policy never runs on
   unauthenticated input and subject shapes cannot be probed without a valid
   signature.

   **`sub_mode` is per-provider.** Authentik sets it on each provider, not on
   the instance, so two apps behind the same Authentik emit differently-shaped
   subjects. Verified live (Khalid, 2026-09-04):

   | Provider | `sub_mode` | Subject | Policy constant |
   |---|---|---|---|
   | Universe apps | `user_email` | the email address | `UNIVERSE_SUBJECT_POLICY` (= `USER_EMAIL_SUBJECT_POLICY`) |
   | Coolify | `hashed_user_id` | opaque hex digest | `HASHED_USER_ID_SUBJECT_POLICY` |

   A relying party picks the policy matching the provider it is registered
   against. An earlier revision shipped a 32-hex/UUID pattern as "the Authentik
   reference"; it matched neither live mode and would have denied every real
   subject on first contact. A regression test now asserts that.

   > **Open decision — email as subject is not a stable identity.**
   > Under `user_email` the subject IS a mutable, reassignable attribute:
   > changing a user's email in Authentik changes their `sub`, and reassigning
   > an address to another person hands them the prior holder's grants. That is
   > the same failure the legacy system has, where payments resolve by email
   > lookup. The verifier matches what Universe emits today; moving Universe
   > providers to `hashed_user_id` (or another opaque, immutable subject) before
   > grants bind to money or personal records is a platform decision, not a
   > code change in this PR.
3. **Issuer-key registry contract** — every issuer has keys with
   `active | retired` status. Unknown `kid` and retired keys are hard denies;
   rotation never falls back to accepting anything. An assertion carries an
   optional `kid` so the registry can select the exact key; with no `kid`, a key
   resolves only when the issuer has exactly one active key — ambiguity denies.
   Rotation = register new key, migrate, retire old.
4. **Per-contract versioning** — `packages/contracts/src/versions.ts` carries a
   version per contract family (`health`, `authz`, `identity`) instead of one
   global `PLATFORM_CONTRACT_VERSION`, so adding a role field never bumps the
   version an integrator who only consumes `/health` is pinned to.

## Compatibility policy

Each slot in `CONTRACT_VERSIONS` is independently semver'd. This policy is what
those numbers mean; without it they are three integers nobody can act on.

**PATCH** — no wire change. Documentation, internal refactors, performance,
error-message text. Integrators never need to read a patch note.

**MINOR** — additive and backward-compatible. A consumer built against the
previous minor keeps working with no code change:

- adding an **optional** claim or field (this is how `act` and `kid` arrived)
- adding a new member to an **open** enum an integrator only reads
- relaxing a constraint (accepting input that was previously rejected)
- adding a new endpoint, method or error code an old client can ignore

**MAJOR** — anything a consumer must react to:

- removing or renaming any field; making an optional field required
- narrowing a type or tightening validation (input that used to pass now fails)
- changing the meaning of an existing field, or a default
- adding a member to a **closed** union an integrator must exhaustively handle
  (the `Role` union is closed — new roles are MAJOR for `authz`)
- any change to the signed envelope's structure or signing input

**Support window** — N-1 is supported for **90 days** after a MAJOR ships. Both
versions are accepted concurrently during that window; the older one is
rejected after it. Deprecation is announced when the new major ships, not when
the window closes.

**Slot boundaries** — a change bumps only the slot it touches:

| Change | Bumps |
|---|---|
| assertion claim set, envelope, signing input, subject policy | `identity` |
| roles, grants, org hierarchy, context resolution, key registry | `authz` |
| the `/health` envelope | `health` |

`PLATFORM_CONTRACT_VERSION` remains as a wire-compatible alias of the `health`
slot for existing consumers. New code reads its own slot via
`contractVersion(name)`.

## Standard seams for hooked businesses

Third-party businesses integrate through versioned contracts + this authz
model, not by reaching into tables:

- identity: one Universe account per human (pbuuid), resolved via the registry
- authorization: grants + server-side context resolution (this package)
- key trust: the issuer-key registry (rotation contract above)
- capability sharing (wallet, address, …): future versioned extension of the
  standard, consent-gated — explicitly out of scope for step 1

## Scope notes

- Persistence of grants/orgs is behind `AuthzStore` (in-memory impl ships;
  Postgres impl lands with the platform data layer).
- Signature verification is injected (`verifyAssertionSignature`); the
  skeleton denies by default until authn lands.
- Gateway middleware enforces: positive assertion → parse → key registry →
  signature → server-side context → allow.
