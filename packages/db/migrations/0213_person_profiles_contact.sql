-- SHU-417: person-owned phone and public profile handle. NULL means not recorded.
ALTER TABLE person_profiles
 ADD COLUMN phone text CHECK (phone IS NULL OR phone ~ '^\+[0-9]{8,15}$'),
 ADD COLUMN phone_written_at timestamptz CHECK (phone IS NULL OR phone_written_at IS NOT NULL),
 ADD COLUMN profile_handle text CHECK (profile_handle IS NULL OR profile_handle ~ '^[a-z][a-z0-9._-]{2,29}$'),
 ADD COLUMN profile_handle_written_at timestamptz CHECK (profile_handle IS NULL OR profile_handle_written_at IS NOT NULL);

CREATE UNIQUE INDEX person_profiles_phone_uq ON person_profiles (phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX person_profiles_profile_handle_uq ON person_profiles (profile_handle) WHERE profile_handle IS NOT NULL;

DO $migration$
DECLARE definition text;
DECLARE previous_fields constant text := $$IN ('language','displayName','arabicName','objective','intro','preferredTime','gender','birthDate','drivingLicence','jobSearchStatus')$$;
DECLARE current_fields constant text := $$IN ('language','displayName','arabicName','objective','intro','preferredTime','gender','birthDate','drivingLicence','jobSearchStatus','phone','handle')$$;
BEGIN
 SELECT pg_get_functiondef('authorization_audit_summary_valid(text,jsonb)'::regprocedure) INTO definition;
 IF definition NOT LIKE '%' || previous_fields || '%' OR definition LIKE '%' || current_fields || '%' THEN RAISE EXCEPTION 'unexpected authorization audit validator'; END IF;
 EXECUTE replace(definition, previous_fields, current_fields);
END
$migration$;
