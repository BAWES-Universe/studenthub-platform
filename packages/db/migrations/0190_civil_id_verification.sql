-- SHU-146: sensitive values stay in the private aggregate, never in audit/job errors.
CREATE TABLE candidate_civil_id (
  candidate_ref TEXT PRIMARY KEY CHECK (length(candidate_ref) BETWEEN 1 AND 512),
  civil_id_number TEXT NOT NULL,
  country_code TEXT NOT NULL CHECK (country_code IN ('KW', 'BH')),
  expiry_date DATE NOT NULL CHECK (expiry_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  need_verification BOOLEAN NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ocr', 'manual', 'staff')),
  candidate_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK ((country_code = 'KW' AND civil_id_number ~ '^[0-9]{12}$')
      OR (country_code = 'BH' AND civil_id_number ~ '^[0-9]{9}$')),
  CHECK (source = 'staff' OR need_verification)
);
CREATE UNIQUE INDEX candidate_civil_id_active_number
  ON candidate_civil_id (country_code, civil_id_number) WHERE NOT candidate_deleted;
CREATE INDEX candidate_civil_id_review_queue
  ON candidate_civil_id (candidate_ref) WHERE need_verification AND NOT candidate_deleted;

CREATE TABLE civil_id_ocr_job (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) BETWEEN 1 AND 512),
  candidate_ref TEXT NOT NULL CHECK (length(candidate_ref) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  code TEXT CHECK (code IN ('civil_id_country_unsupported', 'civil_id_format_invalid',
    'civil_id_expiry_invalid', 'civil_id_duplicate', 'civil_id_request_invalid',
    'not_found', 'civil_id_ocr_failed', 'civil_id_ocr_unreadable')),
  expired BOOLEAN,
  time_zone TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CHECK ((status = 'succeeded' AND code IS NULL AND expired IS NOT NULL)
      OR (status = 'failed' AND code IS NOT NULL AND expired IS NULL))
);

-- One transaction-coupled event per domain operation (including a failed job).
-- No free-text fields, numbers, images, provider payloads or raw principal ids.
CREATE TABLE civil_id_verification_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_ref TEXT NOT NULL CHECK (actor_ref ~ '^[0-9a-f]{64}$'),
  candidate_ref_hash TEXT NOT NULL CHECK (candidate_ref_hash ~ '^[0-9a-f]{64}$'),
  job_ref TEXT CHECK (job_ref ~ '^[0-9a-f]{64}$'),
  operation TEXT NOT NULL CHECK (operation IN ('ocr', 'manual', 'confirm')),
  outcome TEXT NOT NULL CHECK (outcome IN ('written', 'failed')),
  code TEXT CHECK (code IN ('civil_id_country_unsupported', 'civil_id_format_invalid',
    'civil_id_expiry_invalid', 'civil_id_duplicate', 'civil_id_request_invalid',
    'not_found', 'civil_id_ocr_failed', 'civil_id_ocr_unreadable')),
  occurred_at TIMESTAMPTZ NOT NULL,
  CHECK ((operation = 'ocr') = (job_ref IS NOT NULL)),
  CHECK ((outcome = 'written' AND code IS NULL) OR (outcome = 'failed' AND code IS NOT NULL))
);
CREATE FUNCTION reject_civil_id_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'civil_id_audit_append_only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER civil_id_audit_append_only BEFORE UPDATE OR DELETE ON civil_id_verification_audit
  FOR EACH ROW EXECUTE FUNCTION reject_civil_id_audit_mutation();
CREATE TRIGGER civil_id_audit_no_truncate BEFORE TRUNCATE ON civil_id_verification_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_civil_id_audit_mutation();
