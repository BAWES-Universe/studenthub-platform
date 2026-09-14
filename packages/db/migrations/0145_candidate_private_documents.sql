-- SHU-145: isolated document metadata; no profile-field contract changes.
-- Bytes live in R2; this row contains only references, receipts and private audit.
CREATE TABLE candidate_document_snapshot (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  snapshot jsonb NOT NULL
);
INSERT INTO candidate_document_snapshot (singleton, snapshot) VALUES
  (true, '{"state":{"format":1,"documents":[],"retired":[]},"blobs":{}}'::jsonb);

-- Quarantine reservations commit independently before R2 writes, surviving a
-- metadata rollback or uncertain upload. No expiry or automatic deletion policy.
CREATE TABLE candidate_document_object_reservations (
  object_key text PRIMARY KEY,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  retention_status text NOT NULL DEFAULT 'held' CHECK (retention_status = 'held')
);
