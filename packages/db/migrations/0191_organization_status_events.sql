CREATE TABLE organization_status_events (
  id bigserial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  receipt_ref text NOT NULL UNIQUE,
  from_status text NULL CHECK (from_status IN ('active','under_review','inactive')),
  to_status text NULL CHECK (to_status IN ('active','under_review','inactive')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz NULL,
  CHECK (from_status IS DISTINCT FROM to_status)
);
