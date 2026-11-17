-- Universe E2: embed instances, handoffs, bindings and host-verification leases.
-- Every bearer reference (browser binding, embed cookie, OIDC state, platform
-- session, challenge) is stored only as its SHA-256 base64url digest, exactly as
-- login_states/login_sessions store theirs. No plaintext bearer column exists.

CREATE TABLE universe_embed_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  browser_binding_digest text NOT NULL CHECK (length(browser_binding_digest) = 43),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at))
);
-- One instance per browser binding: a second concurrent create finds this one.
CREATE UNIQUE INDEX universe_embed_instances_browser_idx ON universe_embed_instances(browser_binding_digest);

-- An instance may be named by more than one embed cookie (two concurrent first
-- loads each get a cookie), but every cookie names exactly one instance.
CREATE TABLE universe_embed_instance_refs (
  ref_digest text PRIMARY KEY CHECK (length(ref_digest) = 43),
  instance_id uuid NOT NULL REFERENCES universe_embed_instances(id) ON DELETE CASCADE
);
CREATE INDEX universe_embed_instance_refs_instance_idx ON universe_embed_instance_refs(instance_id);

CREATE TABLE universe_embed_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES universe_embed_instances(id) ON DELETE CASCADE,
  browser_binding_digest text NOT NULL CHECK (length(browser_binding_digest) = 43),
  destination text NOT NULL CHECK (destination = '/universe/embed'),
  status text NOT NULL CHECK (status IN ('pending', 'superseded', 'completed', 'consumed')),
  state_digest text CHECK (state_digest IS NULL OR length(state_digest) = 43),
  session_digest text CHECK (session_digest IS NULL OR length(session_digest) = 43),
  person_id text REFERENCES principals(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  CHECK ((status IN ('completed', 'consumed')) = (session_digest IS NOT NULL AND person_id IS NOT NULL))
);
CREATE UNIQUE INDEX universe_embed_handoffs_state_idx ON universe_embed_handoffs(state_digest) WHERE state_digest IS NOT NULL;
-- At most one current handoff per instance (the instance is unique per browser binding).
CREATE UNIQUE INDEX universe_embed_handoffs_current_idx ON universe_embed_handoffs(instance_id)
  WHERE status IN ('pending', 'completed');
CREATE INDEX universe_embed_handoffs_expiry_idx ON universe_embed_handoffs(expires_at);

-- The embed binding and its host-verification lease. One per instance.
-- generation advances on every accepted attestation; a challenge is valid only
-- for the generation it was issued in, so an old challenge can never renew.
CREATE TABLE universe_embed_bindings (
  instance_id uuid PRIMARY KEY REFERENCES universe_embed_instances(id) ON DELETE CASCADE,
  browser_binding_digest text NOT NULL CHECK (length(browser_binding_digest) = 43),
  session_digest text NOT NULL CHECK (length(session_digest) = 43),
  person_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  lease_host_subject_digest text CHECK (lease_host_subject_digest IS NULL OR length(lease_host_subject_digest) = 43),
  lease_expires_at timestamptz CHECK (lease_expires_at IS NULL OR isfinite(lease_expires_at)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_host_subject_digest IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX universe_embed_bindings_person_idx ON universe_embed_bindings(person_id);

CREATE TABLE universe_embed_challenges (
  challenge_digest text PRIMARY KEY CHECK (length(challenge_digest) = 43),
  instance_id uuid NOT NULL REFERENCES universe_embed_bindings(instance_id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation >= 0),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at))
);
CREATE INDEX universe_embed_challenges_instance_idx ON universe_embed_challenges(instance_id);
CREATE INDEX universe_embed_challenges_expiry_idx ON universe_embed_challenges(expires_at);
