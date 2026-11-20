-- Comms lane (contract C-1, C-2): the recruit lane's outbox reaches people.
--
-- Recruit writes one `recruit_outbox` row per invitation, interview, job application and
-- request application change (migrations 0453 to 0458) and leaves delivery to this lane.
-- The email delivery job now dispatches each row once: a feed item of kind
-- `recruit.<event>` for its recipient, rendered at read time from the request as it is
-- then, and for a sent invitation the job invitation email (legacy `Invitation::afterSave`:
-- candidate notification type 0 and `candidate/job-invitation`). Legacy types 10 and 11
-- (job interest shortlisted, rejected) are the `application.*` events.

-- One closed payload rule per kind: 0353's rules, plus the recruit kinds.
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
 (kind IN ('recruit.invitation.sent','recruit.invitation.accepted','recruit.invitation.declined','recruit.invitation.withdrawn',
   'recruit.interview.scheduled','recruit.interview.cancelled','recruit.application.shortlisted','recruit.application.rejected',
   'recruit.request_application.received','recruit.request_application.accepted','recruit.request_application.rejected')
  AND subject_reference ~ '^recruit_outbox:[1-9][0-9]{0,18}$'
  AND parameters='{}'::jsonb)
);

-- The job invitation email is optional, as legacy's was a courtesy: a person may switch it off.
INSERT INTO email_classes(class, transactional) VALUES ('recruit.invitation', false);
