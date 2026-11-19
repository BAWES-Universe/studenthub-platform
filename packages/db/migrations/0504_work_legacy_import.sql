-- Work lane: legacy work history import (M-5, importer lane orchestrates).
--
-- - Legacy ids carry underscores (`can_wrk_hr_<uuid>`, `cwlf_<uuid>`), so legacy
--   references allow them.
-- - Every imported row keeps the digest of what was imported: a re-run with the
--   same row writes nothing, and a changed row is reported with both digests,
--   never overwritten.
-- - Legacy `candidate_work_log_feedback.created_by` is a company contact; a
--   contact with no linked principal imports with `decided_by` null and its
--   legacy reference kept, so the history is complete without inventing an
--   actor. Ratings outside 1 to 5 (legacy had no rule) import as null; the
--   importer reports them.

ALTER TABLE work_assignments DROP CONSTRAINT work_assignments_legacy_ref_check,
 ADD CONSTRAINT work_assignments_legacy_ref_check CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
 ADD COLUMN legacy_digest text CHECK (legacy_digest IS NULL OR legacy_digest ~ '^[0-9a-f]{64}$'),
 ADD CONSTRAINT work_assignments_legacy_digest CHECK ((legacy_digest IS NULL) = (legacy_ref IS NULL));
ALTER TABLE work_sessions DROP CONSTRAINT work_sessions_legacy_ref_check,
 ADD CONSTRAINT work_sessions_legacy_ref_check CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
 ADD COLUMN legacy_digest text CHECK (legacy_digest IS NULL OR legacy_digest ~ '^[0-9a-f]{64}$'),
 ADD CONSTRAINT work_sessions_legacy_digest CHECK ((legacy_digest IS NULL) = (legacy_ref IS NULL));
ALTER TABLE work_appeals DROP CONSTRAINT work_appeals_legacy_ref_check,
 ADD CONSTRAINT work_appeals_legacy_ref_check CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$');
ALTER TABLE work_appeal_updates DROP CONSTRAINT work_appeal_updates_legacy_ref_check,
 ADD CONSTRAINT work_appeal_updates_legacy_ref_check CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$');

ALTER TABLE work_decisions ADD COLUMN legacy_ref text UNIQUE CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
 ADD COLUMN legacy_digest text CHECK (legacy_digest IS NULL OR legacy_digest ~ '^[0-9a-f]{64}$'),
 ADD COLUMN legacy_decided_by text CHECK (legacy_decided_by IS NULL OR legacy_decided_by ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
 ALTER COLUMN decided_by DROP NOT NULL,
 ADD CONSTRAINT work_decisions_actor CHECK (decided_by IS NOT NULL OR legacy_ref IS NOT NULL),
 ADD CONSTRAINT work_decisions_legacy_actor CHECK (legacy_decided_by IS NULL OR legacy_ref IS NOT NULL),
 ADD CONSTRAINT work_decisions_legacy_digest CHECK ((legacy_digest IS NULL) = (legacy_ref IS NULL));

-- Imported sessions keep their legacy status; the decision link is set once
-- the imported decisions are in (the latest legacy decision naming the session).
