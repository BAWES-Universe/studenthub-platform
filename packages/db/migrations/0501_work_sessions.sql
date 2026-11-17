-- Work lane W-3 and W-7: a person clocks in and out; day totals are derived.
--
-- Legacy `candidate_working_hour` (candidate AccountController start/stop,
-- CandidateWorkingHourController add-hour) differs on purpose here:
-- - stop overwrote the start location with the stop coordinates (WK-F2): both
--   pairs are kept;
-- - the duration came from a BEFORE UPDATE trigger that never ran on insert, so
--   a manual row could store a negative or null total: the duration is a
--   generated column and end must not be before start;
-- - only the current store was checked for an open session: one open session
--   per person across every store, enforced by a unique index (two parallel
--   starts can't both win);
-- - discard and staff delete were hard deletes: rows are soft-deleted with who
--   and why, and can be restored;
-- - day totals lived on `candidate_working_date`, kept by after-save code and
--   two repair crons, with rejected time inside `total_time`: the totals are a
--   view over the sessions, split by status, so they can't drift.

CREATE TABLE work_sessions (
 id uuid PRIMARY KEY,
 assignment_id uuid NOT NULL REFERENCES work_assignments(id),
 person_principal_id text NOT NULL REFERENCES principals(id),
 org_id text NOT NULL REFERENCES organizations(id),
 store_id uuid NOT NULL REFERENCES organization_stores(id),
 -- Asia/Kuwait date of the start; a session that runs past midnight keeps it (legacy).
 work_date date NOT NULL,
 started_at timestamptz NOT NULL,
 ended_at timestamptz CHECK (ended_at IS NULL OR ended_at >= started_at),
 -- Whole seconds, truncated like legacy TIMESTAMPDIFF(SECOND, start, end).
 duration_seconds integer GENERATED ALWAYS AS (floor(extract(epoch FROM (ended_at - started_at)))::integer) STORED,
 start_latitude numeric(9,6) CHECK (start_latitude BETWEEN -90 AND 90),
 start_longitude numeric(9,6) CHECK (start_longitude BETWEEN -180 AND 180),
 end_latitude numeric(9,6) CHECK (end_latitude BETWEEN -90 AND 90),
 end_longitude numeric(9,6) CHECK (end_longitude BETWEEN -180 AND 180),
 source text NOT NULL CHECK (source IN ('timer','manual','correction','import')),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
 -- Shown to the approver (D-WK1): a late manual entry, or a missing location on an imported row.
 flags text[] NOT NULL DEFAULT '{}' CHECK (flags <@ ARRAY['late_entry','location_missing']::text[]),
 note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 1000)),
 -- A staff correction (W-6) is a new session that replaces this one in every total; the original is kept.
 corrects_session_id uuid REFERENCES work_sessions(id),
 deleted_at timestamptz,
 deleted_by text REFERENCES principals(id),
 delete_reason text CHECK (delete_reason IS NULL OR (delete_reason = btrim(delete_reason) AND char_length(delete_reason) BETWEEN 1 AND 500)),
 legacy_ref text UNIQUE CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'),
 created_by text REFERENCES principals(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((deleted_at IS NULL) = (delete_reason IS NULL)),
 CHECK ((source = 'import') = (legacy_ref IS NOT NULL)),
 CHECK (source = 'import' OR created_by IS NOT NULL),
 -- Timer sessions carry both locations once closed (D-WK1: location is required).
 CHECK (source <> 'timer' OR (start_latitude IS NOT NULL AND start_longitude IS NOT NULL
   AND (ended_at IS NULL OR (end_latitude IS NOT NULL AND end_longitude IS NOT NULL)))),
 CHECK ((start_latitude IS NULL) = (start_longitude IS NULL) AND (end_latitude IS NULL) = (end_longitude IS NULL)),
 CHECK ((source = 'correction') = (corrects_session_id IS NOT NULL)),
 CHECK (source IN ('timer') OR ended_at IS NOT NULL)
);
CREATE UNIQUE INDEX work_sessions_one_open ON work_sessions(person_principal_id) WHERE ended_at IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX work_sessions_one_live_correction ON work_sessions(corrects_session_id) WHERE corrects_session_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX work_sessions_person_date_idx ON work_sessions(person_principal_id, work_date, id);
CREATE INDEX work_sessions_store_date_idx ON work_sessions(store_id, work_date, id);
CREATE INDEX work_sessions_org_date_idx ON work_sessions(org_id, work_date, id);
CREATE INDEX work_sessions_assignment_idx ON work_sessions(assignment_id) WHERE ended_at IS NULL AND deleted_at IS NULL;

