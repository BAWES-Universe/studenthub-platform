-- SHU-420: person-owned origin and education choices. References are catalogue
-- ids; names remain catalogue-owned and are resolved only for display.
ALTER TABLE person_profiles
 ADD COLUMN nationality_id uuid REFERENCES catalogue_items(id),
 ADD COLUMN nationality_id_written_at timestamptz CHECK (nationality_id IS NULL OR nationality_id_written_at IS NOT NULL),
 ADD COLUMN university_id uuid REFERENCES catalogue_items(id),
 ADD COLUMN university_id_written_at timestamptz CHECK (university_id IS NULL OR university_id_written_at IS NOT NULL),
 ADD COLUMN kuwaiti_mother boolean,
 ADD COLUMN kuwaiti_mother_written_at timestamptz CHECK (kuwaiti_mother IS NULL OR kuwaiti_mother_written_at IS NOT NULL);

CREATE INDEX person_profiles_nationality_id_idx ON person_profiles (nationality_id);
CREATE INDEX person_profiles_university_id_idx ON person_profiles (university_id);

CREATE FUNCTION person_profile_origin_valid() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
 IF NEW.kuwaiti_mother IS TRUE AND EXISTS (
   SELECT 1 FROM catalogue_items WHERE id=NEW.nationality_id AND catalogue_type='country' AND code='KW'
 ) THEN RAISE EXCEPTION 'Kuwaiti mother is not applicable to Kuwaiti nationality' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END
$function$;
CREATE TRIGGER person_profiles_origin_valid BEFORE INSERT OR UPDATE OF nationality_id,kuwaiti_mother ON person_profiles
 FOR EACH ROW EXECUTE FUNCTION person_profile_origin_valid();

DO $migration$
DECLARE definition text;
DECLARE previous_fields constant text := $$IN ('language','displayName','arabicName','objective','intro','preferredTime','gender','birthDate','drivingLicence','jobSearchStatus','phone','handle')$$;
DECLARE current_fields constant text := $$IN ('language','displayName','arabicName','objective','intro','preferredTime','gender','birthDate','drivingLicence','jobSearchStatus','phone','handle','nationality','university','kuwaitiMother')$$;
BEGIN
 SELECT pg_get_functiondef('authorization_audit_summary_valid(text,jsonb)'::regprocedure) INTO definition;
 IF definition NOT LIKE '%' || previous_fields || '%' OR definition LIKE '%' || current_fields || '%' THEN RAISE EXCEPTION 'unexpected authorization audit validator'; END IF;
 EXECUTE replace(definition, previous_fields, current_fields);
END
$migration$;
