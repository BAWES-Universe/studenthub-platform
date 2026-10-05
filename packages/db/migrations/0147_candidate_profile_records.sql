-- SHU-144 (S3): owner-scoped education, experience, skills and links.
-- One soft-delete convention (status + deleted_at) replaces the legacy mix of
-- hard deletes, `deleted` and `is_deleted`. Rows are never physically removed here.
CREATE TABLE candidate_profile_records (
  id                 uuid PRIMARY KEY,
  owner_principal_id text NOT NULL REFERENCES principals (id),
  kind               text NOT NULL CHECK (kind IN ('education', 'experience', 'skill', 'link')),
  status             text NOT NULL CHECK (status IN ('active', 'deleted')),
  fields             jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  deleted_at         timestamptz,
  CHECK ((status = 'active' AND deleted_at IS NULL) OR (status = 'deleted' AND deleted_at IS NOT NULL))
);

CREATE INDEX candidate_profile_records_owner_idx
  ON candidate_profile_records (owner_principal_id, kind, status, created_at, id);

-- Every mutation is audited through the SHU-59 ledger in the same transaction.
-- The summary is closed: the kind and the owner's active-row count, never a record body.
ALTER TABLE authorization_mutation_audit
  DROP CONSTRAINT authorization_mutation_audit_operation_check,
  ADD CONSTRAINT authorization_mutation_audit_operation_check CHECK (
    operation IN ('principal.register', 'grants.grant', 'grants.revoke', 'grants.clear',
      'profile_record.create', 'profile_record.update', 'profile_record.remove',
      'profile_record.restore', 'profile_record.replace')
  ),
  DROP CONSTRAINT auth_audit_target_org_cardinality,
  ADD CONSTRAINT auth_audit_target_org_cardinality CHECK (
    (operation IN ('principal.register', 'grants.clear') AND cardinality(target_org_refs) = 0)
    OR
    (operation IN ('grants.grant', 'grants.revoke') AND cardinality(target_org_refs) > 0)
    OR
    (operation LIKE 'profile_record.%' AND cardinality(target_org_refs) = 0)
  );

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
    WHEN audit_operation LIKE 'profile_record.%' THEN
      jsonb_typeof(summary) = 'object'
      AND summary ?& ARRAY['kind', 'activeCount']
      AND summary - ARRAY['kind', 'activeCount'] = '{}'::jsonb
      AND summary ->> 'kind' IN ('education', 'experience', 'skill', 'link')
      AND jsonb_typeof(summary -> 'activeCount') = 'number'
      AND summary ->> 'activeCount' ~ '^(0|[1-9][0-9]{0,17})$'
    ELSE FALSE
  END
$$;
