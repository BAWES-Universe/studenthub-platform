-- Access lane A9: staff view a person's account read-only for 15 minutes.
--
-- One row per view: both identities, the reason, and the fixed window. Staff
-- never hold a session as the person, so the view cannot write anything; the
-- person sees the dates of the views (never the staff member's name). Rows
-- are append-only.

CREATE TABLE staff_views (
  id                   UUID PRIMARY KEY,
  staff_principal_id   TEXT NOT NULL,
  target_principal_id  TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  reason               TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  started_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at           TIMESTAMPTZ NOT NULL,
  CHECK (staff_principal_id <> target_principal_id),
  CHECK (expires_at = started_at + interval '15 minutes')
);
CREATE INDEX staff_views_target_idx ON staff_views (target_principal_id, started_at DESC);
CREATE INDEX staff_views_staff_target_idx ON staff_views (staff_principal_id, target_principal_id, expires_at DESC);

CREATE FUNCTION staff_views_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staff views are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER staff_views_append_only BEFORE UPDATE OR DELETE ON staff_views
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION staff_views_append_only();
