-- S8 ID cards (reports lane, legacy `candidate_id_card` and staff CandidateIdCardController).
-- One card per person. Staff issue it to someone assigned to a store, valid for three months,
-- and renew it for another three. The card shows the person's name and their current company
-- and store, read from the work lane's assignments when it is shown; it stores none of them.
-- Every issue and renewal leaves an append-only event row in the same transaction.
CREATE TABLE id_cards (
 person_principal_id text PRIMARY KEY REFERENCES principals(id),
 card_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 expires_on date NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 issued_by text REFERENCES principals(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- Cards carried over from legacy keep their legacy row id; they have no issuing staff member.
 legacy_ref text UNIQUE CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[0-9]{1,18}$'),
 CHECK ((issued_by IS NULL) = (legacy_ref IS NOT NULL))
);
CREATE INDEX id_cards_expires_idx ON id_cards(expires_on);

CREATE TABLE id_card_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 person_principal_id text NOT NULL REFERENCES id_cards(person_principal_id),
 kind text NOT NULL CHECK (kind IN ('issued','reissued','renewed')),
 expires_on date NOT NULL,
 actor_principal_id text NOT NULL REFERENCES principals(id),
 at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX id_card_events_person_idx ON id_card_events(person_principal_id, at DESC);

CREATE FUNCTION id_card_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'id_card_events is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER id_card_events_no_change BEFORE UPDATE OR DELETE ON id_card_events
 FOR EACH ROW EXECUTE FUNCTION id_card_events_append_only();
-- TRUNCATE skips row triggers, so it is refused by statement triggers on both tables:
-- truncating id_cards with CASCADE would otherwise take the events with it.
CREATE TRIGGER id_card_events_no_truncate BEFORE TRUNCATE ON id_card_events
 FOR EACH STATEMENT EXECUTE FUNCTION id_card_events_append_only();
CREATE FUNCTION id_cards_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'id_cards rows are retained' USING ERRCODE='55000'; END $$;
CREATE TRIGGER id_cards_no_truncate BEFORE TRUNCATE ON id_cards
 FOR EACH STATEMENT EXECUTE FUNCTION id_cards_retained();
