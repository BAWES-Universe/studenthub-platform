-- SHU-398: structured person profile choices and work availability.
ALTER TABLE person_profiles
 ADD COLUMN gender text CHECK (gender IN ('male','female','other')),
 ADD COLUMN gender_written_at timestamptz,
 ADD COLUMN birth_date date CHECK (birth_date <= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuwait')::date - INTERVAL '16 years')::date),
 ADD COLUMN birth_date_written_at timestamptz,
 ADD COLUMN nationality_id uuid REFERENCES catalogue_items(id),
 ADD COLUMN nationality_written_at timestamptz,
 ADD COLUMN university_id uuid REFERENCES catalogue_items(id),
 ADD COLUMN university_written_at timestamptz,
 ADD COLUMN driving_licence boolean,
 ADD COLUMN driving_licence_written_at timestamptz,
 ADD COLUMN kuwaiti_mother boolean,
 ADD COLUMN kuwaiti_mother_written_at timestamptz,
 ADD COLUMN job_search_status text CHECK (job_search_status IN ('not_looking','active','open_to_offers')),
 ADD COLUMN job_search_status_written_at timestamptz;

CREATE INDEX person_profiles_nationality_id_idx ON person_profiles(nationality_id);
CREATE INDEX person_profiles_university_id_idx ON person_profiles(university_id);

ALTER FUNCTION authorization_audit_summary_valid(text,jsonb) RENAME TO authorization_audit_summary_valid_0211;
CREATE FUNCTION authorization_audit_summary_valid(audit_operation text, summary jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT authorization_audit_summary_valid_0211(audit_operation,summary)
 OR (audit_operation='profile.safe_write'
   AND summary ?& ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']
   AND summary-ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']='{}'::jsonb
   AND summary->'fields'->>0 IN ('gender','birthDate','nationality','university','drivingLicence','kuwaitiMother','jobSearchStatus')
   AND jsonb_typeof(summary->'fields')='array' AND jsonb_array_length(summary->'fields')=1
   AND summary->>'contractVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
   AND summary->>'personRef' ~ '^[0-9a-f]{64}$' AND summary->>'changeSetDigest' ~ '^[0-9a-f]{64}$'
   AND summary->>'tokenRef' ~ '^[0-9a-f]{64}$'
   AND summary->>'committedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
$$;
ALTER TABLE authorization_mutation_audit DROP CONSTRAINT auth_audit_before_summary_shape, DROP CONSTRAINT auth_audit_after_summary_shape;
ALTER TABLE authorization_mutation_audit
 ADD CONSTRAINT auth_audit_before_summary_shape CHECK (authorization_audit_summary_valid(operation,before_summary)),
 ADD CONSTRAINT auth_audit_after_summary_shape CHECK (authorization_audit_summary_valid(operation,after_summary));

CREATE FUNCTION person_profile_ref_in_catalogue(ref uuid, wanted text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT ref IS NULL OR EXISTS (SELECT 1 FROM catalogue_items WHERE id=ref AND catalogue_type=wanted AND status='active')
$$;

CREATE FUNCTION person_profile_choices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT person_profile_ref_in_catalogue(NEW.nationality_id,'country') THEN RAISE EXCEPTION 'invalid nationality' USING ERRCODE='23514'; END IF;
 IF NOT person_profile_ref_in_catalogue(NEW.university_id,'university') THEN RAISE EXCEPTION 'invalid university' USING ERRCODE='23514'; END IF;
 IF NEW.kuwaiti_mother IS NOT NULL AND EXISTS (SELECT 1 FROM catalogue_items WHERE id=NEW.nationality_id AND catalogue_type='country' AND code='KW') THEN
   RAISE EXCEPTION 'kuwaiti mother is inapplicable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER person_profile_choices_guard BEFORE INSERT OR UPDATE OF nationality_id,university_id,kuwaiti_mother ON person_profiles
 FOR EACH ROW EXECUTE FUNCTION person_profile_choices_guard();
