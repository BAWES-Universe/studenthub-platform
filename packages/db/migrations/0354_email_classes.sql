-- Comms slice 2 (contract C-2): the email class table, the civil ID result email, and the
-- daily volume alert record.
--
-- Class table: every class the outbox, the attempt log and the preferences accept is a row
-- here, and the row says whether the class is transactional. A transactional class is
-- always sent; nobody can switch it off, so a preference row for it is refused. The
-- TypeScript templates (`EMAIL_TEMPLATES[class].required`) must say the same; a db test
-- compares the two.
CREATE TABLE email_classes (
  class text PRIMARY KEY CHECK (class ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  transactional boolean NOT NULL
);
INSERT INTO email_classes(class, transactional) VALUES
  ('account.notice', false),
  ('civil_id.result', true);

ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_class_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_class_fkey FOREIGN KEY (class) REFERENCES email_classes(class);
ALTER TABLE email_attempts DROP CONSTRAINT email_attempts_class_check;
ALTER TABLE email_attempts ADD CONSTRAINT email_attempts_class_fkey FOREIGN KEY (class) REFERENCES email_classes(class);
ALTER TABLE email_preferences DROP CONSTRAINT email_preferences_class_check;
ALTER TABLE email_preferences ADD CONSTRAINT email_preferences_class_fkey FOREIGN KEY (class) REFERENCES email_classes(class);

CREATE FUNCTION email_preferences_optional_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT transactional FROM email_classes WHERE class = NEW.class) THEN
    RAISE EXCEPTION 'a transactional email class cannot be switched off' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER email_preferences_optional_only BEFORE INSERT OR UPDATE ON email_preferences
  FOR EACH ROW EXECUTE FUNCTION email_preferences_optional_only();

-- Civil ID result: the staff decision and its email are one transaction. The decision row is
-- append-only and its id is the send-once key, so a decision is emailed exactly once. The
-- rejection reason is the one the person already sees on their profile.
CREATE FUNCTION civil_id_result_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO email_outbox(class, recipient_principal_id, template_parameters, idempotency_key)
  VALUES ('civil_id.result', NEW.subject_principal_id,
    CASE WHEN NEW.decision = 'confirmed' THEN jsonb_build_object('decision', 'confirmed')
         ELSE jsonb_build_object('decision', 'rejected', 'reason', NEW.reason) END,
    'civil_id.result:' || NEW.id::text)
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NULL;
END;
$$;
CREATE TRIGGER civil_id_review_decisions_result_email AFTER INSERT ON civil_id_review_decisions
  FOR EACH ROW EXECUTE FUNCTION civil_id_result_email();

-- Staff delivery log reads one person's messages newest first.
CREATE INDEX email_outbox_recipient_idx ON email_outbox(recipient_principal_id, created_at DESC, id DESC);

-- Daily volume alert. Legacy (`MailLog::afterSave`, threshold 500) alerts when the day's sends
-- pass the threshold, then raises it by another threshold for the rest of the day, so it
-- alerts again at 1000, 1500 and so on. Its date check assigns instead of comparing, so a
-- raised threshold leaks into the next day. Here each (Kuwait day, level) is one row: level n
-- means the day passed n times the threshold, and the row is written once, so each level
-- alerts once and a new day starts again at level 1. A check that finds the day several levels
-- up (500 to 1501 between two runs) writes and alerts every level it skipped, lowest first.
CREATE TABLE email_volume_alerts (
  day date NOT NULL,
  level integer NOT NULL CHECK (level > 0),
  threshold integer NOT NULL CHECK (threshold > 0),
  sent_count integer NOT NULL CHECK (sent_count > threshold * level),
  alerted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (day, level)
);
CREATE INDEX email_attempts_sent_at_idx ON email_attempts(at) WHERE outcome = 'sent';
