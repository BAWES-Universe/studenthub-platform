-- SHU-384: platform-owned text fields.  A written marker is deliberately
-- separate from the nullable value so a clear never falls back to import data.
CREATE TABLE person_profiles (
  principal_id text PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  name text, name_written boolean NOT NULL DEFAULT false, name_updated_at timestamptz,
  name_ar text, name_ar_written boolean NOT NULL DEFAULT false, name_ar_updated_at timestamptz,
  objective text, objective_written boolean NOT NULL DEFAULT false, objective_updated_at timestamptz,
  intro text, intro_written boolean NOT NULL DEFAULT false, intro_updated_at timestamptz,
  preferred_time text, preferred_time_written boolean NOT NULL DEFAULT false, preferred_time_updated_at timestamptz,
  CHECK (NOT name_written OR name_updated_at IS NOT NULL),
  CHECK (NOT name_ar_written OR name_ar_updated_at IS NOT NULL),
  CHECK (NOT objective_written OR objective_updated_at IS NOT NULL),
  CHECK (NOT intro_written OR intro_updated_at IS NOT NULL),
  CHECK (NOT preferred_time_written OR preferred_time_updated_at IS NOT NULL)
);

CREATE FUNCTION person_profile_text_valid(value text, maximum integer, require_two_names boolean, require_arabic boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT value IS NULL OR (
   value IS NFKC NORMALIZED AND char_length(value) BETWEEN 1 AND maximum
   AND value = btrim(value) AND value !~ '[[:space:]][[:space:]]'
   AND value !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFDD0-\uFDEF\uFFFE-\uFFFF]'
   AND NOT EXISTS (SELECT 1 FROM regexp_split_to_table(value, '') ch
                    WHERE ch <> ' ' AND NOT candidate_beneficiary_name_valid('A' || ch))
   AND (NOT require_two_names OR value ~ '[[:alpha:]].* [[:alpha:]]')
   AND (NOT require_arabic OR value ~ '[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]')
 )
$$;
ALTER TABLE person_profiles ADD CHECK(person_profile_text_valid(name,255,true,false)), ADD CHECK(person_profile_text_valid(name_ar,255,true,true)), ADD CHECK(person_profile_text_valid(objective,100,false,false)), ADD CHECK(person_profile_text_valid(intro,5000,false,false)), ADD CHECK(person_profile_text_valid(preferred_time,100,false,false));

-- 0147 deliberately admitted only language. Extend that closed receipt shape
-- without copying the long function (and accidentally losing later branches).
DO $do$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('authorization_audit_summary_valid(text,jsonb)'::regprocedure) INTO definition;
 definition := replace(definition,
   $$summary->'fields'='["language"]'::jsonb$$,
   $$summary->'fields'->>0 IN ('language','name','name_ar','objective','intro','preferred_time')$$);
 IF definition NOT LIKE '%''name''%' THEN RAISE EXCEPTION 'safe-write summary shape was not extended'; END IF;
 EXECUTE definition;
END $do$;

CREATE UNIQUE INDEX authorization_mutation_audit_person_profile_receipt ON authorization_mutation_audit(request_ref) WHERE operation='profile.safe_write';
