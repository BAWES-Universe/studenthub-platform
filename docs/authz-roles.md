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

## Actor-assertion standard (bawes-aa.v1) — Opus's four amendments, all in

Verified review by Opus (2026-09-03); all four folded into this contract:

1. **Optional `act` claim** — `{ orgId, role }` context on the assertion, so an
   actor can express "Khalid, acting as owner of Org A, hiring for Org B."
   Wire-compatible addition to v1 (optional field; consumers that ignore it
   keep working).
2. **Positive subject assertion** — no fail-open denylist of guest/anonymous
   strings. A subject must be a non-empty, positive identity; empty or missing
   is a hard deny. ("guest" is not special-cased at parse time — it resolves
   like any id without a grant: denied.)
3. **Issuer-key registry contract** — every issuer has versioned keys with
   `active | retired` status. Unknown keyId and retired keys are hard denies;
   rotation never falls back to accepting anything. Rotation = register new
   key, migrate, retire old.
4. **Per-contract versioning** — `packages/contracts/src/versions.ts` carries
   a version per contract family (authz, assertions, …) instead of one
   global `PLATFORM_CONTRACT_VERSION`, so a role-field addition doesn't bump
   the version for consumers that only read health.

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
