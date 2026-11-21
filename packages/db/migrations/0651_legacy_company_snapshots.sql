-- Cutover lane (M-4): the approved legacy company snapshot each imported organization carries.
-- The organizations package reads it through ApprovedOrganizationAdapter; the importer writes it
-- once per legacy company (the id map in legacy_id_maps holds the digest, so a changed legacy
-- row is a conflict, never an overwrite). Values are already normalized to what the package parses.
CREATE TABLE legacy_company_snapshots (
  org_id text PRIMARY KEY REFERENCES organizations (id),
  -- The company parent (null for a top-level company, which the registry hangs under the operator org).
  parent_org_id text REFERENCES organizations (id),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  source_revision text NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
