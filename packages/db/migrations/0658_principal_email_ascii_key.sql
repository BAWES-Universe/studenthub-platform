-- Access lane table (migration 0410), cutover lane change (SHU-721, GPT AMEND on #709): one
-- locale-independent normalisation for a verified-address fact, the same rule as the importer's
-- JavaScript normaliseVerifiedEmail. Outer spaces trimmed; the trimmed address must be plain
-- printable ASCII (one @, at most 254 characters) before any case change; then only A-Z is
-- lowered, with translate(), which maps code points and does not depend on the database's
-- collation or ctype. Anything else (a non-ASCII spelling such as a Kelvin sign or a dotted I, a
-- tab, a no-break space) has no key, so no fact can be recorded for it, carried to it, or read
-- as verified for it. Before this, insert, cleanup and read used lower(btrim(...)), whose
-- non-ASCII case mapping follows the database locale.
CREATE FUNCTION principal_email_key(raw text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN char_length(btrim(raw, ' ')) <= 254
     AND btrim(raw, ' ') COLLATE "C" ~ '^[!-?A-~]+@[!-?A-~]+$'
    THEN translate(btrim(raw, ' '), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
  END
$$;

ALTER TABLE principal_email_verifications DROP CONSTRAINT principal_email_verifications_email_check;

-- Cleanup: an address change keeps only the fact for the new address's key; an address with no
-- key keeps nothing.
CREATE OR REPLACE FUNCTION principal_email_verifications_follow_address() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM principal_email_verifications
   WHERE principal_id = NEW.id
     AND (principal_email_key(NEW.email) IS NULL OR email <> principal_email_key(NEW.email));
  RETURN NEW;
END;
$$;

-- Insert: still serialised with an address change by the share lock on the principal row; the
-- recorded address must have the current address's key (the CHECK below makes it that key itself).
CREATE OR REPLACE FUNCTION principal_email_verifications_current_address() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM principals
    WHERE id = NEW.principal_id AND principal_email_key(email) = principal_email_key(NEW.email)
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'principal_email_verifications: not the principal''s current address'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Existing rows (GPT AMEND 2 on #709). A row whose address is not its own key was keyed by the old,
-- locale-dependent lower(btrim()). An issuer negative (verified false) that is still tied to the
-- current address under that old rule is carried to the current address's key, and a negative
-- wins over any answer already recorded for that key, so a legacy promotion can never treat a
-- vetoed address as unanswered. Every other such row is dropped: a positive fails closed (the
-- next sign-in records again), a stale row was for another address, and a current address with
-- no key can never read as verified. Kept as a function so the carry can be tested.
CREATE FUNCTION principal_email_verifications_rekey() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE carried integer;
BEGIN
  INSERT INTO principal_email_verifications (principal_id, email, verified, source, recorded_at)
  SELECT v.principal_id, principal_email_key(p.email), false, v.source, v.recorded_at
    FROM principal_email_verifications v JOIN principals p ON p.id = v.principal_id
   WHERE NOT v.verified
     AND principal_email_key(v.email) IS DISTINCT FROM v.email
     AND p.email IS NOT NULL AND v.email = lower(btrim(p.email))
     AND principal_email_key(p.email) IS NOT NULL
  ON CONFLICT (principal_id, email)
  DO UPDATE SET verified = false, source = EXCLUDED.source, recorded_at = EXCLUDED.recorded_at;
  GET DIAGNOSTICS carried = ROW_COUNT;
  DELETE FROM principal_email_verifications WHERE principal_email_key(email) IS DISTINCT FROM email;
  RETURN carried;
END;
$$;

SELECT principal_email_verifications_rekey();

ALTER TABLE principal_email_verifications ADD CONSTRAINT principal_email_verifications_email_key
  CHECK (principal_email_key(email) IS NOT NULL AND email = principal_email_key(email));
