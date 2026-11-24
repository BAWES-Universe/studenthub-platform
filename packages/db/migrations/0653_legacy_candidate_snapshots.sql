-- Cutover lane (M-1): the approved profile snapshot of each imported legacy candidate. My profile
-- reads it for a person linked to that candidate (legacy_account_links, Q14-L) through
-- PostgresImportedPersonSnapshots. The importer writes it once per legacy candidate; the id map in
-- legacy_id_maps holds the digest, so a changed legacy row is a conflict, never an overwrite.
-- Values are already checked by the profile projector; no credential, contact detail, bank detail,
-- civil ID number or document location is ever stored here.
CREATE TABLE legacy_candidate_snapshots (
  legacy_candidate_id text PRIMARY KEY CHECK (legacy_candidate_id ~ '^[1-9][0-9]{0,17}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  source_revision text NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
