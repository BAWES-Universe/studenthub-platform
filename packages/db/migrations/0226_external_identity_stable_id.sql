-- SHU-496: guard mutable Universe subjects with Authentik's stable user id.
ALTER TABLE external_identities
  ADD COLUMN stable_user_id TEXT,
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN locked_reason TEXT,
  ADD CONSTRAINT external_identities_stable_user_id_valid CHECK (
    stable_user_id IS NULL
    OR (length(stable_user_id) BETWEEN 8 AND 128 AND stable_user_id ~ '^[A-Za-z0-9_-]+$')
  ),
  ADD CONSTRAINT external_identities_lock_valid CHECK (
    (locked_at IS NULL AND locked_reason IS NULL)
    OR (locked_at IS NOT NULL AND locked_reason = 'stable_id_mismatch')
  );
CREATE INDEX external_identities_locked_at_idx ON external_identities (locked_at)
  WHERE locked_at IS NOT NULL;