-- A session that is in force: not deleted and not replaced by a live correction.
CREATE FUNCTION work_session_in_force(session_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS (SELECT 1 FROM work_sessions c WHERE c.corrects_session_id = session_id AND c.deleted_at IS NULL)
$$;

CREATE FUNCTION enforce_work_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
 -- Checked here as well as by the column CHECK: this trigger builds time ranges before CHECKs run.
 IF NEW.ended_at IS NOT NULL AND NEW.ended_at < NEW.started_at THEN
  RAISE EXCEPTION 'work session ends before it starts' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.assignment_id <> OLD.assignment_id OR NEW.person_principal_id <> OLD.person_principal_id
     OR NEW.org_id <> OLD.org_id OR NEW.store_id <> OLD.store_id OR NEW.source <> OLD.source
     OR NEW.corrects_session_id IS DISTINCT FROM OLD.corrects_session_id OR NEW.legacy_ref IS DISTINCT FROM OLD.legacy_ref
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at) THEN
  RAISE EXCEPTION 'work session: identity fields are fixed' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' AND OLD.ended_at IS NOT NULL AND (NEW.started_at <> OLD.started_at OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
     OR NEW.work_date <> OLD.work_date OR NEW.start_latitude IS DISTINCT FROM OLD.start_latitude OR NEW.start_longitude IS DISTINCT FROM OLD.start_longitude
     OR NEW.end_latitude IS DISTINCT FROM OLD.end_latitude OR NEW.end_longitude IS DISTINCT FROM OLD.end_longitude) THEN
  RAISE EXCEPTION 'work session: a closed session is corrected by a new session, never edited' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' AND NEW.status <> OLD.status AND NEW.ended_at IS NULL THEN
  RAISE EXCEPTION 'work session: an open session cannot be decided' USING ERRCODE = '23514';
 END IF;
 -- FOR SHARE: a session insert and a placement end-date change serialize on the
 -- assignment row, so neither can commit a session outside the period.
 SELECT person_principal_id, org_id, store_id, start_date, end_date INTO a FROM work_assignments WHERE id = NEW.assignment_id FOR SHARE;
 IF a.person_principal_id <> NEW.person_principal_id OR a.org_id <> NEW.org_id OR a.store_id <> NEW.store_id THEN
  RAISE EXCEPTION 'work session does not match its assignment' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' AND NEW.source <> 'import' AND (NEW.work_date < a.start_date OR (a.end_date IS NOT NULL AND NEW.work_date > a.end_date)) THEN
  RAISE EXCEPTION 'work session is outside its assignment period' USING ERRCODE = '23514';
 END IF;
 -- No two sessions of a person in force over the same time (legacy manual add had no check).
 IF NEW.deleted_at IS NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('work_session:' || NEW.person_principal_id, 0));
  IF EXISTS (SELECT 1 FROM work_sessions s WHERE s.person_principal_id = NEW.person_principal_id AND s.id <> NEW.id
      AND s.deleted_at IS NULL AND s.id IS DISTINCT FROM NEW.corrects_session_id AND work_session_in_force(s.id)
      AND tstzrange(s.started_at, coalesce(s.ended_at, 'infinity'), '[)') && tstzrange(NEW.started_at, coalesce(NEW.ended_at, 'infinity'), '[)')) THEN
   RAISE EXCEPTION 'work session overlaps another session of this person' USING ERRCODE = '23P01';
  END IF;
 END IF;
 NEW.updated_at := clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER work_sessions_enforce BEFORE INSERT OR UPDATE ON work_sessions FOR EACH ROW EXECUTE FUNCTION enforce_work_session();
CREATE FUNCTION refuse_work_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'work sessions are soft-deleted, never removed' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER work_sessions_no_delete BEFORE DELETE ON work_sessions FOR EACH ROW EXECUTE FUNCTION refuse_work_session_delete();

-- W-7 day totals, derived on read from sessions in force. Approved, pending and
-- rejected time are separate (legacy summed them together); open sessions count
-- only in open_count.
CREATE VIEW work_day_totals AS
SELECT s.person_principal_id, s.assignment_id, s.org_id, s.store_id, s.work_date,
 min(s.started_at) AS first_started_at,
 max(s.ended_at) AS last_ended_at,
 coalesce(sum(s.duration_seconds) FILTER (WHERE s.status = 'approved'), 0)::bigint AS approved_seconds,
 coalesce(sum(s.duration_seconds) FILTER (WHERE s.status = 'pending' AND s.ended_at IS NOT NULL), 0)::bigint AS pending_seconds,
 coalesce(sum(s.duration_seconds) FILTER (WHERE s.status = 'rejected'), 0)::bigint AS rejected_seconds,
 count(*) FILTER (WHERE s.status = 'approved')::integer AS approved_count,
 count(*) FILTER (WHERE s.status = 'pending' AND s.ended_at IS NOT NULL)::integer AS pending_count,
 count(*) FILTER (WHERE s.status = 'rejected')::integer AS rejected_count,
 count(*) FILTER (WHERE s.ended_at IS NULL)::integer AS open_count
FROM work_sessions s
WHERE s.deleted_at IS NULL AND work_session_in_force(s.id)
GROUP BY s.person_principal_id, s.assignment_id, s.org_id, s.store_id, s.work_date;

ALTER TABLE work_events DROP CONSTRAINT work_events_kind_check, ADD CONSTRAINT work_events_kind_check CHECK (kind IN (
 'assignment.created','assignment.ended','assignment.extended',
 'assignment_request.created','assignment_request.accepted','assignment_request.rejected','assignment_request.cancelled',
 'session.started','session.stopped','session.discarded','session.added','session.deleted','session.restored'));
