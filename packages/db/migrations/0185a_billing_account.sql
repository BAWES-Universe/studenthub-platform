-- SHU-263. Membership is explicit; ancestry is only an attach-time eligibility check.
CREATE TABLE billing_account (
  id TEXT PRIMARY KEY,
  parent_org_id TEXT NOT NULL REFERENCES organizations(id),
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  bill_to TEXT NOT NULL CHECK (length(btrim(bill_to)) BETWEEN 1 AND 1024),
  create_actor_ref TEXT NOT NULL CHECK (create_actor_ref ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (create_actor_ref, idempotency_key),
  UNIQUE (id, currency_code)
);
CREATE UNIQUE INDEX billing_account_parent_currency ON billing_account(parent_org_id, currency_code);
CREATE TABLE billing_account_member (
  account_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  currency_code TEXT NOT NULL,
  PRIMARY KEY (account_id, org_id),
  FOREIGN KEY (account_id, currency_code) REFERENCES billing_account(id, currency_code),
  CONSTRAINT billing_member_org_currency UNIQUE (org_id, currency_code)
);
CREATE TABLE billing_account_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_ref TEXT NOT NULL CHECK (actor_ref ~ '^[0-9a-f]{64}$'),
  operation TEXT NOT NULL CHECK (operation IN ('create', 'attach', 'detach')),
  account_id TEXT NOT NULL REFERENCES billing_account(id),
  org_ids TEXT[] NOT NULL CHECK (cardinality(org_ids) > 0),
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE FUNCTION reject_billing_account_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'billing account audit is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER billing_account_audit_append_only BEFORE UPDATE OR DELETE ON billing_account_audit
  FOR EACH ROW EXECUTE FUNCTION reject_billing_account_audit_mutation();
-- No truncate trigger: the existing scratch-db harness truncates organizations CASCADE.
