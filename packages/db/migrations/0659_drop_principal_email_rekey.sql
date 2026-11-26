-- Cutover lane: migration 0658's one-off re-key of existing principal_email_verifications rows
-- has run; nothing may call it again (GPT hygiene note on #709). Its test re-creates it from
-- 0658's own text inside a rolled-back transaction. `m4 promote` requires this migration, so a
-- promotion never runs against a database still on the old address rule.
DROP FUNCTION principal_email_verifications_rekey();
