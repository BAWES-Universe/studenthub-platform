DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'catalogue_items'::regclass
    AND conname = 'catalogue_items_catalogue_type_check';
  IF definition IS NULL OR definition <> 'CHECK ((catalogue_type = ANY (ARRAY[''country''::text, ''currency''::text, ''bank''::text, ''tag''::text, ''brand''::text, ''mall''::text, ''university''::text, ''major''::text, ''degree''::text, ''degree-group''::text])))' THEN
    RAISE EXCEPTION '0217 expected the ten-kind catalogue_items catalogue_type CHECK from 0146, found %', coalesce(definition, '<missing>');
  END IF;
  ALTER TABLE catalogue_items DROP CONSTRAINT catalogue_items_catalogue_type_check;
  ALTER TABLE catalogue_items ADD CONSTRAINT catalogue_items_catalogue_type_check CHECK (catalogue_type IN
    ('country','currency','bank','tag','brand','mall','university','major','degree','degree-group','area'));
END $$;

CREATE TABLE catalogue_area_details (
  area_id uuid PRIMARY KEY REFERENCES catalogue_items(id),
  name_ar text NOT NULL CHECK (name_ar = btrim(name_ar) AND char_length(name_ar) BETWEEN 1 AND 255),
  governorate_en text NOT NULL CHECK (governorate_en = btrim(governorate_en) AND char_length(governorate_en) BETWEEN 1 AND 255),
  governorate_ar text NOT NULL CHECK (governorate_ar = btrim(governorate_ar) AND char_length(governorate_ar) BETWEEN 1 AND 255),
  latitude numeric CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric CHECK (longitude BETWEEN -180 AND 180),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE FUNCTION enforce_catalogue_area_details_area()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalogue_items WHERE id = NEW.area_id AND catalogue_type = 'area') THEN
    RAISE EXCEPTION 'catalogue area details require an area item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalogue_area_details_area BEFORE INSERT OR UPDATE ON catalogue_area_details
FOR EACH ROW EXECUTE FUNCTION enforce_catalogue_area_details_area();

CREATE TABLE person_locations (
  principal_id text PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  area_id uuid REFERENCES catalogue_items(id),
  latitude numeric(9,6),
  longitude numeric(9,6),
  revision integer NOT NULL CHECK (revision >= 1),
  written_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);
CREATE INDEX person_locations_area_idx ON person_locations(area_id);

CREATE TABLE person_location_events (
  id bigserial PRIMARY KEY,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind = 'person_location_saved'),
  changed text[] NOT NULL CHECK (changed <@ ARRAY['area','coordinates']::text[] AND cardinality(changed) BETWEEN 1 AND 2),
  occurred_at timestamptz NOT NULL,
  UNIQUE (principal_id, submission_id)
);
CREATE INDEX person_location_events_principal_idx ON person_location_events(principal_id, occurred_at);
