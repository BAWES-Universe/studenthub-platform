CREATE TABLE email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class TEXT NOT NULL CHECK (class IN ('account.notice')),
  recipient_principal_id TEXT NOT NULL REFERENCES principals(id),
  template_parameters JSONB NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed','not_sent','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX email_outbox_claim_idx ON email_outbox(state,next_attempt_at);
CREATE INDEX email_outbox_admin_idx ON email_outbox(created_at DESC);

CREATE TABLE email_attempts (
  message_id UUID NOT NULL REFERENCES email_outbox(id),
  class TEXT NOT NULL CHECK (class IN ('account.notice')),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('sent','failed','not_sent')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN ('delivery_not_configured','non_production','provider_rejected','provider_timeout','address_unavailable')),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(message_id,attempt_number),
  CHECK ((outcome='sent' AND failure_code IS NULL) OR (outcome<>'sent' AND failure_code IS NOT NULL))
);

CREATE TABLE email_preferences (
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  class TEXT NOT NULL CHECK (class IN ('account.notice')),
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY(principal_id,class)
);

ALTER TABLE job_runs DROP CONSTRAINT job_runs_job_name_check;
ALTER TABLE job_runs ADD CONSTRAINT job_runs_job_name_check
  CHECK (job_name IN ('heartbeat','missed_run_check','email_delivery'));
ALTER TABLE job_leases DROP CONSTRAINT job_leases_job_name_check;
ALTER TABLE job_leases ADD CONSTRAINT job_leases_job_name_check
  CHECK (job_name IN ('heartbeat','missed_run_check','email_delivery'));
