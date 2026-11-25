-- Access lane: whether a person's email address is verified, as a fact tied to the address.
--
-- One row per principal and address. `verified` records the issuer's answer
-- for that address, false included, so a later legacy import (which only ever
-- inserts and never overwrites) cannot turn an issuer's "not verified" into a
-- verified address. The fact applies only while the address is the principal's
-- current one: readers compare it with principals.email, normalised, and the
-- trigger below drops the rows for any other address when the address changes,
-- so changing back to an old address does not revive an old verification.

CREATE TABLE principal_email_verifications (
  principal_id TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  email        TEXT NOT NULL CHECK (email <> '' AND email = lower(btrim(email))),
  verified     BOOLEAN NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('oidc', 'legacy_import')),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, email)
);

CREATE FUNCTION principal_email_verifications_follow_address() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM principal_email_verifications
   WHERE principal_id = NEW.id
     AND (NEW.email IS NULL OR email <> lower(btrim(NEW.email)));
  RETURN NEW;
END;
$$;

CREATE TRIGGER principal_email_verifications_follow_address
  AFTER UPDATE OF email ON principals
  FOR EACH ROW
  WHEN (OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION principal_email_verifications_follow_address();

-- Every write (sign-in or legacy import) is serialised with an address change:
-- it takes a share lock on the principal row and rechecks the current address
-- under that lock. A write racing an address change either waits for the change
-- and is refused, or commits first and is then dropped by the trigger above, so
-- a stale address can never keep a fact that a later change back would revive.
CREATE FUNCTION principal_email_verifications_current_address() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM principals
    WHERE id = NEW.principal_id AND email IS NOT NULL AND lower(btrim(email)) = lower(btrim(NEW.email))
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'principal_email_verifications: not the principal''s current address'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER principal_email_verifications_current_address
  BEFORE INSERT OR UPDATE ON principal_email_verifications
  FOR EACH ROW
  EXECUTE FUNCTION principal_email_verifications_current_address();
