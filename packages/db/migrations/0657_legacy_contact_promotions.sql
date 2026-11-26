-- Cutover lane (M-1 contact slice): the promotion step that moves a linked person's staged
-- legacy contact values (legacy_candidate_contacts) into the person-owned tables. One row per
-- principal, written in the same transaction as the promotion, so a principal is promoted at
-- most once: a value the person later clears or changes is never brought back by a re-run.
-- Each column records what happened to one value as a fixed outcome code; no value, digest or
-- address is kept here.
CREATE TABLE legacy_contact_promotions (
  principal_id TEXT PRIMARY KEY REFERENCES principals (id) ON DELETE CASCADE,
  legacy_candidate_id TEXT NOT NULL CHECK (legacy_candidate_id ~ '^[1-9][0-9]{0,17}$'),
  revision TEXT NOT NULL CHECK (revision ~ '^[a-z0-9-]{1,40}$'),
  phone TEXT NOT NULL CHECK (phone IN ('promoted', 'none', 'personWritten', 'taken')),
  handle TEXT NOT NULL CHECK (handle IN ('promoted', 'none', 'personWritten', 'taken')),
  civil_id TEXT NOT NULL CHECK (civil_id IN ('promoted', 'none', 'personWritten', 'taken', 'undecryptable')),
  email TEXT NOT NULL CHECK (email IN ('promoted', 'none', 'answered', 'mismatch', 'unverifiable', 'addressChanged')),
  promoted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX legacy_contact_promotions_candidate_idx ON legacy_contact_promotions (legacy_candidate_id);
