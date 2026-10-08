-- SHU-182 (F1): a candidate's own bank details, written only through the SHU-82 safe write.
-- Bank, IBAN and beneficiary name are one row and change together. The values are
-- validated before they reach SQL (mod-97, ISO 13616 length, active catalogue bank);
-- these CHECKs are the backstop for any other writer. No platform read projection
-- selects from this table: the bank-details store is its only reader.
CREATE TABLE candidate_bank_details (
  principal_id     text PRIMARY KEY REFERENCES principals (id),
  bank_id          uuid NOT NULL REFERENCES catalogue_items (id),
  iban             text NOT NULL CHECK (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  beneficiary_name text NOT NULL CHECK (char_length(beneficiary_name) BETWEEN 2 AND 70 AND beneficiary_name = btrim(beneficiary_name)),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);

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
