CREATE TABLE civil_id_ocr_jobs (
  id uuid PRIMARY KEY,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('front','back')),
  document_id uuid NOT NULL,
  document_version uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','read','unreadable','failed','noted')),
  failure_code text,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  not_before timestamptz NOT NULL,
  lease_owner uuid,
  lease_expires_at timestamptz,
  country text CHECK (country IN ('KW','BH')),
  number_ciphertext bytea,
  key_version smallint,
  last4 text CHECK (last4 ~ '^[0-9]{4}$'),
  expiry_date date,
  fallback_version uuid,
  superseded_at timestamptz,
  resolved text CHECK (resolved IN ('accepted','dismissed')),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (document_id, document_version),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CHECK (failure_code IS NULL OR failure_code IN ('provider_unavailable','provider_rejected','image_too_large','image_missing','attempts_exhausted')),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((country IS NULL AND number_ciphertext IS NULL AND key_version IS NULL AND last4 IS NULL) OR
         (status = 'read' AND country IS NOT NULL AND number_ciphertext IS NOT NULL AND key_version IS NOT NULL AND last4 IS NOT NULL)),
  CHECK ((resolved IS NULL) = (resolved_at IS NULL))
);
CREATE INDEX civil_id_ocr_claim ON civil_id_ocr_jobs(status,not_before,created_at) WHERE status IN ('pending','running') AND superseded_at IS NULL;
CREATE INDEX civil_id_ocr_person ON civil_id_ocr_jobs(principal_id,side,created_at DESC);
CREATE INDEX civil_id_ocr_lease ON civil_id_ocr_jobs(lease_expires_at) WHERE status = 'running';
CREATE TABLE civil_id_ocr_sweeps (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  swept_at timestamptz NOT NULL
);
