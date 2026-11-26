-- Pay F6 (invoices lane): one paid notice per paid pay line. Numbered 0607, after the comms lane's 0606,
-- because each feed migration re-states the whole notifications_kind_payload_check: a number below
-- 0606 would run first on a fresh database and 0606 would drop this kind again.
--
-- Legacy has this notice in code (TransferCandidate::sendTransferPaidNotification, "KD {amount}
-- has been transferred to your bank account") but switched off; the lane plan records sending it
-- as a deliberate addition. The bank result apply writes one feed row per line it marks paid, in
-- the same transaction, keyed by that payment's confirmation row (append-only, one per paid line
-- and bank reference). The row is rendered at read time from the confirmation and its line, and
-- only for the line's own person.

-- One closed payload rule per kind: 0606's rules, plus the paid notice.
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
 (kind='pay.line_paid'
  AND subject_reference ~ '^bank_confirmation:[1-9][0-9]{0,18}$'
  AND parameters='{}'::jsonb)
 OR
 (kind IN ('recruit.invitation.sent','recruit.invitation.accepted','recruit.invitation.declined','recruit.invitation.withdrawn',
   'recruit.interview.scheduled','recruit.interview.cancelled','recruit.application.shortlisted','recruit.application.rejected',
   'recruit.request_application.received','recruit.request_application.accepted','recruit.request_application.rejected')
  AND subject_reference ~ '^recruit_outbox:[1-9][0-9]{0,18}$'
  AND parameters='{}'::jsonb)
);
