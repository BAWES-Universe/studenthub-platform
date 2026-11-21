-- Cutover lane (M-4): the id map from each imported legacy row to the platform row it became.
-- Keyed by the legacy table and its primary key as text. Several legacy rows can map to one
-- platform row (two active legacy catalogue rows with the same name become one item), so the
-- platform side is not unique. The digest is sha256 of the mapped content: a re-run with the
-- same content writes nothing, and changed content is a conflict, never an overwrite.
CREATE TABLE legacy_id_maps (
  legacy_table text NOT NULL CHECK (legacy_table ~ '^[a-z][a-z0-9_]{0,63}$'),
  legacy_id text NOT NULL CHECK (legacy_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  entity text NOT NULL CHECK (entity ~ '^[a-z][a-z0-9_-]{0,63}$'),
  platform_id text NOT NULL CHECK (char_length(platform_id) BETWEEN 1 AND 128),
  -- imported: this row created the platform row; merged: same name as another legacy row,
  -- mapped to that row's item; adopted: mapped to a platform row that already existed.
  outcome text NOT NULL CHECK (outcome IN ('imported', 'merged', 'adopted')),
  digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (legacy_table, legacy_id)
);
CREATE INDEX legacy_id_maps_platform_idx ON legacy_id_maps (entity, platform_id);
