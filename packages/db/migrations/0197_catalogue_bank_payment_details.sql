CREATE TABLE catalogue_bank_payment_details (
  bank_id uuid PRIMARY KEY REFERENCES catalogue_items(id),
  swift_code text NOT NULL CHECK (swift_code ~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  iban_bank_code text NOT NULL CHECK (iban_bank_code ~ '^[A-Z0-9]{4}$'),
  abk_code text NOT NULL CHECK (abk_code ~ '^(100|[1-9]?[0-9])$'),
  transfer_type text NOT NULL CHECK (transfer_type IN ('local', 'international', 'within_bank')),
  created_by_ref char(64) NOT NULL CHECK (created_by_ref ~ '^[0-9a-f]{64}$'),
  updated_by_ref char(64) NOT NULL CHECK (updated_by_ref ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE FUNCTION enforce_catalogue_bank_payment_details_bank()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM catalogue_items
    WHERE id = NEW.bank_id AND catalogue_type = 'bank'
  ) THEN
    RAISE EXCEPTION 'catalogue bank payment details require a bank item';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER catalogue_bank_payment_details_bank
BEFORE INSERT OR UPDATE ON catalogue_bank_payment_details
FOR EACH ROW EXECUTE FUNCTION enforce_catalogue_bank_payment_details_bank();
