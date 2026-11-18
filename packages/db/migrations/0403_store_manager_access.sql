-- Access lane A4: a store manager sees one store, never a sibling store or
-- the company.
--
-- The store grant is its own table, not a row of grants: it adds no role and
-- no scope to the closed unions, so resolveActiveContext and every company
-- page cannot be satisfied by it. Only store pages read it, and every read
-- joins the store's current status and its company's liveness, so removing
-- the store or deleting the company ends the grant on the next request
-- without deleting the row. Taking the grant away sets revoked_at.

CREATE TABLE store_manager_access (
  id             UUID PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations (id),
  store_id       UUID NOT NULL REFERENCES organization_stores (id),
  principal_id   TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  granted_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at     TIMESTAMPTZ,
  revoked_by     TEXT,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE UNIQUE INDEX store_manager_access_live_idx ON store_manager_access (store_id, principal_id) WHERE revoked_at IS NULL;
CREATE INDEX store_manager_access_principal_idx ON store_manager_access (principal_id) WHERE revoked_at IS NULL;
CREATE INDEX store_manager_access_store_idx ON store_manager_access (store_id);
CREATE INDEX store_manager_access_org_idx ON store_manager_access (org_id) WHERE revoked_at IS NULL;

-- org_id is the store's own company, always; a revoked grant stays revoked.
CREATE FUNCTION store_manager_access_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'store manager access is revoked with revoked_at, never deleted' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organization_stores s WHERE s.id = NEW.store_id AND s.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'store manager access must name the store''s own company' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.store_id <> OLD.store_id OR NEW.principal_id <> OLD.principal_id OR NEW.org_id <> OLD.org_id
      OR NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'store manager access can only be revoked' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER store_manager_access_guard BEFORE INSERT OR UPDATE ON store_manager_access
  FOR EACH ROW EXECUTE FUNCTION store_manager_access_guard();
-- A principal's deletion cascades (ON DELETE CASCADE above); a direct DELETE is refused.
CREATE TRIGGER store_manager_access_no_delete BEFORE DELETE ON store_manager_access
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION store_manager_access_guard();

-- A store invitation offers the store manager access for one named store.
ALTER TABLE company_invitations
  ADD COLUMN store_id UUID REFERENCES organization_stores (id),
  DROP CONSTRAINT company_invitations_role_check,
  ADD CONSTRAINT company_invitations_role_check CHECK (role IN ('org-owner', 'recruiter', 'finance', 'store-manager')),
  ADD CONSTRAINT company_invitations_store_role CHECK ((store_id IS NULL) = (role <> 'store-manager') AND (store_id IS NULL OR scope = 'self'));

DROP INDEX company_invitations_one_pending_idx;
CREATE UNIQUE INDEX company_invitations_one_pending_idx
  ON company_invitations (org_id, role, invited_email_normalized, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- Store grants and their removal are recorded with scope 'store'. The event
-- log keeps the store id without a foreign key, like its other ids, so it
-- never cascades with the store or its company.
ALTER TABLE access_grant_events
  ADD COLUMN store_id UUID,
  DROP CONSTRAINT access_grant_events_role_check,
  ADD CONSTRAINT access_grant_events_role_check CHECK (role IN ('candidate', 'staff', 'admin', 'org-owner', 'recruiter', 'finance', 'store-manager')),
  DROP CONSTRAINT access_grant_events_scope_check,
  ADD CONSTRAINT access_grant_events_scope_check CHECK (scope IN ('self', 'subtree', 'store')),
  ADD CONSTRAINT access_grant_events_store_scope CHECK ((scope = 'store') = (store_id IS NOT NULL) AND (scope = 'store') = (role = 'store-manager'));
