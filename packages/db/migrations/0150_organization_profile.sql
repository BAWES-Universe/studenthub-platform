CREATE TABLE organization_profile_fields (
 org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 field TEXT NOT NULL CHECK(field IN ('name_ar','name_en','description_ar','description_en','website')),
 value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(org_id,field)
);
ALTER TABLE authorization_mutation_audit
 DROP CONSTRAINT auth_audit_target_org_cardinality,
 ADD CONSTRAINT auth_audit_target_org_cardinality CHECK ((operation IN ('principal.register','grants.clear','profile_record.create','profile_record.update','profile_record.remove','profile_record.restore','profile_record.replace') AND cardinality(target_org_refs)=0) OR (operation IN ('grants.grant','grants.revoke') AND cardinality(target_org_refs)>0) OR (operation='profile.safe_write' AND cardinality(target_org_refs) IN (0,1))),
 DROP CONSTRAINT auth_audit_safe_write_self,
 ADD CONSTRAINT auth_audit_safe_write_self CHECK (operation<>'profile.safe_write' OR (actor_principal_ref IS NOT NULL AND (cardinality(target_org_refs)=1 OR actor_principal_ref=target_principal_ref))),
 DROP CONSTRAINT auth_audit_before_summary_shape, DROP CONSTRAINT auth_audit_after_summary_shape;
ALTER TABLE authorization_mutation_audit
 ADD CONSTRAINT auth_audit_before_summary_shape CHECK (authorization_audit_summary_valid(operation,before_summary) OR (operation='profile.safe_write' AND cardinality(target_org_refs)=1 AND before_summary ?& ARRAY['valuePresent'] AND before_summary-ARRAY['valuePresent']='{}'::jsonb)),
 ADD CONSTRAINT auth_audit_after_summary_shape CHECK (authorization_audit_summary_valid(operation,after_summary) OR (operation='profile.safe_write' AND cardinality(target_org_refs)=1 AND after_summary ?& ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef'] AND after_summary-ARRAY['contractVersion','personRef','changeSetDigest','fields','committedAt','tokenRef']='{}'::jsonb AND after_summary->'fields' <@ '["name_ar","name_en","description_ar","description_en","website"]'::jsonb AND jsonb_array_length(after_summary->'fields')=1));
