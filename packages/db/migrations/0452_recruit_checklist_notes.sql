-- Recruit R2b: the admin-managed request checklist (legacy request_checklist)
-- and staff notes on requests and pipeline cards (legacy note rows with a
-- request, story or checklist reference). A checklist step is done on a request
-- once a note names it. Items are removed softly so old notes keep their step.
-- Staff edit (type and text) and remove notes as legacy allowed any staff member to;
-- removal is soft and records who removed it.
CREATE TABLE recruit_checklist_items (
 id uuid PRIMARY KEY,
 name_en text NOT NULL CHECK (name_en = btrim(name_en) AND char_length(name_en) BETWEEN 1 AND 100),
 name_ar text CHECK (name_ar IS NULL OR (name_ar = btrim(name_ar) AND char_length(name_ar) BETWEEN 1 AND 100)),
 required boolean NOT NULL DEFAULT false,
 sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 1000),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
 legacy_uuid text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX recruit_checklist_items_active_idx ON recruit_checklist_items(sort_order, id) WHERE status = 'active';

CREATE TABLE recruit_request_notes (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES recruit_requests(id),
 card_id uuid REFERENCES recruit_pipeline_cards(id),
 checklist_item_id uuid REFERENCES recruit_checklist_items(id),
 note_type text NOT NULL CHECK (note_type IN ('internal_note','phone_call','email','meeting','interview','task')),
 note_text text NOT NULL CHECK (note_text = btrim(note_text) AND char_length(note_text) BETWEEN 1 AND 5000),
 author_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 legacy_note_uuid text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 removed_at timestamptz
);
CREATE INDEX recruit_request_notes_request_idx ON recruit_request_notes(request_id, created_at, id);
CREATE INDEX recruit_request_notes_card_idx ON recruit_request_notes(card_id) WHERE card_id IS NOT NULL;
CREATE INDEX recruit_request_notes_item_idx ON recruit_request_notes(checklist_item_id) WHERE checklist_item_id IS NOT NULL;

CREATE FUNCTION enforce_recruit_request_note() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.request_id <> OLD.request_id OR NEW.card_id IS DISTINCT FROM OLD.card_id
   OR NEW.checklist_item_id IS DISTINCT FROM OLD.checklist_item_id OR NEW.author_principal_id IS DISTINCT FROM OLD.author_principal_id OR NEW.created_at <> OLD.created_at) THEN
  RAISE EXCEPTION 'only a note type and text can be edited' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' AND OLD.removed_at IS NOT NULL THEN
  RAISE EXCEPTION 'a removed note is read-only' USING ERRCODE = '23514';
 END IF;
 IF NEW.card_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recruit_pipeline_cards WHERE id = NEW.card_id AND request_id = NEW.request_id) THEN
  RAISE EXCEPTION 'note card must belong to the note request' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruit_request_notes_rules BEFORE INSERT OR UPDATE ON recruit_request_notes FOR EACH ROW EXECUTE FUNCTION enforce_recruit_request_note();
CREATE FUNCTION refuse_recruit_request_note_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'request notes are removed softly' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER recruit_request_notes_no_delete BEFORE DELETE ON recruit_request_notes FOR EACH ROW EXECUTE FUNCTION refuse_recruit_request_note_delete();
CREATE FUNCTION refuse_recruit_checklist_item_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'checklist items are removed softly' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER recruit_checklist_items_no_delete BEFORE DELETE ON recruit_checklist_items FOR EACH ROW EXECUTE FUNCTION refuse_recruit_checklist_item_delete();
