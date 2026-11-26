-- Comms lane (contract C-1, C-2), after 0607: a transfer whose payment was received reaches the
-- feed of each person on it.
--
-- Legacy wrote candidate notification type 5 (transfer initiated) when staff marked a transfer's
-- payment received (admin Transfer::paymentReceived -> Transfer::sendNewTransferNotification), one
-- for each candidate line of the transfer: "New transfer initiated", the line's total, its store and
-- company. Here the pay lane records that step as an append-only `pay_transfer_lifecycle_history`
-- row with action 'payment_received' (migration 0562). The email delivery job dispatches each such
-- row once: a feed item `pay.transfer_initiated` for each line's person, rendered at read time from
-- the line (its amount is frozen once the transfer leaves draft), its store and the transfer's
-- company. Line ids follow the pay history page's form; a line id outside it gets no item.

-- One closed payload rule per kind: 0607's rules, plus the initiated transfer kind.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_payload_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_payload_check CHECK (
 (kind='organization.status_changed'
  AND subject_reference ~ '^organization:.+'
  AND jsonb_typeof(parameters)='object'
  AND parameters=jsonb_build_object('status',parameters->'status')
  AND jsonb_typeof(parameters->'status')='string'
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
  AND jsonb_typeof(parameters->'workDate')='string'
  AND notification_calendar_date(parameters->>'workDate'))
 OR
 (kind='work.assigned'
  AND subject_reference ~ '^work_assignment:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND parameters='{}'::jsonb)
 OR
 (kind='pay.transfer_paid'
  AND subject_reference ~ '^bank_confirmation:[1-9][0-9]{0,18}$'
  AND parameters='{}'::jsonb)
 OR
 (kind='pay.transfer_initiated'
  AND subject_reference ~ '^pay_line:[A-Za-z0-9._:-]{1,128}$'
  AND parameters='{}'::jsonb)
 OR
 (kind IN ('recruit.invitation.sent','recruit.invitation.accepted','recruit.invitation.declined','recruit.invitation.withdrawn',
   'recruit.interview.scheduled','recruit.interview.cancelled','recruit.application.shortlisted','recruit.application.rejected',
   'recruit.request_application.received','recruit.request_application.accepted','recruit.request_application.rejected')
  AND subject_reference ~ '^recruit_outbox:[1-9][0-9]{0,18}$'
  AND parameters='{}'::jsonb)
);

-- Which payment-received steps this lane has dispatched. The history is append-only, so the mark
-- lives here, with no foreign key (a key would make the history's TRUNCATE guard fail on the key
-- first). Steps recorded before this migration are marked done, so the first run adds nothing old.
CREATE TABLE comms_dispatched_transfer_receipts (
 history_id bigint PRIMARY KEY,
 dispatched_at timestamptz NOT NULL
);
INSERT INTO comms_dispatched_transfer_receipts(history_id, dispatched_at)
 SELECT id, clock_timestamp() FROM pay_transfer_lifecycle_history WHERE action='payment_received';
CREATE INDEX pay_transfer_lifecycle_history_payment_received_idx
 ON pay_transfer_lifecycle_history(id) WHERE action='payment_received';
