-- SHU-55: authz persistence tables backing the Postgres AuthzStore.
--
-- This schema mirrors packages/contracts/src/authz exactly and adds the
-- constraints the in-memory store enforces in code as DATABASE invariants:
--
--  * ROLES / GRANT_SCOPES from packages/contracts are re-asserted as CHECK
--    constraints so a rogue writer can never mint a role or scope the
--    resolver does not understand (the closed union is a contract property).
--  * principal_pbuuids.pbuuid is PRIMARY KEY, not merely indexed. That single
--    constraint is the TOCTOU-safe backstop for the cross-principal theft
--    check the in-memory store does with a pre-flight scan: two concurrent
--    registrations claiming the same pbuuid are serialized by the unique
--    index and exactly one commits; the loser fails with unique-violation
--    23505 instead of silently stealing the mapping (CWE-863 class).
--  * grants is UNIQUE (principal_id, org_id, role): re-granting the same
--    (org, role) must widen the existing row in place, never duplicate it.
--  * principal rows cascade to their pbuuids and grants so removing a
--    principal can never orphan authorization data or identity links.
--
-- Files in this directory are applied in filename order by
-- src/migrate.ts, each inside its own transaction and recorded in
-- schema_migrations. CREATE TABLE IF NOT EXISTS keeps hand-applied
-- databases harmless; the version ledger is the real source of truth.

CREATE TABLE IF NOT EXISTS organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- NULL = root organization. The self-referencing FK makes a child point
  -- at a parent that must exist; cross-row cycles (a->b->a) are not
  -- expressible in a FK and are rejected by contract construction helpers
  -- plus kept cycle-safe everywhere in the resolver.
  parent_org_id TEXT REFERENCES organizations (id)
);

CREATE TABLE IF NOT EXISTS principals (
  id           TEXT PRIMARY KEY,
  display_name TEXT,
  email        TEXT
);

-- One row per (principal, pbuuid) link. The pbuuid PRIMARY KEY means a
-- pbuuid is owned by AT MOST ONE principal at any instant — see header.
CREATE TABLE IF NOT EXISTS principal_pbuuids (
  principal_id TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  pbuuid       TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS grants (
  id           BIGSERIAL PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  org_id       TEXT NOT NULL REFERENCES organizations (id),
  role         TEXT NOT NULL CHECK (
    role IN ('candidate', 'staff', 'admin', 'org-owner', 'recruiter', 'finance')
  ),
  scope        TEXT NOT NULL CHECK (scope IN ('self', 'subtree')),
  UNIQUE (principal_id, org_id, role)
);
