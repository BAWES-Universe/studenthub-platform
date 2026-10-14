CREATE TABLE organization_notes (
  id bigserial PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  author_principal_id text NOT NULL, body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000 AND body=btrim(body)),
  receipt_ref text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX organization_notes_org_created ON organization_notes(org_id,created_at DESC,id DESC);
CREATE FUNCTION organization_notes_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'organization notes are append-only'; END $$;
CREATE TRIGGER organization_notes_no_update BEFORE UPDATE ON organization_notes FOR EACH ROW EXECUTE FUNCTION organization_notes_no_update();
ALTER TABLE authorization_mutation_audit
  DROP CONSTRAINT authorization_mutation_audit_operation_check,
  ADD CONSTRAINT authorization_mutation_audit_operation_check CHECK (
    operation IN ('principal.register', 'grants.grant', 'grants.revoke', 'grants.clear', 'profile.safe_write',
      'profile_record.create', 'profile_record.update', 'profile_record.remove',
      'profile_record.restore', 'profile_record.replace', 'organization.profile.safe_write', 'organization.status.safe_write', 'organization.commercial_terms.safe_write', 'organization.approved_to_hire.safe_write', 'organization.note.safe_write',
      'pay_contract.create', 'pay_contract.update', 'pay_contract.remove', 'candidate.bank_details.safe_write')
  ),
  DROP CONSTRAINT auth_audit_target_org_cardinality,
  ADD CONSTRAINT auth_audit_target_org_cardinality CHECK (
    (operation IN ('principal.register', 'grants.clear', 'profile.safe_write',
      'profile_record.create', 'profile_record.update', 'profile_record.remove',
      'profile_record.restore', 'profile_record.replace', 'candidate.bank_details.safe_write') AND cardinality(target_org_refs) = 0)
    OR
    (operation IN ('grants.grant', 'grants.revoke', 'organization.profile.safe_write', 'organization.status.safe_write', 'organization.commercial_terms.safe_write', 'organization.approved_to_hire.safe_write', 'organization.note.safe_write') AND cardinality(target_org_refs) > 0)
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
    operation NOT IN ('profile.safe_write', 'organization.profile.safe_write', 'organization.status.safe_write', 'organization.commercial_terms.safe_write', 'organization.approved_to_hire.safe_write', 'organization.note.safe_write', 'candidate.bank_details.safe_write')
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
  WHEN audit_operation IN ('profile.safe_write','organization.profile.safe_write','organization.status.safe_write', 'organization.commercial_terms.safe_write', 'organization.approved_to_hire.safe_write', 'organization.note.safe_write','candidate.bank_details.safe_write') THEN jsonb_typeof(summary)='object' AND (
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
      OR (audit_operation='organization.status.safe_write' AND summary->'fields'='["status"]'::jsonb)
      OR (audit_operation='organization.commercial_terms.safe_write' AND summary->'fields'->>0 IN ('hourly_rate','bonus_commission'))
      OR (audit_operation='organization.approved_to_hire.safe_write' AND summary->'fields'='["approved_to_hire"]'::jsonb)
      OR (audit_operation='organization.note.safe_write' AND summary->'fields'='["note"]'::jsonb)
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

CREATE UNIQUE INDEX authorization_mutation_audit_organization_note_token
 ON authorization_mutation_audit ((after_summary ->> 'tokenRef')) WHERE operation='organization.note.safe_write';
CREATE UNIQUE INDEX authorization_mutation_audit_organization_note_receipt
 ON authorization_mutation_audit (request_ref) WHERE operation='organization.note.safe_write';
