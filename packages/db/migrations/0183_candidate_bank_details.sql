-- SHU-182 (F1): a candidate's own bank details, written only through the SHU-82 safe write.
-- Bank, IBAN and beneficiary name are one row and change together. The database
-- enforces the same rules the application validates with, so no writer can store a
-- value the application would refuse:
--  * the IBAN passes candidate_iban_valid: ISO 13616 country length and mod 97, with the
--    country registry copied from @studenthub/pay-contracts' IBAN_LENGTHS;
--  * the beneficiary name passes candidate_beneficiary_name_valid: NFKC, single spaces,
--    2-70 code points and none of BENEFICIARY_NAME_FORBIDDEN_RANGES (listed below code point by code point);
--  * the bank is a catalogue item of type bank (composite foreign key) that is active
--    when the row is written (trigger). A bank retired later leaves stored rows as they were.
-- A test compares both functions with the application's validators code point by code point.
-- No platform read projection selects from this table: the bank-details store is its only reader.
CREATE FUNCTION candidate_iban_valid(iban text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  expected integer;
  remainder integer := 0;
  ch text;
  digits text;
BEGIN
  IF iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' THEN RETURN false; END IF;
  expected := CASE substr(iban, 1, 2)
      WHEN 'AD' THEN 24 WHEN 'AE' THEN 23 WHEN 'AL' THEN 28 WHEN 'AT' THEN 20 WHEN 'AZ' THEN 28 WHEN 'BA' THEN 20 WHEN 'BE' THEN 16 WHEN 'BG' THEN 22
      WHEN 'BH' THEN 22 WHEN 'BI' THEN 27 WHEN 'BR' THEN 29 WHEN 'BY' THEN 28 WHEN 'CH' THEN 21 WHEN 'CR' THEN 22 WHEN 'CY' THEN 28 WHEN 'CZ' THEN 24
      WHEN 'DE' THEN 22 WHEN 'DJ' THEN 27 WHEN 'DK' THEN 18 WHEN 'DO' THEN 28 WHEN 'EE' THEN 20 WHEN 'EG' THEN 29 WHEN 'ES' THEN 24 WHEN 'FI' THEN 18
      WHEN 'FK' THEN 18 WHEN 'FO' THEN 18 WHEN 'FR' THEN 27 WHEN 'GB' THEN 22 WHEN 'GE' THEN 22 WHEN 'GI' THEN 23 WHEN 'GL' THEN 18 WHEN 'GR' THEN 27
      WHEN 'GT' THEN 28 WHEN 'HN' THEN 28 WHEN 'HR' THEN 21 WHEN 'HU' THEN 28 WHEN 'IE' THEN 22 WHEN 'IL' THEN 23 WHEN 'IQ' THEN 23 WHEN 'IS' THEN 26
      WHEN 'IT' THEN 27 WHEN 'JO' THEN 30 WHEN 'KW' THEN 30 WHEN 'KZ' THEN 20 WHEN 'LB' THEN 28 WHEN 'LC' THEN 32 WHEN 'LI' THEN 21 WHEN 'LT' THEN 20
      WHEN 'LU' THEN 20 WHEN 'LV' THEN 21 WHEN 'LY' THEN 25 WHEN 'MC' THEN 27 WHEN 'MD' THEN 24 WHEN 'ME' THEN 22 WHEN 'MK' THEN 19 WHEN 'MN' THEN 20
      WHEN 'MR' THEN 27 WHEN 'MT' THEN 31 WHEN 'MU' THEN 30 WHEN 'NI' THEN 28 WHEN 'NL' THEN 18 WHEN 'NO' THEN 15 WHEN 'OM' THEN 23 WHEN 'PK' THEN 24
      WHEN 'PL' THEN 28 WHEN 'PS' THEN 29 WHEN 'PT' THEN 25 WHEN 'QA' THEN 29 WHEN 'RO' THEN 24 WHEN 'RS' THEN 22 WHEN 'RU' THEN 33 WHEN 'SA' THEN 24
      WHEN 'SC' THEN 31 WHEN 'SD' THEN 18 WHEN 'SE' THEN 24 WHEN 'SI' THEN 19 WHEN 'SK' THEN 24 WHEN 'SM' THEN 27 WHEN 'SO' THEN 23 WHEN 'ST' THEN 25
      WHEN 'SV' THEN 28 WHEN 'TL' THEN 23 WHEN 'TN' THEN 24 WHEN 'TR' THEN 26 WHEN 'UA' THEN 29 WHEN 'VA' THEN 22 WHEN 'VG' THEN 24 WHEN 'XK' THEN 20
      WHEN 'YE' THEN 30
    END;
  IF expected IS NULL OR char_length(iban) <> expected THEN RETURN false; END IF;
  FOREACH ch IN ARRAY regexp_split_to_array(substr(iban, 5) || substr(iban, 1, 4), '') LOOP
    digits := CASE WHEN ch ~ '^[A-Z]$' THEN (ascii(ch) - 55)::text ELSE ch END;
    FOR i IN 1 .. char_length(digits) LOOP
      remainder := (remainder * 10 + substr(digits, i, 1)::integer) % 97;
    END LOOP;
  END LOOP;
  RETURN remainder = 1;
END
$$;

CREATE FUNCTION candidate_beneficiary_name_valid(name text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT name IS NFKC NORMALIZED
    AND char_length(name) BETWEEN 2 AND 70
    AND name !~ '^ | $|  '
    AND name !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u1680\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001CCD6-\U0001CCF9\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F]'
$$;

-- Lets the bank-details row name the catalogue type in its foreign key.
CREATE UNIQUE INDEX catalogue_items_id_type_uq ON catalogue_items (id, catalogue_type);

CREATE TABLE candidate_bank_details (
  principal_id      text PRIMARY KEY REFERENCES principals (id),
  bank_id           uuid NOT NULL,
  bank_catalogue    text NOT NULL DEFAULT 'bank' CHECK (bank_catalogue = 'bank'),
  iban              text NOT NULL CHECK (candidate_iban_valid(iban)),
  beneficiary_name  text NOT NULL CHECK (candidate_beneficiary_name_valid(beneficiary_name)),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (bank_id, bank_catalogue) REFERENCES catalogue_items (id, catalogue_type)
);

CREATE FUNCTION candidate_bank_details_active_bank() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalogue_items WHERE id = NEW.bank_id AND catalogue_type = 'bank' AND status = 'active') THEN
    RAISE EXCEPTION 'bank % is not an active catalogue bank', NEW.bank_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER candidate_bank_details_active_bank BEFORE INSERT OR UPDATE ON candidate_bank_details
  FOR EACH ROW EXECUTE FUNCTION candidate_bank_details_active_bank();

