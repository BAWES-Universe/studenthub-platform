-- Cutover lane (M-1 contact slice): each imported legacy candidate's phone, profile handle and
-- civil ID, staged apart from the person-owned tables. Nothing here is shown to anyone: the
-- cutover step that loads these into person_profiles and person_civil_ids (only for a linked
-- person with no platform-written value) is a later, reviewed step. Values are already checked
-- by the platform's own rules. The civil ID number is stored only sealed (CivilIdVault: AES-GCM,
-- bound to the legacy candidate) with its keyed hash; the row digest is an HMAC, so neither it
-- nor any report can be used to guess a phone or a number. A changed legacy row is a conflict,
-- never an overwrite.
CREATE TABLE legacy_candidate_contacts (
  legacy_candidate_id text PRIMARY KEY CHECK (legacy_candidate_id ~ '^[1-9][0-9]{0,17}$'),
  phone text CHECK (phone IS NULL OR phone ~ '^\+[0-9]{8,15}$'),
  profile_handle text CHECK (profile_handle IS NULL OR profile_handle ~ '^[a-z][a-z0-9._-]{2,29}$'),
  civil_country text CHECK (civil_country IN ('KW', 'BH')),
  civil_number_ciphertext bytea CHECK (civil_number_ciphertext IS NULL OR octet_length(civil_number_ciphertext) >= 33),
  civil_number_hash bytea CHECK (civil_number_hash IS NULL OR octet_length(civil_number_hash) = 32),
  civil_key_version smallint CHECK (civil_key_version IS NULL OR civil_key_version > 0),
  civil_needs_review boolean,
  CHECK ((civil_country IS NULL AND civil_number_ciphertext IS NULL AND civil_number_hash IS NULL AND civil_key_version IS NULL AND civil_needs_review IS NULL)
      OR (civil_country IS NOT NULL AND civil_number_ciphertext IS NOT NULL AND civil_number_hash IS NOT NULL AND civil_key_version IS NOT NULL)),
  CHECK (phone IS NOT NULL OR profile_handle IS NOT NULL OR civil_country IS NOT NULL),
  digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- The mapper already records a shared value for nobody; these are the backstop.
CREATE UNIQUE INDEX legacy_candidate_contacts_phone_uq ON legacy_candidate_contacts (phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX legacy_candidate_contacts_handle_uq ON legacy_candidate_contacts (profile_handle) WHERE profile_handle IS NOT NULL;
CREATE UNIQUE INDEX legacy_candidate_contacts_civil_uq ON legacy_candidate_contacts (civil_country, civil_number_hash) WHERE civil_number_hash IS NOT NULL;
