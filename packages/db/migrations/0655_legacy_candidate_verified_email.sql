-- Cutover lane (M-1 contact slice, SHU-721): the address legacy marked verified
-- (candidate_email_verification = 1) is staged only as an HMAC under the importer's separate
-- digest key, never as an address. At cutover a linked person's current address is hashed the
-- same way; only on a match does the cutover step add principal_email_verifications
-- (source 'legacy_import', ON CONFLICT DO NOTHING, so an OIDC answer always wins).
ALTER TABLE legacy_candidate_contacts
  ADD COLUMN verified_email_hmac bytea CHECK (verified_email_hmac IS NULL OR octet_length(verified_email_hmac) = 32);
CREATE UNIQUE INDEX legacy_candidate_contacts_verified_email_uq ON legacy_candidate_contacts (verified_email_hmac)
  WHERE verified_email_hmac IS NOT NULL;

-- A row may now hold only a verified address: replace 0654's "at least one value" check.
DO $migration$
DECLARE name text;
BEGIN
  SELECT conname INTO STRICT name FROM pg_constraint
   WHERE conrelid = 'legacy_candidate_contacts'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) = 'CHECK (((phone IS NOT NULL) OR (profile_handle IS NOT NULL) OR (civil_country IS NOT NULL)))';
  EXECUTE format('ALTER TABLE legacy_candidate_contacts DROP CONSTRAINT %I', name);
END
$migration$;
ALTER TABLE legacy_candidate_contacts ADD CONSTRAINT legacy_candidate_contacts_has_value
  CHECK (phone IS NOT NULL OR profile_handle IS NOT NULL OR civil_country IS NOT NULL OR verified_email_hmac IS NOT NULL);
