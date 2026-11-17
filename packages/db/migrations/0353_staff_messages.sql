-- Staff messages and document requests to a person (legacy CandidateNotification types
-- 12 profile photo request, 13 civil ID request, 14 staff message). The message row holds
-- what staff wrote; the person's feed holds only a reference to it, so the feed still
-- stores no rendered text. send_key is the sender's idempotency key, as legacy's sendKey.
CREATE TABLE staff_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 recipient_principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 sender_principal_id text NOT NULL REFERENCES principals(id),
 kind text NOT NULL CHECK (kind IN ('profile_photo_request','civil_id_request','message')),
 body text,
 send_key text NOT NULL UNIQUE CHECK (send_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((kind='message')=(body IS NOT NULL)),
 CHECK (body IS NULL OR (char_length(body) BETWEEN 1 AND 2000 AND body=btrim(body)))
);
CREATE INDEX staff_messages_recipient_created_idx ON staff_messages(recipient_principal_id,created_at DESC);

-- One closed payload rule per kind, replacing the single-kind checks of 0352. Work session
-- decisions (legacy types 8 and 9) are written by the work lane inside its decision transaction.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications DROP CONSTRAINT notifications_subject_reference_check;
ALTER TABLE notifications DROP CONSTRAINT notifications_parameters_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_payload_check CHECK (
 (kind='organization.status_changed'
  AND subject_reference ~ '^organization:.+'
  AND jsonb_typeof(parameters)='object'
  AND parameters=jsonb_build_object('status',parameters->'status')
  AND parameters->>'status' IS NOT NULL
  AND parameters->>'status' IN ('active','under_review','inactive','none'))
 OR
 (kind='staff.message'
  AND subject_reference ~ '^staff_message:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND parameters='{}'::jsonb)
 OR
 (kind IN ('work.session_approved','work.session_rejected')
  AND subject_reference ~ '^work_session:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  AND jsonb_typeof(parameters)='object'
  AND parameters=jsonb_build_object('workDate',parameters->'workDate')
  AND parameters->>'workDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
