-- Work lane: work history can't be emptied by TRUNCATE.
--
-- Placements, sessions, decisions, appeals, appeal updates, staff time and the
-- work event log already refuse DELETE (and the logs refuse UPDATE) row by row.
-- Row triggers don't fire on TRUNCATE, so a TRUNCATE of any of these tables, or
-- a TRUNCATE ... CASCADE from a parent such as principals or organizations,
-- would still have wiped them. A statement trigger on each table refuses that.
-- Test fixtures that reset through principals go through resetPayAwareFixture,
-- which lifts these guards inside its own transaction only.

CREATE FUNCTION refuse_work_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'work history is append-only and never removed (TRUNCATE on %)', TG_TABLE_NAME USING ERRCODE = '23514'; END $$;

CREATE TRIGGER work_assignments_no_truncate BEFORE TRUNCATE ON work_assignments FOR EACH STATEMENT EXECUTE FUNCTION refuse_work_truncate();
CREATE TRIGGER work_events_no_truncate BEFORE TRUNCATE ON work_events FOR EACH STATEMENT EXECUTE FUNCTION refuse_work_truncate();
CREATE TRIGGER work_sessions_no_truncate BEFORE TRUNCATE ON work_sessions FOR EACH STATEMENT EXECUTE FUNCTION refuse_work_truncate();
CREATE TRIGGER work_decisions_no_truncate BEFORE TRUNCATE ON work_decisions FOR EACH STATEMENT EXECUTE FUNCTION refuse_work_truncate();
CREATE TRIGGER work_appeals_no_truncate BEFORE TRUNCATE ON work_appeals FOR EACH STATEMENT EXECUTE FUNCTION refuse_work_truncate();
CREATE TRIGGER work_appeal_updates_no_truncate BEFORE TRUNCATE ON work_appeal_updates FOR EACH STATEMENT EXECUTE FUNCTION refuse_work_truncate();
CREATE TRIGGER work_staff_sessions_no_truncate BEFORE TRUNCATE ON work_staff_sessions FOR EACH STATEMENT EXECUTE FUNCTION refuse_work_truncate();
