-- SHU-165 O7a: an organization's stores (physical locations where candidates
-- work). Staff and admin keep the list; members read it. A store may name one
-- brand the organization owns and one mall from the reference catalogue.
-- Removal is soft so later assignments and transfers keep their history.
CREATE TABLE organization_stores (
 id uuid PRIMARY KEY,
 org_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),
 location text CHECK (location IS NULL OR (location = btrim(location) AND char_length(location) BETWEEN 1 AND 500)),
 brand_id uuid REFERENCES catalogue_items(id),
 mall_id uuid REFERENCES catalogue_items(id),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
 created_by_ref char(64) NOT NULL CHECK (created_by_ref ~ '^[0-9a-f]{64}$'),
 updated_by_ref char(64) NOT NULL CHECK (updated_by_ref ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deleted_at timestamptz,
 CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE INDEX organization_stores_org_id_idx ON organization_stores(org_id) WHERE status = 'active';
CREATE FUNCTION enforce_organization_store_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.brand_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catalogue_items WHERE id=NEW.brand_id AND catalogue_type='brand') THEN
  RAISE EXCEPTION 'organization store brand must reference a brand' USING ERRCODE='23514';
 END IF;
 IF NEW.mall_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catalogue_items WHERE id=NEW.mall_id AND catalogue_type='mall') THEN
  RAISE EXCEPTION 'organization store mall must reference a mall' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'UPDATE' AND (NEW.org_id <> OLD.org_id OR NEW.id <> OLD.id) THEN
  RAISE EXCEPTION 'organization store cannot move organization' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'UPDATE' AND OLD.status = 'deleted' THEN
  RAISE EXCEPTION 'removed organization store is read-only' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_stores_references BEFORE INSERT OR UPDATE ON organization_stores FOR EACH ROW EXECUTE FUNCTION enforce_organization_store_references();
CREATE FUNCTION refuse_organization_store_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'organization stores are removed softly' USING ERRCODE='23514'; END $$;
CREATE TRIGGER organization_stores_soft_delete BEFORE DELETE ON organization_stores FOR EACH ROW EXECUTE FUNCTION refuse_organization_store_delete();

ALTER TABLE authorization_mutation_audit
 DROP CONSTRAINT authorization_mutation_audit_operation_check,
 ADD CONSTRAINT authorization_mutation_audit_operation_check CHECK (operation IN ('principal.register','grants.grant','grants.revoke','grants.clear','profile.safe_write','profile_record.create','profile_record.update','profile_record.remove','profile_record.restore','profile_record.replace','organization.profile.safe_write','organization.status.safe_write','organization.commercial_terms.safe_write','organization.approved_to_hire.safe_write','organization.note.safe_write','organization.deletion.safe_write','pay_contract.create.safe_write','pay_contract.update.safe_write','pay_contract.remove.safe_write','pay_contract.create','pay_contract.update','pay_contract.remove','candidate.bank_details.safe_write','organization.brand.link','organization.brand.unlink','organization.store.create','organization.store.update','organization.store.remove')),
 DROP CONSTRAINT auth_audit_target_org_cardinality,
 ADD CONSTRAINT auth_audit_target_org_cardinality CHECK (
  (operation IN ('principal.register','grants.clear','profile.safe_write','profile_record.create','profile_record.update','profile_record.remove','profile_record.restore','profile_record.replace','candidate.bank_details.safe_write') AND cardinality(target_org_refs)=0) OR
  (operation IN ('grants.grant','grants.revoke','organization.profile.safe_write','organization.status.safe_write','organization.commercial_terms.safe_write','organization.approved_to_hire.safe_write','organization.note.safe_write','organization.deletion.safe_write','pay_contract.create.safe_write','pay_contract.update.safe_write','pay_contract.remove.safe_write') AND cardinality(target_org_refs)>0) OR
  (operation IN ('pay_contract.create','pay_contract.update','pay_contract.remove','organization.brand.link','organization.brand.unlink','organization.store.create','organization.store.update','organization.store.remove') AND cardinality(target_org_refs)=1)
 );

