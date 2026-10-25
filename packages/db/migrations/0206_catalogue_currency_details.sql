CREATE TABLE catalogue_currency_details (
  currency_id uuid PRIMARY KEY REFERENCES catalogue_items(id),
  symbol text NOT NULL CHECK (symbol = btrim(symbol) AND char_length(symbol) BETWEEN 1 AND 8),
  decimal_places smallint NOT NULL CHECK (decimal_places BETWEEN 0 AND 4),
  created_by_ref char(64) NOT NULL CHECK (created_by_ref ~ '^[0-9a-f]{64}$'),
  updated_by_ref char(64) NOT NULL CHECK (updated_by_ref ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE FUNCTION enforce_catalogue_currency_details_currency()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalogue_items WHERE id = NEW.currency_id AND catalogue_type = 'currency') THEN
    RAISE EXCEPTION 'catalogue currency details require a currency item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER catalogue_currency_details_currency
BEFORE INSERT OR UPDATE ON catalogue_currency_details
FOR EACH ROW EXECUTE FUNCTION enforce_catalogue_currency_details_currency();
