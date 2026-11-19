-- F2 additive generation reservation. No approval, finalization, or money movement.
CREATE TABLE pay_generation_claims (
 line_id text PRIMARY KEY REFERENCES pay_transfer_lines(id) DEFERRABLE INITIALLY DEFERRED,
 transfer_id text NOT NULL REFERENCES pay_transfers(id),
 person_id text NOT NULL REFERENCES principals(id), contract_id text NOT NULL,
 period_start date NOT NULL, period_end date NOT NULL CHECK(period_end >= period_start),
 candidate_key text NOT NULL,
 UNIQUE(person_id,contract_id,period_start,period_end)
);
CREATE TABLE pay_generation_roots (
 root_id text PRIMARY KEY,
 line_id text NOT NULL REFERENCES pay_generation_claims(line_id)
);
CREATE TABLE pay_generation_receipts (
 transfer_id text NOT NULL REFERENCES pay_transfers(id), batch_key text NOT NULL,
 revision text NOT NULL, resulting_version integer NOT NULL CHECK(resulting_version>0),
 line_ids jsonb NOT NULL CHECK(jsonb_typeof(line_ids)='array'),
 PRIMARY KEY(transfer_id,batch_key)
);
-- Manual F1 writes participate without requiring a changed F1 payload. Unknown
-- manual contract provenance conflicts conservatively with ANY claimed contract.
CREATE FUNCTION pay_generation_manual_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t pay_transfers; own pay_generation_claims;
BEGIN
 IF TG_OP='UPDATE' AND NEW.person_id=OLD.person_id AND NEW.transfer_id=OLD.transfer_id
   AND NEW.candidate_total=OLD.candidate_total AND NEW.company_total=OLD.company_total AND NEW.calculation=OLD.calculation THEN RETURN NEW; END IF;
 SELECT * INTO t FROM pay_transfers WHERE id=NEW.transfer_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(NEW.person_id)::text, 0));
 SELECT * INTO own FROM pay_generation_claims WHERE line_id=NEW.id;
 IF FOUND AND (own.transfer_id<>NEW.transfer_id OR own.person_id<>NEW.person_id OR own.period_start<>t.period_start OR own.period_end<>t.period_end
   OR NEW.calculation->>'contractId' IS DISTINCT FROM own.contract_id OR NEW.calculation->>'candidateKey' IS DISTINCT FROM own.candidate_key) THEN
  RAISE EXCEPTION 'generation claim identity mismatch' USING ERRCODE='23505';
 END IF;
 IF EXISTS(SELECT 1 FROM pay_generation_claims c WHERE c.person_id=NEW.person_id AND c.period_start<=t.period_end AND c.period_end>=t.period_start AND c.line_id<>NEW.id
    AND (NEW.calculation->>'contractId' IS NULL OR NEW.calculation->>'contractId'='' OR c.contract_id=NEW.calculation->>'contractId')) THEN
  RAISE EXCEPTION 'generation claim conflict' USING ERRCODE='23505';
 END IF;
 IF EXISTS(SELECT 1 FROM pay_generation_roots r WHERE r.line_id<>NEW.id AND r.root_id IN
   (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(NEW.calculation->'provenance'->'roots')='array' THEN NEW.calculation->'provenance'->'roots' ELSE '[]'::jsonb END))) THEN
  RAISE EXCEPTION 'generation root conflict' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pay_generation_manual_guard BEFORE INSERT OR UPDATE ON pay_transfer_lines FOR EACH ROW EXECUTE FUNCTION pay_generation_manual_guard();
CREATE FUNCTION pay_generation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'generation records are retained' USING ERRCODE='55000'; END $$;
CREATE TRIGGER pay_generation_claims_immutable BEFORE UPDATE OR DELETE ON pay_generation_claims FOR EACH ROW EXECUTE FUNCTION pay_generation_immutable();
CREATE TRIGGER pay_generation_roots_immutable BEFORE UPDATE OR DELETE ON pay_generation_roots FOR EACH ROW EXECUTE FUNCTION pay_generation_immutable();
CREATE TRIGGER pay_generation_receipts_immutable BEFORE UPDATE OR DELETE ON pay_generation_receipts FOR EACH ROW EXECUTE FUNCTION pay_generation_immutable();
CREATE FUNCTION pay_generation_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Header updates already lock the same parent row as pay-line writes.
 IF (NEW.period_start,NEW.period_end,NEW.company_id) IS DISTINCT FROM (OLD.period_start,OLD.period_end,OLD.company_id) THEN
  IF EXISTS(SELECT 1 FROM pay_generation_claims WHERE transfer_id=OLD.id) THEN
   RAISE EXCEPTION 'claimed generation transfer identity is immutable' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM pay_transfer_lines WHERE transfer_id=OLD.id) THEN
   RAISE EXCEPTION 'transfer identity is immutable while pay lines are retained' USING ERRCODE='55000';
  END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER pay_generation_period_guard BEFORE UPDATE ON pay_transfers FOR EACH ROW EXECUTE FUNCTION pay_generation_period_guard();
