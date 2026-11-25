-- Cutover lane (M-1 contact slice): a verifier for the civil ID key, provisioned on the target.
-- The importer seals staged civil IDs with the key the operator supplies. A well-formed but wrong
-- key would stage ciphertext the platform cannot open, and a replay would only compare digests.
-- So the target holds one check value: a fixed, non-personal number sealed under the platform's
-- civil ID key by the importer's `keycheck` step, set once and never changed. A write refuses
-- before any step unless the supplied key opens it.
ALTER TABLE legacy_import_target
  ADD COLUMN civil_key_check bytea CHECK (civil_key_check IS NULL OR octet_length(civil_key_check) BETWEEN 33 AND 128),
  ADD COLUMN civil_key_check_version integer CHECK (civil_key_check_version IS NULL OR civil_key_check_version > 0),
  ADD COLUMN civil_key_check_set_at timestamptz,
  ADD CONSTRAINT legacy_import_target_civil_key_check_whole
    CHECK ((civil_key_check IS NULL) = (civil_key_check_version IS NULL) AND (civil_key_check IS NULL) = (civil_key_check_set_at IS NULL));

-- Set once: a provisioned check is never replaced or cleared.
CREATE FUNCTION legacy_import_target_civil_key_check_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.civil_key_check IS NOT NULL AND (NEW.civil_key_check IS DISTINCT FROM OLD.civil_key_check
      OR NEW.civil_key_check_version IS DISTINCT FROM OLD.civil_key_check_version
      OR NEW.civil_key_check_set_at IS DISTINCT FROM OLD.civil_key_check_set_at) THEN
    RAISE EXCEPTION 'legacy_import_target.civil_key_check is set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_import_target_civil_key_check_once BEFORE UPDATE ON legacy_import_target
  FOR EACH ROW EXECUTE FUNCTION legacy_import_target_civil_key_check_once();
