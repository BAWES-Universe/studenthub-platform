-- SHU-300: owner safe writes for the text half of the organization profile.
CREATE TABLE organization_profiles (
  org_id          TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  common_name_en  TEXT,
  common_name_ar  TEXT,
  description_en  TEXT,
  description_ar  TEXT,
  website         TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE authorization_mutation_audit
  DROP CONSTRAINT authorization_mutation_audit_operation_check,
  ADD CONSTRAINT authorization_mutation_audit_operation_check CHECK (
    operation IN ('principal.register', 'grants.grant', 'grants.revoke', 'grants.clear', 'profile.safe_write',
      'profile_record.create', 'profile_record.update', 'profile_record.remove',
      'profile_record.restore', 'profile_record.replace', 'organization.profile.safe_write')
  ),
  DROP CONSTRAINT auth_audit_target_org_cardinality,
  ADD CONSTRAINT auth_audit_target_org_cardinality CHECK (
    (operation IN ('principal.register', 'grants.clear', 'profile.safe_write',
      'profile_record.create', 'profile_record.update', 'profile_record.remove',
      'profile_record.restore', 'profile_record.replace') AND cardinality(target_org_refs) = 0)
    OR (operation IN ('grants.grant', 'grants.revoke', 'organization.profile.safe_write')
      AND cardinality(target_org_refs) > 0)
  );

-- Preserve every earlier validation branch and add the organization receipt shape.
CREATE OR REPLACE FUNCTION authorization_audit_summary_valid(audit_operation TEXT, summary JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN audit_operation = 'principal.register' THEN
      jsonb_typeof(summary)='object' AND summary ?& ARRAY['existed','identityCount','displayNamePresent','emailPresent']
      AND summary-ARRAY['existed','identityCount','displayNamePresent','emailPresent']='{}'::jsonb
      AND jsonb_typeof(summary->'existed')='boolean' AND jsonb_typeof(summary->'displayNamePresent')='boolean'
      AND jsonb_typeof(summary->'emailPresent')='boolean' AND jsonb_typeof(summary->'identityCount')='number'
      AND summary->>'identityCount' ~ '^(0|[1-9][0-9]{0,17})$'
    WHEN audit_operation IN ('grants.grant','grants.revoke','grants.clear') THEN
      jsonb_typeof(summary)='object' AND summary ?& ARRAY['grantCount','selfCount','subtreeCount']
      AND summary-ARRAY['grantCount','selfCount','subtreeCount']='{}'::jsonb
      AND jsonb_typeof(summary->'grantCount')='number' AND jsonb_typeof(summary->'selfCount')='number'
      AND jsonb_typeof(summary->'subtreeCount')='number' AND summary->>'grantCount' ~ '^(0|[1-9][0-9]{0,17})$'
      AND summary->>'selfCount' ~ '^(0|[1-9][0-9]{0,17})$' AND summary->>'subtreeCount' ~ '^(0|[1-9][0-9]{0,17})$'
    WHEN audit_operation IN ('profile.safe_write','organization.profile.safe_write') THEN
      jsonb_typeof(summary)='object' AND ((summary ?& ARRAY['valuePresent'] AND summary-ARRAY['valuePresent']='{}'::jsonb
        AND jsonb_typeof(summary->'valuePresent')='boolean') OR
       (summary ?& ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']
        AND summary-ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']='{}'::jsonb
        AND summary->>'contractVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
        AND summary->>'personRef' ~ '^[0-9a-f]{64}$' AND summary->>'changeSetDigest' ~ '^[0-9a-f]{64}$'
        AND summary->>'tokenRef' ~ '^[0-9a-f]{64}$' AND jsonb_typeof(summary->'fields')='array'
        AND jsonb_array_length(summary->'fields')=1
        AND (audit_operation <> 'profile.safe_write' OR summary->'fields'='["language"]'::jsonb)
        AND (audit_operation <> 'organization.profile.safe_write' OR summary->> 'fields' IS NOT NULL
          AND summary->'fields'->>0 IN ('commonNameEn','commonNameAr','descriptionEn','descriptionAr','website'))
        AND summary->>'committedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'))
    WHEN audit_operation IN ('profile_record.create','profile_record.update','profile_record.remove','profile_record.restore','profile_record.replace') THEN
      jsonb_typeof(summary)='object' AND summary ?& ARRAY['kind','activeCount']
      AND summary-ARRAY['kind','activeCount']='{}'::jsonb AND summary->>'kind' IN ('education','experience','skill','link')
      AND jsonb_typeof(summary->'activeCount')='number' AND summary->>'activeCount' ~ '^(0|[1-9][0-9]{0,17})$'
    ELSE FALSE END
$$;

CREATE UNIQUE INDEX authorization_mutation_audit_organization_profile_token
  ON authorization_mutation_audit ((after_summary->>'tokenRef'))
  WHERE operation='organization.profile.safe_write';
CREATE UNIQUE INDEX authorization_mutation_audit_organization_profile_receipt
  ON authorization_mutation_audit(request_ref) WHERE operation='organization.profile.safe_write';
