-- Person reminder emails (comms lane slice 10), ported from legacy's cron jobs:
-- Candidate::birthdayAlert and Candidate::civilIdExpire (daily, 13:30 Kuwait) and
-- Candidate::notifyCivilIDExpiring (the 15th and 28th). All three are optional: a person may switch
-- each off.
INSERT INTO email_classes(class, transactional) VALUES
  ('person.birthday', false),
  ('person.civil_id_expired', false),
  ('person.civil_id_expiring', false);

-- One row per reminder kind and Asia/Kuwait day that has been queued, so a day is sent once however
-- many workers run. A failed queue writes nothing and the next run tries again.
CREATE TABLE person_reminder_runs (
  kind text NOT NULL CHECK (kind IN ('birthday','civil_id_expired','civil_id_expiring')),
  day date NOT NULL,
  recipients integer NOT NULL CHECK (recipients >= 0),
  ran_at timestamptz NOT NULL,
  PRIMARY KEY (kind, day)
);
