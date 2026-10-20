import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { organizationBrandDecision, organizationBrandLinkOutcome, organizationBrandUnlinkOutcome, organizationStoreReadDecision, organizationStoresView, organizationStoreWriteDecision } from "@studenthub/organizations";
import { ORGANIZATION_STORE_CREATE_OPERATION, ORGANIZATION_STORE_REMOVE_OPERATION, ORGANIZATION_STORE_UPDATE_OPERATION, organizationAuditRef, PostgresAuthzStore, PostgresOrganizationBrandsStore, PostgresOrganizationStoresStore, runMigrations } from "@studenthub/db";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresOrganizationStoresStore, brands: PostgresOrganizationBrandsStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresOrganizationStoresStore({ pool, writeDecision: organizationStoreWriteDecision, readDecision: organizationStoreReadDecision });
  brands = new PostgresOrganizationBrandsStore({ pool, decision: organizationBrandDecision, linkOutcome: organizationBrandLinkOutcome, unlinkOutcome: organizationBrandUnlinkOutcome });
});
after(async () => pool.end());

async function organization(parentOrgId?: string) {
  const id = `shu165-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id, name: `company-${id}`, ...(parentOrgId ? { parentOrgId } : {}) }));
  return id;
}
async function principal(orgId: string, role = "staff", grantOrg = orgId, scope: "self" | "subtree" = "self") {
  const id = `shu165-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  await authz.grantMany(id, [{ orgId: grantOrg, role, scope }]);
  return id;
}
async function item(type: "brand" | "mall" | "currency", name = `${type}-${randomUUID()}`) {
  const id = randomUUID();
  await pool.query("INSERT INTO catalogue_items(id,catalogue_type,name,normalized_name,status,created_by_ref,updated_by_ref,created_at,updated_at) VALUES($1,$2,$3,$3,'active',$4,$4,now(),now())", [id, type, name, "a".repeat(64)]);
  return { id, name };
}
async function audits(orgId: string) {
  return (await pool.query("SELECT operation,target_org_refs,before_summary,after_summary FROM authorization_mutation_audit WHERE operation=ANY($1) AND target_org_refs=$2::text[] ORDER BY occurred_at,id",
    [[ORGANIZATION_STORE_CREATE_OPERATION, ORGANIZATION_STORE_UPDATE_OPERATION, ORGANIZATION_STORE_REMOVE_OPERATION], [organizationAuditRef(orgId)]])).rows;
}
const fields = (over: Partial<{ name: string; location: string | null; brandId: string | null; mallId: string | null }> = {}) => ({ name: "Avenues", location: null, brandId: null, mallId: null, ...over });

test("SHU-165 postgres staff creates, edits and removes a store; audits carry only counts", async () => {
  const orgId = await organization(), staff = await principal(orgId), brand = await item("brand", `Private Brand ${randomUUID()}`), mall = await item("mall");
  assert.deepEqual(await brands.link(staff, orgId, brand.id), { kind: "linked" });
  const created = await store.create(staff, orgId, fields({ name: "Secret Store", location: "Hidden Street", brandId: brand.id, mallId: mall.id }));
  assert.equal(created.kind, "created");
  const storeId = (created as { storeId: string }).storeId;
  assert.deepEqual(organizationStoresView((await store.list(staff, orgId)) ?? []), [{ storeId, name: "Secret Store", location: "Hidden Street", brand: { id: brand.id, name: brand.name }, mall: { id: mall.id, name: mall.name } }]);
  assert.deepEqual(await store.update(staff, orgId, storeId, fields({ name: "Secret Store", location: "Hidden Street", brandId: brand.id, mallId: mall.id })), { kind: "unchanged" });
  assert.deepEqual(await store.update(staff, orgId, storeId, fields({ name: "Renamed", brandId: brand.id })), { kind: "updated" });
  assert.deepEqual(organizationStoresView((await store.list(staff, orgId)) ?? [])[0], { storeId, name: "Renamed", location: null, brand: { id: brand.id, name: brand.name }, mall: null });
  assert.deepEqual(await store.remove(staff, orgId, storeId), { kind: "removed" });
  assert.deepEqual(await store.remove(staff, orgId, storeId), { kind: "store_not_found" });
  assert.deepEqual(await store.update(staff, orgId, storeId, fields()), { kind: "store_not_found" });
  assert.deepEqual(await store.list(staff, orgId), []);
  const rows = await audits(orgId);
  assert.deepEqual(rows.map((r) => [r.operation, r.before_summary, r.after_summary]), [
    [ORGANIZATION_STORE_CREATE_OPERATION, { storeCount: 0 }, { storeCount: 1 }],
    [ORGANIZATION_STORE_UPDATE_OPERATION, { storeCount: 1 }, { storeCount: 1 }],
    [ORGANIZATION_STORE_REMOVE_OPERATION, { storeCount: 1 }, { storeCount: 0 }],
  ], "an unchanged edit writes no audit row");
  for (const secret of [storeId, "Secret Store", "Hidden Street", brand.id, mall.id, orgId]) assert.equal(JSON.stringify(rows).includes(secret), false, secret);
  await assert.rejects(pool.query("DELETE FROM organization_stores WHERE id=$1", [storeId]), /removed softly/);
  await assert.rejects(pool.query("UPDATE organization_stores SET name='Back' WHERE id=$1", [storeId]), /read-only/);
});

