import assert from "node:assert/strict";
import { test } from "node:test";
import * as normal from "../src/organization-stores.js";

// SHU165_TEST_MODULE lets organization-stores-mutations.mjs run this suite against a mutated build.
const subject = process.env.SHU165_TEST_MODULE ? (await import(process.env.SHU165_TEST_MODULE)) as typeof normal : normal;
const ORG = "company", PARENT = "parent", OPERATOR = "operator";
const BRAND = "123e4567-e89b-42d3-a456-426614174000", MALL = "223e4567-e89b-42d3-a456-426614174000";
const grant = (role: string, org_id = ORG, scope = "self") => [{ org_id, role, scope }];
const row = (over: Partial<normal.OrganizationStoreRow> = {}): normal.OrganizationStoreRow => ({
  store_id: "s1", name: "Avenues", location: "Phase 4", status: "active",
  brand_id: BRAND, brand_name: "Brand", brand_status: "active", mall_id: MALL, mall_name: "The Avenues", mall_status: "active", ...over,
});

test("SHU-165/AC-01 write-owner-staff-admin refuses recruiters, finance and candidates", () => {
  for (const role of ["recruiter", "finance", "candidate"]) assert.equal(subject.organizationStoreWriteDecision(grant(role), ORG, [], [OPERATOR]), false, role);
  for (const role of ["staff", "admin", "org-owner"]) assert.equal(subject.organizationStoreWriteDecision(grant(role), ORG, [], [OPERATOR]), true, role);
  assert.equal(subject.organizationStoreWriteDecision(grant("org-owner", PARENT, "subtree"), ORG, [PARENT], [OPERATOR]), true, "a group owner keeps sub-company stores");
  assert.equal(subject.organizationStoreWriteDecision(grant("admin", PARENT, "subtree"), ORG, [PARENT], [OPERATOR]), true);
  assert.equal(subject.organizationStoreWriteDecision(grant("staff", PARENT, "self"), ORG, [PARENT], [OPERATOR]), false, "a self grant on the parent does not reach the child");
  assert.equal(subject.organizationStoreWriteDecision(grant("staff", "sibling"), ORG, [PARENT], [OPERATOR]), false);
  assert.equal(subject.organizationStoreWriteDecision(grant("admin", OPERATOR, "subtree"), OPERATOR, [], [OPERATOR]), false, "operator organizations have no stores");
});

test("SHU-165/AC-02 read-members-and-staff lets owners and recruiters read but not finance", () => {
  for (const role of ["org-owner", "recruiter", "staff", "admin"]) assert.equal(subject.organizationStoreReadDecision(grant(role), ORG, [], [OPERATOR]), true, role);
  for (const role of ["finance", "candidate"]) assert.equal(subject.organizationStoreReadDecision(grant(role), ORG, [], [OPERATOR]), false, role);
  assert.equal(subject.organizationStoreReadDecision(grant("org-owner", PARENT, "subtree"), ORG, [PARENT], [OPERATOR]), true);
  assert.equal(subject.organizationStoreReadDecision(grant("org-owner", "sibling"), ORG, [PARENT], [OPERATOR]), false, "a sibling company reads nothing");
  assert.equal(subject.organizationStoreReadDecision(grant("staff", OPERATOR), OPERATOR, [], [OPERATOR]), false);
});

test("SHU-165/AC-03 fields-parse trims, requires a name and refuses unknown keys", () => {
  assert.deepEqual(subject.parseOrganizationStoreFields({ name: "  Avenues  ", location: " Phase 4 ", brandId: BRAND.toUpperCase(), mallId: null }), { name: "Avenues", location: "Phase 4", brandId: BRAND, mallId: null });
  assert.deepEqual(subject.parseOrganizationStoreFields({ name: "Avenues" }), { name: "Avenues", location: null, brandId: null, mallId: null });
  for (const bad of [null, [], "x", {}, { name: "" }, { name: "   " }, { name: "x".repeat(121) }, { name: "a\nb" }, { name: "A", location: "" }, { name: "A", location: "x".repeat(501) },
    { name: "A", brandId: "not-a-uuid" }, { name: "A", mallId: 7 }, { name: "A", orgId: "other" }, { name: "A", status: "deleted" }])
    assert.equal(subject.parseOrganizationStoreFields(bad), undefined, JSON.stringify(bad));
  assert.equal(subject.parseOrganizationStoreFields({ name: "x".repeat(120) })?.name.length, 120);
});

test("SHU-165/AC-04 removed-hidden filters removed stores and removed references, sorted", () => {
  const view = subject.organizationStoresView([row({ store_id: "b", name: "Same" }), row({ store_id: "gone", name: "A", status: "deleted" }), row({ store_id: "a", name: "Same", brand_status: "deleted", mall_status: "deleted" })]);
  assert.deepEqual(view.map((v) => v.storeId), ["a", "b"]);
  assert.equal(view[0]!.brand, null);
  assert.equal(view[0]!.mall, null);
  assert.deepEqual(view[1]!.brand, { id: BRAND, name: "Brand" });
  assert.deepEqual(subject.organizationStoresView([row({ brand_id: null, brand_name: null, brand_status: null })])[0]!.brand, null);
});

test("SHU-165/AC-05 view-whitelist exposes exact keys", () => {
  const view = subject.organizationStoresView([row({ org_id: "secret-org", created_by_ref: "f".repeat(64), updated_at: "2025-01-01Z" })]);
  assert.deepEqual(Object.keys(view[0]!), ["storeId", "name", "location", "brand", "mall"]);
  for (const secret of ["secret-org", "f".repeat(64), "2025-01-01"]) assert.equal(JSON.stringify(view).includes(secret), false);
});

test("SHU331_GROUP_REFUSED refused parent stops before loading children", async () => {
  let childrenCalled = false;
  assert.equal(await subject.organizationGroupStores(ORG, async () => null, async () => { childrenCalled = true; return ["c1"]; }), null);
  assert.equal(childrenCalled, false);
});

test("SHU331_GROUP_SCOPE refused children are omitted while authorized organizations remain", async () => {
  const rows = new Map<string, readonly normal.OrganizationStoreRow[] | null>([
    [ORG, [row({ store_id: "parent-store", name: "Parent" })]],
    ["c1", [row({ store_id: "child-store", name: "Child" })]],
    ["c2", null],
  ]);
  const stores = await subject.organizationGroupStores(ORG, async (id) => rows.get(id) ?? null, async () => ["c1", "c2"]);
  assert.deepEqual(stores?.map((store) => [store.orgId, store.storeId]), [[ORG, "parent-store"], ["c1", "child-store"]]);
  assert.equal(stores?.some((store) => store.orgId === "c2"), false);
});

test("SHU331_GROUP_VIEW exposes exact group keys, filters removed data and keeps parent first", async () => {
  const stores = await subject.organizationGroupStores(ORG, async (id) => id === ORG
    ? [row({ store_id: "parent", name: "Parent" }), row({ store_id: "removed", status: "deleted" })]
    : [row({ store_id: "child", name: "Child", brand_status: "deleted" })], async () => ["c1"]);
  assert.deepEqual(stores?.map((store) => store.storeId), ["parent", "child"]);
  assert.deepEqual(Object.keys(stores![0]!), ["orgId", "storeId", "name", "location", "brand", "mall"]);
  assert.equal(stores![1]!.brand, null);
});
