-- SHU-413: platform-owned personal choices. Age eligibility is enforced by the
-- application setting; the database deliberately constrains only the date shape.
ALTER TABLE person_profiles
 ADD COLUMN gender text CHECK (gender IS NULL OR gender IN ('male','female','other')),
 ADD COLUMN gender_written_at timestamptz CHECK (gender IS NULL OR gender_written_at IS NOT NULL),
 ADD COLUMN birth_date date,
 ADD COLUMN birth_date_written_at timestamptz CHECK (birth_date IS NULL OR birth_date_written_at IS NOT NULL),
 ADD COLUMN driving_licence boolean,
 ADD COLUMN driving_licence_written_at timestamptz CHECK (driving_licence IS NULL OR driving_licence_written_at IS NOT NULL),
 ADD COLUMN job_search_status text CHECK (job_search_status IS NULL OR job_search_status IN ('not_looking','active','open_to_offers')),
 ADD COLUMN job_search_status_written_at timestamptz CHECK (job_search_status IS NULL OR job_search_status_written_at IS NOT NULL);

-- Preserve the complete audit validator accumulated by earlier migrations while
-- restating profile.safe_write's field list with this card's four fields added.
DO $migration$
DECLARE definition text;
DECLARE previous_fields constant text := $$IN ('language','displayName','arabicName','objective','intro','preferredTime')$$;
DECLARE current_fields constant text := $$IN ('language','displayName','arabicName','objective','intro','preferredTime','gender','birthDate','drivingLicence','jobSearchStatus')$$;
BEGIN
 SELECT pg_get_functiondef('authorization_audit_summary_valid(text,jsonb)'::regprocedure) INTO definition;
 IF definition NOT LIKE '%' || previous_fields || '%' OR definition LIKE '%' || current_fields || '%' THEN
  RAISE EXCEPTION 'unexpected authorization audit validator';
 END IF;
 EXECUTE replace(definition, previous_fields, current_fields);
END
$migration$;
