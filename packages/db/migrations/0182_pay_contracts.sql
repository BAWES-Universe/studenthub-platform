-- SHU-182 (F1): one contract aggregate with three pay models.
-- Legacy split a contract across `contract` and three detail tables, held money in
-- PHP floats, and left its schema partly undocumented (FI-F12). Here the terms are
-- typed columns on one row, money is numeric(12,3), and each pay model's columns
-- are required or forbidden by a CHECK. Rows are soft-deleted, never removed.
CREATE TABLE pay_contracts (
  id                     uuid PRIMARY KEY,
  candidate_principal_id text NOT NULL REFERENCES principals (id),
  company_org_id         text NOT NULL REFERENCES organizations (id),
  -- Stores have no platform table until O7 (SHU-165); the id is the imported store key.
  store_id               text NOT NULL CHECK (store_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'),
  pay_model              text NOT NULL CHECK (pay_model IN ('hourly', 'fixed_price', 'monthly_salary')),
  start_date             date NOT NULL,
  end_date               date CHECK (end_date IS NULL OR end_date >= start_date),
  currency_id            uuid NOT NULL REFERENCES catalogue_items (id),
  transfer_cost          numeric(12,3) NOT NULL CHECK (transfer_cost >= 0),
  auto_generate          boolean NOT NULL CHECK (NOT auto_generate OR pay_model = 'monthly_salary'),
  status                 text NOT NULL CHECK (status IN ('active', 'inactive', 'deleted')),
  candidate_hourly_rate  numeric(12,3),
  company_hourly_rate    numeric(12,3),
  candidate_total        numeric(12,3),
  company_total          numeric(12,3),
  completion_percentage  smallint CHECK (completion_percentage BETWEEN 0 AND 100),
  salary_day             smallint CHECK (salary_day BETWEEN 1 AND 31),
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  deleted_at             timestamptz,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  -- IS TRUE: a comparison with a NULL term is unknown, which a bare CHECK would let through.
  CHECK ((
    (pay_model = 'hourly'
      AND candidate_hourly_rate > 0 AND company_hourly_rate >= candidate_hourly_rate
      AND candidate_total IS NULL AND company_total IS NULL AND completion_percentage IS NULL AND salary_day IS NULL)
    OR (pay_model = 'fixed_price'
      AND candidate_total > 0 AND company_total >= candidate_total AND completion_percentage IS NOT NULL
      AND candidate_hourly_rate IS NULL AND company_hourly_rate IS NULL AND salary_day IS NULL)
    OR (pay_model = 'monthly_salary'
      AND candidate_total > 0 AND company_total >= candidate_total AND salary_day IS NOT NULL
      AND candidate_hourly_rate IS NULL AND company_hourly_rate IS NULL AND completion_percentage IS NULL)
  ) IS TRUE)
);

CREATE INDEX pay_contracts_pair_idx ON pay_contracts (candidate_principal_id, store_id, start_date);

-- Every mutation is audited through the SHU-59 ledger in the same transaction, naming
-- the contract's company. The summary is closed: the pay model and the number of
-- non-deleted contracts the candidate holds at that store, never a rate or an amount.
ALTER TABLE authorization_mutation_audit
  DROP CONSTRAINT authorization_mutation_audit_operation_check,
  ADD CONSTRAINT authorization_mutation_audit_operation_check CHECK (
    operation IN ('principal.register', 'grants.grant', 'grants.revoke', 'grants.clear', 'profile.safe_write',
      'profile_record.create', 'profile_record.update', 'profile_record.remove',
      'profile_record.restore', 'profile_record.replace',
      'pay_contract.create', 'pay_contract.update', 'pay_contract.remove')
  ),
  DROP CONSTRAINT auth_audit_target_org_cardinality,
  ADD CONSTRAINT auth_audit_target_org_cardinality CHECK (
    (operation IN ('principal.register', 'grants.clear', 'profile.safe_write',
      'profile_record.create', 'profile_record.update', 'profile_record.remove',
      'profile_record.restore', 'profile_record.replace') AND cardinality(target_org_refs) = 0)
    OR
    (operation IN ('grants.grant', 'grants.revoke') AND cardinality(target_org_refs) > 0)
    OR
    (operation IN ('pay_contract.create', 'pay_contract.update', 'pay_contract.remove') AND cardinality(target_org_refs) = 1)
  );

-- Extends 0148's receipt shapes with the pay_contract branch; every earlier branch is unchanged.
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
    WHEN audit_operation IN ('profile_record.create', 'profile_record.update', 'profile_record.remove',
                             'profile_record.restore', 'profile_record.replace') THEN
      jsonb_typeof(summary) = 'object'
      AND summary ?& ARRAY['kind', 'activeCount']
      AND summary - ARRAY['kind', 'activeCount'] = '{}'::jsonb
      AND summary ->> 'kind' IN ('education', 'experience', 'skill', 'link')
      AND jsonb_typeof(summary -> 'activeCount') = 'number'
      AND summary ->> 'activeCount' ~ '^(0|[1-9][0-9]{0,17})$'
    WHEN audit_operation IN ('pay_contract.create', 'pay_contract.update', 'pay_contract.remove') THEN
      jsonb_typeof(summary) = 'object'
      AND summary ?& ARRAY['payModel', 'contractCount']
      AND summary - ARRAY['payModel', 'contractCount'] = '{}'::jsonb
      AND summary ->> 'payModel' IN ('hourly', 'fixed_price', 'monthly_salary')
      AND jsonb_typeof(summary -> 'contractCount') = 'number'
      AND summary ->> 'contractCount' ~ '^(0|[1-9][0-9]{0,17})$'
    ELSE FALSE
  END
$$;
