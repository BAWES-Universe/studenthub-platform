-- Recruit R7: the job board, kept as legacy (decision SHU-207). Staff publish
-- jobs for a request; people apply once with an optional note; staff shortlist
-- or reject and the person hears through the recruit outbox. A draft or closed
-- job takes no application (the store checks it under the job's row lock).
-- Age and gender are information only. Jobs and applications are never deleted.
CREATE TABLE recruit_jobs (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES recruit_requests(id),
 area_id uuid REFERENCES catalogue_items(id),
 position text NOT NULL CHECK (char_length(position) BETWEEN 1 AND 255),
 position_ar text CHECK (position_ar IS NULL OR char_length(position_ar) BETWEEN 1 AND 255),
 description text CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 10000),
 description_ar text CHECK (description_ar IS NULL OR char_length(description_ar) BETWEEN 1 AND 10000),
 hours_per_day smallint CHECK (hours_per_day IS NULL OR hours_per_day BETWEEN 1 AND 24),
 days_per_week smallint CHECK (days_per_week IS NULL OR days_per_week BETWEEN 1 AND 7),
 compensation_type text CHECK (compensation_type IS NULL OR char_length(compensation_type) BETWEEN 1 AND 64),
 compensation_amount text CHECK (compensation_amount IS NULL OR char_length(compensation_amount) BETWEEN 1 AND 255),
 compensation_description text CHECK (compensation_description IS NULL OR char_length(compensation_description) BETWEEN 1 AND 2000),
 compensation_description_ar text CHECK (compensation_description_ar IS NULL OR char_length(compensation_description_ar) BETWEEN 1 AND 2000),
 min_age smallint CHECK (min_age IS NULL OR min_age BETWEEN 14 AND 99),
 max_age smallint CHECK (max_age IS NULL OR max_age BETWEEN 14 AND 99),
 gender text NOT NULL DEFAULT 'any' CHECK (gender IN ('any','male','female','other')),
 available_from date,
 available_to date,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
 skills text[] NOT NULL DEFAULT '{}' CHECK (cardinality(skills) <= 30),
 created_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 updated_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 legacy_job_uuid text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age),
 CHECK (available_from IS NULL OR available_to IS NULL OR available_from <= available_to)
);
CREATE INDEX recruit_jobs_board_idx ON recruit_jobs(created_at DESC, id) WHERE status = 'active';
CREATE INDEX recruit_jobs_request_idx ON recruit_jobs(request_id, created_at DESC);

CREATE TABLE recruit_job_applications (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES recruit_jobs(id),
 person_principal_id text NOT NULL REFERENCES principals(id),
 status text NOT NULL DEFAULT 'interested' CHECK (status IN ('interested','shortlisted','rejected')),
 note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
 decided_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 legacy_job_interest_uuid text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 decided_at timestamptz,
 UNIQUE (job_id, person_principal_id),
 CHECK ((status = 'interested') = (decided_at IS NULL))
);
CREATE INDEX recruit_job_applications_person_idx ON recruit_job_applications(person_principal_id, created_at DESC, id);

CREATE FUNCTION enforce_recruit_job_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'applications are kept' USING ERRCODE = '23514'; END IF;
 IF ROW(NEW.job_id, NEW.person_principal_id, NEW.note, NEW.created_at) IS DISTINCT FROM ROW(OLD.job_id, OLD.person_principal_id, OLD.note, OLD.created_at) THEN
  RAISE EXCEPTION 'an application keeps its job, person and note' USING ERRCODE = '23514';
 END IF;
 IF NEW.status <> OLD.status AND NOT (OLD.status, NEW.status) IN (('interested','shortlisted'),('interested','rejected'),('shortlisted','rejected')) THEN
  RAISE EXCEPTION 'application % to % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruit_job_applications_rules BEFORE UPDATE OR DELETE ON recruit_job_applications FOR EACH ROW EXECUTE FUNCTION enforce_recruit_job_application();
CREATE FUNCTION refuse_recruit_job_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'jobs are kept; close them instead' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER recruit_jobs_no_delete BEFORE DELETE ON recruit_jobs FOR EACH ROW EXECUTE FUNCTION refuse_recruit_job_delete();

ALTER TABLE recruit_outbox DROP CONSTRAINT recruit_outbox_kind_check;
ALTER TABLE recruit_outbox ADD CONSTRAINT recruit_outbox_kind_check CHECK (kind IN (
 'invitation.sent','invitation.accepted','invitation.declined','invitation.withdrawn','interview.scheduled','interview.cancelled','application.shortlisted','application.rejected'));
