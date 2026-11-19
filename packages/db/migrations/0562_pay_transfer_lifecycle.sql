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
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pay_transfer_lifecycle_history_transfer ON pay_transfer_lifecycle_history(transfer_id,id);
CREATE FUNCTION pay_transfer_lifecycle_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pay lifecycle history is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER pay_transfer_lifecycle_history_no_mutation BEFORE UPDATE OR DELETE ON pay_transfer_lifecycle_history FOR EACH ROW EXECUTE FUNCTION pay_transfer_lifecycle_history_immutable();
