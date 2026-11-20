-- Work lane: legacy staff time and stand-up import (M-5, importer lane orchestrates).
--
-- Like 0504 for candidate hours: every imported row keeps the digest of what
-- was imported, so a re-run with the same row writes nothing and a changed row
-- is reported with both digests, never overwritten. The one exception is a
-- staff session legacy still showed open that legacy has since ended
-- (incremental sync): the end is written once, as the timer would.

ALTER TABLE work_staff_sessions ADD COLUMN legacy_digest text CHECK (legacy_digest IS NULL OR legacy_digest ~ '^[0-9a-f]{64}$'),
 ADD CONSTRAINT work_staff_sessions_legacy_digest CHECK ((legacy_digest IS NULL) = (legacy_ref IS NULL));
ALTER TABLE work_standup_questions ADD COLUMN legacy_digest text CHECK (legacy_digest IS NULL OR legacy_digest ~ '^[0-9a-f]{64}$'),
 ADD CONSTRAINT work_standup_questions_legacy_digest CHECK ((legacy_digest IS NULL) = (legacy_ref IS NULL));
ALTER TABLE work_standup_answers ADD COLUMN legacy_digest text CHECK (legacy_digest IS NULL OR legacy_digest ~ '^[0-9a-f]{64}$'),
 ADD CONSTRAINT work_standup_answers_legacy_digest CHECK ((legacy_digest IS NULL) = (legacy_ref IS NULL));

-- The import key of a staff session or question is fixed once written.
CREATE OR REPLACE FUNCTION enforce_work_staff_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.ended_at IS NOT NULL AND NEW.ended_at < NEW.started_at THEN
  RAISE EXCEPTION 'staff session ends before it starts' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.staff_principal_id <> OLD.staff_principal_id OR NEW.work_date <> OLD.work_date
     OR NEW.started_at <> OLD.started_at OR NEW.source <> OLD.source OR NEW.legacy_ref IS DISTINCT FROM OLD.legacy_ref
     OR NEW.legacy_digest IS DISTINCT FROM OLD.legacy_digest OR NEW.created_at <> OLD.created_at) THEN
  RAISE EXCEPTION 'staff session: only the end is written, once' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' AND OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
  RAISE EXCEPTION 'staff session: a closed session is never edited' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION refuse_work_standup_question_key_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.legacy_ref IS DISTINCT FROM OLD.legacy_ref OR NEW.legacy_digest IS DISTINCT FROM OLD.legacy_digest THEN
  RAISE EXCEPTION 'stand-up question: the import key is never changed' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_standup_questions_import_key BEFORE UPDATE ON work_standup_questions FOR EACH ROW EXECUTE FUNCTION refuse_work_standup_question_key_change();
