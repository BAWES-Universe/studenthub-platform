-- SHU-404: platform-owned profile choices.
ALTER TABLE person_profiles
 ADD COLUMN gender text,
 ADD COLUMN gender_written_at timestamptz,
 ADD COLUMN birth_date date,
 ADD COLUMN birth_date_written_at timestamptz,
 ADD COLUMN nationality_id uuid REFERENCES catalogue_items(id),
 ADD COLUMN nationality_written_at timestamptz,
 ADD COLUMN university_id uuid REFERENCES catalogue_items(id),
 ADD COLUMN university_written_at timestamptz,
 ADD COLUMN driving_licence boolean,
 ADD COLUMN driving_licence_written_at timestamptz,
 ADD COLUMN kuwaiti_mother boolean,
 ADD COLUMN kuwaiti_mother_written_at timestamptz,
 ADD COLUMN job_search_status text,
 ADD COLUMN job_search_status_written_at timestamptz,
 ADD CONSTRAINT person_profiles_gender_valid CHECK (gender IS NULL OR gender IN ('male','female','other')),
 ADD CONSTRAINT person_profiles_birth_date_valid CHECK (birth_date IS NULL OR birth_date <= CURRENT_DATE),
 ADD CONSTRAINT person_profiles_job_search_valid CHECK (job_search_status IS NULL OR job_search_status IN ('not_looking','active','open_to_offers')),
 ADD CONSTRAINT person_profiles_choice_times CHECK (
   (gender IS NULL OR gender_written_at IS NOT NULL) AND
   (birth_date IS NULL OR birth_date_written_at IS NOT NULL) AND
   (nationality_id IS NULL OR nationality_written_at IS NOT NULL) AND
   (university_id IS NULL OR university_written_at IS NOT NULL) AND
   (driving_licence IS NULL OR driving_licence_written_at IS NOT NULL) AND
   (kuwaiti_mother IS NULL OR kuwaiti_mother_written_at IS NOT NULL) AND
   (job_search_status IS NULL OR job_search_status_written_at IS NOT NULL));

CREATE FUNCTION person_profile_kuwaiti_mother_valid(country_id uuid, flag boolean)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT flag IS NULL OR country_id IS NULL OR NOT EXISTS
   (SELECT 1 FROM catalogue_items WHERE id=country_id AND catalogue_type='country' AND code='KW')
$$;
ALTER TABLE person_profiles ADD CONSTRAINT person_profiles_kuwaiti_mother_valid
 CHECK (person_profile_kuwaiti_mother_valid(nationality_id,kuwaiti_mother));

-- Preserve the complete validator installed by 0211 and widen only this operation.
ALTER FUNCTION authorization_audit_summary_valid(text,jsonb) RENAME TO authorization_audit_summary_valid_0211;
CREATE FUNCTION authorization_audit_summary_valid(audit_operation text, summary jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT authorization_audit_summary_valid_0211(audit_operation,summary) OR
  (audit_operation='profile.safe_write' AND jsonb_typeof(summary)='object' AND
   summary ?& ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef'] AND
   summary-ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']='{}'::jsonb AND
   jsonb_typeof(summary->'contractVersion')='string' AND summary->>'contractVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+$' AND
   jsonb_typeof(summary->'personRef')='string' AND summary->>'personRef' ~ '^[0-9a-f]{64}$' AND
   jsonb_typeof(summary->'changeSetDigest')='string' AND summary->>'changeSetDigest' ~ '^[0-9a-f]{64}$' AND
   jsonb_typeof(summary->'tokenRef')='string' AND summary->>'tokenRef' ~ '^[0-9a-f]{64}$' AND
   jsonb_typeof(summary->'fields')='array' AND jsonb_array_length(summary->'fields')=1 AND
   summary->'fields'->>0 IN ('gender','birthDate','nationality','university','drivingLicence','kuwaitiMother','jobSearchStatus') AND
   jsonb_typeof(summary->'committedAt')='string' AND summary->>'committedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
$$;

-- CHECK expressions retain function OIDs across a rename. Recreate the two
-- constraints so they bind to the widened function above, not the 0211 body.
ALTER TABLE authorization_mutation_audit
 DROP CONSTRAINT auth_audit_before_summary_shape,
 DROP CONSTRAINT auth_audit_after_summary_shape,
 ADD CONSTRAINT auth_audit_before_summary_shape
   CHECK (authorization_audit_summary_valid(operation,before_summary)),
 ADD CONSTRAINT auth_audit_after_summary_shape
   CHECK (authorization_audit_summary_valid(operation,after_summary));
