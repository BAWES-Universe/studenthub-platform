ALTER TABLE job_runs DROP CONSTRAINT job_runs_job_name_check;
ALTER TABLE job_runs ADD CONSTRAINT job_runs_job_name_check CHECK(job_name IN ('heartbeat','missed_run_check','email_outbox_delivery'));
ALTER TABLE job_leases DROP CONSTRAINT job_leases_job_name_check;
ALTER TABLE job_leases ADD CONSTRAINT job_leases_job_name_check CHECK(job_name IN ('heartbeat','missed_run_check','email_outbox_delivery'));

CREATE TABLE email_outbox (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), class TEXT NOT NULL CHECK(class IN ('account.notice')),
 recipient_principal_id TEXT NOT NULL REFERENCES principals(id), template_parameters JSONB NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','not_sent','suppressed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TIMESTAMPTZ
);
CREATE INDEX email_outbox_claim_idx ON email_outbox(state,next_attempt_at);
CREATE INDEX email_outbox_admin_idx ON email_outbox(created_at DESC,id DESC);
CREATE TABLE email_attempts (
 message_id UUID NOT NULL REFERENCES email_outbox(id) ON DELETE CASCADE, attempt_number INTEGER NOT NULL,
 class TEXT NOT NULL CHECK(class IN ('account.notice')), outcome TEXT NOT NULL CHECK(outcome IN ('sent','failed','not_sent','suppressed')),
 failure_code TEXT CHECK(failure_code IN ('delivery_not_configured','non_production','recipient_unavailable','provider_rejected','provider_timeout','attempt_limit')),
 at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(message_id,attempt_number)
);
CREATE TABLE email_preferences (
 principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE, class TEXT NOT NULL CHECK(class IN ('account.notice')),
 enabled BOOLEAN NOT NULL, PRIMARY KEY(principal_id,class)
);
