CREATE TABLE civil_id_review_decisions (
 id uuid PRIMARY KEY,
 subject_principal_id text NOT NULL REFERENCES principals(id),
 reviewer_principal_id text NOT NULL REFERENCES principals(id),
 decision text NOT NULL CHECK (decision IN ('confirmed','rejected')),
 reason text,
 civil_revision integer NOT NULL,
 front_version uuid,
 back_version uuid,
 confirm_ref char(64) NOT NULL UNIQUE,
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (subject_principal_id <> reviewer_principal_id),
 CHECK ((decision='confirmed' AND reason IS NULL) OR
        (decision='rejected' AND char_length(reason) BETWEEN 1 AND 300 AND reason !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || ']')))
);
CREATE INDEX civil_id_review_decisions_subject ON civil_id_review_decisions(subject_principal_id,decided_at DESC,id);
CREATE INDEX civil_id_review_decisions_decided ON civil_id_review_decisions(decided_at DESC);

CREATE TABLE staff_person_views (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 viewer_principal_id text NOT NULL REFERENCES principals(id),
 subject_principal_id text NOT NULL REFERENCES principals(id),
 kind text NOT NULL CHECK (kind IN ('civil_id_page','civil_id_image_issue','civil_id_image_deliver','person_page','person_document_issue','person_document_deliver')),
 document_type text CHECK (document_type IN ('personal-photo','resume','civil-id-front','civil-id-back')),
 document_version uuid,
 viewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((kind IN ('civil_id_image_issue','civil_id_image_deliver','person_document_issue','person_document_deliver')) =
        (document_type IS NOT NULL AND document_version IS NOT NULL))
);
CREATE INDEX staff_person_views_subject ON staff_person_views(subject_principal_id,viewed_at DESC);
CREATE INDEX staff_person_views_viewer ON staff_person_views(viewer_principal_id,viewed_at DESC);
CREATE INDEX person_civil_ids_review_queue ON person_civil_ids(updated_at DESC,principal_id) WHERE needs_review AND released_at IS NULL;

CREATE FUNCTION civil_id_review_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'civil id review records are append-only'; END $$;
CREATE TRIGGER civil_id_review_decisions_append_only BEFORE UPDATE OR DELETE ON civil_id_review_decisions FOR EACH ROW EXECUTE FUNCTION civil_id_review_append_only();
CREATE TRIGGER staff_person_views_append_only BEFORE UPDATE OR DELETE ON staff_person_views FOR EACH ROW EXECUTE FUNCTION civil_id_review_append_only();
