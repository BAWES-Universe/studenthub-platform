-- Recruit R6: interviews and versioned evaluations (legacy RequestInterview,
-- InterviewEvaluation, CandidateEvaluation). An interview belongs to a pipeline
-- card; it is scheduled, then completed by its first evaluation, or cancelled.
-- Evaluations are append-only versions: a correction adds a version, the latest
-- one is current. The internal note is for operator staff only (the store keeps
-- it out of every other view). Scheduling and cancelling write outbox rows.
CREATE TABLE recruit_interviews (
 id uuid PRIMARY KEY,
 card_id uuid NOT NULL REFERENCES recruit_pipeline_cards(id),
 scheduled_at timestamptz NOT NULL,
 duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
 mode text NOT NULL CHECK (mode IN ('in_person','phone','video')),
 location text CHECK (location IS NULL OR char_length(location) BETWEEN 1 AND 500),
 status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
 scheduled_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 legacy_interview_id bigint UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 closed_at timestamptz,
 closed_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 CHECK ((status = 'scheduled') = (closed_at IS NULL))
);
CREATE INDEX recruit_interviews_card_idx ON recruit_interviews(card_id, scheduled_at, id);

CREATE FUNCTION enforce_recruit_interview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'interviews are kept' USING ERRCODE = '23514'; END IF;
 IF ROW(NEW.card_id, NEW.scheduled_at, NEW.duration_minutes, NEW.mode, NEW.location, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.card_id, OLD.scheduled_at, OLD.duration_minutes, OLD.mode, OLD.location, OLD.created_at)
    OR (NEW.scheduled_by_principal_id IS NOT NULL AND NEW.scheduled_by_principal_id IS DISTINCT FROM OLD.scheduled_by_principal_id) THEN
  RAISE EXCEPTION 'a scheduled interview is not rewritten; cancel it and schedule another' USING ERRCODE = '23514';
 END IF;
 IF NEW.status <> OLD.status AND NOT (OLD.status = 'scheduled' AND NEW.status IN ('completed','cancelled')) THEN
  RAISE EXCEPTION 'interview % to % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruit_interviews_rules BEFORE UPDATE OR DELETE ON recruit_interviews FOR EACH ROW EXECUTE FUNCTION enforce_recruit_interview();

CREATE TABLE recruit_interview_evaluations (
 id uuid PRIMARY KEY,
 interview_id uuid NOT NULL REFERENCES recruit_interviews(id),
 version integer NOT NULL CHECK (version >= 1),
 outcome text NOT NULL CHECK (outcome IN ('passed','not_passed','no_show')),
 rating smallint CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
 shared_note text CHECK (shared_note IS NULL OR char_length(shared_note) BETWEEN 1 AND 5000),
 internal_note text CHECK (internal_note IS NULL OR char_length(internal_note) BETWEEN 1 AND 5000),
 evaluated_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 legacy_evaluation_id bigint UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (interview_id, version),
 CHECK (outcome <> 'no_show' OR rating IS NULL)
);
CREATE FUNCTION refuse_recruit_evaluation_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND NEW.evaluated_by_principal_id IS NULL AND OLD.evaluated_by_principal_id IS NOT NULL
   AND ROW(NEW.id, NEW.interview_id, NEW.version, NEW.outcome, NEW.rating, NEW.shared_note, NEW.internal_note, NEW.legacy_evaluation_id, NEW.created_at)
   IS NOT DISTINCT FROM ROW(OLD.id, OLD.interview_id, OLD.version, OLD.outcome, OLD.rating, OLD.shared_note, OLD.internal_note, OLD.legacy_evaluation_id, OLD.created_at) THEN
  RETURN NEW; -- a deleted evaluator is forgotten, nothing else moves
 END IF;
 RAISE EXCEPTION 'evaluations are versioned, never changed' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER recruit_interview_evaluations_append_only BEFORE UPDATE OR DELETE ON recruit_interview_evaluations FOR EACH ROW EXECUTE FUNCTION refuse_recruit_evaluation_change();

ALTER TABLE recruit_outbox DROP CONSTRAINT recruit_outbox_kind_check;
ALTER TABLE recruit_outbox ADD CONSTRAINT recruit_outbox_kind_check CHECK (kind IN (
 'invitation.sent','invitation.accepted','invitation.declined','invitation.withdrawn','interview.scheduled','interview.cancelled'));
