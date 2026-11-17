-- Recruit R1: a company's request for people, with one status convention and
-- an activity list. Legacy `request` has six string statuses set by any save;
-- here a status change and its activity row commit together, and the allowed
-- pairs are enforced both in the domain and by the trigger below.
CREATE TABLE recruit_requests (
 id uuid PRIMARY KEY,
 org_id text NOT NULL REFERENCES organizations(id),
 store_id uuid NOT NULL REFERENCES organization_stores(id),
 created_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 position_title text NOT NULL CHECK (position_title = btrim(position_title) AND char_length(position_title) BETWEEN 1 AND 255),
 description text NOT NULL CHECK (description = btrim(description) AND char_length(description) BETWEEN 1 AND 5000),
 compensation_text text NOT NULL CHECK (compensation_text = btrim(compensation_text) AND char_length(compensation_text) BETWEEN 1 AND 500),
 position_type text NOT NULL CHECK (position_type IN ('full_time','part_time')),
 headcount integer NOT NULL CHECK (headcount BETWEEN 1 AND 10000),
 period_start date,
 period_end date,
 pay_model text CHECK (pay_model IS NULL OR pay_model IN ('hourly','fixed_price','monthly_salary')),
 gender text NOT NULL DEFAULT 'any' CHECK (gender IN ('any','male','female','other')),
 location text CHECK (location IS NULL OR (location = btrim(location) AND char_length(location) BETWEEN 1 AND 500)),
 priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 10),
 status text NOT NULL CHECK (status IN ('draft','open','filling','filled','closed')),
 close_reason text CHECK (close_reason IS NULL OR close_reason IN ('fulfilled','cancelled')),
 assigned_recruiter_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 legacy_request_id bigint UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((status = 'closed') = (close_reason IS NOT NULL)),
 CHECK ((period_start IS NULL) = (period_end IS NULL)),
 CHECK (period_end IS NULL OR period_end >= period_start)
);
CREATE INDEX recruit_requests_org_page_idx ON recruit_requests(org_id, created_at DESC, id DESC);
CREATE INDEX recruit_requests_org_status_page_idx ON recruit_requests(org_id, status, created_at DESC, id DESC);
CREATE INDEX recruit_requests_staff_page_idx ON recruit_requests(created_at DESC, id DESC) WHERE status <> 'draft';
CREATE INDEX recruit_requests_status_page_idx ON recruit_requests(status, created_at DESC, id DESC);
CREATE INDEX recruit_requests_store_idx ON recruit_requests(store_id);
CREATE INDEX recruit_requests_recruiter_idx ON recruit_requests(assigned_recruiter_principal_id) WHERE assigned_recruiter_principal_id IS NOT NULL;

CREATE FUNCTION enforce_recruit_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM organization_stores WHERE id = NEW.store_id AND org_id = NEW.org_id) THEN
  RAISE EXCEPTION 'recruit request store must belong to its company' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF NEW.org_id <> OLD.org_id OR NEW.store_id <> OLD.store_id THEN
   RAISE EXCEPTION 'recruit request cannot move company or store' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status, NEW.status) IN (
   ('draft','open'),('draft','closed'),('open','filling'),('open','closed'),
   ('filling','filled'),('filling','closed'),('filled','filling'),('filled','closed')) THEN
   RAISE EXCEPTION 'recruit request transition % to % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'closed' AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'closed recruit request is read-only' USING ERRCODE = '23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruit_requests_rules BEFORE INSERT OR UPDATE ON recruit_requests FOR EACH ROW EXECUTE FUNCTION enforce_recruit_request();
CREATE FUNCTION refuse_recruit_request_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'recruit requests are closed, never deleted' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER recruit_requests_no_delete BEFORE DELETE ON recruit_requests FOR EACH ROW EXECUTE FUNCTION refuse_recruit_request_delete();

CREATE TABLE recruit_request_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES recruit_requests(id),
 from_status text CHECK (from_status IS NULL OR from_status IN ('draft','open','filling','filled','closed')),
 to_status text NOT NULL CHECK (to_status IN ('draft','open','filling','filled','closed')),
 close_reason text CHECK (close_reason IS NULL OR close_reason IN ('fulfilled','cancelled')),
 actor_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 actor_ref char(64) NOT NULL CHECK (actor_ref ~ '^[0-9a-f]{64}$'),
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((to_status = 'closed') = (close_reason IS NOT NULL))
);
CREATE INDEX recruit_request_events_request_idx ON recruit_request_events(request_id, at, id);
CREATE FUNCTION refuse_recruit_request_event_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'recruit request activity is append-only' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER recruit_request_events_append_only BEFORE UPDATE OR DELETE ON recruit_request_events FOR EACH ROW EXECUTE FUNCTION refuse_recruit_request_event_change();
