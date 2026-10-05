-- SHU-264: permanent per-account numbering namespace; issued snapshots have no
-- dependency on mutable organization/store names or billing-account tables.
CREATE TABLE billing_sequence (
  account_id text PRIMARY KEY CHECK (account_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  account_prefix text NOT NULL UNIQUE CHECK (
    account_prefix ~ '^[A-Z][A-Z0-9-]{0,31}$' AND account_prefix !~ '^LEGACY(-|$)'),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);

CREATE FUNCTION billing_sequence_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'billing sequence cannot be removed' USING ERRCODE = '23514';
  END IF;
  IF NEW.account_id <> OLD.account_id OR NEW.account_prefix <> OLD.account_prefix
     OR NEW.last_sequence <= OLD.last_sequence THEN
    RAISE EXCEPTION 'billing sequence cannot be reset or rebound' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_sequence_no_reset BEFORE UPDATE OR DELETE ON billing_sequence
  FOR EACH ROW EXECUTE FUNCTION billing_sequence_monotonic();
CREATE TRIGGER billing_sequence_no_truncate BEFORE TRUNCATE ON billing_sequence
  FOR EACH STATEMENT EXECUTE FUNCTION billing_sequence_monotonic();

CREATE TABLE invoice_document (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL REFERENCES billing_sequence(account_id),
  invoice_number text NOT NULL UNIQUE,
  group_id text NOT NULL,
  org_id text,
  kind text NOT NULL CHECK (kind IN ('consolidated', 'subtotal', 'credit')),
  credit_of text,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  object_ref text NOT NULL CHECK (length(object_ref) > 0),
  UNIQUE (account_id, invoice_number),
  FOREIGN KEY (account_id, credit_of) REFERENCES invoice_document(account_id, invoice_number),
  CHECK ((kind = 'credit') = (credit_of IS NOT NULL)),
  CHECK (credit_of IS NULL OR credit_of <> invoice_number),
  CHECK ((document->>'invoiceNumber') IS NOT DISTINCT FROM invoice_number),
  CHECK ((document->>'groupId') IS NOT DISTINCT FROM group_id),
  CHECK ((document->>'orgId') IS NOT DISTINCT FROM org_id),
  CHECK ((document->>'kind') IS NOT DISTINCT FROM kind),
  CHECK ((document->>'creditOf') IS NOT DISTINCT FROM credit_of),
  CHECK ((document->>'bodyHash') IS NOT DISTINCT FROM body_hash)
);

CREATE FUNCTION invoice_document_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issued invoice documents are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER invoice_document_no_change BEFORE UPDATE OR DELETE ON invoice_document
  FOR EACH ROW EXECUTE FUNCTION invoice_document_immutable();
CREATE TRIGGER invoice_document_no_truncate BEFORE TRUNCATE ON invoice_document
  FOR EACH STATEMENT EXECUTE FUNCTION invoice_document_immutable();
