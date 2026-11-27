-- Cutover lane (M-2 copy step): each legacy candidate document an accepted doccheck approved,
-- copied into staging object storage and recorded here, apart from the person-owned documents.
-- Nothing here is shown to anyone. Promotion into a linked person's empty slot is a later,
-- reviewed step that takes only a complete copy receipt. Rows are per refresh generation: a
-- generation's rows are never rewritten, and another generation's rows never stand in for them.
-- The object key is derived from the row (content-addressed), so a row cannot point elsewhere.
-- No legacy key, file name or byte is stored.
ALTER TABLE legacy_import_target
  ADD COLUMN document_bucket text CHECK (document_bucket IS NULL OR document_bucket ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$');

CREATE TABLE legacy_candidate_documents (
  legacy_candidate_id text NOT NULL CHECK (legacy_candidate_id ~ '^[1-9][0-9]{0,17}$'),
  kind text NOT NULL CHECK (kind IN ('personal-photo', 'resume', 'civil-id-front', 'civil-id-back')),
  generation uuid NOT NULL,
  mime text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'application/pdf')),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 10485760),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL UNIQUE,
  doccheck_invocation uuid NOT NULL,
  copy_invocation uuid NOT NULL,
  staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (legacy_candidate_id, kind, generation),
  CHECK ((kind = 'resume') = (mime = 'application/pdf')),
  CHECK (object_key = 'legacy-import/' || generation::text || '/' || legacy_candidate_id || '/' || kind || '/' || sha256)
);
