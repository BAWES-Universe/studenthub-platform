-- SHU-381 (contract tokens retain SHU-372): five person-owned profile text fields.
CREATE TABLE person_profiles (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  display_name TEXT, display_name_updated_at TIMESTAMPTZ,
  arabic_name TEXT, arabic_name_updated_at TIMESTAMPTZ,
  objective TEXT, objective_updated_at TIMESTAMPTZ,
  introduction TEXT, introduction_updated_at TIMESTAMPTZ,
  preferred_time TEXT, preferred_time_updated_at TIMESTAMPTZ,
  written_fields TEXT[] NOT NULL DEFAULT '{}',
  CHECK (written_fields <@ ARRAY['displayName','arabicName','objective','intro','preferredTime'])
);

-- 0183 owns the Unicode-16 forbidden list. Reusing its predicate keeps the
-- application/database character rule identical without depending on the
-- PostgreSQL server's Unicode version. The surrounding "Ab" satisfies its
-- beneficiary-specific minimum while leaving the candidate text untouched.
CREATE FUNCTION person_profile_text_valid(value TEXT, maximum INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE offset_at INTEGER := 1;
BEGIN
  IF value IS NOT NFKC NORMALIZED OR char_length(value) NOT BETWEEN 1 AND maximum
    OR value ~ '^\s|\s$|\s\s' THEN RETURN FALSE; END IF;
  -- candidate_beneficiary_name_valid carries 0183's exact forbidden ranges but
  -- also has its own 70-character field maximum. Check bounded slices between
  -- safe ASCII letters; whitespace shape is checked across the whole value.
  WHILE offset_at <= char_length(value) LOOP
    IF NOT candidate_beneficiary_name_valid('Ab' || substr(value,offset_at,60) || 'Cd') THEN RETURN FALSE; END IF;
    offset_at := offset_at + 60;
  END LOOP;
  RETURN TRUE;
END
$$;

ALTER TABLE person_profiles ADD CONSTRAINT person_profiles_values_valid CHECK (
  (display_name IS NULL OR (person_profile_text_valid(display_name,255) AND display_name ~ ' ')) AND
  (arabic_name IS NULL OR (person_profile_text_valid(arabic_name,255) AND arabic_name ~ ' ' AND arabic_name ~ '[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]')) AND
  (objective IS NULL OR person_profile_text_valid(objective,100)) AND
  (introduction IS NULL OR person_profile_text_valid(introduction,5000)) AND
  (preferred_time IS NULL OR person_profile_text_valid(preferred_time,100))
);

-- Broaden only the closed receipt field position in 0147's validator.
-- pg_get_functiondef is server-authored trusted SQL; the exact old fragment is
-- asserted so migration drift cannot silently weaken the receipt shape.
DO $$
DECLARE definition TEXT;
BEGIN
  SELECT pg_get_functiondef('authorization_audit_summary_valid(text,jsonb)'::regprocedure) INTO definition;
  IF position('summary -> ''fields'' = ''["language"]''::jsonb' in definition) = 0 THEN
    RAISE EXCEPTION 'unexpected authorization audit summary validator';
  END IF;
  definition := replace(definition,
    'summary -> ''fields'' = ''["language"]''::jsonb',
    'summary -> ''fields'' IN (''["language"]''::jsonb,''["displayName"]''::jsonb,''["arabicName"]''::jsonb,''["objective"]''::jsonb,''["intro"]''::jsonb,''["preferredTime"]''::jsonb)');
  EXECUTE definition;
END $$;
