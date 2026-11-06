ALTER TABLE job_runs DROP CONSTRAINT job_runs_job_name_check;
ALTER TABLE job_runs ADD CONSTRAINT job_runs_job_name_check CHECK (job_name IN ('heartbeat','missed_run_check','email_delivery'));
ALTER TABLE job_leases DROP CONSTRAINT job_leases_job_name_check;
ALTER TABLE job_leases ADD CONSTRAINT job_leases_job_name_check CHECK (job_name IN ('heartbeat','missed_run_check','email_delivery'));

CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class text NOT NULL CHECK (class IN ('account.notice')),
  recipient_principal_id text NOT NULL REFERENCES principals(id),
  template_parameters jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed','not_sent','suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at timestamptz
);
CREATE INDEX email_outbox_claim_idx ON email_outbox(state,next_attempt_at);
CREATE INDEX email_outbox_admin_idx ON email_outbox(created_at DESC,id DESC);

CREATE TABLE email_attempts (
  message_id uuid NOT NULL REFERENCES email_outbox(id),
  class text NOT NULL CHECK (class IN ('account.notice')),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome text NOT NULL CHECK (outcome IN ('sent','failed','not_sent','suppressed')),
  failure_code text CHECK (failure_code IN ('delivery_not_configured','non_production','address_unavailable','provider_rejected','provider_timeout','retry_limit')),
  at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(message_id,attempt_number)
);

CREATE TABLE email_preferences (
  principal_id text NOT NULL REFERENCES principals(id),
  class text NOT NULL CHECK (class IN ('account.notice')),
  enabled boolean NOT NULL,
  PRIMARY KEY(principal_id,class)
);
