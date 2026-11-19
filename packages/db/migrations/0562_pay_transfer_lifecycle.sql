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
 unlock_source_version integer,
 witness_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK ((action = 'admin_unlock') = (unlock_source_version IS NOT NULL)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pay_transfer_lifecycle_history_transfer ON pay_transfer_lifecycle_history(transfer_id,id);
CREATE FUNCTION pay_transfer_lifecycle_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pay lifecycle history is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER pay_transfer_lifecycle_history_no_mutation BEFORE UPDATE OR DELETE ON pay_transfer_lifecycle_history FOR EACH ROW EXECUTE FUNCTION pay_transfer_lifecycle_history_immutable();
-- The witness protects ordinary writes from accidental bypass of the authorized
-- lifecycle adapter; DB roles able to forge audit rows are not a separate trust boundary.
CREATE UNIQUE INDEX pay_transfer_lifecycle_one_unlock_per_version
 ON pay_transfer_lifecycle_history(transfer_id,unlock_source_version)
 WHERE unlock_source_version IS NOT NULL;

CREATE FUNCTION pay_transfer_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
  RAISE EXCEPTION 'pay transfer company is immutable' USING ERRCODE='55000';
 END IF;
 IF OLD.status IN ('locked','payment_sent') AND NEW.status='draft' THEN
  IF NEW.version<>OLD.version+1
   OR (to_jsonb(NEW)-'status'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'version')
   OR NOT EXISTS (
    SELECT 1 FROM pay_transfer_lifecycle_history h
     WHERE h.transfer_id=OLD.id AND h.action='admin_unlock' AND NOT h.deleted
       AND h.from_status=OLD.status AND h.to_status=NEW.status
       AND h.unlock_source_version=OLD.version AND h.witness_transaction=pg_current_xact_id()
   )
  THEN
   RAISE EXCEPTION 'pay transfer unlock requires its lifecycle history' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pay_transfer_lifecycle_guard BEFORE UPDATE ON pay_transfers
 FOR EACH ROW EXECUTE FUNCTION pay_transfer_lifecycle_guard();
