-- Work lane W-6: a person appeals hours; staff answer and correct them (D-WK3).
--
-- Legacy `candidate_working_hour_appeal`, `..._appeal_updates` and staff
-- CandidateWorkingHourController add-hour, with these fixes:
-- - a person could appeal any session id, not only their own: the appeal must
--   name a session of the appellant;
-- - marking an update read had no owner check: only the appellant marks read;
-- - a staff correction was an extra approved row beside the original, so both
--   counted: a correction replaces its original in every total (the original is
--   kept), and adding missing time is a separate, explicit staff entry;
-- - status could be set to any integer: four named states.
-- Staff correct approved hours without re-approval; a reason is required and
-- every correction is recorded as an approval decision by the staff member.

CREATE TABLE work_appeals (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES work_sessions(id),
 person_principal_id text NOT NULL REFERENCES principals(id),
 org_id text NOT NULL REFERENCES organizations(id),
 store_id uuid NOT NULL REFERENCES organization_stores(id),
 reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 2000),
 status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','awaiting_review','in_progress','resolved')),
 legacy_ref text UNIQUE CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX work_appeals_person_idx ON work_appeals(person_principal_id, created_at DESC, id);
CREATE INDEX work_appeals_status_idx ON work_appeals(status, created_at DESC, id);
CREATE INDEX work_appeals_session_idx ON work_appeals(session_id);

CREATE FUNCTION enforce_work_appeal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF NEW.id <> OLD.id OR NEW.session_id <> OLD.session_id OR NEW.person_principal_id <> OLD.person_principal_id OR NEW.org_id <> OLD.org_id
     OR NEW.store_id <> OLD.store_id OR NEW.reason <> OLD.reason OR NEW.legacy_ref IS DISTINCT FROM OLD.legacy_ref OR NEW.created_at <> OLD.created_at THEN
   RAISE EXCEPTION 'work appeal: only the status changes' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
 END IF;
 SELECT person_principal_id, org_id, store_id INTO s FROM work_sessions WHERE id = NEW.session_id;
 IF s.person_principal_id <> NEW.person_principal_id OR s.org_id <> NEW.org_id OR s.store_id <> NEW.store_id THEN
  RAISE EXCEPTION 'work appeal must name a session of the appellant' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_appeals_enforce BEFORE INSERT OR UPDATE ON work_appeals FOR EACH ROW EXECUTE FUNCTION enforce_work_appeal();

CREATE TABLE work_appeal_updates (
 id uuid PRIMARY KEY,
 appeal_id uuid NOT NULL REFERENCES work_appeals(id),
 title text CHECK (title IS NULL OR (title = btrim(title) AND char_length(title) BETWEEN 1 AND 255)),
 detail text NOT NULL CHECK (detail = btrim(detail) AND char_length(detail) BETWEEN 1 AND 5000),
 author_principal_id text REFERENCES principals(id),
 legacy_ref text UNIQUE CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 read_at timestamptz,
 CHECK (author_principal_id IS NOT NULL OR legacy_ref IS NOT NULL)
);
CREATE INDEX work_appeal_updates_appeal_idx ON work_appeal_updates(appeal_id, created_at, id);

-- Updates are append-only; the appellant marking one read is the only change.
CREATE FUNCTION enforce_work_appeal_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' OR NEW.id <> OLD.id OR NEW.appeal_id <> OLD.appeal_id OR NEW.title IS DISTINCT FROM OLD.title OR NEW.detail <> OLD.detail
    OR NEW.author_principal_id IS DISTINCT FROM OLD.author_principal_id OR NEW.legacy_ref IS DISTINCT FROM OLD.legacy_ref
    OR NEW.created_at <> OLD.created_at OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
  RAISE EXCEPTION 'work appeal updates are append-only' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_appeal_updates_append_only BEFORE UPDATE OR DELETE ON work_appeal_updates FOR EACH ROW EXECUTE FUNCTION enforce_work_appeal_update();
CREATE FUNCTION refuse_work_appeal_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'work appeals are never removed' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER work_appeals_no_delete BEFORE DELETE ON work_appeals FOR EACH ROW EXECUTE FUNCTION refuse_work_appeal_delete();

-- A staff entry made while answering an appeal (a correction, or missing time) names it.
ALTER TABLE work_sessions ADD COLUMN appeal_id uuid REFERENCES work_appeals(id),
 ADD CONSTRAINT work_sessions_appeal_source CHECK (appeal_id IS NULL OR source IN ('manual','correction'));
CREATE INDEX work_sessions_appeal_idx ON work_sessions(appeal_id) WHERE appeal_id IS NOT NULL;
CREATE FUNCTION fix_work_session_appeal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.appeal_id IS DISTINCT FROM OLD.appeal_id THEN
  RAISE EXCEPTION 'work session: identity fields are fixed' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_sessions_fixed_appeal BEFORE UPDATE ON work_sessions FOR EACH ROW EXECUTE FUNCTION fix_work_session_appeal();

ALTER TABLE work_events DROP CONSTRAINT work_events_kind_check, ADD CONSTRAINT work_events_kind_check CHECK (kind IN (
 'assignment.created','assignment.ended','assignment.extended',
 'assignment_request.created','assignment_request.accepted','assignment_request.rejected','assignment_request.cancelled',
 'session.started','session.stopped','session.discarded','session.added','session.deleted','session.restored',
 'session.approved','session.rejected','session.undone','session.corrected',
 'appeal.raised','appeal.updated','appeal.status_changed'));
