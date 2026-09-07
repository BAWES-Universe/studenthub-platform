-- SHU-29: persistent OIDC login state, sessions, and immutable issuer/subject
-- bindings. Mutable profile fields are attributes only and are never lookup
-- keys, so a first login cannot claim an existing person by email/name/phone.

CREATE TABLE IF NOT EXISTS login_states (
  state              TEXT PRIMARY KEY,
  browser_session_id TEXT NOT NULL,
  nonce              TEXT NOT NULL,
  code_verifier      TEXT NOT NULL,
  return_to          TEXT NOT NULL,
  expires_at         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS login_states_expires_at_idx ON login_states (expires_at);

CREATE TABLE IF NOT EXISTS login_sessions (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS login_sessions_expires_at_idx ON login_sessions (expires_at);

CREATE TABLE IF NOT EXISTS external_identities (
  issuer     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  person_id  TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);
