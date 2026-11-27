-- Per-owner document store (cutover lane, before M-2 promotion; GPT design OK on #393, comment 7224434712).
--
-- 0145 kept every candidate's and organization's documents in ONE row
-- (candidate_document_snapshot). Every write locked it and re-read every object,
-- under a 192 MiB aggregate. This migration splits that row, unchanged in format,
-- into one row per owner: a person (`person`, the scope's personId) or an
-- organization's own documents (`org`, the scope's orgId). Each owner row holds
-- exactly the packed state the old row held for that owner (documents, retired
-- versions, pending uploads, receipts, cleanup and audit, in their original
-- order) and the blob references those rows use. No object is copied, moved or
-- deleted: object keys, digests and sizes are carried as they are.
--
-- Handover. The migration runs in one transaction. It first takes an ACCESS
-- EXCLUSIVE lock on the old table, before reading it, and holds it to commit: an
-- old writer that committed first is read and placed exactly once; one that comes
-- later waits, then finds the table gone. The old table is then renamed to
-- candidate_document_snapshot_0661_rollback and frozen by a trigger, so an older
-- build can neither write nor read it under its old name: old writers and old
-- readers both fail `unavailable` instead of serving or changing stale state.
--
-- Rollback boundary. The authority row records the first owner write
-- (first_write_at), set in the same transaction as that write; every writer holds
-- the authority row FOR SHARE. While first_write_at is null, rollback
-- (docs/contracts/candidate-document-store-rollback-0661.sql) restores the old
-- table unchanged under its name and drops these objects; it locks the authority
-- row FOR UPDATE and refuses once any owner write has committed. After that,
-- recovery is forward only.

LOCK TABLE candidate_document_snapshot IN ACCESS EXCLUSIVE MODE;

CREATE TABLE candidate_document_store_authority (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  store text NOT NULL CHECK (store = 'partitioned'),
  switched_at timestamptz NOT NULL DEFAULT now(),
  first_write_at timestamptz
);
-- Whether rollback to the old table is still allowed: true only before the first owner write.
CREATE OR REPLACE FUNCTION candidate_document_store_rollback_allowed() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT first_write_at IS NULL FROM candidate_document_store_authority WHERE singleton
$$;

CREATE TABLE candidate_document_partitions (
  owner_kind text NOT NULL CHECK (owner_kind IN ('person', 'org')),
  owner_id text NOT NULL CHECK (owner_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  snapshot jsonb NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);

-- Which owner holds a document id (active or retired), so a request that names
-- only a document reads only that owner's row. A document never changes owner.
CREATE TABLE candidate_document_ids (
  document_id uuid PRIMARY KEY,
  owner_kind text NOT NULL,
  owner_id text NOT NULL,
  FOREIGN KEY (owner_kind, owner_id) REFERENCES candidate_document_partitions (owner_kind, owner_id)
);
CREATE OR REPLACE FUNCTION reject_candidate_document_id_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'candidate_document_ids is append-only';
END;
$$;
CREATE TRIGGER candidate_document_ids_append_only
  BEFORE UPDATE OR DELETE ON candidate_document_ids
  FOR EACH ROW EXECUTE FUNCTION reject_candidate_document_id_change();

-- Durable slot history: every (person, org, type) that has ever held a document,
-- and whether it holds one now. A row is never deleted, so "never held" stays
-- provable after a person clears a slot, whatever retention later does to bytes.
CREATE TABLE candidate_document_slots (
  person_id text NOT NULL CHECK (person_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  org_id text NOT NULL CHECK (org_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  type text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'cleared')),
  first_held_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, org_id, type)
);
CREATE OR REPLACE FUNCTION reject_candidate_document_slot_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'candidate_document_slots rows are never deleted';
END;
$$;
CREATE TRIGGER candidate_document_slots_no_delete
  BEFORE DELETE ON candidate_document_slots
  FOR EACH ROW EXECUTE FUNCTION reject_candidate_document_slot_delete();
CREATE TRIGGER candidate_document_slots_no_truncate
  BEFORE TRUNCATE ON candidate_document_slots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_candidate_document_slot_delete();

-- Backfill. Every element of the old row goes to exactly one owner, in order; any
-- element that cannot be placed fails the migration (nothing is guessed).
DO $$
DECLARE
  snap jsonb;
  st jsonb;
  has_lifecycle boolean;
  placed bigint;
  expected bigint;
BEGIN
  SELECT snapshot INTO STRICT snap FROM candidate_document_snapshot WHERE singleton;
  st := snap->'state';
  IF jsonb_typeof(st->'documents') <> 'array' OR jsonb_typeof(st->'retired') <> 'array' OR jsonb_typeof(snap->'blobs') <> 'object' THEN
    RAISE EXCEPTION 'candidate document snapshot is not in the expected format';
  END IF;
  has_lifecycle := st ? 'lifecycle' AND st->'lifecycle' <> 'null'::jsonb;

  CREATE TEMP TABLE m_rows (section text, ord bigint, elem jsonb, owner_kind text, owner_id text) ON COMMIT DROP;

  INSERT INTO m_rows
  SELECT s.section, e.ord, e.elem,
         CASE WHEN e.elem->'scope' ? 'personId' THEN 'person' ELSE 'org' END,
         COALESCE(e.elem->'scope'->>'personId', e.elem->'scope'->>'orgId')
  FROM (VALUES ('documents'), ('retired')) AS s(section),
       LATERAL jsonb_array_elements(st->s.section) WITH ORDINALITY AS e(elem, ord);

  IF has_lifecycle THEN
    INSERT INTO m_rows
    SELECT 'uploads', e.ord, e.elem, 'person', e.elem->>'principalId'
    FROM jsonb_array_elements(st->'lifecycle'->'uploads') WITH ORDINALITY AS e(elem, ord);

    -- Receipts and audit are keyed by principalRef = sha256 hex of the principal id.
    INSERT INTO m_rows
    SELECT s.section, e.ord, e.elem, 'person', o.owner_id
    FROM (VALUES ('receipts'), ('audit')) AS s(section),
         LATERAL jsonb_array_elements(st->'lifecycle'->s.section) WITH ORDINALITY AS e(elem, ord)
         LEFT JOIN LATERAL (
           -- The person's own documents or uploads first; a principal who only
           -- listed (an audit row with nothing stored) is found among principals.
           SELECT DISTINCT r.owner_id FROM m_rows r
           WHERE r.owner_kind = 'person' AND r.section IN ('documents', 'retired', 'uploads')
             AND encode(sha256(convert_to(r.owner_id, 'UTF8')), 'hex') = e.elem->>'principalRef'
           UNION
           SELECT p.id FROM principals p
           WHERE encode(sha256(convert_to(p.id, 'UTF8')), 'hex') = e.elem->>'principalRef'
         ) o ON true;

    -- Cleanup entries follow the document they retire.
    INSERT INTO m_rows
    SELECT 'cleanup', e.ord, e.elem, o.owner_kind, o.owner_id
    FROM jsonb_array_elements(st->'lifecycle'->'cleanup') WITH ORDINALITY AS e(elem, ord)
         LEFT JOIN LATERAL (
           SELECT DISTINCT r.owner_kind, r.owner_id FROM m_rows r
           WHERE r.section IN ('documents', 'retired') AND r.elem->>'id' = e.elem->>'documentId'
         ) o ON true;
  END IF;

  IF EXISTS (SELECT 1 FROM m_rows WHERE owner_id IS NULL OR owner_id !~ '^[A-Za-z0-9_-]{1,128}$') THEN
    RAISE EXCEPTION 'a candidate document element has no single owner';
  END IF;
  IF EXISTS (SELECT 1 FROM m_rows GROUP BY section, ord HAVING count(*) <> 1) THEN
    RAISE EXCEPTION 'a candidate document element matches more than one owner';
  END IF;

  INSERT INTO candidate_document_partitions (owner_kind, owner_id, snapshot)
  SELECT o.owner_kind, o.owner_id, jsonb_build_object(
    'state', jsonb_build_object('format', 1,
      'documents', COALESCE((SELECT jsonb_agg(elem ORDER BY ord) FROM m_rows r WHERE r.section = 'documents' AND (r.owner_kind, r.owner_id) = (o.owner_kind, o.owner_id)), '[]'::jsonb),
      'retired', COALESCE((SELECT jsonb_agg(elem ORDER BY ord) FROM m_rows r WHERE r.section = 'retired' AND (r.owner_kind, r.owner_id) = (o.owner_kind, o.owner_id)), '[]'::jsonb))
      || CASE WHEN has_lifecycle THEN jsonb_build_object('lifecycle', jsonb_build_object('format', 1,
           'uploads', COALESCE((SELECT jsonb_agg(elem ORDER BY ord) FROM m_rows r WHERE r.section = 'uploads' AND (r.owner_kind, r.owner_id) = (o.owner_kind, o.owner_id)), '[]'::jsonb),
           'receipts', COALESCE((SELECT jsonb_agg(elem ORDER BY ord) FROM m_rows r WHERE r.section = 'receipts' AND (r.owner_kind, r.owner_id) = (o.owner_kind, o.owner_id)), '[]'::jsonb),
           'cleanup', COALESCE((SELECT jsonb_agg(elem ORDER BY ord) FROM m_rows r WHERE r.section = 'cleanup' AND (r.owner_kind, r.owner_id) = (o.owner_kind, o.owner_id)), '[]'::jsonb),
           'audit', COALESCE((SELECT jsonb_agg(elem ORDER BY ord) FROM m_rows r WHERE r.section = 'audit' AND (r.owner_kind, r.owner_id) = (o.owner_kind, o.owner_id)), '[]'::jsonb)))
         ELSE '{}'::jsonb END,
    'blobs', COALESCE((SELECT jsonb_object_agg(b.key, b.value) FROM jsonb_each(snap->'blobs') b
      WHERE EXISTS (SELECT 1 FROM m_rows r WHERE (r.owner_kind, r.owner_id) = (o.owner_kind, o.owner_id)
        AND r.section IN ('documents', 'retired', 'uploads') AND r.elem->>'data' = 'r2:' || b.key)), '{}'::jsonb))
  FROM (SELECT DISTINCT owner_kind, owner_id FROM m_rows) o;

  -- Parity: every element and every blob reference is placed exactly once.
  SELECT count(*) INTO placed FROM candidate_document_partitions p,
    LATERAL (SELECT jsonb_array_length(p.snapshot->'state'->'documents') + jsonb_array_length(p.snapshot->'state'->'retired')
      + COALESCE(jsonb_array_length(p.snapshot->'state'->'lifecycle'->'uploads'), 0) + COALESCE(jsonb_array_length(p.snapshot->'state'->'lifecycle'->'receipts'), 0)
      + COALESCE(jsonb_array_length(p.snapshot->'state'->'lifecycle'->'cleanup'), 0) + COALESCE(jsonb_array_length(p.snapshot->'state'->'lifecycle'->'audit'), 0) AS n) c,
    LATERAL generate_series(1, c.n);
  expected := jsonb_array_length(st->'documents') + jsonb_array_length(st->'retired');
  IF has_lifecycle THEN
    expected := expected + jsonb_array_length(st->'lifecycle'->'uploads') + jsonb_array_length(st->'lifecycle'->'receipts')
      + jsonb_array_length(st->'lifecycle'->'cleanup') + jsonb_array_length(st->'lifecycle'->'audit');
  END IF;
  IF placed <> expected THEN RAISE EXCEPTION 'candidate document backfill placed % of % elements', placed, expected; END IF;
  SELECT count(*) INTO placed FROM candidate_document_partitions p, jsonb_object_keys(p.snapshot->'blobs');
  IF placed <> (SELECT count(*) FROM jsonb_object_keys(snap->'blobs')) THEN
    RAISE EXCEPTION 'candidate document backfill placed % blob references of %', placed, (SELECT count(*) FROM jsonb_object_keys(snap->'blobs'));
  END IF;

  INSERT INTO candidate_document_ids (document_id, owner_kind, owner_id)
  SELECT DISTINCT (elem->>'id')::uuid, owner_kind, owner_id FROM m_rows WHERE section IN ('documents', 'retired');

  INSERT INTO candidate_document_slots (person_id, org_id, type, state)
  SELECT owner_id, elem->'scope'->>'orgId', elem->>'type',
         CASE WHEN bool_or(section = 'documents') THEN 'active' ELSE 'cleared' END
  FROM m_rows WHERE owner_kind = 'person' AND section IN ('documents', 'retired')
  GROUP BY owner_id, elem->'scope'->>'orgId', elem->>'type';
END;
$$;

INSERT INTO candidate_document_store_authority (store) VALUES ('partitioned');

-- The old row is the frozen rollback record from here on, under a name no older build uses.
ALTER TABLE candidate_document_snapshot RENAME TO candidate_document_snapshot_0661_rollback;
CREATE OR REPLACE FUNCTION reject_candidate_document_snapshot_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'candidate_document_snapshot_0661_rollback is frozen; candidate_document_partitions is the store';
END;
$$;
CREATE TRIGGER candidate_document_snapshot_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON candidate_document_snapshot_0661_rollback
  FOR EACH ROW EXECUTE FUNCTION reject_candidate_document_snapshot_write();
CREATE TRIGGER candidate_document_snapshot_frozen_truncate
  BEFORE TRUNCATE ON candidate_document_snapshot_0661_rollback
  FOR EACH STATEMENT EXECUTE FUNCTION reject_candidate_document_snapshot_write();
