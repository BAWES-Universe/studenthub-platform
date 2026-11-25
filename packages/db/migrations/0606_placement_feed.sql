-- Comms lane (contract C-1, C-2), numbered after the work lane's 0500: a new placement reaches the person's feed.
--
-- Legacy wrote candidate notification type 1 (assignment) when a placement was saved
-- (CandidateWorkHistory::afterSave). Its type 2 (unassigned) was commented out in legacy, so it
-- is not ported. Here the work lane writes an `assignment.created` row in `work_events` in the
-- same transaction as each placement (migration 0500), and the email delivery job dispatches
-- each such row once: a feed item `work.assigned` for the placed person, rendered at read time
-- from the placement as it is then. Imported placements write no event, so they add no item.

-- One closed payload rule per kind: 0355's rules, plus the placement kind.
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
 (kind IN ('recruit.invitation.sent','recruit.invitation.accepted','recruit.invitation.declined','recruit.invitation.withdrawn',
   'recruit.interview.scheduled','recruit.interview.cancelled','recruit.application.shortlisted','recruit.application.rejected',
   'recruit.request_application.received','recruit.request_application.accepted','recruit.request_application.rejected')
  AND subject_reference ~ '^recruit_outbox:[1-9][0-9]{0,18}$'
  AND parameters='{}'::jsonb)
);

-- Which placement events this lane has dispatched. The work lane's event table is append-only,
-- so the mark lives here. Events written before this migration are marked done: they are not
-- news any more and must not flood the feed on the first run.
CREATE TABLE comms_dispatched_work_events (
 -- No foreign key: one would make a plain TRUNCATE of the work lane's append-only event table fail
 -- on the key before its own no-truncate guard speaks. Marks are only ever written for events read.
 event_id bigint PRIMARY KEY,
 dispatched_at timestamptz NOT NULL
);
INSERT INTO comms_dispatched_work_events(event_id, dispatched_at)
 SELECT id, clock_timestamp() FROM work_events WHERE kind = 'assignment.created';

-- The dispatcher's only read of work_events: placement events in id order. Without this index
-- every run would scan the whole event table, which is mostly work sessions.
CREATE INDEX work_events_assignment_created_idx ON work_events(id) WHERE kind = 'assignment.created';
