-- SHU-624: fixed-cost staff people directory lookup indexes; no mirrored data.
CREATE INDEX person_profiles_job_search_status_idx ON person_profiles (job_search_status);
CREATE INDEX person_profiles_names_search_idx ON person_profiles USING gin (to_tsvector('simple', coalesce(display_name, '') || ' ' || coalesce(arabic_name, '')));
CREATE INDEX principals_display_name_search_idx ON principals USING gin (to_tsvector('simple', coalesce(display_name, '')));
CREATE INDEX person_profiles_phone_reversed_idx ON person_profiles (reverse(phone) text_pattern_ops) WHERE phone IS NOT NULL;
CREATE INDEX person_civil_ids_expiry_idx ON person_civil_ids (expiry_date) WHERE released_at IS NULL;
CREATE INDEX civil_id_review_decisions_subject_revision_idx ON civil_id_review_decisions (subject_principal_id, civil_revision, decided_at DESC);
