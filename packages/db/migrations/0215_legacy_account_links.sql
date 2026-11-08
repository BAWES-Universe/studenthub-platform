-- SHU-514: immutable-principal to legacy-candidate account links.
CREATE TABLE legacy_account_links (
  principal_id TEXT PRIMARY KEY REFERENCES principals (id) ON DELETE CASCADE,
  legacy_candidate_id TEXT NOT NULL UNIQUE CHECK (legacy_candidate_id ~ '^[1-9][0-9]*$'),
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by_ref char(64) NOT NULL CHECK (linked_by_ref ~ '^[0-9a-f]{64}$'),
  method TEXT NOT NULL CHECK (method IN ('legacy_login', 'staff'))
);

CREATE TABLE legacy_account_link_events (
  id bigserial PRIMARY KEY,
  principal_id TEXT NOT NULL,
  legacy_candidate_id TEXT NOT NULL CHECK (legacy_candidate_id ~ '^[1-9][0-9]*$'),
  kind TEXT NOT NULL CHECK (kind IN ('linked', 'unlinked')),
  actor_ref char(64) NOT NULL CHECK (actor_ref ~ '^[0-9a-f]{64}$'),
  method TEXT NOT NULL CHECK (method IN ('legacy_login', 'staff')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legacy_account_link_events_principal_id_idx ON legacy_account_link_events (principal_id);
CREATE INDEX legacy_account_link_events_candidate_id_idx ON legacy_account_link_events (legacy_candidate_id);

CREATE TABLE legacy_link_attempts (
  principal_id TEXT PRIMARY KEY REFERENCES principals (id) ON DELETE CASCADE,
  failures integer NOT NULL CHECK (failures >= 0),
  locked_until timestamptz
);
CREATE INDEX legacy_link_attempts_locked_until_idx ON legacy_link_attempts (locked_until);
