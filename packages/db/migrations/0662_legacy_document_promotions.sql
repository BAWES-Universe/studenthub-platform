-- Cutover lane (M-2 promotion step): the record of each staged legacy document promoted into a
-- linked person's empty slot, or found held by the person. One row per (principal, kind), written
-- in the same transaction as the person's document store row (0661), so a slot is promoted at most
-- once and a slot the person filled or cleared is never refilled by a re-run. Ids, kinds, digests,
-- outcome codes and invocations only: no byte, key or name.
CREATE TABLE legacy_document_promotions (
  principal_id text NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('personal-photo', 'resume', 'civil-id-front', 'civil-id-back')),
  legacy_candidate_id text NOT NULL CHECK (legacy_candidate_id ~ '^[1-9][0-9]{0,17}$'),
  generation uuid NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  org_id text NOT NULL CHECK (org_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  outcome text NOT NULL CHECK (outcome IN ('promoted', 'personHeld')),
  document_id uuid,
  document_version uuid,
  revision text NOT NULL CHECK (revision ~ '^[a-z0-9-]{1,40}$'),
  accepted_copy uuid NOT NULL,
  invocation uuid NOT NULL,
  promoted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_id, kind),
  CHECK ((outcome = 'promoted') = (document_id IS NOT NULL AND document_version IS NOT NULL)),
  CHECK (outcome = 'promoted' OR (document_id IS NULL AND document_version IS NULL)),
  -- The staged row it came from (0660); staged rows are never updated or deleted.
  FOREIGN KEY (legacy_candidate_id, kind, generation) REFERENCES legacy_candidate_documents (legacy_candidate_id, kind, generation)
);
CREATE INDEX legacy_document_promotions_candidate_idx ON legacy_document_promotions (legacy_candidate_id);

-- A promotion row is never rewritten or removed (a principal's deletion cascades).
CREATE OR REPLACE FUNCTION reject_legacy_document_promotion_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'legacy_document_promotions rows are never updated';
END;
$$;
CREATE TRIGGER legacy_document_promotions_no_update
  BEFORE UPDATE ON legacy_document_promotions
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_document_promotion_update();