-- The receipt is a row in the SHU-59 ledger, like every safe write before it. It names
-- no organization and carries the field name only, never the bank, IBAN or name.
ALTER TABLE authorization_mutation_audit
  DROP CONSTRAINT authorization_mutation_audit_operation_check,
  ADD CONSTRAINT authorization_mutation_audit_operation_check CHECK (
    operation IN ('principal.register', 'grants.grant', 'grants.revoke', 'grants.clear', 'profile.safe_write',
      'profile_record.create', 'profile_record.update', 'profile_record.remove',
      'profile_record.restore', 'profile_record.replace', 'organization.profile.safe_write',
      'pay_contract.create', 'pay_contract.update', 'pay_contract.remove', 'candidate.bank_details.safe_write')
  ),
  DROP CONSTRAINT auth_audit_target_org_cardinality,
  ADD CONSTRAINT auth_audit_target_org_cardinality CHECK (
    (operation IN ('principal.register', 'grants.clear', 'profile.safe_write',
      'profile_record.create', 'profile_record.update', 'profile_record.remove',
      'profile_record.restore', 'profile_record.replace', 'candidate.bank_details.safe_write') AND cardinality(target_org_refs) = 0)
    OR
    (operation IN ('grants.grant', 'grants.revoke', 'organization.profile.safe_write') AND cardinality(target_org_refs) > 0)
    OR
    (operation IN ('pay_contract.create', 'pay_contract.update', 'pay_contract.remove') AND cardinality(target_org_refs) = 1)
  ),
  -- Self-authored, as 0147 requires of the language write. NULL is excluded explicitly.
  DROP CONSTRAINT auth_audit_safe_write_self,
  ADD CONSTRAINT auth_audit_safe_write_self CHECK (
    operation NOT IN ('profile.safe_write', 'candidate.bank_details.safe_write')
    OR (actor_principal_ref IS NOT NULL AND actor_principal_ref = target_principal_ref)
  ),
  DROP CONSTRAINT auth_audit_safe_write_halves,
  ADD CONSTRAINT auth_audit_safe_write_halves CHECK (
    operation NOT IN ('profile.safe_write', 'organization.profile.safe_write', 'candidate.bank_details.safe_write')
    OR (before_summary ? 'valuePresent' AND after_summary ? 'tokenRef')
  );