test("SHU-165 postgres admin and owners write through grants; recruiters read but cannot write", async () => {
  const root = await organization(), orgId = await organization(root), admin = await principal(orgId, "admin", root, "subtree");
  const recruiter = await principal(orgId, "recruiter"), groupOwner = await principal(orgId, "org-owner", root, "subtree"), finance = await principal(orgId, "finance");
  const created = await store.create(admin, orgId, fields());
  assert.equal(created.kind, "created");
  const storeId = (created as { storeId: string }).storeId;
  for (const reader of [recruiter, groupOwner]) assert.equal((await store.list(reader, orgId))?.[0]?.store_id, storeId);
  assert.equal(await store.list(finance, orgId), null);
  assert.deepEqual(await store.create(recruiter, orgId, fields()), { kind: "not_found" });
  assert.deepEqual(await store.update(recruiter, orgId, storeId, fields({ name: "Taken" })), { kind: "not_found" });
  assert.deepEqual(await store.remove(recruiter, orgId, storeId), { kind: "not_found" });
  assert.equal((await audits(orgId)).length, 1, "refused writes leave no audit row");
  assert.deepEqual(await store.update(groupOwner, orgId, storeId, fields({ name: "Group owner edit" })), { kind: "updated" });
});

test("SHU-165 postgres a store belongs to one organization; a sibling cannot see, edit or remove it", async () => {
  const first = await organization(), second = await organization(), firstStaff = await principal(first), secondStaff = await principal(second);
  const created = await store.create(firstStaff, first, fields());
  const storeId = (created as { storeId: string }).storeId;
  assert.equal(await store.list(secondStaff, first), null);
  assert.deepEqual(await store.update(secondStaff, second, storeId, fields({ name: "Moved" })), { kind: "store_not_found" });
  assert.deepEqual(await store.remove(secondStaff, second, storeId), { kind: "store_not_found" });
  assert.deepEqual(await store.update(secondStaff, first, storeId, fields({ name: "Moved" })), { kind: "not_found" });
  assert.equal((await store.list(firstStaff, first))?.[0]?.name, "Avenues");
  await assert.rejects(pool.query("UPDATE organization_stores SET org_id=$2 WHERE id=$1", [storeId, second]), /cannot move/);
});

test("SHU-165 postgres refuses a brand the organization does not own, a wrong-type or removed mall", async () => {
  const orgId = await organization(), other = await organization(), staff = await principal(orgId), otherStaff = await principal(other);
  const unlinked = await item("brand"), foreign = await item("brand"), mall = await item("mall"), currency = await item("currency"), removedMall = await item("mall");
  assert.deepEqual(await brands.link(otherStaff, other, foreign.id), { kind: "linked" });
  await pool.query("UPDATE catalogue_items SET status='deleted',deleted_at=now() WHERE id=$1", [removedMall.id]);
  assert.deepEqual(await store.create(staff, orgId, fields({ brandId: unlinked.id })), { kind: "brand_not_found" });
  assert.deepEqual(await store.create(staff, orgId, fields({ brandId: foreign.id })), { kind: "brand_not_found" });
  assert.deepEqual(await store.create(staff, orgId, fields({ brandId: mall.id })), { kind: "brand_not_found" });
  for (const mallId of [currency.id, removedMall.id, randomUUID()]) assert.deepEqual(await store.create(staff, orgId, fields({ mallId })), { kind: "mall_not_found" });
  await assert.rejects(pool.query("INSERT INTO organization_stores(id,org_id,name,mall_id,created_by_ref,updated_by_ref) VALUES($1,$2,'X',$3,$4,$4)", [randomUUID(), orgId, currency.id, "b".repeat(64)]), /must reference a mall/);
  assert.deepEqual(await store.list(staff, orgId), []);
  assert.equal((await audits(orgId)).length, 0);
});

test("SHU-165 postgres an edit keeps a brand that was unlinked after the store named it", async () => {
  const orgId = await organization(), staff = await principal(orgId), brand = await item("brand");
  await brands.link(staff, orgId, brand.id);
  const storeId = ((await store.create(staff, orgId, fields({ brandId: brand.id }))) as { storeId: string }).storeId;
  assert.deepEqual(await brands.unlink(staff, orgId, brand.id), { kind: "unlinked" });
  assert.deepEqual(await store.update(staff, orgId, storeId, fields({ name: "Renamed", brandId: brand.id })), { kind: "updated" });
  const other = await item("brand");
  assert.deepEqual(await store.update(staff, orgId, storeId, fields({ name: "Renamed", brandId: other.id })), { kind: "brand_not_found" });
});

test("SHU-165 postgres a deleted organization answers not_found to every store call", async () => {
  const orgId = await organization(), staff = await principal(orgId), owner = await principal(orgId, "org-owner");
  const storeId = ((await store.create(staff, orgId, fields())) as { storeId: string }).storeId;
  await pool.query("INSERT INTO organization_deletions(org_id,receipt_ref) VALUES($1,$2)", [orgId, `shu165-${randomUUID()}`]);
  assert.deepEqual(await store.create(staff, orgId, fields()), { kind: "not_found" });
  assert.deepEqual(await store.update(staff, orgId, storeId, fields({ name: "After" })), { kind: "not_found" });
  assert.deepEqual(await store.remove(staff, orgId, storeId), { kind: "not_found" });
  assert.equal(await store.list(staff, orgId), null);
  assert.equal(await store.list(owner, orgId), null);
  assert.equal(await store.list(staff, `shu165-unknown-${randomUUID()}`), null);
});
