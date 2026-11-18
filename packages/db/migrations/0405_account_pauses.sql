-- Access lane A6: staff pause and resume a person's StudentHub access.
--
-- A pause row keeps the exact grants and store grants taken away, so resuming
-- gives back the same set (minus a deleted company or a removed store). While
-- a pause is live no login session can be created for the person, whatever
-- path tries: the trigger below refuses the insert. Pausing also deletes the
-- person's sessions in the same transaction, so it applies on their next
-- request. Rows are never deleted; resuming fills the resumed_* columns once.

CREATE TABLE account_pauses (
  id                  UUID PRIMARY KEY,
  principal_id        TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  paused_by           TEXT NOT NULL,
  reason              TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  paused_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  suspended_grants    JSONB NOT NULL CHECK (jsonb_typeof(suspended_grants) = 'array'),
  suspended_stores    JSONB NOT NULL CHECK (jsonb_typeof(suspended_stores) = 'array'),
  resumed_at          TIMESTAMPTZ,
  resumed_by          TEXT,
  resume_reason       TEXT CHECK (resume_reason IS NULL OR char_length(resume_reason) BETWEEN 3 AND 500),
  restored_grants     JSONB,
  CHECK ((resumed_at IS NULL) = (resumed_by IS NULL)
     AND (resumed_at IS NULL) = (resume_reason IS NULL)
     AND (resumed_at IS NULL) = (restored_grants IS NULL))
);

CREATE UNIQUE INDEX account_pauses_live_idx ON account_pauses (principal_id) WHERE resumed_at IS NULL;
CREATE INDEX account_pauses_principal_idx ON account_pauses (principal_id, paused_at DESC);

CREATE FUNCTION account_pauses_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account pauses are resumed, never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.resumed_at IS NOT NULL OR NEW.resumed_at IS NULL
     OR NEW.principal_id <> OLD.principal_id OR NEW.paused_by <> OLD.paused_by OR NEW.reason <> OLD.reason
     OR NEW.paused_at <> OLD.paused_at OR NEW.suspended_grants <> OLD.suspended_grants OR NEW.suspended_stores <> OLD.suspended_stores THEN
    RAISE EXCEPTION 'an account pause can only be resumed, once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_pauses_guard BEFORE UPDATE ON account_pauses
  FOR EACH ROW EXECUTE FUNCTION account_pauses_guard();
-- A principal's deletion cascades; a direct DELETE is refused.
CREATE TRIGGER account_pauses_no_delete BEFORE DELETE ON account_pauses
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION account_pauses_guard();

CREATE FUNCTION login_sessions_refuse_paused() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account_pauses p WHERE p.principal_id = NEW.person_id AND p.resumed_at IS NULL) THEN
    RAISE EXCEPTION 'StudentHub access is paused for this person' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER login_sessions_refuse_paused BEFORE INSERT ON login_sessions
  FOR EACH ROW EXECUTE FUNCTION login_sessions_refuse_paused();
