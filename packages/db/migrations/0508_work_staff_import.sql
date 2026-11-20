-- Work lane: legacy staff time and stand-up import (M-5, importer lane orchestrates).
--
-- Like 0504 for candidate hours: every imported row keeps the digest of what
-- was imported, so a re-run with the same row writes nothing and a changed row
-- is reported with both digests, never overwritten. The one exception is a
-- staff session legacy still showed open that legacy has since ended
-- (incremental sync): the end is written once, as the timer would.

ALTER TABLE work_staff_sessions ADD COLUMN legacy_digest text CHECK (legacy_digest IS NULL OR legacy_digest ~ '^[0-9a-f]{64}$'),
 ADD CONSTRAINT work_staff_sessions_legacy_digest CHECK (legacy_digest IS NULL OR legacy_ref IS NOT NULL);
ALTER TABLE work_standup_questions ADD COLUMN legacy_digest text CHECK (legacy_digest IS NULL OR legacy_digest ~ '^[0-9a-f]{64}$'),
 ADD CONSTRAINT work_standup_questions_legacy_digest CHECK (legacy_digest IS NULL OR legacy_ref IS NOT NULL);
ALTER TABLE work_standup_answers ADD COLUMN legacy_digest text CHECK (legacy_digest IS NULL OR legacy_digest ~ '^[0-9a-f]{64}$'),
 ADD CONSTRAINT work_standup_answers_legacy_digest CHECK (legacy_digest IS NULL OR legacy_ref IS NOT NULL);

-- Rows 0505/0506 already allowed with a legacy_ref were written with no record
-- of what was imported. Their digest is unknown and stays NULL: nothing is
-- made up for them, they keep working as before (a timer can still end an
-- open one), and the importer holds each one as `unknown_digest` instead of
-- comparing or overwriting it. Every row imported from here on must carry its
-- digest, so the rule is checked when a row is inserted, not on old rows.
CREATE FUNCTION require_work_import_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.legacy_ref IS NOT NULL AND NEW.legacy_digest IS NULL THEN
  RAISE EXCEPTION '%: an imported row carries its digest', TG_TABLE_NAME USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_staff_sessions_import_digest BEFORE INSERT ON work_staff_sessions FOR EACH ROW EXECUTE FUNCTION require_work_import_digest();
CREATE TRIGGER work_standup_questions_import_digest BEFORE INSERT ON work_standup_questions FOR EACH ROW EXECUTE FUNCTION require_work_import_digest();
CREATE TRIGGER work_standup_answers_import_digest BEFORE INSERT ON work_standup_answers FOR EACH ROW EXECUTE FUNCTION require_work_import_digest();

-- The import key of a staff session or question is fixed once written (an
-- unknown digest stays unknown).
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
