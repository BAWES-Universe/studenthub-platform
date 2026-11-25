-- Missing bank details reminder (comms lane), ported from legacy's Candidate::notifyMissingBankInfo,
-- which cron/mid-month and cron/end-of-month ran on the 15th and 28th. It is optional: a person may
-- switch it off. Who gets it is decided with the bank-details store, the only reader of the
-- bank details table, which answers only whether a row exists.
INSERT INTO email_classes(class, transactional) VALUES ('person.bank_details_missing', false);

ALTER TABLE person_reminder_runs DROP CONSTRAINT person_reminder_runs_kind_check,
  ADD CONSTRAINT person_reminder_runs_kind_check CHECK (kind IN ('birthday','civil_id_expired','civil_id_expiring','bank_details_missing'));
