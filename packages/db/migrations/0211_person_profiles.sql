-- SHU-372: platform-owned person profile text. Column names deliberately match
-- the approved import mapping so SHU-103 writes into this same row.
CREATE TABLE person_profiles (
  principal_id text PRIMARY KEY REFERENCES principals(id),
  candidate_name text CHECK (candidate_name IS NULL OR (char_length(candidate_name) BETWEEN 1 AND 255 AND btrim(candidate_name) <> '' AND btrim(candidate_name) ~ '[[:space:]]')),
  candidate_name_ar text CHECK (candidate_name_ar IS NULL OR (char_length(candidate_name_ar) BETWEEN 1 AND 255 AND btrim(candidate_name_ar) <> '' AND btrim(candidate_name_ar) ~ '[[:space:]]')),
  candidate_objective text CHECK (candidate_objective IS NULL OR (char_length(candidate_objective) BETWEEN 1 AND 100 AND btrim(candidate_objective) <> '')),
  candidate_intro text CHECK (candidate_intro IS NULL OR (char_length(candidate_intro) BETWEEN 1 AND 5000 AND btrim(candidate_intro) <> '')),
  candidate_preferred_time text CHECK (candidate_preferred_time IS NULL OR (char_length(candidate_preferred_time) BETWEEN 1 AND 100 AND btrim(candidate_preferred_time) <> '')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Preserve the accumulated audit grammar and extend only profile.safe_write.
ALTER FUNCTION authorization_audit_summary_valid(text,jsonb) RENAME TO authorization_audit_summary_valid_pre_0211;
CREATE FUNCTION authorization_audit_summary_valid(audit_operation text, summary jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN audit_operation='profile.safe_write' AND jsonb_typeof(summary)='object' THEN
   (summary ?& ARRAY['valuePresent'] AND summary-ARRAY['valuePresent']='{}'::jsonb AND jsonb_typeof(summary->'valuePresent')='boolean')
   OR (summary ?& ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']
    AND summary-ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']='{}'::jsonb
    AND jsonb_typeof(summary->'contractVersion')='string' AND summary->>'contractVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    AND jsonb_typeof(summary->'personRef')='string' AND summary->>'personRef' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(summary->'changeSetDigest')='string' AND summary->>'changeSetDigest' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(summary->'tokenRef')='string' AND summary->>'tokenRef' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(summary->'fields')='array' AND jsonb_array_length(summary->'fields')=1
    AND summary->'fields'->>0 IN ('language','display_name','arabic_name','objective','intro','preferred_time')
    AND jsonb_typeof(summary->'committedAt')='string' AND summary->>'committedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
 ELSE authorization_audit_summary_valid_pre_0211(audit_operation,summary) END
$$;

ALTER TABLE authorization_mutation_audit
 DROP CONSTRAINT auth_audit_before_summary_shape,
 DROP CONSTRAINT auth_audit_after_summary_shape,
 ADD CONSTRAINT auth_audit_before_summary_shape CHECK (authorization_audit_summary_valid(operation,before_summary)),
 ADD CONSTRAINT auth_audit_after_summary_shape CHECK (authorization_audit_summary_valid(operation,after_summary));
