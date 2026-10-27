-- SHU-368: eligible-manager reads begin with the company and must not scan
-- the principal-leading unique index on grants.
CREATE INDEX IF NOT EXISTS grants_org_id_index ON grants (org_id);
