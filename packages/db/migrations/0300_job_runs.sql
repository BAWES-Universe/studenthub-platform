CREATE TABLE job_runs (
  run_id uuid PRIMARY KEY,
  job_name text NOT NULL CHECK (job_name IN ('heartbeat','missed_run_check')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','failed','refused_overlap'))
);
CREATE INDEX job_runs_job_started_idx ON job_runs(job_name, started_at DESC);

CREATE TABLE job_leases (
  job_name text PRIMARY KEY CHECK (job_name IN ('heartbeat','missed_run_check')),
  holder_run_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