CREATE OR REPLACE FUNCTION authorization_audit_summary_valid(audit_operation TEXT, summary JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE
  WHEN audit_operation='principal.register' THEN jsonb_typeof(summary)='object' AND summary ?& ARRAY['existed','identityCount','displayNamePresent','emailPresent'] AND summary-ARRAY['existed','identityCount','displayNamePresent','emailPresent']='{}'::jsonb AND jsonb_typeof(summary->'existed')='boolean' AND jsonb_typeof(summary->'displayNamePresent')='boolean' AND jsonb_typeof(summary->'emailPresent')='boolean' AND jsonb_typeof(summary->'identityCount')='number' AND summary->>'identityCount' ~ '^(0|[1-9][0-9]{0,17})$'
  WHEN audit_operation IN ('grants.grant','grants.revoke','grants.clear') THEN jsonb_typeof(summary)='object' AND summary ?& ARRAY['grantCount','selfCount','subtreeCount'] AND summary-ARRAY['grantCount','selfCount','subtreeCount']='{}'::jsonb AND jsonb_typeof(summary->'grantCount')='number' AND jsonb_typeof(summary->'selfCount')='number' AND jsonb_typeof(summary->'subtreeCount')='number' AND summary->>'grantCount' ~ '^(0|[1-9][0-9]{0,17})$' AND summary->>'selfCount' ~ '^(0|[1-9][0-9]{0,17})$' AND summary->>'subtreeCount' ~ '^(0|[1-9][0-9]{0,17})$'
  WHEN audit_operation IN ('profile.safe_write','organization.profile.safe_write','organization.status.safe_write','organization.commercial_terms.safe_write','organization.approved_to_hire.safe_write','organization.note.safe_write','organization.deletion.safe_write','pay_contract.create.safe_write','pay_contract.update.safe_write','pay_contract.remove.safe_write','candidate.bank_details.safe_write') THEN jsonb_typeof(summary)='object' AND ((summary ?& ARRAY['valuePresent'] AND summary-ARRAY['valuePresent']='{}'::jsonb AND jsonb_typeof(summary->'valuePresent')='boolean') OR (summary ?& ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef'] AND summary-ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']='{}'::jsonb AND jsonb_typeof(summary->'contractVersion')='string' AND summary->>'contractVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+$' AND jsonb_typeof(summary->'personRef')='string' AND summary->>'personRef' ~ '^[0-9a-f]{64}$' AND jsonb_typeof(summary->'changeSetDigest')='string' AND summary->>'changeSetDigest' ~ '^[0-9a-f]{64}$' AND jsonb_typeof(summary->'tokenRef')='string' AND summary->>'tokenRef' ~ '^[0-9a-f]{64}$' AND jsonb_typeof(summary->'fields')='array' AND jsonb_array_length(summary->'fields')=1 AND ((audit_operation='profile.safe_write' AND summary->'fields'='["language"]'::jsonb) OR (audit_operation='organization.profile.safe_write' AND summary->'fields'->>0 IN ('name_en','name_ar','description_en','description_ar','website')) OR (audit_operation='organization.status.safe_write' AND summary->'fields'='["status"]'::jsonb) OR (audit_operation='organization.commercial_terms.safe_write' AND summary->'fields'->>0 IN ('hourly_rate','bonus_commission')) OR (audit_operation='organization.approved_to_hire.safe_write' AND summary->'fields'='["approved_to_hire"]'::jsonb) OR (audit_operation='organization.note.safe_write' AND summary->'fields'->>0 IN ('note','note_phone_call','note_email','note_meeting','note_interview','note_task')) OR (audit_operation='organization.deletion.safe_write' AND summary->'fields'='["deletion"]'::jsonb) OR (audit_operation='pay_contract.create.safe_write' AND summary->'fields'='["pay_contract"]'::jsonb) OR (audit_operation='pay_contract.update.safe_write' AND summary->'fields'='["pay_contract_terms"]'::jsonb) OR (audit_operation='pay_contract.remove.safe_write' AND summary->'fields'='["pay_contract_removal"]'::jsonb) OR (audit_operation='candidate.bank_details.safe_write' AND summary->'fields'='["bank_details"]'::jsonb)) AND jsonb_typeof(summary->'committedAt')='string' AND summary->>'committedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'))
  WHEN audit_operation IN ('profile_record.create','profile_record.update','profile_record.remove','profile_record.restore','profile_record.replace') THEN jsonb_typeof(summary)='object' AND summary ?& ARRAY['kind','activeCount'] AND summary-ARRAY['kind','activeCount']='{}'::jsonb AND summary->>'kind' IN ('education','experience','skill','link') AND jsonb_typeof(summary->'activeCount')='number' AND summary->>'activeCount' ~ '^(0|[1-9][0-9]{0,17})$'
  WHEN audit_operation IN ('pay_contract.create','pay_contract.update','pay_contract.remove') THEN jsonb_typeof(summary)='object' AND summary ?& ARRAY['payModel','contractCount'] AND summary-ARRAY['payModel','contractCount']='{}'::jsonb AND summary->>'payModel' IN ('hourly','fixed_price','monthly_salary') AND jsonb_typeof(summary->'contractCount')='number' AND summary->>'contractCount' ~ '^(0|[1-9][0-9]{0,17})$'
  WHEN audit_operation IN ('organization.brand.link','organization.brand.unlink') THEN jsonb_typeof(summary)='object' AND summary ?& ARRAY['brandCount'] AND summary-ARRAY['brandCount']='{}'::jsonb AND jsonb_typeof(summary->'brandCount')='number' AND summary->>'brandCount' ~ '^(0|[1-9][0-9]{0,17})$'
  WHEN audit_operation IN ('organization.store.create','organization.store.update','organization.store.remove') THEN jsonb_typeof(summary)='object' AND summary ?& ARRAY['storeCount'] AND summary-ARRAY['storeCount']='{}'::jsonb AND jsonb_typeof(summary->'storeCount')='number' AND summary->>'storeCount' ~ '^(0|[1-9][0-9]{0,17})$'
  ELSE FALSE END
$$;
