CREATE TABLE organization_account_manager_events (
  id bigserial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  receipt_ref text NOT NULL UNIQUE,
  -- Deliberately not foreign keys: history must survive principal removal.
  from_principal_id text NULL,
  to_principal_id text NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (from_principal_id IS DISTINCT FROM to_principal_id)
);

CREATE INDEX organization_account_manager_events_org_id_idx
  ON organization_account_manager_events(org_id);
