-- S8 public ID card photo (reports lane). The public check page behind a card's QR code shows the
-- holder's photo to whoever scanned it. Nobody is signed in, so these reads cannot go in
-- staff_person_views (its viewer is a principal); each one is recorded here before the photo is
-- sent: which card, which photo version, when, and a keyed hash of the client address (never the
-- address itself). Rows are never changed or removed.
CREATE TABLE id_card_public_views (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 card_number bigint NOT NULL REFERENCES id_cards(card_number),
 subject_principal_id text NOT NULL REFERENCES principals(id),
 document_type text NOT NULL CHECK (document_type = 'personal-photo'),
 document_version uuid NOT NULL,
 client_hash text NOT NULL CHECK (client_hash ~ '^[A-Za-z0-9_-]{22}$'),
 viewed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX id_card_public_views_card_idx ON id_card_public_views(card_number, viewed_at DESC);
CREATE INDEX id_card_public_views_subject_idx ON id_card_public_views(subject_principal_id, viewed_at DESC);

CREATE FUNCTION id_card_public_views_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'id_card_public_views is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER id_card_public_views_no_change BEFORE UPDATE OR DELETE ON id_card_public_views
 FOR EACH ROW EXECUTE FUNCTION id_card_public_views_append_only();
-- TRUNCATE skips row triggers, so it is refused by a statement trigger.
CREATE TRIGGER id_card_public_views_no_truncate BEFORE TRUNCATE ON id_card_public_views
 FOR EACH STATEMENT EXECUTE FUNCTION id_card_public_views_append_only();
