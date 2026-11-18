-- Recruit R2: staff work a request through a pipeline of cards (one person on
-- one request at one stage). Legacy story statuses were unchecked (RC-F3/F4);
-- here the stages are a closed set, moves follow an explicit list enforced by a
-- trigger, every move writes an event, and cancelling a request withdraws its
-- open cards in the database itself. "Placed" records the work lane's
-- assignment id; the work tables come later (0500), so it carries no FK.
ALTER TABLE recruit_requests ADD COLUMN assigned_at timestamptz;
ALTER TABLE recruit_requests ADD CONSTRAINT recruit_requests_assigned_at_check
 CHECK (assigned_recruiter_principal_id IS NULL OR assigned_at IS NOT NULL);

CREATE TABLE recruit_pipeline_cards (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES recruit_requests(id),
 person_principal_id text NOT NULL REFERENCES principals(id),
 stage text NOT NULL CHECK (stage IN ('suggested','contacted','interviewing','offered','placed','withdrawn')),
 assignment_id uuid,
 legacy_suggestion_id bigint UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (request_id, person_principal_id),
 CHECK (assignment_id IS NULL OR stage = 'placed')
);
CREATE INDEX recruit_pipeline_cards_person_idx ON recruit_pipeline_cards(person_principal_id);
CREATE INDEX recruit_pipeline_cards_request_stage_idx ON recruit_pipeline_cards(request_id, stage);

CREATE TABLE recruit_pipeline_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 card_id uuid NOT NULL REFERENCES recruit_pipeline_cards(id),
 from_stage text CHECK (from_stage IS NULL OR from_stage IN ('suggested','contacted','interviewing','offered','placed','withdrawn')),
 to_stage text NOT NULL CHECK (to_stage IN ('suggested','contacted','interviewing','offered','placed','withdrawn')),
 actor_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 actor_ref char(64) NOT NULL CHECK (actor_ref ~ '^[0-9a-f]{64}$'),
 at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX recruit_pipeline_events_card_idx ON recruit_pipeline_events(card_id, at, id);
CREATE TRIGGER recruit_pipeline_events_append_only BEFORE UPDATE OR DELETE ON recruit_pipeline_events FOR EACH ROW EXECUTE FUNCTION refuse_recruit_request_event_change();

CREATE FUNCTION enforce_recruit_pipeline_card() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.request_id <> OLD.request_id OR NEW.person_principal_id <> OLD.person_principal_id THEN
  RAISE EXCEPTION 'pipeline card cannot move request or person' USING ERRCODE = '23514';
 END IF;
 IF NEW.stage <> OLD.stage AND NOT (OLD.stage, NEW.stage) IN (
  ('suggested','contacted'),('suggested','withdrawn'),('contacted','interviewing'),('contacted','offered'),('contacted','withdrawn'),
  ('interviewing','offered'),('interviewing','withdrawn'),('offered','placed'),('offered','withdrawn')) THEN
  RAISE EXCEPTION 'pipeline move % to % is not allowed', OLD.stage, NEW.stage USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruit_pipeline_cards_rules BEFORE UPDATE ON recruit_pipeline_cards FOR EACH ROW EXECUTE FUNCTION enforce_recruit_pipeline_card();
CREATE FUNCTION refuse_recruit_pipeline_card_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pipeline cards are withdrawn, never deleted' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER recruit_pipeline_cards_no_delete BEFORE DELETE ON recruit_pipeline_cards FOR EACH ROW EXECUTE FUNCTION refuse_recruit_pipeline_card_delete();

-- The system actor (all zeros) marks changes no person made directly.
CREATE FUNCTION cascade_recruit_request_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 WITH open_cards AS (
  SELECT id, stage FROM recruit_pipeline_cards
  WHERE request_id = NEW.id AND stage IN ('suggested','contacted','interviewing','offered') FOR UPDATE
 ), withdrawn AS (
  UPDATE recruit_pipeline_cards c SET stage = 'withdrawn', updated_at = clock_timestamp()
  FROM open_cards o WHERE c.id = o.id
  RETURNING c.id, o.stage AS old_stage
 )
 INSERT INTO recruit_pipeline_events(card_id, from_stage, to_stage, actor_ref)
 SELECT id, old_stage, 'withdrawn', repeat('0', 64) FROM withdrawn;
 RETURN NEW;
END $$;
CREATE TRIGGER recruit_requests_cancel_cascade AFTER UPDATE OF status ON recruit_requests FOR EACH ROW
 WHEN (NEW.status = 'closed' AND NEW.close_reason = 'cancelled' AND OLD.status <> 'closed')
 EXECUTE FUNCTION cascade_recruit_request_cancel();
