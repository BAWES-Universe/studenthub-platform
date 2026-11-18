-- Access lane A3: a company's extra contacts (an accountant, a branch manager).
--
-- A contact is a plain record: no principal, no grant, no sign-in. Removal is
-- soft (removed_at), so the importer and the audit trail can still tell a
-- contact existed; removed contacts are never listed. A contact row is never
-- deleted, so its channels stay with it.

CREATE TABLE company_contacts (
  id          UUID PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations (id),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  role_title  TEXT CHECK (role_title IS NULL OR (char_length(role_title) BETWEEN 1 AND 120 AND role_title = btrim(role_title))),
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_by  TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  removed_at  TIMESTAMPTZ,
  removed_by  TEXT,
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);

CREATE INDEX company_contacts_live_idx ON company_contacts (org_id, lower(name), id) WHERE removed_at IS NULL;

-- Up to 5 phones and 5 email addresses per contact, stored normalized.
CREATE TABLE company_contact_channels (
  contact_id  UUID NOT NULL REFERENCES company_contacts (id),
  kind        TEXT NOT NULL CHECK (kind IN ('phone', 'email')),
  position    SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 4),
  value       TEXT NOT NULL,
  label       TEXT CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 40 AND label = btrim(label))),
  PRIMARY KEY (contact_id, kind, position),
  CHECK (
    (kind = 'phone' AND value ~ '^\+?[0-9]{6,20}$')
    OR (kind = 'email' AND char_length(value) BETWEEN 3 AND 254 AND value = lower(value) AND value ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')
  )
);

CREATE INDEX company_contact_channels_contact_idx ON company_contact_channels (contact_id);

-- A removed contact stays removed: no un-removing, no edits after removal.
CREATE FUNCTION company_contacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company contacts are removed with removed_at, never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a removed company contact cannot change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_contacts_guard BEFORE UPDATE OR DELETE ON company_contacts
  FOR EACH ROW EXECUTE FUNCTION company_contacts_guard();
