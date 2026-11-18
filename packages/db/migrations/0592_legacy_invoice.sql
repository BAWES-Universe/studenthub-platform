-- Invoices lane, legacy invoice import (F4.6). Legacy invoice numbers are database
-- ids already printed on documents; they are kept verbatim as LEGACY-<id>, a
-- namespace billing_sequence can never mint. Ids, dates, statuses and amounts
-- only: no names or personal fields are copied.
CREATE TABLE legacy_invoice (
  invoice_number TEXT PRIMARY KEY CHECK (invoice_number = 'LEGACY-' || legacy_invoice_id::text),
  legacy_invoice_id BIGINT NOT NULL UNIQUE CHECK (legacy_invoice_id > 0),
  transfer_id BIGINT NOT NULL CHECK (transfer_id > 0),
  parent_transfer_id BIGINT CHECK (parent_transfer_id > 0),
  company_id BIGINT NOT NULL CHECK (company_id > 0),
  invoice_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unpaid', 'paid')),
  total NUMERIC(18, 3) NOT NULL,
  currency_code TEXT NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  deleted BOOLEAN NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX legacy_invoice_company ON legacy_invoice (company_id, currency_code, status) WHERE NOT deleted;
CREATE INDEX legacy_invoice_transfer ON legacy_invoice (transfer_id);

-- Legacy stays live until cutover, so a re-import may only move an invoice
-- forward the way legacy can: unpaid -> paid, and live -> soft-deleted.
-- Everything else about an imported number is frozen, and nothing is removed.
CREATE FUNCTION legacy_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'legacy invoices cannot be removed' USING ERRCODE = '23514';
  END IF;
  IF NEW.invoice_number <> OLD.invoice_number OR NEW.legacy_invoice_id <> OLD.legacy_invoice_id
     OR NEW.transfer_id <> OLD.transfer_id OR NEW.parent_transfer_id IS DISTINCT FROM OLD.parent_transfer_id
     OR NEW.company_id <> OLD.company_id OR NEW.invoice_date <> OLD.invoice_date
     OR NEW.total <> OLD.total OR NEW.currency_code <> OLD.currency_code
     OR NEW.imported_at <> OLD.imported_at
     OR (OLD.status = 'paid' AND NEW.status <> 'paid')
     OR (OLD.deleted AND NOT NEW.deleted) THEN
    RAISE EXCEPTION 'imported legacy invoice can only become paid or deleted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER legacy_invoice_forward_only BEFORE UPDATE OR DELETE ON legacy_invoice
  FOR EACH ROW EXECUTE FUNCTION legacy_invoice_guard();
CREATE TRIGGER legacy_invoice_no_truncate BEFORE TRUNCATE ON legacy_invoice
  FOR EACH STATEMENT EXECUTE FUNCTION legacy_invoice_guard();
