CREATE OR REPLACE FUNCTION organization_notes_no_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'organization notes are append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER organization_notes_no_update ON organization_notes;
CREATE TRIGGER organization_notes_no_update
  BEFORE UPDATE OR DELETE ON organization_notes
  FOR EACH ROW EXECUTE FUNCTION organization_notes_no_update();

CREATE TRIGGER organization_notes_no_truncate
  BEFORE TRUNCATE ON organization_notes
  FOR EACH STATEMENT EXECUTE FUNCTION organization_notes_no_update();
