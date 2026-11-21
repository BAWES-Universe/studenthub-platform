-- Reports slice (contract P-3, legacy `FiringHitmap::updateHitMap` / `firingSpike`): the firing spike email.
--
-- Legacy's daily cron emailed the operations mailbox once per company and month when the
-- month's ended placements passed the company's 12-month average ("warning") or twice it
-- ("danger"), and marked the month `is_alerted` so it never alerted twice. Here, as with the
-- morning summary, a staff member turns the email on for themself on the hit map page, and
-- that subscription is the permission: only someone still StudentHub staff, account not
-- paused, gets it. The importer maps the people behind legacy's operations mailbox onto rows here.
INSERT INTO email_classes(class, transactional) VALUES ('staff.firing_spike', false);

CREATE TABLE firing_spike_subscriptions (
  principal_id text PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  subscribed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One row per company and month that alerted: the level and numbers it alerted with. The
-- primary key is legacy's `is_alerted`: a month alerts once, even if it later gets worse.
CREATE TABLE firing_spike_alerts (
  org_id text NOT NULL REFERENCES organizations(id),
  month text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  level text NOT NULL CHECK (level IN ('warning', 'danger')),
  total integer NOT NULL CHECK (total > 0),
  twelve_month_total integer NOT NULL CHECK (twelve_month_total >= total),
  recipients integer NOT NULL CHECK (recipients >= 0),
  alerted_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, month)
);

-- One row per Asia/Kuwait day the check ran, so the check runs once a day however many
-- workers run. The day's alerts, emails and send-once keys
-- (`staff.firing_spike:<org>:<month>:<principal>`) are written in the same transaction.
CREATE TABLE firing_spike_runs (
  day date PRIMARY KEY,
  alerts integer NOT NULL CHECK (alerts >= 0),
  ran_at timestamptz NOT NULL
);

CREATE FUNCTION refuse_firing_spike_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'firing spike alerts and runs are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER firing_spike_alerts_append_only BEFORE UPDATE OR DELETE ON firing_spike_alerts
  FOR EACH ROW EXECUTE FUNCTION refuse_firing_spike_change();
CREATE TRIGGER firing_spike_runs_append_only BEFORE UPDATE OR DELETE ON firing_spike_runs
  FOR EACH ROW EXECUTE FUNCTION refuse_firing_spike_change();
