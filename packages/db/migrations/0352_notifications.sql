CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('organization.status_changed')),
  subject_reference text NOT NULL CHECK (subject_reference ~ '^organization:.+'),
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters)='object' AND parameters ? 'status' AND jsonb_object_length(parameters)=1 AND parameters->>'status' IN ('active','under_review','inactive','none')),
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz
);
CREATE UNIQUE INDEX notifications_recipient_dedupe_idx ON notifications(recipient_principal_id,dedupe_key);
CREATE INDEX notifications_recipient_read_created_idx ON notifications(recipient_principal_id,read_at,created_at DESC);
