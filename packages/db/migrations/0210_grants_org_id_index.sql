-- SHU-359: company-scoped eligible-manager listings start from org_id.
CREATE INDEX IF NOT EXISTS grants_org_id_index ON grants (org_id);
