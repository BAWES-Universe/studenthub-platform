-- Comms lane (contract C-1, C-2), numbered after the pay lane's 0575: a paid transfer line reaches
-- the person's feed.
--
-- Legacy wrote candidate notification type 6 (transfer paid) from the daily cron for each paid
-- transfer line not yet notified (TransferCandidate::sendTransferPaidNotification, with
-- `is_candidate_notified`). Here a line is marked paid only when a bank result file confirms it,
-- and the pay lane writes one append-only `bank_result_confirmations` row in the same transaction
-- (migration 0575). The email delivery job dispatches each confirmation once: a feed item
-- `pay.transfer_paid` for the line's person, rendered at read time from the confirmation, the
-- line's store and the transfer's company.

-- One closed payload rule per kind: 0606's rules, plus the paid transfer kind.
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
 (kind IN ('recruit.invitation.sent','recruit.invitation.accepted','recruit.invitation.declined','recruit.invitation.withdrawn',
   'recruit.interview.scheduled','recruit.interview.cancelled','recruit.application.shortlisted','recruit.application.rejected',
   'recruit.request_application.received','recruit.request_application.accepted','recruit.request_application.rejected')
  AND subject_reference ~ '^recruit_outbox:[1-9][0-9]{0,18}$'
  AND parameters='{}'::jsonb)
);

-- Which bank confirmations this lane has dispatched. The pay lane's evidence is append-only, so the
-- mark lives here, with no foreign key (a key would make the evidence tables' TRUNCATE guards fail on
-- the key first). Confirmations recorded before this migration are marked done, so the first run adds
-- nothing old.
CREATE TABLE comms_dispatched_bank_confirmations (
 confirmation_id bigint PRIMARY KEY,
 dispatched_at timestamptz NOT NULL
);
INSERT INTO comms_dispatched_bank_confirmations(confirmation_id, dispatched_at)
 SELECT id, clock_timestamp() FROM bank_result_confirmations;
