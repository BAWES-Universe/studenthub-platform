-- Work lane W-4: the employer approves or rejects hours.
--
-- Legacy `candidate_work_log_feedback` (company CandidateWorkLogFeedbackController
-- save, bulk-save, undo) differs on purpose here:
-- - save and bulk-save never checked that the sessions belonged to the caller's
--   company: every decision is scoped to the decider's company, stores or
--   managed stores (service rule, store-checked again in the transaction);
-- - a day decision rewrote every closed session, earlier decisions included:
--   a day decision changes pending sessions only;
-- - undo had no record and kept the old decision link: undo writes its own
--   decision row and the session points at it;
-- - rating had no range: 1 to 5.
-- Ratings stay as legacy (D-WK2: visible to other employers in search).
-- Decision rows are append-only; the session carries its latest decision.

CREATE TABLE work_decisions (
 id uuid PRIMARY KEY,
 org_id text NOT NULL REFERENCES organizations(id),
 store_id uuid NOT NULL REFERENCES organization_stores(id),
 person_principal_id text NOT NULL REFERENCES principals(id),
 work_date date NOT NULL,
 scope text NOT NULL CHECK (scope IN ('session','day')),
 outcome text NOT NULL CHECK (outcome IN ('approved','rejected','undone')),
 -- The sessions this decision changed (a day decision may change none if all were decided already).
 session_ids uuid[] NOT NULL,
 reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 255)),
 note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 2000)),
 rating smallint CHECK (rating BETWEEN 1 AND 5),
 -- Legacy `is_public`: the note is shown to the person only when true.
 note_public boolean NOT NULL DEFAULT false,
 batch_id uuid,
 decided_by text NOT NULL REFERENCES principals(id),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (outcome <> 'undone' OR (scope = 'session' AND rating IS NULL))
);
CREATE INDEX work_decisions_person_idx ON work_decisions(person_principal_id, work_date);
CREATE INDEX work_decisions_store_idx ON work_decisions(store_id, work_date);
CREATE INDEX work_decisions_sessions_idx ON work_decisions USING gin(session_ids);
CREATE FUNCTION refuse_work_decision_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'work decisions are append-only' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER work_decisions_append_only BEFORE UPDATE OR DELETE ON work_decisions FOR EACH ROW EXECUTE FUNCTION refuse_work_decision_change();

ALTER TABLE work_sessions ADD COLUMN decision_id uuid REFERENCES work_decisions(id);
-- When status or existence last changed; the pay seam reports it so work changed after a pay run is found.
ALTER TABLE work_sessions ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE FUNCTION touch_work_session_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
  NEW.status_changed_at := clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_sessions_touch_status BEFORE UPDATE ON work_sessions FOR EACH ROW EXECUTE FUNCTION touch_work_session_status();

-- A decision link must name a decision about this session.
CREATE FUNCTION enforce_work_session_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.decision_id IS NOT NULL AND NEW.decision_id IS DISTINCT FROM OLD.decision_id
    AND NOT EXISTS (SELECT 1 FROM work_decisions d WHERE d.id = NEW.decision_id AND NEW.id = ANY(d.session_ids)) THEN
  RAISE EXCEPTION 'work session decision does not name this session' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_sessions_decision_link BEFORE UPDATE ON work_sessions FOR EACH ROW EXECUTE FUNCTION enforce_work_session_decision();

ALTER TABLE work_events DROP CONSTRAINT work_events_kind_check, ADD CONSTRAINT work_events_kind_check CHECK (kind IN (
 'assignment.created','assignment.ended','assignment.extended',
 'assignment_request.created','assignment_request.accepted','assignment_request.rejected','assignment_request.cancelled',
 'session.started','session.stopped','session.discarded','session.added','session.deleted','session.restored',
 'session.approved','session.rejected','session.undone'));
