CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('organization.status_changed')),
  subject_ref text NOT NULL CHECK (subject_ref ~ '^organization:[^:]+$'),
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'object'
    AND parameters ? 'status' AND parameters - 'status' = '{}'::jsonb
    AND (parameters->'status' = 'null'::jsonb OR parameters->>'status' IN ('active','under_review','inactive'))),
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  UNIQUE (recipient_principal_id, dedupe_key)
);

CREATE INDEX notifications_recipient_read_created_idx
  ON notifications (recipient_principal_id, read_at, created_at DESC);
