-- SHU-300: owner-safe text edits for an organization profile.
CREATE TABLE organization_profiles (
  org_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  name_en text, name_ar text, description_en text, description_ar text, website text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE authorization_mutation_audit
  DROP CONSTRAINT authorization_mutation_audit_operation_check,
  ADD CONSTRAINT authorization_mutation_audit_operation_check CHECK (
    operation IN ('principal.register','grants.grant','grants.revoke','grants.clear','profile.safe_write',
      'profile_record.create','profile_record.update','profile_record.remove','profile_record.restore','profile_record.replace',
      'organization.profile.safe_write')
  ),
  DROP CONSTRAINT auth_audit_target_org_cardinality,
  ADD CONSTRAINT auth_audit_target_org_cardinality CHECK (
    (operation IN ('principal.register','grants.clear','profile.safe_write','profile_record.create','profile_record.update',
      'profile_record.remove','profile_record.restore','profile_record.replace') AND cardinality(target_org_refs)=0)
    OR (operation IN ('grants.grant','grants.revoke','organization.profile.safe_write') AND cardinality(target_org_refs)>0)
  );

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
  WHEN audit_operation IN ('profile.safe_write','organization.profile.safe_write') THEN jsonb_typeof(summary)='object' AND (
   (summary ?& ARRAY['valuePresent'] AND summary-ARRAY['valuePresent']='{}'::jsonb AND jsonb_typeof(summary->'valuePresent')='boolean') OR
   (summary ?& ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']
    AND summary-ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']='{}'::jsonb
    AND jsonb_typeof(summary->'contractVersion')='string' AND summary->>'contractVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    AND jsonb_typeof(summary->'personRef')='string' AND summary->>'personRef' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(summary->'changeSetDigest')='string' AND summary->>'changeSetDigest' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(summary->'tokenRef')='string' AND summary->>'tokenRef' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(summary->'fields')='array' AND jsonb_array_length(summary->'fields')=1
    AND ((audit_operation='profile.safe_write' AND summary->'fields'='["language"]'::jsonb)
      OR (audit_operation='organization.profile.safe_write' AND summary->'fields'->>0 IN ('name_en','name_ar','description_en','description_ar','website')))
    AND jsonb_typeof(summary->'committedAt')='string'
    AND summary->>'committedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'))
  WHEN audit_operation IN ('profile_record.create','profile_record.update','profile_record.remove','profile_record.restore','profile_record.replace') THEN
   jsonb_typeof(summary)='object' AND summary ?& ARRAY['kind','activeCount'] AND summary-ARRAY['kind','activeCount']='{}'::jsonb
   AND summary->>'kind' IN ('education','experience','skill','link') AND jsonb_typeof(summary->'activeCount')='number'
   AND summary->>'activeCount' ~ '^(0|[1-9][0-9]{0,17})$'
  ELSE FALSE END
$$;

ALTER TABLE authorization_mutation_audit DROP CONSTRAINT auth_audit_safe_write_halves,
 ADD CONSTRAINT auth_audit_safe_write_halves CHECK (
   operation NOT IN ('profile.safe_write','organization.profile.safe_write')
   OR (before_summary ? 'valuePresent' AND after_summary ? 'tokenRef'));

CREATE UNIQUE INDEX authorization_mutation_audit_organization_profile_token
 ON authorization_mutation_audit ((after_summary->>'tokenRef')) WHERE operation='organization.profile.safe_write';
CREATE UNIQUE INDEX authorization_mutation_audit_organization_profile_receipt
 ON authorization_mutation_audit (request_ref) WHERE operation='organization.profile.safe_write';
