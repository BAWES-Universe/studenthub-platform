-- SHU-390: platform-owned, independently dated profile self-edits.
CREATE FUNCTION person_profile_name_valid(value text, arabic boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT value IS NFC NORMALIZED AND char_length(value) BETWEEN 1 AND 255
   AND value = btrim(value, E' \t\n\r\f\x0b\u00a0')
   AND value !~ '[[:space:]]{2}|[\t\n\r\f\v\u00A0\u1680\u2000-\u200F\u2028-\u202F\u205F\u2060-\u206F\u3000\u0001-\u001F\u007F-\u009F\u00AD\u061C\uFEFF]'
   AND (SELECT count(*) >= 2 FROM regexp_matches(value, '[[:alpha:]][[:alpha:]\u0300-\u036F]*', 'g'))
   AND (NOT arabic OR value ~ '[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]')
$$;
CREATE FUNCTION person_profile_text_valid(value text, maximum integer) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT value IS NULL OR (value IS NFC NORMALIZED AND char_length(value) BETWEEN 1 AND maximum
   AND value = btrim(value, E' \t\n\r\f\x0b\u00a0')
   AND value !~ '[\t\n\r\f\v\u00A0\u1680\u2000-\u200F\u2028-\u202F\u205F\u2060-\u206F\u3000\u0001-\u001F\u007F-\u009F\u00AD\u061C\uFEFF]')
$$;
CREATE TABLE person_profiles (
 principal_id text PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
 display_name text CHECK (display_name IS NULL OR person_profile_name_valid(display_name,false)), display_name_updated_at timestamptz,
 arabic_name text CHECK (arabic_name IS NULL OR person_profile_name_valid(arabic_name,true)), arabic_name_updated_at timestamptz,
 objective text CHECK (person_profile_text_valid(objective,100)), objective_updated_at timestamptz,
 introduction text CHECK (person_profile_text_valid(introduction,5000)), introduction_updated_at timestamptz,
 preferred_time text CHECK (person_profile_text_valid(preferred_time,100)), preferred_time_updated_at timestamptz,
 CHECK ((display_name_updated_at IS NULL) = (display_name IS NULL))
);
-- Extend the existing profile.safe_write receipt vocabulary in place; values remain impossible.
CREATE OR REPLACE FUNCTION authorization_audit_summary_valid(audit_operation text, summary jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE
  WHEN audit_operation='principal.register' THEN jsonb_typeof(summary)='object'
   AND summary ?& ARRAY['existed','identityCount','displayNamePresent','emailPresent']
   AND summary-ARRAY['existed','identityCount','displayNamePresent','emailPresent']='{}'::jsonb
   AND jsonb_typeof(summary->'existed')='boolean' AND jsonb_typeof(summary->'displayNamePresent')='boolean'
   AND jsonb_typeof(summary->'emailPresent')='boolean' AND jsonb_typeof(summary->'identityCount')='number'
   AND summary->>'identityCount' ~ '^(0|[1-9][0-9]{0,17})$'
  WHEN audit_operation IN ('grants.grant','grants.revoke','grants.clear') THEN jsonb_typeof(summary)='object'
   AND summary ?& ARRAY['grantCount','selfCount','subtreeCount']
   AND summary-ARRAY['grantCount','selfCount','subtreeCount']='{}'::jsonb
   AND jsonb_typeof(summary->'grantCount')='number' AND jsonb_typeof(summary->'selfCount')='number'
   AND jsonb_typeof(summary->'subtreeCount')='number'
   AND summary->>'grantCount' ~ '^(0|[1-9][0-9]{0,17})$' AND summary->>'selfCount' ~ '^(0|[1-9][0-9]{0,17})$'
   AND summary->>'subtreeCount' ~ '^(0|[1-9][0-9]{0,17})$'
  WHEN audit_operation='profile.safe_write' THEN jsonb_typeof(summary)='object' AND
   ((summary ?& ARRAY['valuePresent'] AND summary-ARRAY['valuePresent']='{}'::jsonb AND jsonb_typeof(summary->'valuePresent')='boolean') OR
   (summary ?& ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']
   AND summary-ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']='{}'::jsonb
   AND summary->'fields' IN ('["language"]','["display_name"]','["arabic_name"]','["objective"]','["introduction"]','["preferred_time"]')
   AND jsonb_typeof(summary->'contractVersion')='string' AND summary->>'contractVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
   AND summary->>'personRef' ~ '^[0-9a-f]{64}$' AND summary->>'changeSetDigest' ~ '^[0-9a-f]{64}$'
   AND summary->>'tokenRef' ~ '^[0-9a-f]{64}$' AND jsonb_typeof(summary->'committedAt')='string'
   AND summary->>'committedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'))
  ELSE false END
$$;
ALTER TABLE authorization_mutation_audit
 DROP CONSTRAINT auth_audit_before_summary_shape,
 DROP CONSTRAINT auth_audit_after_summary_shape;
ALTER TABLE authorization_mutation_audit
 ADD CONSTRAINT auth_audit_before_summary_shape CHECK (authorization_audit_summary_valid(operation,before_summary)),
 ADD CONSTRAINT auth_audit_after_summary_shape CHECK (authorization_audit_summary_valid(operation,after_summary));
