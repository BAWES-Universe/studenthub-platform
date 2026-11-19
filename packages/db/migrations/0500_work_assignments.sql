-- Work lane W-1: a person is placed at a store for a period.
--
-- Legacy kept one `candidate.store_id` plus `candidate_work_history` rows and
-- created a `contract` row inside the assign action (staff CandidateController
-- actionAssign/actionUnassign). Here an assignment is its own row with a date
-- range. The pay contract is chosen from the F1 contracts that cover the period
-- and the choice is recorded with its reasoning; the assignment never edits a
-- contract. History is kept: ending an assignment sets its end date, it is never
-- deleted. Every write leaves an append-only work_events row in the same
-- transaction.

CREATE TABLE work_assignment_requests (
 id uuid PRIMARY KEY,
 person_principal_id text NOT NULL REFERENCES principals(id),
 org_id text NOT NULL REFERENCES organizations(id),
 store_id uuid NOT NULL REFERENCES organization_stores(id),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','cancelled')),
 note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 1000)),
 requested_by text NOT NULL REFERENCES principals(id),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 decided_by text REFERENCES principals(id),
 decided_at timestamptz,
 decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 1 AND 500)),
 CHECK ((status = 'pending') = (decided_at IS NULL)),
 CHECK ((decided_at IS NULL) = (decided_by IS NULL))
);
-- Legacy let a company file the same request twice; one open request per person and store.
CREATE UNIQUE INDEX work_assignment_requests_one_pending ON work_assignment_requests(person_principal_id, store_id) WHERE status = 'pending';
CREATE INDEX work_assignment_requests_org_idx ON work_assignment_requests(org_id, status, requested_at DESC);

CREATE TABLE work_assignments (
 id uuid PRIMARY KEY,
 person_principal_id text NOT NULL REFERENCES principals(id),
 org_id text NOT NULL REFERENCES organizations(id),
 store_id uuid NOT NULL REFERENCES organization_stores(id),
 pay_contract_id uuid REFERENCES pay_contracts(id),
 -- Why that contract (or none) applied: F1 resolver version, steps and matched ids.
 contract_resolution jsonb NOT NULL CHECK (jsonb_typeof(contract_resolution) = 'object'),
 start_date date NOT NULL,
 end_date date CHECK (end_date IS NULL OR end_date >= start_date),
 warnings text[] NOT NULL DEFAULT '{}' CHECK (warnings <@ ARRAY['civil_id_missing','civil_id_expires_before_start','no_pay_contract']::text[]),
 source text NOT NULL CHECK (source IN ('staff','request','recruit','import')),
 request_id uuid UNIQUE REFERENCES work_assignment_requests(id),
 -- Placement from the recruit lane's "placed" stage: idempotent on the recruit card.
 recruit_card_id uuid UNIQUE,
 recruit_request_id uuid,
 legacy_ref text UNIQUE CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'),
 created_by text REFERENCES principals(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (source = 'import' OR created_by IS NOT NULL),
 CHECK ((source = 'request') = (request_id IS NOT NULL)),
 CHECK ((source = 'recruit') = (recruit_card_id IS NOT NULL)),
 CHECK (recruit_request_id IS NULL OR source = 'recruit'),
 CHECK ((source = 'import') = (legacy_ref IS NOT NULL))
);
CREATE INDEX work_assignments_person_idx ON work_assignments(person_principal_id, start_date);
CREATE INDEX work_assignments_store_idx ON work_assignments(store_id, start_date);
CREATE INDEX work_assignments_org_idx ON work_assignments(org_id, start_date);

-- One place at a time (legacy rule 1, "remove old store before assigning a new
-- one"), enforced over date ranges so history and future placements are both
-- covered. The per-person advisory lock serializes two concurrent writers, which
-- a plain SELECT-then-INSERT would not.
CREATE FUNCTION enforce_work_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE store_org text; store_status text; c record;
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.person_principal_id <> OLD.person_principal_id OR NEW.org_id <> OLD.org_id
     OR NEW.store_id <> OLD.store_id OR NEW.start_date <> OLD.start_date OR NEW.source <> OLD.source
     OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.recruit_card_id IS DISTINCT FROM OLD.recruit_card_id
     OR NEW.recruit_request_id IS DISTINCT FROM OLD.recruit_request_id OR NEW.legacy_ref IS DISTINCT FROM OLD.legacy_ref
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.pay_contract_id IS DISTINCT FROM OLD.pay_contract_id OR NEW.contract_resolution <> OLD.contract_resolution) THEN
  RAISE EXCEPTION 'work assignment: only the end date may change' USING ERRCODE = '23514';
 END IF;
 SELECT org_id, status INTO store_org, store_status FROM organization_stores WHERE id = NEW.store_id;
 IF store_org IS DISTINCT FROM NEW.org_id THEN
  RAISE EXCEPTION 'work assignment store belongs to another organization' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' AND store_status <> 'active' AND NEW.source <> 'import' THEN
  RAISE EXCEPTION 'work assignment store is removed' USING ERRCODE = '23514';
 END IF;
 IF NEW.pay_contract_id IS NOT NULL THEN
  SELECT candidate_principal_id, company_org_id, store_id, status INTO c FROM pay_contracts WHERE id = NEW.pay_contract_id;
  IF c.candidate_principal_id <> NEW.person_principal_id OR c.company_org_id <> NEW.org_id OR c.store_id <> NEW.store_id::text OR c.status = 'deleted' THEN
   RAISE EXCEPTION 'work assignment contract does not bind this person and store' USING ERRCODE = '23514';
  END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('work_assignment:' || NEW.person_principal_id, 0));
 IF EXISTS (SELECT 1 FROM work_assignments a WHERE a.person_principal_id = NEW.person_principal_id AND a.id <> NEW.id
     AND daterange(a.start_date, a.end_date, '[]') && daterange(NEW.start_date, NEW.end_date, '[]')) THEN
  RAISE EXCEPTION 'work assignment overlaps another assignment of this person' USING ERRCODE = '23P01';
 END IF;
 NEW.updated_at := clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER work_assignments_enforce BEFORE INSERT OR UPDATE ON work_assignments FOR EACH ROW EXECUTE FUNCTION enforce_work_assignment();
CREATE FUNCTION refuse_work_assignment_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'work assignments are ended, never deleted' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER work_assignments_no_delete BEFORE DELETE ON work_assignments FOR EACH ROW EXECUTE FUNCTION refuse_work_assignment_delete();

-- Append-only history for the whole work lane (assignments, sessions, decisions,
-- appeals). Detail is a small closed object per kind: ids and dates, never rates
-- or amounts.
CREATE TABLE work_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN (
  'assignment.created','assignment.ended','assignment.extended',
  'assignment_request.created','assignment_request.accepted','assignment_request.rejected','assignment_request.cancelled')),
 org_id text NOT NULL REFERENCES organizations(id),
 person_principal_id text NOT NULL REFERENCES principals(id),
 subject_id uuid NOT NULL,
 actor_principal_id text REFERENCES principals(id),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX work_events_subject_idx ON work_events(subject_id, id);
CREATE INDEX work_events_person_idx ON work_events(person_principal_id, id);
CREATE FUNCTION refuse_work_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'work events are append-only' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER work_events_append_only BEFORE UPDATE OR DELETE ON work_events FOR EACH ROW EXECUTE FUNCTION refuse_work_event_change();
