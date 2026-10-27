CREATE INDEX organization_status_events_org_occurred_id_idx
  ON organization_status_events (org_id, occurred_at DESC, id DESC);
