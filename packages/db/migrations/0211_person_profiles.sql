-- SHU-372: platform-owned person profile text. Column names deliberately match
-- the approved import mapping so SHU-103 writes into this same row.
CREATE FUNCTION person_profile_text_valid(value text, maximum integer) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT char_length(value) BETWEEN 1 AND maximum
   AND value !~ '^[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
   AND value !~ '[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]'
$$;

CREATE FUNCTION person_profile_name_valid(value text, arabic boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT person_profile_text_valid(value,255)
   AND value ~ '[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
   AND (NOT arabic OR value ~ '[\u0620-\u064A\u066E-\u06D3\u06FA-\u06FC\u0750-\u077F\u08A0-\u08C9\uFB50-\uFBC2\uFBD3-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFEFC]')
$$;

CREATE TABLE person_profiles (
  principal_id text PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  candidate_name text CHECK (candidate_name IS NULL OR person_profile_name_valid(candidate_name,false)),
  candidate_name_updated_at timestamptz,
  candidate_name_ar text CHECK (candidate_name_ar IS NULL OR person_profile_name_valid(candidate_name_ar,true)),
  candidate_name_ar_updated_at timestamptz,
  candidate_objective text CHECK (candidate_objective IS NULL OR person_profile_text_valid(candidate_objective,100)),
  candidate_objective_updated_at timestamptz,
  candidate_intro text CHECK (candidate_intro IS NULL OR person_profile_text_valid(candidate_intro,5000)),
  candidate_intro_updated_at timestamptz,
  candidate_preferred_time text CHECK (candidate_preferred_time IS NULL OR person_profile_text_valid(candidate_preferred_time,100)),
  candidate_preferred_time_updated_at timestamptz,
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
