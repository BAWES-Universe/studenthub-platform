-- F-3 depends on 0550_pay_transfer_lines.sql. No billing/child schema is invented.
ALTER TABLE pay_transfers ADD COLUMN payment_received_on date;
CREATE TABLE pay_transfer_lifecycle_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 transfer_id text NOT NULL REFERENCES pay_transfers(id),
 actor_id text NOT NULL REFERENCES principals(id),
 action text NOT NULL CHECK (action IN ('lock','cancel','payment_sent','payment_received','admin_revert','admin_unlock','complete','reopen_after_unpaid','delete')),
 from_status text NOT NULL CHECK (from_status IN ('draft','locked','payment_sent','distributing','complete','cancelled')),
 to_status text NOT NULL CHECK (to_status IN ('draft','locked','payment_sent','distributing','complete','cancelled')),
 deleted boolean NOT NULL,
 occurred_at timestamptz NOT NULL,
 source_version integer NOT NULL CHECK (source_version >= 0),
 witness_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(transfer_id,source_version),
 CHECK (deleted = (action = 'delete')),
 CHECK (from_status <> to_status OR action = 'delete'),
 CHECK (CASE action
  WHEN 'lock' THEN from_status='draft' AND to_status='locked'
  WHEN 'cancel' THEN from_status='draft' AND to_status='cancelled'
  WHEN 'payment_sent' THEN from_status='locked' AND to_status='payment_sent'
  WHEN 'payment_received' THEN from_status IN ('locked','payment_sent') AND to_status='distributing'
  WHEN 'admin_revert' THEN from_status='payment_sent' AND to_status='locked'
  WHEN 'admin_unlock' THEN from_status IN ('locked','payment_sent') AND to_status='draft'
  WHEN 'complete' THEN from_status='distributing' AND to_status='complete'
  WHEN 'reopen_after_unpaid' THEN from_status='complete' AND to_status='distributing'
  WHEN 'delete' THEN from_status IN ('draft','locked','cancelled') AND to_status=from_status
  ELSE false END)
);
CREATE INDEX pay_transfer_lifecycle_history_transfer ON pay_transfer_lifecycle_history(transfer_id,id);
CREATE FUNCTION pay_transfer_lifecycle_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pay lifecycle history is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER pay_transfer_lifecycle_history_no_mutation BEFORE UPDATE OR DELETE ON pay_transfer_lifecycle_history FOR EACH ROW EXECUTE FUNCTION pay_transfer_lifecycle_history_immutable();
CREATE TRIGGER pay_transfer_lifecycle_history_no_truncate BEFORE TRUNCATE ON pay_transfer_lifecycle_history FOR EACH STATEMENT EXECUTE FUNCTION pay_transfer_lifecycle_history_immutable();
-- Mirrors the domain state matrix and binds each change to its exact source version.
-- The witness protects ordinary writes from accidental bypass of the authorized
-- lifecycle adapter; DB roles able to forge audit rows are not a separate trust boundary.
CREATE FUNCTION pay_transfer_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
  RAISE EXCEPTION 'pay transfer company is immutable' USING ERRCODE='55000';
 END IF;
 IF OLD.deleted AND NOT NEW.deleted THEN
  RAISE EXCEPTION 'deleted pay transfers cannot be restored' USING ERRCODE='55000';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted IS DISTINCT FROM OLD.deleted
    OR NEW.payment_received_on IS DISTINCT FROM OLD.payment_received_on THEN
  IF OLD.deleted OR NEW.version<>OLD.version+1
   OR (to_jsonb(NEW)-'status'-'version'-'deleted'-'payment_received_on')
       IS DISTINCT FROM (to_jsonb(OLD)-'status'-'version'-'deleted'-'payment_received_on')
   OR NOT EXISTS (
    SELECT 1 FROM pay_transfer_lifecycle_history h
     WHERE h.transfer_id=OLD.id AND h.from_status=OLD.status AND h.to_status=NEW.status
       AND h.deleted=NEW.deleted AND h.source_version=OLD.version
       AND h.witness_transaction=pg_current_xact_id()
       AND (CASE WHEN h.action='payment_received'
          THEN NEW.payment_received_on IS NOT DISTINCT FROM (h.occurred_at AT TIME ZONE 'Asia/Kuwait')::date
          ELSE NEW.payment_received_on IS NOT DISTINCT FROM OLD.payment_received_on END)
   )
  THEN
   RAISE EXCEPTION 'pay transfer change requires its lifecycle history' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pay_transfer_lifecycle_guard BEFORE UPDATE ON pay_transfers
 FOR EACH ROW EXECUTE FUNCTION pay_transfer_lifecycle_guard();
