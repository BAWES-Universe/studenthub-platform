-- SHU-373: platform-owned profile choices. Catalogue references retain their
-- ids; names remain catalogue-owned. The two FKs also provide indexed lookup
-- columns via the explicit indexes below.
ALTER TABLE person_profiles
 ADD COLUMN gender text CHECK (gender IN ('male','female','other')),
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
 ADD COLUMN job_search_status text CHECK (job_search_status IN ('not_looking','active','open_to_offers')),
 ADD COLUMN job_search_status_written_at timestamptz CHECK (job_search_status IS NULL OR job_search_status_written_at IS NOT NULL);

-- PostgreSQL does not permit a subquery in a CHECK constraint. Enforce the
-- cross-table invariant with a constraint trigger, while the store checks it
-- in the same transaction for a useful safe-write refusal.
CREATE FUNCTION person_profile_ref_valid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.nationality_id IS NOT NULL AND NOT EXISTS
   (SELECT 1 FROM catalogue_items WHERE id=NEW.nationality_id AND catalogue_type='country' AND status='active') THEN
   RAISE EXCEPTION 'invalid nationality' USING ERRCODE='23514';
 END IF;
 IF NEW.university_id IS NOT NULL AND NOT EXISTS
   (SELECT 1 FROM catalogue_items WHERE id=NEW.university_id AND catalogue_type='university' AND status='active') THEN
   RAISE EXCEPTION 'invalid university' USING ERRCODE='23514';
 END IF;
 IF NEW.kuwaiti_mother IS TRUE AND EXISTS
   (SELECT 1 FROM catalogue_items WHERE id=NEW.nationality_id AND catalogue_type='country' AND code='KW') THEN
   RAISE EXCEPTION 'Kuwaiti mother cannot accompany Kuwaiti nationality' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER person_profiles_reference_choices
 AFTER INSERT OR UPDATE OF nationality_id,university_id,kuwaiti_mother ON person_profiles
 DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION person_profile_ref_valid();

CREATE INDEX person_profiles_nationality_id_idx ON person_profiles(nationality_id);
CREATE INDEX person_profiles_university_id_idx ON person_profiles(university_id);

-- Extend the existing audit validator without duplicating its long definition.
DO $body$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('authorization_audit_summary_valid(text,jsonb)'::regprocedure) INTO definition;
 definition := replace(definition, '''preferredTime'')',
   '''preferredTime'',''gender'',''birthDate'',''nationality'',''university'',''drivingLicence'',''jobSearchStatus'')');
 EXECUTE definition;
END $body$;
