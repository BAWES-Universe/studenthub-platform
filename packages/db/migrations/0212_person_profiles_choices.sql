ALTER TABLE person_profiles
  ADD COLUMN gender text,
  ADD COLUMN gender_written_at timestamptz,
  ADD COLUMN birth_date date,
  ADD COLUMN birth_date_written_at timestamptz,
  ADD COLUMN nationality_id uuid,
  ADD COLUMN nationality_written_at timestamptz,
  ADD COLUMN university_id uuid,
  ADD COLUMN university_written_at timestamptz,
  ADD COLUMN driving_licence boolean,
  ADD COLUMN driving_licence_written_at timestamptz,
  ADD COLUMN kuwaiti_mother boolean,
  ADD COLUMN kuwaiti_mother_written_at timestamptz,
  ADD COLUMN job_search_status text,
  ADD COLUMN job_search_status_written_at timestamptz,
  ADD CONSTRAINT person_profiles_gender_ck CHECK (gender IS NULL OR gender IN ('male','female','other')),
  ADD CONSTRAINT person_profiles_job_search_ck CHECK (job_search_status IS NULL OR job_search_status IN ('not_looking','active','open_to_offers')),
  ADD CONSTRAINT person_profiles_nationality_fk FOREIGN KEY (nationality_id) REFERENCES catalogue_items(id),
  ADD CONSTRAINT person_profiles_university_fk FOREIGN KEY (university_id) REFERENCES catalogue_items(id);

CREATE OR REPLACE FUNCTION person_profile_choice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nationality_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM catalogue_items WHERE id=NEW.nationality_id AND catalogue_type='country' AND status='active') THEN
    RAISE EXCEPTION 'invalid nationality' USING ERRCODE='23514';
  END IF;
  IF NEW.university_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM catalogue_items WHERE id=NEW.university_id AND catalogue_type='university' AND status='active') THEN
    RAISE EXCEPTION 'invalid university' USING ERRCODE='23514';
  END IF;
  IF NEW.kuwaiti_mother IS NOT NULL AND EXISTS
    (SELECT 1 FROM catalogue_items WHERE id=NEW.nationality_id AND catalogue_type='country' AND code='KW') THEN
    RAISE EXCEPTION 'kuwaiti mother not applicable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER person_profile_choice_guard BEFORE INSERT OR UPDATE ON person_profiles
FOR EACH ROW EXECUTE FUNCTION person_profile_choice_guard();

CREATE INDEX person_profiles_nationality_idx ON person_profiles(nationality_id) WHERE nationality_id IS NOT NULL;
CREATE INDEX person_profiles_university_idx ON person_profiles(university_id) WHERE university_id IS NOT NULL;

DO $$
DECLARE old_body text; new_body text;
BEGIN
  SELECT prosrc INTO old_body FROM pg_proc WHERE oid = 'authorization_audit_summary_valid(text,jsonb)'::regprocedure;
  new_body := replace(old_body,
    $needle$IN ('language','displayName','arabicName','objective','intro','preferredTime')$needle$,
    $replacement$IN ('language','displayName','arabicName','objective','intro','preferredTime','gender','birthDate','nationality','university','drivingLicence','kuwaitiMother','jobSearchStatus')$replacement$);
  IF new_body = old_body THEN RAISE EXCEPTION 'profile safe-write audit whitelist was not found'; END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION authorization_audit_summary_valid(TEXT,JSONB) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS %L', new_body);
END $$;
