-- Work lane: the daily stand-up (legacy `daily_standup_question` and
-- `daily_standup_answer`; the staff app asked the next unanswered question while
-- the day was in progress, and the admin app kept the questions and read the
-- answers by staff member and date).
--
-- Differences from legacy, on purpose:
-- - a question was deleted outright: here it is retired, so old answers keep
--   pointing at it, and it is no longer asked;
-- - legacy ordered nothing, so the "next" question was whichever MySQL found
--   first: here questions are asked in the order they were added;
-- - an answer's day was DATE(created_at) on the server's clock: here it is the
--   Asia/Kuwait date, kept on the row;
-- - nothing stopped a second answer to the same question on the same day: one
--   answer per staff member, question and day is enforced by a unique index;
-- - answers were plain rows: an answer is never edited or removed, and neither
--   table can be emptied with TRUNCATE (directly or by a CASCADE from a parent).

CREATE TABLE work_standup_questions (
 id uuid PRIMARY KEY,
 question text NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 255 AND question = btrim(question)),
 created_by text REFERENCES principals(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 retired_at timestamptz,
 legacy_ref text UNIQUE CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$')
);
CREATE INDEX work_standup_questions_order_idx ON work_standup_questions(created_at, id) WHERE retired_at IS NULL;

CREATE TABLE work_standup_answers (
 id uuid PRIMARY KEY,
 staff_principal_id text NOT NULL REFERENCES principals(id),
 question_id uuid NOT NULL REFERENCES work_standup_questions(id),
 -- The question as it read when answered (legacy kept a copy too), so a later edit doesn't change what was answered.
 question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 255),
 answer text NOT NULL CHECK (char_length(btrim(answer)) BETWEEN 1 AND 4000),
 -- Asia/Kuwait date of the answer.
 work_date date NOT NULL,
 source text NOT NULL CHECK (source IN ('app','import')),
 legacy_ref text UNIQUE CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'),
 -- Milliseconds, so the page cursor (an ISO time) matches the stored value exactly.
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
 CHECK ((source = 'import') = (legacy_ref IS NOT NULL))
);
-- Imported legacy rows may repeat a question on a day (legacy allowed it); answers given here may not.
CREATE UNIQUE INDEX work_standup_answers_once ON work_standup_answers(staff_principal_id, question_id, work_date) WHERE source = 'app';
CREATE INDEX work_standup_answers_day_idx ON work_standup_answers(work_date, staff_principal_id, created_at, id);

CREATE FUNCTION refuse_work_standup_answer_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'stand-up answers are never edited or removed' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER work_standup_answers_frozen BEFORE UPDATE OR DELETE ON work_standup_answers FOR EACH ROW EXECUTE FUNCTION refuse_work_standup_answer_change();
CREATE FUNCTION refuse_work_standup_question_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'stand-up questions are retired, never removed' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER work_standup_questions_no_delete BEFORE DELETE ON work_standup_questions FOR EACH ROW EXECUTE FUNCTION refuse_work_standup_question_delete();
CREATE FUNCTION refuse_work_standup_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'stand-up questions and answers are append-only and never removed' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER work_standup_answers_no_truncate BEFORE TRUNCATE ON work_standup_answers FOR EACH STATEMENT EXECUTE FUNCTION refuse_work_standup_truncate();
CREATE TRIGGER work_standup_questions_no_truncate BEFORE TRUNCATE ON work_standup_questions FOR EACH STATEMENT EXECUTE FUNCTION refuse_work_standup_truncate();
