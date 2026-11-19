-- Reports slice (contract P-2, legacy `CronController::actionSummary`): the staff morning summary.
--
-- Legacy emails twelve counters at 08:00 to every staff member holding the "morning-report"
-- permission. Here a staff member turns the email on for themself on the morning summary
-- page (SHU-211: the page is the main view, the email is optional per staff member), and
-- that subscription is the permission. Whether they still get it is decided when it is sent:
-- only someone who is still StudentHub staff (a staff or admin grant over the operator
-- organization's subtree) and whose account is not paused. The importer maps legacy's
-- morning-report permission holders onto rows here.
INSERT INTO email_classes(class, transactional) VALUES ('staff.morning_summary', false);

CREATE TABLE morning_summary_subscriptions (
  principal_id text PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  subscribed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One row per Asia/Kuwait day the summary went out: the counters it carried (null for a
-- counter whose source has not landed, never 0) and how many staff it was queued for. The
-- row, the emails and their send-once keys (`staff.morning_summary:<day>:<principal>`) are
-- written in one transaction, so a day is sent once however many workers run.
CREATE TABLE morning_summary_runs (
  day date PRIMARY KEY,
  counters jsonb NOT NULL CHECK (jsonb_typeof(counters) = 'object'),
  recipients integer NOT NULL CHECK (recipients >= 0),
  ran_at timestamptz NOT NULL
);

CREATE FUNCTION refuse_morning_summary_run_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'morning summary runs are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER morning_summary_runs_append_only BEFORE UPDATE OR DELETE ON morning_summary_runs
  FOR EACH ROW EXECUTE FUNCTION refuse_morning_summary_run_change();

-- The interview counter reads one Kuwait day of scheduled interviews.
CREATE INDEX recruit_interviews_scheduled_idx ON recruit_interviews(scheduled_at) WHERE status = 'scheduled';
