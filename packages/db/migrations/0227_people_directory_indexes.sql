CREATE INDEX person_profiles_job_search_status_idx ON person_profiles(job_search_status);
CREATE INDEX person_profiles_names_fts_idx ON person_profiles USING gin(to_tsvector('simple',coalesce(display_name,'')||' '||coalesce(arabic_name,'')));
CREATE INDEX principals_display_name_fts_idx ON principals USING gin(to_tsvector('simple',coalesce(display_name,'')));
CREATE INDEX person_profiles_phone_reverse_idx ON person_profiles(reverse(phone) text_pattern_ops) WHERE phone IS NOT NULL;
CREATE INDEX person_civil_ids_expiry_active_idx ON person_civil_ids(expiry_date) WHERE released_at IS NULL;
CREATE INDEX civil_id_review_decisions_revision_idx ON civil_id_review_decisions(subject_principal_id,civil_revision,decided_at DESC,id);
