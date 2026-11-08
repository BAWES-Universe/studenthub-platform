CREATE TABLE person_civil_ids (
 principal_id text PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
 country text CHECK (country IN ('KW','BH')),
 number_ciphertext bytea,
 number_hash bytea CHECK (number_hash IS NULL OR octet_length(number_hash)=32),
 key_version smallint,
 expiry_date date,
 needs_review boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
 written_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 released_at timestamptz,
 CHECK ((country IS NULL AND number_ciphertext IS NULL AND number_hash IS NULL AND key_version IS NULL)
     OR (country IS NOT NULL AND number_ciphertext IS NOT NULL AND number_hash IS NOT NULL AND key_version IS NOT NULL))
);
CREATE UNIQUE INDEX person_civil_ids_active_number ON person_civil_ids(country,number_hash)
 WHERE released_at IS NULL AND number_hash IS NOT NULL;
CREATE TABLE person_civil_id_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 submission_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind='person_changed'),
 changed text[] NOT NULL CHECK (changed <@ ARRAY['country','number','expiry']::text[] AND cardinality(changed)>0),
 occurred_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX person_civil_id_events_submission ON person_civil_id_events(principal_id,submission_id);
