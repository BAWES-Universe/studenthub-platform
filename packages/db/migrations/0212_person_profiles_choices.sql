-- SHU-402: platform-owned profile choices and work availability.
ALTER TABLE person_profiles
 ADD COLUMN gender text CHECK (gender IS NULL OR gender IN ('male','female','other')),
 ADD COLUMN gender_written_at timestamptz CHECK (gender IS NULL OR gender_written_at IS NOT NULL),
 ADD COLUMN birth_date date,
 ADD COLUMN birth_date_written_at timestamptz CHECK (birth_date IS NULL OR birth_date_written_at IS NOT NULL),
 ADD COLUMN nationality_id uuid REFERENCES catalogue_items(id),
 ADD COLUMN nationality_written_at timestamptz CHECK (nationality_id IS NULL OR nationality_written_at IS NOT NULL),
 ADD COLUMN university_id uuid REFERENCES catalogue_items(id),
 ADD COLUMN university_written_at timestamptz CHECK (university_id IS NULL OR university_written_at IS NOT NULL),
 ADD COLUMN driving_licence boolean,
 ADD COLUMN driving_licence_written_at timestamptz CHECK (driving_licence IS NULL OR driving_licence_written_at IS NOT NULL),
 ADD COLUMN kuwaiti_mother boolean,
 ADD COLUMN kuwaiti_mother_written_at timestamptz CHECK (kuwaiti_mother IS NULL OR kuwaiti_mother_written_at IS NOT NULL),
 ADD COLUMN job_search_status text CHECK (job_search_status IS NULL OR job_search_status IN ('not_looking','active','open_to_offers')),
 ADD COLUMN job_search_status_written_at timestamptz CHECK (job_search_status IS NULL OR job_search_status_written_at IS NOT NULL);

CREATE INDEX person_profiles_nationality_id_idx ON person_profiles(nationality_id);
CREATE INDEX person_profiles_university_id_idx ON person_profiles(university_id);

CREATE FUNCTION person_profile_choices_valid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE nationality_code text;
BEGIN
 IF NEW.nationality_id IS NOT NULL THEN
  SELECT code INTO nationality_code FROM catalogue_items WHERE id=NEW.nationality_id AND catalogue_type='country' AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid nationality' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.university_id IS NOT NULL AND NOT EXISTS
   (SELECT 1 FROM catalogue_items WHERE id=NEW.university_id AND catalogue_type='university' AND status='active')
 THEN RAISE EXCEPTION 'invalid university' USING ERRCODE='23514'; END IF;
 IF NEW.kuwaiti_mother IS NOT NULL AND nationality_code='KW' THEN
  RAISE EXCEPTION 'Kuwaiti mother is inapplicable to Kuwaiti nationality' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER person_profile_choices_guard BEFORE INSERT OR UPDATE ON person_profiles
 FOR EACH ROW EXECUTE FUNCTION person_profile_choices_valid();

ALTER FUNCTION authorization_audit_summary_valid(text,jsonb) RENAME TO authorization_audit_summary_valid_0211;
CREATE FUNCTION authorization_audit_summary_valid(audit_operation text, summary jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT authorization_audit_summary_valid_0211(audit_operation,summary)
 OR (audit_operation='profile.safe_write'
   AND jsonb_typeof(summary)='object'
   AND summary ?& ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']
   AND summary-ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']='{}'::jsonb
   AND summary->>'contractVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
   AND summary->>'personRef' ~ '^[0-9a-f]{64}$' AND summary->>'changeSetDigest' ~ '^[0-9a-f]{64}$'
   AND summary->>'tokenRef' ~ '^[0-9a-f]{64}$' AND jsonb_array_length(summary->'fields')=1
   AND summary->'fields'->>0 IN ('gender','birthDate','nationality','university','drivingLicence','kuwaitiMother','jobSearchStatus')
   AND summary->>'committedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
$$;
ALTER TABLE authorization_mutation_audit DROP CONSTRAINT auth_audit_before_summary_shape;
ALTER TABLE authorization_mutation_audit DROP CONSTRAINT auth_audit_after_summary_shape;
ALTER TABLE authorization_mutation_audit ADD CONSTRAINT auth_audit_before_summary_shape
 CHECK (authorization_audit_summary_valid(operation,before_summary));
ALTER TABLE authorization_mutation_audit ADD CONSTRAINT auth_audit_after_summary_shape
 CHECK (authorization_audit_summary_valid(operation,after_summary));
