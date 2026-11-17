-- Access lane A8: per-person limits on writes and uploads, and the network
-- address block list.
--
-- person_request_counts is a fixed-window counter keyed by principal, so the
-- limit is shared across every session of the person; old windows are pruned
-- by the writer. ip_blocks keeps who blocked an address, when and why, and who
-- unblocked it, when and why: rows are never deleted or edited otherwise.

CREATE TABLE person_request_counts (
  principal_id  TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('write', 'upload')),
  window_start  TIMESTAMPTZ NOT NULL,
  count         INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (principal_id, kind, window_start)
);
CREATE INDEX person_request_counts_window_idx ON person_request_counts (window_start);

CREATE TABLE ip_blocks (
  id             UUID PRIMARY KEY,
  cidr           CIDR NOT NULL,
  reason         TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  removed_at     TIMESTAMPTZ,
  removed_by     TEXT,
  remove_reason  TEXT CHECK (remove_reason IS NULL OR char_length(remove_reason) BETWEEN 3 AND 500),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL) AND (removed_at IS NULL) = (remove_reason IS NULL))
);
CREATE UNIQUE INDEX ip_blocks_live_idx ON ip_blocks (cidr) WHERE removed_at IS NULL;
CREATE INDEX ip_blocks_created_idx ON ip_blocks (created_at DESC);

CREATE FUNCTION ip_blocks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'address blocks are removed with removed_at, never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NEW.cidr <> OLD.cidr OR NEW.reason <> OLD.reason
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an address block can only be removed, once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ip_blocks_guard BEFORE UPDATE OR DELETE ON ip_blocks
  FOR EACH ROW EXECUTE FUNCTION ip_blocks_guard();
