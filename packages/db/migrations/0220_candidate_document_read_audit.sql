CREATE TABLE candidate_document_read_audit (
  id UUID PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('list','issueDelivery','deliver')),
  principal_ref TEXT NOT NULL CHECK (principal_ref ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX candidate_document_read_audit_principal_occurred_idx
  ON candidate_document_read_audit (principal_ref, occurred_at);

CREATE OR REPLACE FUNCTION reject_candidate_document_read_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'candidate document read audit rows are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER candidate_document_read_audit_append_only
  BEFORE UPDATE OR DELETE ON candidate_document_read_audit
  FOR EACH ROW EXECUTE FUNCTION reject_candidate_document_read_audit_mutation();
CREATE TRIGGER candidate_document_read_audit_no_truncate
  BEFORE TRUNCATE ON candidate_document_read_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_candidate_document_read_audit_mutation();
