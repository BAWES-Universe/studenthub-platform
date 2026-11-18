-- Access lane A1: who gave or took away a grant, when and why.
--
-- The grants table keeps holding the current grants and
-- authorization_mutation_audit keeps its hashed, count-only audit row for
-- every change (operations grants.grant and grants.revoke, unchanged). This
-- table adds what an admin needs to read on a person's Access page: the
-- organization, role, scope, the acting principal and the reason. It stores
-- principal ids, never an email address or a name.
--
-- Rows are append-only. token_id is the single-use preview/confirm token a
-- change was confirmed with; its uniqueness is what makes a replayed confirm
-- fail. Changes made without a token (A2 invitation acceptance) leave it null.

CREATE TABLE access_grant_events (
  id                  BIGSERIAL PRIMARY KEY,
  target_principal_id TEXT NOT NULL CHECK (char_length(target_principal_id) BETWEEN 1 AND 256),
  org_id              TEXT NOT NULL CHECK (char_length(org_id) BETWEEN 1 AND 256),
  role                TEXT NOT NULL CHECK (
    role IN ('candidate', 'staff', 'admin', 'org-owner', 'recruiter', 'finance')
  ),
  scope               TEXT NOT NULL CHECK (scope IN ('self', 'subtree')),
  action              TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
  actor_principal_id  TEXT NOT NULL CHECK (char_length(actor_principal_id) BETWEEN 1 AND 256),
  reason              TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  token_id            TEXT UNIQUE CHECK (token_id IS NULL OR token_id ~ '^[0-9a-f]{64}$'),
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- The person's history, and the latest grant event per (person, org, role).
CREATE INDEX access_grant_events_target_idx
  ON access_grant_events (target_principal_id, occurred_at DESC, id DESC);
CREATE INDEX access_grant_events_target_grant_idx
  ON access_grant_events (target_principal_id, org_id, role, occurred_at DESC, id DESC);
CREATE INDEX access_grant_events_org_idx
  ON access_grant_events (org_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION reject_access_grant_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'access grant events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER access_grant_events_append_only
  BEFORE UPDATE OR DELETE ON access_grant_events
  FOR EACH ROW EXECUTE FUNCTION reject_access_grant_event_mutation();

CREATE TRIGGER access_grant_events_no_truncate
  BEFORE TRUNCATE ON access_grant_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_access_grant_event_mutation();

-- Admin lookups: exact email (case-insensitive), name prefix, company name prefix.
CREATE INDEX IF NOT EXISTS principals_lower_email_idx ON principals (lower(email));
CREATE INDEX IF NOT EXISTS principals_lower_display_name_prefix_idx
  ON principals (lower(display_name) text_pattern_ops);
CREATE INDEX IF NOT EXISTS organizations_lower_name_prefix_idx
  ON organizations (lower(name) text_pattern_ops);
