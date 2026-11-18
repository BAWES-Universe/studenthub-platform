-- Access lane A7: a company signs up and StudentHub staff approve it.
--
-- One row per "Register a company" submission (the legacy CompanyRequest
-- fields). A row is pending until operator staff approve or reject it with a
-- reason; approval records the organization it created. A person has at most
-- one pending registration. A decided row never changes again.
--
-- Deleting a person deletes their registrations by cascade, decided or not
-- (the row holds their contact details); the guard below runs only for a
-- direct change. A company an approval created, and its audit rows, stay.

CREATE TABLE company_registrations (
  id                     UUID PRIMARY KEY,
  submitter_principal_id TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  company_name           TEXT NOT NULL CHECK (char_length(company_name) BETWEEN 2 AND 255),
  contact_name           TEXT NOT NULL CHECK (char_length(contact_name) BETWEEN 2 AND 120),
  contact_position       TEXT NOT NULL CHECK (char_length(contact_position) <= 120),
  phone_number           TEXT NOT NULL CHECK (char_length(phone_number) BETWEEN 6 AND 24),
  company_email          TEXT NOT NULL CHECK (char_length(company_email) BETWEEN 3 AND 254),
  requesting_for         TEXT NOT NULL CHECK (char_length(requesting_for) <= 255),
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reviewed_by            TEXT,
  reviewed_at            TIMESTAMPTZ,
  review_reason          TEXT CHECK (review_reason IS NULL OR char_length(btrim(review_reason)) BETWEEN 3 AND 500),
  org_id                 TEXT REFERENCES organizations (id),
  CHECK (CASE WHEN status = 'pending' THEN reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL
              ELSE reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL END),
  CHECK ((status = 'approved') = (org_id IS NOT NULL)),
  CHECK (reviewed_by IS NULL OR reviewed_by <> submitter_principal_id)
);
CREATE UNIQUE INDEX company_registrations_one_pending_idx
  ON company_registrations (submitter_principal_id) WHERE status = 'pending';
CREATE INDEX company_registrations_queue_idx ON company_registrations (status, submitted_at, id);
CREATE INDEX company_registrations_submitter_idx ON company_registrations (submitter_principal_id, submitted_at DESC);

-- Only pending -> approved or rejected, once; the submission itself never changes.
CREATE FUNCTION company_registrations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company registrations are kept' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status = 'pending'
     OR (NEW.id, NEW.submitter_principal_id, NEW.company_name, NEW.contact_name, NEW.contact_position,
         NEW.phone_number, NEW.company_email, NEW.requesting_for, NEW.submitted_at)
        IS DISTINCT FROM
        (OLD.id, OLD.submitter_principal_id, OLD.company_name, OLD.contact_name, OLD.contact_position,
         OLD.phone_number, OLD.company_email, OLD.requesting_for, OLD.submitted_at) THEN
    RAISE EXCEPTION 'a company registration is decided once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_registrations_guard BEFORE UPDATE OR DELETE ON company_registrations
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION company_registrations_guard();
