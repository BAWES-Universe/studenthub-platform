-- Recruit R4: invitations to a request (legacy request invitations) and the
-- recruit outbox. One invitation per person per request; the person marks it
-- seen and accepts or declines, staff may withdraw it while it is open; answered
-- and withdrawn invitations are final. Every change writes an outbox row that the
-- notifications lane delivers later; nothing here talks to a provider.
CREATE TABLE recruit_invitations (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES recruit_requests(id),
 person_principal_id text NOT NULL REFERENCES principals(id),
 invited_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','seen','accepted','declined','withdrawn')),
 legacy_invitation_id bigint UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 seen_at timestamptz,
 answered_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (request_id, person_principal_id),
 CHECK ((status IN ('accepted','declined','withdrawn')) = (answered_at IS NOT NULL))
);
CREATE INDEX recruit_invitations_person_idx ON recruit_invitations(person_principal_id, created_at DESC, id);

CREATE FUNCTION enforce_recruit_invitation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.request_id <> OLD.request_id OR NEW.person_principal_id <> OLD.person_principal_id OR NEW.created_at <> OLD.created_at THEN
  RAISE EXCEPTION 'an invitation cannot move request or person' USING ERRCODE = '23514';
 END IF;
 IF NEW.status <> OLD.status AND NOT (OLD.status, NEW.status) IN (
  ('sent','seen'),('sent','accepted'),('sent','declined'),('seen','accepted'),('seen','declined'),('sent','withdrawn'),('seen','withdrawn')) THEN
  RAISE EXCEPTION 'invitation % to % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruit_invitations_rules BEFORE UPDATE ON recruit_invitations FOR EACH ROW EXECUTE FUNCTION enforce_recruit_invitation();
CREATE FUNCTION refuse_recruit_invitation_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'invitations are kept' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER recruit_invitations_no_delete BEFORE DELETE ON recruit_invitations FOR EACH ROW EXECUTE FUNCTION refuse_recruit_invitation_delete();

CREATE TABLE recruit_outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('invitation.sent','invitation.accepted','invitation.declined','invitation.withdrawn')),
 recipient_principal_id text NOT NULL REFERENCES principals(id),
 request_id uuid NOT NULL REFERENCES recruit_requests(id),
 subject_id uuid NOT NULL,
 dedupe_key text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 dispatched_at timestamptz
);
CREATE INDEX recruit_outbox_pending_idx ON recruit_outbox(id) WHERE dispatched_at IS NULL;
CREATE FUNCTION enforce_recruit_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'recruit outbox rows are kept' USING ERRCODE = '23514'; END IF;
 IF ROW(NEW.kind, NEW.recipient_principal_id, NEW.request_id, NEW.subject_id, NEW.dedupe_key, NEW.created_at) IS DISTINCT FROM ROW(OLD.kind, OLD.recipient_principal_id, OLD.request_id, OLD.subject_id, OLD.dedupe_key, OLD.created_at)
   OR OLD.dispatched_at IS NOT NULL THEN
  RAISE EXCEPTION 'only an undispatched outbox row can be marked dispatched' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruit_outbox_rules BEFORE UPDATE OR DELETE ON recruit_outbox FOR EACH ROW EXECUTE FUNCTION enforce_recruit_outbox();
