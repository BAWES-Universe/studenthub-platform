CREATE TABLE catalogue_items (
  id uuid PRIMARY KEY,
  catalogue_type text NOT NULL CHECK (catalogue_type IN
    ('country','currency','bank','tag','brand','mall','university','major','degree','degree-group')),
  name text NOT NULL,
  normalized_name text NOT NULL,
  code text,
  status text NOT NULL CHECK (status IN ('active','deleted')),
  created_by_ref char(64) NOT NULL CHECK (created_by_ref ~ '^[0-9a-f]{64}$'),
  updated_by_ref char(64) NOT NULL CHECK (updated_by_ref ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CHECK ((status = 'active' AND deleted_at IS NULL) OR (status = 'deleted' AND deleted_at IS NOT NULL))
);

CREATE UNIQUE INDEX catalogue_items_active_name_uq
  ON catalogue_items (catalogue_type, normalized_name)
  WHERE status = 'active';
CREATE INDEX catalogue_items_list_idx
  ON catalogue_items (catalogue_type, normalized_name COLLATE "C", id)
  WHERE status = 'active';

CREATE TABLE catalogue_submissions (
  id uuid PRIMARY KEY,
  catalogue_type text NOT NULL CHECK (catalogue_type IN ('university','major')),
  name text NOT NULL,
  normalized_name text NOT NULL,
  code text,
  status text NOT NULL CHECK (status IN ('pending','approved','rejected')),
  submitted_by_ref char(64) NOT NULL CHECK (submitted_by_ref ~ '^[0-9a-f]{64}$'),
  organization_id text NOT NULL REFERENCES organizations(id),
  submitted_at timestamptz NOT NULL,
  moderated_by_ref char(64) CHECK (moderated_by_ref IS NULL OR moderated_by_ref ~ '^[0-9a-f]{64}$'),
  moderated_at timestamptz,
  created_item_id uuid REFERENCES catalogue_items(id),
  CHECK (
    (status = 'pending' AND moderated_by_ref IS NULL AND moderated_at IS NULL AND created_item_id IS NULL)
    OR (status = 'approved' AND moderated_by_ref IS NOT NULL AND moderated_at IS NOT NULL AND created_item_id IS NOT NULL)
    OR (status = 'rejected' AND moderated_by_ref IS NOT NULL AND moderated_at IS NOT NULL AND created_item_id IS NULL)
  )
);

CREATE UNIQUE INDEX catalogue_submissions_pending_name_uq
  ON catalogue_submissions (catalogue_type, normalized_name)
  WHERE status = 'pending';
CREATE INDEX catalogue_submissions_queue_idx
  ON catalogue_submissions (status, catalogue_type, submitted_at, id);