-- Extends 0182's receipt shapes (which carry 0150's and 0148's) by admitting the bank-details
-- write to the safe-write branch with its one field; every other branch is unchanged.
CREATE OR REPLACE FUNCTION authorization_audit_summary_valid(audit_operation TEXT, summary JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE
  WHEN audit_operation='principal.register' THEN jsonb_typeof(summary)='object'
   AND summary ?& ARRAY['existed','identityCount','displayNamePresent','emailPresent']
   AND summary-ARRAY['existed','identityCount','displayNamePresent','emailPresent']='{}'::jsonb
   AND jsonb_typeof(summary->'existed')='boolean' AND jsonb_typeof(summary->'displayNamePresent')='boolean'
   AND jsonb_typeof(summary->'emailPresent')='boolean' AND jsonb_typeof(summary->'identityCount')='number'
   AND summary->>'identityCount' ~ '^(0|[1-9][0-9]{0,17})$'
  WHEN audit_operation IN ('grants.grant','grants.revoke','grants.clear') THEN jsonb_typeof(summary)='object'
   AND summary ?& ARRAY['grantCount','selfCount','subtreeCount'] AND summary-ARRAY['grantCount','selfCount','subtreeCount']='{}'::jsonb
   AND jsonb_typeof(summary->'grantCount')='number' AND jsonb_typeof(summary->'selfCount')='number'
   AND jsonb_typeof(summary->'subtreeCount')='number' AND summary->>'grantCount' ~ '^(0|[1-9][0-9]{0,17})$'
   AND summary->>'selfCount' ~ '^(0|[1-9][0-9]{0,17})$' AND summary->>'subtreeCount' ~ '^(0|[1-9][0-9]{0,17})$'
  WHEN audit_operation IN ('profile.safe_write','organization.profile.safe_write','candidate.bank_details.safe_write') THEN jsonb_typeof(summary)='object' AND (
   (summary ?& ARRAY['valuePresent'] AND summary-ARRAY['valuePresent']='{}'::jsonb AND jsonb_typeof(summary->'valuePresent')='boolean') OR
   (summary ?& ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']
    AND summary-ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']='{}'::jsonb
    AND jsonb_typeof(summary->'contractVersion')='string' AND summary->>'contractVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    AND jsonb_typeof(summary->'personRef')='string' AND summary->>'personRef' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(summary->'changeSetDigest')='string' AND summary->>'changeSetDigest' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(summary->'tokenRef')='string' AND summary->>'tokenRef' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(summary->'fields')='array' AND jsonb_array_length(summary->'fields')=1
    AND ((audit_operation='profile.safe_write' AND summary->'fields'='["language"]'::jsonb)
      OR (audit_operation='organization.profile.safe_write' AND summary->'fields'->>0 IN ('name_en','name_ar','description_en','description_ar','website'))
      OR (audit_operation='candidate.bank_details.safe_write' AND summary->'fields'='["bank_details"]'::jsonb))
    AND jsonb_typeof(summary->'committedAt')='string'
    AND summary->>'committedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'))
  WHEN audit_operation IN ('profile_record.create','profile_record.update','profile_record.remove','profile_record.restore','profile_record.replace') THEN
   jsonb_typeof(summary)='object' AND summary ?& ARRAY['kind','activeCount'] AND summary-ARRAY['kind','activeCount']='{}'::jsonb
   AND summary->>'kind' IN ('education','experience','skill','link') AND jsonb_typeof(summary->'activeCount')='number'
   AND summary->>'activeCount' ~ '^(0|[1-9][0-9]{0,17})$'
  WHEN audit_operation IN ('pay_contract.create','pay_contract.update','pay_contract.remove') THEN
   jsonb_typeof(summary)='object' AND summary ?& ARRAY['payModel','contractCount'] AND summary-ARRAY['payModel','contractCount']='{}'::jsonb
   AND summary->>'payModel' IN ('hourly','fixed_price','monthly_salary') AND jsonb_typeof(summary->'contractCount')='number'
   AND summary->>'contractCount' ~ '^(0|[1-9][0-9]{0,17})$'
  ELSE FALSE END
$$;

CREATE UNIQUE INDEX authorization_mutation_audit_bank_details_token
  ON authorization_mutation_audit ((after_summary ->> 'tokenRef')) WHERE operation = 'candidate.bank_details.safe_write';
CREATE UNIQUE INDEX authorization_mutation_audit_bank_details_receipt
  ON authorization_mutation_audit (request_ref) WHERE operation = 'candidate.bank_details.safe_write';
