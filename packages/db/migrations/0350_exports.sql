-- Export audit lives with the private file because authorization_audit requires an
-- organization target and rejects export outcomes in its closed summary constraint.
CREATE TABLE exports (
 id text PRIMARY KEY,
 kind text NOT NULL,
 requester_principal_id text NOT NULL REFERENCES principals(id),
 filters jsonb NOT NULL,
 row_count integer NOT NULL CHECK (row_count >= 0),
 outcome text NOT NULL CHECK (outcome IN ('created','refused_limit','refused_authorization')),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 csv_bytes bytea,
 CHECK (octet_length(csv_bytes) <= 5242880),
 CHECK (outcome='created' OR csv_bytes IS NULL),
 CHECK (expires_at > created_at)
);
CREATE INDEX exports_expires_at_idx ON exports(expires_at);
CREATE INDEX exports_requester_created_idx ON exports(requester_principal_id,created_at DESC);
