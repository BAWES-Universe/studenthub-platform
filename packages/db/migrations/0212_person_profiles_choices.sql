-- SHU-405: platform-owned profile choices. Catalogue ids remain references to
-- the shared catalogue; this migration never creates catalogue data.
ALTER TABLE person_profiles
 ADD COLUMN gender text CHECK (gender IN ('male','female','other')),
 ADD COLUMN gender_written_at timestamptz CHECK (gender IS NULL OR gender_written_at IS NOT NULL),
 -- The self-edit policy owns the configurable minimum-age rule and evaluates
 -- it on the UTC calendar day. Keep the database column date-only so there is
 -- one threshold setting rather than a second literal that can drift.
 ADD COLUMN birth_date date,
 ADD COLUMN birth_date_written_at timestamptz CHECK (birth_date IS NULL OR birth_date_written_at IS NOT NULL),
 ADD COLUMN nationality_id uuid REFERENCES catalogue_items(id),
 ADD COLUMN nationality_id_written_at timestamptz CHECK (nationality_id IS NULL OR nationality_id_written_at IS NOT NULL),
 ADD COLUMN university_id uuid REFERENCES catalogue_items(id),
 ADD COLUMN university_id_written_at timestamptz CHECK (university_id IS NULL OR university_id_written_at IS NOT NULL),
 ADD COLUMN driving_licence boolean,
 ADD COLUMN driving_licence_written_at timestamptz CHECK (driving_licence IS NULL OR driving_licence_written_at IS NOT NULL),
 ADD COLUMN kuwaiti_mother boolean,
 ADD COLUMN kuwaiti_mother_written_at timestamptz CHECK (kuwaiti_mother IS NULL OR kuwaiti_mother_written_at IS NOT NULL),
 ADD COLUMN job_search_status text CHECK (job_search_status IN ('not_looking','active','open_to_offers')),
 ADD COLUMN job_search_status_written_at timestamptz CHECK (job_search_status IS NULL OR job_search_status_written_at IS NOT NULL);

CREATE INDEX person_profiles_nationality_idx ON person_profiles(nationality_id) WHERE nationality_id IS NOT NULL;
CREATE INDEX person_profiles_university_idx ON person_profiles(university_id) WHERE university_id IS NOT NULL;

CREATE FUNCTION person_profile_choices_valid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.nationality_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catalogue_items WHERE id=NEW.nationality_id AND catalogue_type='country' AND status='active') THEN
  RAISE EXCEPTION 'invalid nationality' USING ERRCODE='23514';
 END IF;
 IF NEW.university_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catalogue_items WHERE id=NEW.university_id AND catalogue_type='university' AND status='active') THEN
  RAISE EXCEPTION 'invalid university' USING ERRCODE='23514';
 END IF;
 IF NEW.kuwaiti_mother IS NOT NULL AND EXISTS (SELECT 1 FROM catalogue_items WHERE id=NEW.nationality_id AND catalogue_type='country' AND code='KW') THEN
  RAISE EXCEPTION 'kuwaiti mother is not applicable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER person_profile_choices_check BEFORE INSERT OR UPDATE OF nationality_id,university_id,kuwaiti_mother ON person_profiles
 FOR EACH ROW EXECUTE FUNCTION person_profile_choices_valid();

-- Preserve the full current validator and extend only profile.safe_write's list.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('authorization_audit_summary_valid(text,jsonb)'::regprocedure) INTO definition;
 definition := replace(definition,
  '''language'',''displayName'',''arabicName'',''objective'',''intro'',''preferredTime''',
  '''language'',''displayName'',''arabicName'',''objective'',''intro'',''preferredTime'',''gender'',''birthDate'',''nationality'',''university'',''drivingLicence'',''kuwaitiMother'',''jobSearchStatus''');
 IF definition NOT LIKE '%''jobSearchStatus''%' THEN RAISE EXCEPTION 'audit validator profile field list not found'; END IF;
 EXECUTE definition;
END $$;
