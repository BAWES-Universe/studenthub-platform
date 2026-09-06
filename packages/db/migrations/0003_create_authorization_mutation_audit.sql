-- SHU-59: transaction-coupled audit facts for authorization mutations.
--
-- Principal identifiers can contain an Authentik subject or email in legacy
-- bootstrap data. Audit rows therefore store stable SHA-256 references rather
-- than raw principal identifiers. Organization ids and role names are policy
-- identifiers, not identity attributes.

CREATE TABLE IF NOT EXISTS authorization_mutation_audit (
  id                   BIGSERIAL PRIMARY KEY,
  request_ref          TEXT NOT NULL CHECK (request_ref ~ '^[0-9a-f]{64}$'),
  actor_principal_ref  TEXT CHECK (
    actor_principal_ref IS NULL OR actor_principal_ref ~ '^[0-9a-f]{64}$'
  ),
  operation            TEXT NOT NULL CHECK (
    operation IN ('principal.register', 'grants.grant', 'grants.revoke', 'grants.clear')
  ),
  target_principal_ref TEXT CHECK (
    target_principal_ref IS NULL OR target_principal_ref ~ '^[0-9a-f]{64}$'
  ),
  target_org_refs      TEXT[] NOT NULL DEFAULT '{}' CHECK (
    target_org_refs::text ~ '^\{([0-9a-f]{64}(,[0-9a-f]{64})*)?\}$'
  ),
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  before_summary       JSONB NOT NULL,
  after_summary        JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS authorization_mutation_audit_request_idx
  ON authorization_mutation_audit (request_ref, id);

-- The application role owns these tables today, so SQL privileges cannot
-- distinguish store writes from accidental audit edits. A row trigger makes
-- the audit ledger append-only even for another code path using that role.
CREATE OR REPLACE FUNCTION reject_authorization_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'authorization mutation audit rows are append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS authorization_mutation_audit_append_only
  ON authorization_mutation_audit;
CREATE TRIGGER authorization_mutation_audit_append_only
  BEFORE UPDATE OR DELETE ON authorization_mutation_audit
  FOR EACH ROW EXECUTE FUNCTION reject_authorization_audit_mutation();
