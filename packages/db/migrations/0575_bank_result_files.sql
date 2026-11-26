-- F5 bank result files. Depends on 0550 pay lines. Only the paid flag on a pay
-- line is written elsewhere; everything here is the evidence of why.
CREATE TABLE bank_result_files (
 id uuid PRIMARY KEY,
 format text NOT NULL CHECK (format IN ('aub','kfh')),
 content_sha256 text NOT NULL UNIQUE CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
 uploaded_by text NOT NULL REFERENCES principals(id),
 uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 sheet jsonb NOT NULL CHECK (jsonb_typeof(sheet) = 'object'),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied')),
 applied_by text REFERENCES principals(id),
 applied_at timestamptz,
 CHECK ((status = 'applied') = (applied_at IS NOT NULL AND applied_by IS NOT NULL))
);
-- One decision per sheet row, written once when the file is applied.
CREATE TABLE bank_result_rows (
 file_id uuid NOT NULL REFERENCES bank_result_files(id),
 row_number integer NOT NULL CHECK (row_number > 0),
 kind text NOT NULL CHECK (kind IN ('pay','unpay','duplicate','hold')),
 reason text CHECK (reason IN ('rejected_row','unmatched','ambiguous','amount_mismatch','currency_mismatch','already_paid','line_listed_twice','reference_conflict','missing_reference','paid_line_failed')),
 line_ids text[] NOT NULL,
 reference text,
 PRIMARY KEY (file_id,row_number),
 CHECK ((kind = 'hold') = (reason IS NOT NULL))
);
-- Every confirmation that marked a line paid, from any file. A bank reference
-- settles at most one line ever: the unique index is the replay proof that holds
-- across files and transfers even if two applies race.
CREATE TABLE bank_result_confirmations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 reference text CHECK (reference IS NULL OR length(reference) > 0),
 line_id text NOT NULL REFERENCES pay_transfer_lines(id),
 file_id uuid NOT NULL,
 row_number integer NOT NULL,
 account text,
 amount numeric(12,3) NOT NULL,
 currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (file_id,row_number) REFERENCES bank_result_rows(file_id,row_number)
);
CREATE UNIQUE INDEX bank_result_confirmations_reference ON bank_result_confirmations(reference) WHERE reference IS NOT NULL;
CREATE INDEX bank_result_confirmations_line ON bank_result_confirmations(line_id);
CREATE FUNCTION bank_result_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'bank result evidence is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER bank_result_rows_no_mutation BEFORE UPDATE OR DELETE ON bank_result_rows FOR EACH ROW EXECUTE FUNCTION bank_result_evidence_immutable();
CREATE TRIGGER bank_result_rows_no_truncate BEFORE TRUNCATE ON bank_result_rows FOR EACH STATEMENT EXECUTE FUNCTION bank_result_evidence_immutable();
CREATE TRIGGER bank_result_confirmations_no_mutation BEFORE UPDATE OR DELETE ON bank_result_confirmations FOR EACH ROW EXECUTE FUNCTION bank_result_evidence_immutable();
CREATE TRIGGER bank_result_confirmations_no_truncate BEFORE TRUNCATE ON bank_result_confirmations FOR EACH STATEMENT EXECUTE FUNCTION bank_result_evidence_immutable();
-- A file is applied once: only pending -> applied, content never changes, never deleted.
CREATE FUNCTION bank_result_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'bank result files are retained' USING ERRCODE='55000'; END IF;
 IF OLD.status <> 'pending' OR NEW.status <> 'applied' OR NEW.id <> OLD.id OR NEW.format <> OLD.format
   OR NEW.content_sha256 <> OLD.content_sha256 OR NEW.uploaded_by <> OLD.uploaded_by
   OR NEW.uploaded_at <> OLD.uploaded_at OR NEW.sheet <> OLD.sheet THEN
  RAISE EXCEPTION 'bank result file is applied once' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_result_files_guard BEFORE UPDATE OR DELETE ON bank_result_files FOR EACH ROW EXECUTE FUNCTION bank_result_file_guard();
CREATE TRIGGER bank_result_files_no_truncate BEFORE TRUNCATE ON bank_result_files FOR EACH STATEMENT EXECUTE FUNCTION bank_result_evidence_immutable();
