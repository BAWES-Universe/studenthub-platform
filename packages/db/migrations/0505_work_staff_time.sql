-- Work lane: internal staff time (legacy `staff_work_session`, the staff app's
-- start and end session on the daily stand-up screen, and the admin list,
-- inactive list and Excel download). Hours are hours: StudentHub's own staff
-- clock in and out here, apart from the hours candidates work at companies.
--
-- Differences from legacy, on purpose:
-- - legacy stored only the minutes, written at end from the app server's
--   clock, and `created_at` as the start: start and end are both kept and the
--   minutes are derived from them, so they can't disagree;
-- - legacy's open session was "today's row with no minutes", so a session left
--   open on an earlier day stayed open for ever and its minutes were empty:
--   here too an earlier day's open session is never ended for the staff member
--   (the export shows it blank, or the staff record's hours per day once that
--   port is wired, as legacy did);
-- - two parallel starts could both insert: one open session per staff member
--   and day is enforced by a unique index;
-- - rows were plain updates and deletes: a closed session is never edited and
--   no row is removed.

CREATE TABLE work_staff_sessions (
 id uuid PRIMARY KEY,
 staff_principal_id text NOT NULL REFERENCES principals(id),
 -- Asia/Kuwait date of the start; a session that runs past midnight keeps it (legacy grouped by DATE(created_at)).
 work_date date NOT NULL,
 started_at timestamptz NOT NULL,
 ended_at timestamptz CHECK (ended_at IS NULL OR ended_at >= started_at),
 -- Whole minutes, truncated like legacy's (int)((end - start) / 60).
 minutes integer GENERATED ALWAYS AS (floor(extract(epoch FROM (ended_at - started_at)) / 60)::integer) STORED,
 source text NOT NULL CHECK (source IN ('timer','import')),
 legacy_ref text UNIQUE CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((source = 'import') = (legacy_ref IS NOT NULL))
);
CREATE UNIQUE INDEX work_staff_sessions_one_open ON work_staff_sessions(staff_principal_id, work_date) WHERE ended_at IS NULL;
CREATE INDEX work_staff_sessions_date_idx ON work_staff_sessions(work_date, staff_principal_id, id);

CREATE FUNCTION enforce_work_staff_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.ended_at IS NOT NULL AND NEW.ended_at < NEW.started_at THEN
  RAISE EXCEPTION 'staff session ends before it starts' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.staff_principal_id <> OLD.staff_principal_id OR NEW.work_date <> OLD.work_date
     OR NEW.started_at <> OLD.started_at OR NEW.source <> OLD.source OR NEW.legacy_ref IS DISTINCT FROM OLD.legacy_ref OR NEW.created_at <> OLD.created_at) THEN
  RAISE EXCEPTION 'staff session: only the end is written, once' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' AND OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
  RAISE EXCEPTION 'staff session: a closed session is never edited' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_staff_sessions_enforce BEFORE INSERT OR UPDATE ON work_staff_sessions FOR EACH ROW EXECUTE FUNCTION enforce_work_staff_session();
CREATE FUNCTION refuse_work_staff_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'staff sessions are never removed' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER work_staff_sessions_no_delete BEFORE DELETE ON work_staff_sessions FOR EACH ROW EXECUTE FUNCTION refuse_work_staff_session_delete();
