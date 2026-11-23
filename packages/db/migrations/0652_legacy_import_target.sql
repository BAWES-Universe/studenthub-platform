-- Cutover lane (M-4 rehearsal): names the environment a database belongs to, for the legacy
-- importer. The importer writes only into a database whose one row says 'staging'. The operator
-- sets that row once on staging (a Hermes card); no other database carries it. Writing into
-- production at cutover needs its own value here, added with the owner's explicit go, never by default.
CREATE TABLE legacy_import_target (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('staging')),
  set_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
