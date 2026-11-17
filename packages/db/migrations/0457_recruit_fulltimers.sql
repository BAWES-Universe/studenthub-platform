-- Recruit R9: the full-timer track, kept by the legacy-benchmark rule (legacy
-- Fulltimer, FulltimerTags, FulltimerSkill, FulltimerExperience). Staff keep
-- records of people looking for full-time work who have no StudentHub account,
-- and suggest them to requests on the same pipeline as people with an account:
-- a card holds exactly one of a person or a full-timer. Salary and contact
-- fields are read by operator staff only. A full-timer is archived, never
-- deleted, because cards and notes refer to it.
CREATE TABLE recruit_fulltimers (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
 name_key text NOT NULL,
 phone text CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{6,20}$'),
 email text CHECK (email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+$')),
 nationality_id uuid REFERENCES catalogue_items(id),
 country_id uuid REFERENCES catalogue_items(id),
 area_id uuid REFERENCES catalogue_items(id),
 university_id uuid REFERENCES catalogue_items(id),
 latitude numeric(9,6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
 longitude numeric(9,6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
 gender text CHECK (gender IS NULL OR gender IN ('male','female','other')),
 birth_date date,
 employed boolean,
 driving_licence boolean,
 current_salary text CHECK (current_salary IS NULL OR char_length(current_salary) BETWEEN 1 AND 64),
 expected_salary text CHECK (expected_salary IS NULL OR char_length(expected_salary) BETWEEN 1 AND 64),
 currency_code char(3) NOT NULL DEFAULT 'KWD' CHECK (currency_code ~ '^[A-Z]{3}$'),
 tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 30),
 skills text[] NOT NULL DEFAULT '{}' CHECK (cardinality(skills) <= 50),
 experience text[] NOT NULL DEFAULT '{}' CHECK (cardinality(experience) <= 30),
 legacy_cv_reference text CHECK (legacy_cv_reference IS NULL OR char_length(legacy_cv_reference) BETWEEN 1 AND 1024),
 archived_at timestamptz,
 created_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 updated_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 legacy_fulltimer_uuid text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Legacy refused a second full-timer with the same name or phone; archived records keep theirs.
CREATE UNIQUE INDEX recruit_fulltimers_name_key ON recruit_fulltimers(name_key) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX recruit_fulltimers_phone_key ON recruit_fulltimers(phone) WHERE archived_at IS NULL AND phone IS NOT NULL;
CREATE INDEX recruit_fulltimers_list_idx ON recruit_fulltimers(currency_code, created_at DESC, id) WHERE archived_at IS NULL;
CREATE FUNCTION refuse_recruit_fulltimer_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'full-timers are archived, never deleted' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER recruit_fulltimers_no_delete BEFORE DELETE ON recruit_fulltimers FOR EACH ROW EXECUTE FUNCTION refuse_recruit_fulltimer_delete();

ALTER TABLE recruit_pipeline_cards ALTER COLUMN person_principal_id DROP NOT NULL;
ALTER TABLE recruit_pipeline_cards ADD COLUMN fulltimer_id uuid REFERENCES recruit_fulltimers(id);
ALTER TABLE recruit_pipeline_cards ADD CONSTRAINT recruit_pipeline_cards_one_subject CHECK (num_nonnulls(person_principal_id, fulltimer_id) = 1);
-- A full-timer is never placed into a work assignment (they have no account to pay); "placed" records the hire.
ALTER TABLE recruit_pipeline_cards ADD CONSTRAINT recruit_pipeline_cards_fulltimer_unassigned CHECK (fulltimer_id IS NULL OR assignment_id IS NULL);
CREATE UNIQUE INDEX recruit_pipeline_cards_fulltimer_key ON recruit_pipeline_cards(request_id, fulltimer_id) WHERE fulltimer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_recruit_pipeline_card() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.person_principal_id IS DISTINCT FROM OLD.person_principal_id OR NEW.fulltimer_id IS DISTINCT FROM OLD.fulltimer_id THEN
  RAISE EXCEPTION 'pipeline card cannot move request or person' USING ERRCODE = '23514';
 END IF;
 IF NEW.stage <> OLD.stage AND NOT (OLD.stage, NEW.stage) IN (
  ('suggested','contacted'),('suggested','withdrawn'),('contacted','interviewing'),('contacted','offered'),('contacted','withdrawn'),
  ('interviewing','offered'),('interviewing','withdrawn'),('offered','placed'),('offered','withdrawn')) THEN
  RAISE EXCEPTION 'pipeline move % to % is not allowed', OLD.stage, NEW.stage USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
