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
