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
-- PostgreSQL server's Unicode version. Safe padding satisfies its
-- beneficiary-specific minimum while leaving each candidate point isolated.
CREATE FUNCTION person_profile_text_valid(value TEXT, maximum INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE offset_at INTEGER := 1; candidate TEXT;
BEGIN
  IF value IS NOT NFKC NORMALIZED OR char_length(value) NOT BETWEEN 1 AND maximum
    OR value ~ '^\s|\s$|\s\s' THEN RETURN FALSE; END IF;
  -- Check each code point against 0183's generated Unicode list. A space is
  -- already governed above; every other character is isolated after a space,
  -- so a combining mark at a chunk boundary cannot compose with our padding.
  WHILE offset_at <= char_length(value) LOOP
    candidate := substr(value,offset_at,1);
    IF candidate <> ' ' AND NOT candidate_beneficiary_name_valid('A ' || candidate || ' Cd') THEN RETURN FALSE; END IF;
    offset_at := offset_at + 1;
  END LOOP;
  RETURN TRUE;
END
$$;

ALTER TABLE person_profiles ADD CONSTRAINT person_profiles_values_valid CHECK (
  (display_name IS NULL OR (person_profile_text_valid(display_name,255) AND display_name ~ ' ')) AND
  (arabic_name IS NULL OR (person_profile_text_valid(arabic_name,255) AND arabic_name ~ ' ' AND arabic_name ~ '[\u0620-\u064A\u066E-\u06D3\u06D5\u06EE-\u06EF\u06FA-\u06FC\u06FF\u0750-\u077F\u0870-\u0887\u0889-\u088F\u08A0-\u08C9\uFB50-\uFBC2\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFEFC]')) AND
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
  IF definition !~ 'summary\s*->\s*''fields''\s*=\s*''\["language"\]''::jsonb' THEN
    RAISE EXCEPTION 'unexpected authorization audit summary validator';
  END IF;
  definition := regexp_replace(definition,
    'summary\s*->\s*''fields''\s*=\s*''\["language"\]''::jsonb',
    'summary -> ''fields'' IN (''["language"]''::jsonb,''["displayName"]''::jsonb,''["arabicName"]''::jsonb,''["objective"]''::jsonb,''["intro"]''::jsonb,''["preferredTime"]''::jsonb)');
  EXECUTE definition;
END $$;
