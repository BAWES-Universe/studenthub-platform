-- Rollback of migration 0661 (per-owner candidate document store), allowed only
-- before the first owner write. Run as one transaction by the operator with the
-- new build stopped and the previous build ready to start. It restores
-- candidate_document_snapshot exactly as 0661 froze it and drops every 0661 object.
-- It refuses (and changes nothing) once candidate_document_store_authority.first_write_at
-- is set: from then on the old row is stale and recovery is forward only.
BEGIN;
DO $$
DECLARE wrote timestamptz;
BEGIN
  SELECT first_write_at INTO STRICT wrote FROM candidate_document_store_authority WHERE singleton FOR UPDATE;
  IF wrote IS NOT NULL THEN
    RAISE EXCEPTION 'rollback refused: the per-owner store accepted its first write at %', wrote;
  END IF;
END;
$$;
DROP TRIGGER candidate_document_snapshot_frozen ON candidate_document_snapshot_0661_rollback;
DROP TRIGGER candidate_document_snapshot_frozen_truncate ON candidate_document_snapshot_0661_rollback;
DROP FUNCTION reject_candidate_document_snapshot_write();
ALTER TABLE candidate_document_snapshot_0661_rollback RENAME TO candidate_document_snapshot;
-- The current-documents view (0663) reads the slot history; it goes first, with its ledger row.
DROP VIEW IF EXISTS candidate_current_documents;
DELETE FROM schema_migrations WHERE version = '0663_candidate_current_documents';
DROP TABLE candidate_document_slots;
DROP FUNCTION reject_candidate_document_slot_delete();
DROP TABLE candidate_document_ids;
DROP FUNCTION reject_candidate_document_id_change();
DROP TABLE candidate_document_partitions;
DROP FUNCTION candidate_document_store_rollback_allowed();
DROP TABLE candidate_document_store_authority;
DELETE FROM schema_migrations WHERE version = '0661_candidate_document_partitions';
COMMIT;
