-- Recruit R7b: people apply to an open request (legacy RequestApplication).
-- One application per person per request; the company or the request's recruiter
-- accepts it (the person joins the pipeline at "contacted") or rejects it.
-- Applications are kept: no delete, and only applied -> accepted|rejected.

CREATE TABLE recruit_request_applications (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES recruit_requests(id),
 person_principal_id text NOT NULL REFERENCES principals(id),
 status text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','accepted','rejected')),
 decided_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 legacy_application_uuid text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 decided_at timestamptz,
 UNIQUE (request_id, person_principal_id),
 CHECK ((status = 'applied') = (decided_at IS NULL))
);
CREATE INDEX recruit_request_applications_person_idx ON recruit_request_applications(person_principal_id, created_at DESC, id);

CREATE FUNCTION enforce_recruit_request_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'applications are kept' USING ERRCODE = '23514'; END IF;
 IF ROW(NEW.request_id, NEW.person_principal_id, NEW.created_at) IS DISTINCT FROM ROW(OLD.request_id, OLD.person_principal_id, OLD.created_at) THEN
  RAISE EXCEPTION 'an application keeps its request and person' USING ERRCODE = '23514';
 END IF;
 IF NEW.status <> OLD.status AND NOT (OLD.status, NEW.status) IN (('applied','accepted'),('applied','rejected')) THEN
  RAISE EXCEPTION 'application % to % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruit_request_applications_rules BEFORE UPDATE OR DELETE ON recruit_request_applications FOR EACH ROW EXECUTE FUNCTION enforce_recruit_request_application();

ALTER TABLE recruit_outbox DROP CONSTRAINT recruit_outbox_kind_check;
ALTER TABLE recruit_outbox ADD CONSTRAINT recruit_outbox_kind_check CHECK (kind IN (
 'invitation.sent','invitation.accepted','invitation.declined','invitation.withdrawn','interview.scheduled','interview.cancelled','application.shortlisted','application.rejected',
 'request_application.received','request_application.accepted','request_application.rejected'));
