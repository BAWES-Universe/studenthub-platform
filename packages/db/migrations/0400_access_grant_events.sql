CREATE INDEX IF NOT EXISTS principals_email_lower_idx ON principals (lower(email));
CREATE INDEX IF NOT EXISTS principals_display_name_lower_prefix_idx
  ON principals (lower(display_name) text_pattern_ops);

CREATE TABLE access_grant_events (
  id BIGSERIAL PRIMARY KEY,
  target_principal_id TEXT NOT NULL REFERENCES principals(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('candidate','staff','admin','org-owner','recruiter','finance')),
  scope TEXT NOT NULL CHECK (scope IN ('self','subtree')),
  action TEXT NOT NULL CHECK (action IN ('grant','revoke')),
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500 AND reason = btrim(reason)),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX access_grant_events_target_time_idx
  ON access_grant_events (target_principal_id, occurred_at DESC);
CREATE INDEX access_grant_events_org_time_idx
  ON access_grant_events (organization_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION access_grant_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'access grant events are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER access_grant_events_no_change BEFORE UPDATE OR DELETE ON access_grant_events
  FOR EACH ROW EXECUTE FUNCTION access_grant_events_append_only();
-- Durable replay protection for the access-specific preview token.
CREATE TABLE access_grant_spent_tokens (
  token_id TEXT PRIMARY KEY CHECK (token_id ~ '^[0-9a-f]{32}$'),
  spent_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
