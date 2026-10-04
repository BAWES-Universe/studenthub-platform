-- SHU-84: the platform's first safe write (SHU-82 contract, SHU-83 field).
--
-- The one writable field is the person's language preference. The platform
-- owns it outright: it is not imported from, mirrored to, or read by legacy.
-- A row exists only once a person has confirmed a change, so "no row" is the
-- contract's absent value (`before: null`).
--
-- The receipt is NOT a second audit surface. It is a row in SHU-59's
-- append-only authorization_mutation_audit, written in the same transaction
-- as the field, so a mutation whose receipt fails does not commit.

CREATE TABLE IF NOT EXISTS person_preferences (
  principal_id TEXT PRIMARY KEY REFERENCES principals (id) ON DELETE CASCADE,
  language     TEXT NOT NULL CHECK (language IN ('en', 'ar')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE authorization_mutation_audit
  DROP CONSTRAINT IF EXISTS authorization_mutation_audit_operation_check,
  DROP CONSTRAINT IF EXISTS auth_audit_target_org_cardinality,
  DROP CONSTRAINT IF EXISTS auth_audit_before_summary_shape,
  DROP CONSTRAINT IF EXISTS auth_audit_after_summary_shape;

ALTER TABLE authorization_mutation_audit
  ADD CONSTRAINT authorization_mutation_audit_operation_check CHECK (
    operation IN ('principal.register', 'grants.grant', 'grants.revoke', 'grants.clear', 'profile.safe_write')
  ),
  ADD CONSTRAINT auth_audit_target_org_cardinality CHECK (
    (operation IN ('principal.register', 'grants.clear', 'profile.safe_write') AND cardinality(target_org_refs) = 0)
    OR
    (operation IN ('grants.grant', 'grants.revoke') AND cardinality(target_org_refs) > 0)
  ),
  -- A receipt is self-authored: the person who confirmed is the person changed.
  ADD CONSTRAINT auth_audit_safe_write_self CHECK (
    operation <> 'profile.safe_write' OR actor_principal_ref = target_principal_ref
  );

-- Positional receipt shape. Every key is closed and every value has the shape
-- its position permits: references are SHA-256 hex, the field list holds only
-- the permitted field, and nothing can carry a value, email, token or secret.
CREATE OR REPLACE FUNCTION authorization_audit_summary_valid(
  audit_operation TEXT,
  summary JSONB
) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN audit_operation = 'principal.register' THEN
      jsonb_typeof(summary) = 'object'
      AND summary ?& ARRAY['existed', 'identityCount', 'displayNamePresent', 'emailPresent']
      AND summary - ARRAY['existed', 'identityCount', 'displayNamePresent', 'emailPresent'] = '{}'::jsonb
      AND jsonb_typeof(summary -> 'existed') = 'boolean'
      AND jsonb_typeof(summary -> 'displayNamePresent') = 'boolean'
      AND jsonb_typeof(summary -> 'emailPresent') = 'boolean'
      AND jsonb_typeof(summary -> 'identityCount') = 'number'
      AND summary ->> 'identityCount' ~ '^(0|[1-9][0-9]{0,17})$'
    WHEN audit_operation IN ('grants.grant', 'grants.revoke', 'grants.clear') THEN
      jsonb_typeof(summary) = 'object'
      AND summary ?& ARRAY['grantCount', 'selfCount', 'subtreeCount']
      AND summary - ARRAY['grantCount', 'selfCount', 'subtreeCount'] = '{}'::jsonb
      AND jsonb_typeof(summary -> 'grantCount') = 'number'
      AND jsonb_typeof(summary -> 'selfCount') = 'number'
      AND jsonb_typeof(summary -> 'subtreeCount') = 'number'
      AND summary ->> 'grantCount' ~ '^(0|[1-9][0-9]{0,17})$'
      AND summary ->> 'selfCount' ~ '^(0|[1-9][0-9]{0,17})$'
      AND summary ->> 'subtreeCount' ~ '^(0|[1-9][0-9]{0,17})$'
    WHEN audit_operation = 'profile.safe_write' THEN
      jsonb_typeof(summary) = 'object'
      AND (
        (
          summary ?& ARRAY['valuePresent']
          AND summary - ARRAY['valuePresent'] = '{}'::jsonb
          AND jsonb_typeof(summary -> 'valuePresent') = 'boolean'
        ) OR (
          summary ?& ARRAY['contractVersion', 'personRef', 'changeSetDigest', 'fields', 'committedAt', 'tokenRef']
          AND summary - ARRAY['contractVersion', 'personRef', 'changeSetDigest', 'fields', 'committedAt', 'tokenRef'] = '{}'::jsonb
          AND jsonb_typeof(summary -> 'contractVersion') = 'string'
          AND summary ->> 'contractVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
          AND jsonb_typeof(summary -> 'personRef') = 'string'
          AND summary ->> 'personRef' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof(summary -> 'changeSetDigest') = 'string'
          AND summary ->> 'changeSetDigest' ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof(summary -> 'tokenRef') = 'string'
          AND summary ->> 'tokenRef' ~ '^[0-9a-f]{64}$'
          AND summary -> 'fields' = '["language"]'::jsonb
          AND jsonb_typeof(summary -> 'committedAt') = 'string'
          AND summary ->> 'committedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        )
      )
    ELSE FALSE
  END
$$;

ALTER TABLE authorization_mutation_audit
  ADD CONSTRAINT auth_audit_before_summary_shape
    CHECK (authorization_audit_summary_valid(operation, before_summary)),
  ADD CONSTRAINT auth_audit_after_summary_shape
    CHECK (authorization_audit_summary_valid(operation, after_summary)),
  -- The before half is the presence flag only; the after half is the receipt.
  ADD CONSTRAINT auth_audit_safe_write_halves CHECK (
    operation <> 'profile.safe_write'
    OR (before_summary ? 'valuePresent' AND after_summary ? 'tokenRef')
  );

-- Single use is the store's job, and this index is where it lives: a token
-- can be committed once, across every process and every restart.
CREATE UNIQUE INDEX IF NOT EXISTS authorization_mutation_audit_safe_write_token
  ON authorization_mutation_audit ((after_summary ->> 'tokenRef'))
  WHERE operation = 'profile.safe_write';

-- One row per receipt reference. Retrieval also matches the owner, so a
-- reference alone never reveals whose receipt it is.
CREATE UNIQUE INDEX IF NOT EXISTS authorization_mutation_audit_safe_write_receipt
  ON authorization_mutation_audit (request_ref)
  WHERE operation = 'profile.safe_write';
