import assert from "node:assert/strict";
import test from "node:test";

import { mapLegacyBrandLinks, mapLegacyStores } from "../src/m4-stores.js";

// Synthetic brand and store rows only.
const brand = (uuid: string, company: unknown) => ({ brand_uuid: uuid, company_id: company, brand_name_en: `Brand ${uuid}`, brand_name_ar: "x" });
const store = (id: unknown, extra: Record<string, unknown> = {}) => ({
  store_id: id, company_id: 7, store_manager_uuid: null, brand_uuid: "b-7", mall_uuid: "m-1", store_name: ` Store ${String(id)} `,
  store_location: " Block 3 ", store_status: 10, store_created_at: "2024-03-01 22:15:00", store_updated_at: "2024-03-02 08:00:00",
  deleted: 0, ...extra,
});
const BRANDS = [brand("b-7", 7), brand("b-9", "9")];

test("brand rows become company links, one per brand, with bad rows reported by id", () => {
  const { links, issues } = mapLegacyBrandLinks([brand("b-9", "9"), brand("b-7", 7), brand("b-7", 8), brand("b-x", null), brand("", 7), { brand_uuid: 12, company_id: 7 }]);
  assert.deepEqual(links.map((l) => [l.brandLegacyId, l.companyLegacyId]), [["b-7", "7"], ["b-9", "9"]]);
  assert.match(links[0]!.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(issues, [
    { rule: "brand.duplicateId", legacyTable: "brand", legacyId: "b-7" },
    { rule: "brand.noCompany", legacyTable: "brand", legacyId: "b-x", field: "company_id" },
    { rule: "brand.badId", legacyTable: "brand", legacyId: "?" },
    { rule: "brand.badId", legacyTable: "brand", legacyId: "?" },
  ]);
});

test("a store maps with trimmed text, its references, Kuwait times and its status; ids sort numerically", () => {
  const { stores, issues } = mapLegacyStores([store(12), store("3", { deleted: 1, mall_uuid: null, brand_uuid: "" })], BRANDS);
  assert.deepEqual(issues, []);
  assert.deepEqual(stores.map((s) => s.legacyId), ["3", "12"]);
  const [removed, active] = stores;
  assert.deepEqual({ ...active, digest: undefined }, {
    legacyId: "12", companyLegacyId: "7", name: "Store 12", location: "Block 3", brandLegacyId: "b-7", mallLegacyId: "m-1",
    status: "active", createdAt: "2024-03-01T19:15:00.000Z", updatedAt: "2024-03-02T05:00:00.000Z", digest: undefined,
  });
  assert.equal(removed!.status, "deleted");
  assert.equal(removed!.brandLegacyId, null);
  assert.equal(removed!.mallLegacyId, null);
});

test("the digest follows the mapped content only", () => {
  const a = mapLegacyStores([store(1)], BRANDS).stores[0]!;
  assert.equal(mapLegacyStores([store(1, { store_status: 0, store_manager_uuid: "c-1" })], BRANDS).stores[0]!.digest, a.digest);
  assert.notEqual(mapLegacyStores([store(1, { store_location: "Block 4" })], BRANDS).stores[0]!.digest, a.digest);
  assert.notEqual(mapLegacyStores([store(1, { deleted: "1" })], BRANDS).stores[0]!.digest, a.digest);
});

test("a store that cannot be kept as legacy shows it is left out and reported", () => {
  const { stores, issues } = mapLegacyStores([
    store(1), store(1), store(0), store(2, { company_id: null }), store(3, { store_name: "   " }),
    store(4, { store_name: "x".repeat(121) }), store(5, { store_name: "x".repeat(120) }),
  ], BRANDS);
  assert.deepEqual(stores.map((s) => s.legacyId), ["1", "5"]);
  assert.deepEqual(issues, [
    { rule: "store.duplicateId", legacyTable: "store", legacyId: "1" },
    { rule: "store.badId", legacyTable: "store", legacyId: "?" },
    { rule: "store.noCompany", legacyTable: "store", legacyId: "2", field: "company_id" },
    { rule: "store.badName", legacyTable: "store", legacyId: "3", field: "store_name" },
    { rule: "store.badName", legacyTable: "store", legacyId: "4", field: "store_name" },
  ]);
});

test("an unusable optional value is dropped and reported; the store still imports", () => {
  const { stores, issues } = mapLegacyStores([
    store(1, { store_location: "y".repeat(501) }), store(2, { store_location: 5 }), store(3, { store_location: "   " }),
    store(4, { brand_uuid: "b-9" }), store(5, { brand_uuid: "b-404" }), store(6, { brand_uuid: "bad id" }), store(7, { mall_uuid: 3 }),
    store(8, { store_location: "y".repeat(500) }),
  ], BRANDS);
  assert.equal(stores.length, 8);
  const by = new Map(stores.map((s) => [s.legacyId, s]));
  assert.equal(by.get("1")!.location, null);
  assert.equal(by.get("2")!.location, null);
  assert.equal(by.get("3")!.location, null);
  assert.equal(by.get("8")!.location, "y".repeat(500));
  assert.equal(by.get("4")!.brandLegacyId, null);
  assert.equal(by.get("5")!.brandLegacyId, null);
  assert.equal(by.get("6")!.brandLegacyId, null);
  assert.equal(by.get("7")!.mallLegacyId, null);
  assert.equal(by.get("7")!.brandLegacyId, "b-7");
  assert.deepEqual(issues, [
    { rule: "store.badLocation", legacyTable: "store", legacyId: "1", field: "store_location" },
    { rule: "store.badLocation", legacyTable: "store", legacyId: "2", field: "store_location" },
    { rule: "store.brandOtherCompany", legacyTable: "store", legacyId: "4", field: "brand_uuid" },
    { rule: "store.unknownBrand", legacyTable: "store", legacyId: "5", field: "brand_uuid" },
    { rule: "store.badReference", legacyTable: "store", legacyId: "6", field: "brand_uuid" },
    { rule: "store.badReference", legacyTable: "store", legacyId: "7", field: "mall_uuid" },
  ]);
});

test("issues carry no legacy text", () => {
  const secret = "Private Store Name Ali";
  const { issues } = mapLegacyStores([store(1, { store_name: secret.repeat(10) }), store(2, { brand_uuid: "zz", store_location: secret.repeat(40) })], BRANDS);
  assert.ok(issues.length > 0);
  assert.ok(!JSON.stringify(issues).includes("Private"));
});
