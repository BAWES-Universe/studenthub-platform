-- Recruit R5 (decision SHU-200): every employer document link issued and every
-- document opened through one is recorded, with the request that gave sight.
-- Append-only.
CREATE TABLE recruit_employer_document_views (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 viewer_principal_id text NOT NULL REFERENCES principals(id),
 subject_principal_id text NOT NULL REFERENCES principals(id),
 request_id uuid NOT NULL REFERENCES recruit_requests(id),
 operation text NOT NULL CHECK (operation IN ('issue','deliver')),
 document_type text NOT NULL CHECK (document_type IN ('personal-photo','resume','civil-id-front','civil-id-back')),
 document_version text NOT NULL CHECK (char_length(document_version) BETWEEN 1 AND 200),
 at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX recruit_employer_document_views_subject_idx ON recruit_employer_document_views(subject_principal_id, at DESC);
CREATE FUNCTION refuse_recruit_employer_document_view_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'employer document views are append-only' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER recruit_employer_document_views_append_only BEFORE UPDATE OR DELETE ON recruit_employer_document_views FOR EACH ROW EXECUTE FUNCTION refuse_recruit_employer_document_view_change();
