-- Invoices lane: invoices issued when a pay transfer locks, paid when payment is
-- received, voided with the transfer. Legacy keeps one invoice per main transfer,
-- or one per sub-company child transfer. Here a "child" is the company that owns
-- the line's store; lines owned by the transfer's own company are invoiced on it
-- (legacy dropped them when sub-companies existed). Rows are never edited or
-- removed: the only moves are unpaid -> paid and live -> void.
CREATE TABLE transfer_invoice (
  invoice_number text PRIMARY KEY CHECK (invoice_number ~ '^SH-[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{6,}$'),
  transfer_id text NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  invoice_date date NOT NULL,
  total numeric(18,3) NOT NULL CHECK (total >= 0),
  line_count integer NOT NULL CHECK (line_count >= 0),
  lines_hash text NOT NULL CHECK (lines_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid')),
  paid_at timestamptz,
  deleted boolean NOT NULL DEFAULT false,
  void_reason text CHECK (void_reason IN ('reissued', 'transfer_deleted')),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (transfer_id, currency_code) REFERENCES pay_transfers(id, currency_code),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK (deleted = (void_reason IS NOT NULL)),
  CHECK (NOT (deleted AND status = 'paid'))
);
-- Exactly one live invoice per transfer and billed company.
CREATE UNIQUE INDEX transfer_invoice_live ON transfer_invoice(transfer_id, org_id) WHERE NOT deleted;
CREATE INDEX transfer_invoice_org_date ON transfer_invoice(org_id, invoice_date) WHERE NOT deleted;

CREATE FUNCTION transfer_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
       OR (OLD.status = 'unpaid' AND NEW.status = 'unpaid' AND NEW.deleted AND NEW.paid_at IS NULL)
     ) THEN
    RAISE EXCEPTION 'issued transfer invoices only move forward' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transfer_invoice_forward_only BEFORE UPDATE OR DELETE ON transfer_invoice
  FOR EACH ROW EXECUTE FUNCTION transfer_invoice_guard();
CREATE TRIGGER transfer_invoice_no_truncate BEFORE TRUNCATE ON transfer_invoice
  FOR EACH STATEMENT EXECUTE FUNCTION transfer_invoice_guard();
