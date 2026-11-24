-- Invoices lane F4.7: voiding an issued transfer invoice with a credit note.
-- Legacy has no void or credit note. Here a void is additive: the invoice row keeps
-- its number, total, dates and paid status, a credit note with its own number from
-- the same series reverses it, and the invoice is marked void with reason
-- 'credited' so that a relock of its transfer can issue a new invoice for the same
-- company. Paid or unpaid, an invoice is credited at most once, in full.
CREATE TABLE transfer_invoice_credit (
  credit_number text PRIMARY KEY CHECK (credit_number ~ '^SH-[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{6,}$'),
  invoice_number text NOT NULL UNIQUE REFERENCES transfer_invoice(invoice_number),
  org_id text NOT NULL REFERENCES organizations(id),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  credit_date date NOT NULL,
  total numeric(18,3) NOT NULL CHECK (total >= 0),
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500),
  actor_id text NOT NULL REFERENCES principals(id),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (credit_number <> invoice_number)
);
CREATE INDEX transfer_invoice_credit_org_date ON transfer_invoice_credit(org_id, credit_date);

-- A credit note copies its invoice: same company, currency and total, and only a
-- live invoice can be credited. Credit notes are never edited or removed.
CREATE FUNCTION transfer_invoice_credit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'credit notes are retained' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM transfer_invoice i
     WHERE i.invoice_number = NEW.invoice_number AND NOT i.deleted
       AND i.org_id = NEW.org_id AND i.currency_code = NEW.currency_code AND i.total = NEW.total
  ) THEN
    RAISE EXCEPTION 'a credit note reverses one live invoice in full' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transfer_invoice_credit_insert_only BEFORE INSERT OR UPDATE OR DELETE ON transfer_invoice_credit
  FOR EACH ROW EXECUTE FUNCTION transfer_invoice_credit_guard();
CREATE TRIGGER transfer_invoice_credit_no_truncate BEFORE TRUNCATE ON transfer_invoice_credit
  FOR EACH STATEMENT EXECUTE FUNCTION transfer_invoice_credit_guard();

ALTER TABLE transfer_invoice DROP CONSTRAINT transfer_invoice_void_reason_check;
ALTER TABLE transfer_invoice ADD CONSTRAINT transfer_invoice_void_reason_check
  CHECK (void_reason IN ('reissued', 'transfer_deleted', 'credited'));
-- Only a credited invoice can be both paid and void: the credit note carries the refund.
ALTER TABLE transfer_invoice DROP CONSTRAINT transfer_invoice_check2;
ALTER TABLE transfer_invoice ADD CONSTRAINT transfer_invoice_paid_void_credited
  CHECK (NOT (deleted AND status = 'paid') OR void_reason = 'credited');

-- The 0593 moves, plus one: a live invoice, paid or not, becomes void with reason
-- 'credited' only once its credit note exists, and keeps its status and paid time.
CREATE OR REPLACE FUNCTION transfer_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'transfer invoices are retained' USING ERRCODE = '23514';
  END IF;
  IF OLD.deleted
     OR (to_jsonb(NEW) - 'status' - 'paid_at' - 'deleted' - 'void_reason')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'paid_at' - 'deleted' - 'void_reason')
     OR NOT (
       -- paid, once
       (OLD.status = 'unpaid' AND NEW.status = 'paid' AND NOT NEW.deleted)
       -- voided while unpaid
       OR (OLD.status = 'unpaid' AND NEW.status = 'unpaid' AND NEW.deleted AND NEW.paid_at IS NULL
           AND NEW.void_reason IN ('reissued', 'transfer_deleted'))
       -- credited, paid or not
       OR (NEW.deleted AND NEW.void_reason = 'credited' AND NEW.status = OLD.status
           AND NEW.paid_at IS NOT DISTINCT FROM OLD.paid_at
           AND EXISTS (SELECT 1 FROM transfer_invoice_credit c WHERE c.invoice_number = OLD.invoice_number))
     ) THEN
    RAISE EXCEPTION 'issued transfer invoices only move forward' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
