-- F-1 local slice: draft transfers, exact lines, optimistic edits and append-only audit.
-- Lifecycle effects belong to F-3; no bank or notification effect here.
CREATE TABLE pay_transfers (
 id text PRIMARY KEY,
 company_id text NOT NULL REFERENCES organizations(id),
 period_start date NOT NULL,
 period_end date NOT NULL CHECK (period_end >= period_start),
 currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked','payment_sent','distributing','complete','cancelled')),
 deleted boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
 UNIQUE(id,currency_code)
);
CREATE TABLE pay_transfer_lines (
 id text PRIMARY KEY,
 transfer_id text NOT NULL,
 person_id text NOT NULL REFERENCES principals(id),
 store_id uuid NOT NULL REFERENCES organization_stores(id),
 currency_code text NOT NULL,
 candidate_total numeric(12,3) NOT NULL CHECK (candidate_total >= 0),
 company_total numeric(12,3) NOT NULL CHECK (company_total > 0),
 note text NOT NULL CHECK (length(note) <= 2000),
 calculation jsonb NOT NULL CHECK (jsonb_typeof(calculation) = 'object'),
 paid boolean NOT NULL DEFAULT false,
 FOREIGN KEY(transfer_id,currency_code) REFERENCES pay_transfers(id,currency_code)
);
CREATE TABLE pay_line_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 transfer_id text NOT NULL REFERENCES pay_transfers(id),
 line_id text REFERENCES pay_transfer_lines(id),
 actor_id text NOT NULL REFERENCES principals(id),
 operation text NOT NULL CHECK (operation IN ('create_transfer','add_line','edit_line')),
 before_value jsonb,
 after_value jsonb NOT NULL,
 at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION pay_line_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pay line audit is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER pay_line_audit_no_mutation BEFORE UPDATE OR DELETE ON pay_line_audit FOR EACH ROW EXECUTE FUNCTION pay_line_audit_immutable();
CREATE FUNCTION pay_line_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t pay_transfers;
BEGIN
 SELECT * INTO t FROM pay_transfers WHERE id=COALESCE(NEW.transfer_id, OLD.transfer_id) FOR UPDATE;
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'pay lines are retained' USING ERRCODE='55000'; END IF;
 IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.transfer_id <> OLD.transfer_id OR NEW.person_id <> OLD.person_id OR NEW.store_id <> OLD.store_id OR NEW.currency_code <> OLD.currency_code) THEN
  RAISE EXCEPTION 'pay line identity is immutable' USING ERRCODE='55000';
 END IF;
 -- F-5 may change paid; monetary content is frozen outside draft.
 IF (t.status <> 'draft' OR t.deleted) AND (TG_OP='INSERT' OR NEW.candidate_total <> OLD.candidate_total OR NEW.company_total <> OLD.company_total OR NEW.note <> OLD.note OR NEW.calculation <> OLD.calculation) THEN
  RAISE EXCEPTION 'pay transfer is not editable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pay_line_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON pay_transfer_lines FOR EACH ROW EXECUTE FUNCTION pay_line_draft_only();
