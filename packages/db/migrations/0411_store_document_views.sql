-- People M-05: a store manager opens the photo or CV of a person placed at
-- their store through a short signed link. Every link issued and every
-- document delivered through one is recorded, with the store that gave sight.
-- Append-only. Civil ID images are never offered to store managers, so the
-- type check names only the photo and the CV.

CREATE TABLE store_document_views (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  viewer_principal_id   text NOT NULL REFERENCES principals (id),
  subject_principal_id  text NOT NULL REFERENCES principals (id),
  store_id              uuid NOT NULL REFERENCES organization_stores (id),
  operation             text NOT NULL CHECK (operation IN ('issue', 'deliver')),
  document_type         text NOT NULL CHECK (document_type IN ('personal-photo', 'resume')),
  document_version      text NOT NULL CHECK (char_length(document_version) BETWEEN 1 AND 200),
  at                    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX store_document_views_subject_idx ON store_document_views (subject_principal_id, at DESC);

CREATE FUNCTION store_document_views_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'store document views are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER store_document_views_append_only BEFORE UPDATE OR DELETE ON store_document_views
  FOR EACH ROW EXECUTE FUNCTION store_document_views_append_only();
