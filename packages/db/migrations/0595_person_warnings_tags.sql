-- A-02 slice 1: staff warn and tag a person (legacy candidate_warning and candidate_tag).
--
-- Legacy benchmark (BAWES-Universe/studenthub@55119d3): m230606_130436_warning.php,
-- m230504_083255_candidate_tag.php and m230521_161132_tag_reason.php. A warning has a
-- title (100, default "Not appearing for interview") and a required message; staff may
-- correct it. Here every earlier wording is kept in person_warning_edits, and a warning
-- is never deleted. A tag has the tag (128) and a reason. Legacy replaced the whole set
-- with a hard delete; here a tag is removed once, and its row is kept. Rows go only when
-- the person's principal is deleted.

CREATE TABLE person_warnings (
  id            UUID PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT 'Not appearing for interview' CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  message       TEXT NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 5000),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ,
  CHECK ((updated_by IS NULL) = (updated_at IS NULL) AND (version = 1) = (updated_at IS NULL))
);
CREATE INDEX person_warnings_principal_idx ON person_warnings (principal_id, created_at DESC);

-- The wording a correction replaced, one row per correction.
CREATE TABLE person_warning_edits (
  warning_id    UUID NOT NULL REFERENCES person_warnings (id) ON DELETE CASCADE,
  version       INTEGER NOT NULL CHECK (version >= 1),
  title         TEXT NOT NULL,
  message       TEXT NOT NULL,
  written_by    TEXT NOT NULL,
  written_at    TIMESTAMPTZ NOT NULL,
  replaced_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (warning_id, version)
);

CREATE FUNCTION person_warnings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'person warnings are corrected, never deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.principal_id <> OLD.principal_id OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.version <> OLD.version + 1 OR NEW.updated_by IS NULL OR NEW.updated_at IS NULL THEN
    RAISE EXCEPTION 'a person warning can only be corrected, one version at a time' USING ERRCODE = '55000';
  END IF;
  INSERT INTO person_warning_edits (warning_id, version, title, message, written_by, written_at)
    VALUES (OLD.id, OLD.version, OLD.title, OLD.message, COALESCE(OLD.updated_by, OLD.created_by), COALESCE(OLD.updated_at, OLD.created_at));
  RETURN NEW;
END;
$$;
CREATE TRIGGER person_warnings_guard BEFORE UPDATE ON person_warnings
  FOR EACH ROW EXECUTE FUNCTION person_warnings_guard();
CREATE TRIGGER person_warnings_no_delete BEFORE DELETE ON person_warnings
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION person_warnings_guard();

CREATE FUNCTION person_warning_edits_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'person warning edits are kept as written' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER person_warning_edits_guard BEFORE UPDATE ON person_warning_edits
  FOR EACH ROW EXECUTE FUNCTION person_warning_edits_guard();
CREATE TRIGGER person_warning_edits_no_delete BEFORE DELETE ON person_warning_edits
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION person_warning_edits_guard();

CREATE TABLE person_tags (
  id            UUID PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  tag           TEXT NOT NULL CHECK (char_length(btrim(tag)) BETWEEN 1 AND 128 AND tag = btrim(tag)),
  -- Required for a tag added here; a legacy import may carry none.
  reason        TEXT CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 1000),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  removed_by    TEXT,
  removed_at    TIMESTAMPTZ,
  CHECK ((removed_by IS NULL) = (removed_at IS NULL))
);
CREATE UNIQUE INDEX person_tags_live_idx ON person_tags (principal_id, lower(tag)) WHERE removed_at IS NULL;
CREATE INDEX person_tags_principal_idx ON person_tags (principal_id, created_at DESC);

CREATE FUNCTION person_tags_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'person tags are removed, never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NEW.id IS DISTINCT FROM OLD.id OR NEW.principal_id <> OLD.principal_id
     OR NEW.tag <> OLD.tag OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a person tag can only be removed, once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER person_tags_guard BEFORE UPDATE ON person_tags
  FOR EACH ROW EXECUTE FUNCTION person_tags_guard();
CREATE TRIGGER person_tags_no_delete BEFORE DELETE ON person_tags
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION person_tags_guard();
