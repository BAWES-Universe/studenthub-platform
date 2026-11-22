import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresCatalogueImportStore, PostgresOrganizationImportStore, PostgresStoreImportStore } from "@studenthub/db/import";
import { ORGANIZATION_PARITY_REVISION } from "../../organizations/src/index.js";
import { mapLegacyCatalogue } from "../../../tools/legacy-import/src/m4-catalogue.js";
import { mapLegacyCompanies } from "../../../tools/legacy-import/src/m4-organizations.js";
import { mapLegacyBrandLinks, mapLegacyStores } from "../../../tools/legacy-import/src/m4-stores.js";

// Synthetic company, brand, mall and store rows only; fresh legacy ids per run so the suite can share a database.

const URL = process.env.DATABASE_URL ?? "";
const ACTOR = createHash("sha256").update("legacy-import:test").digest("hex");
const NOW = "2026-11-20T12:00:00.000Z";
let pool: pg.Pool, stores: PostgresStoreImportStore, catalogue: PostgresCatalogueImportStore, organizations: PostgresOrganizationImportStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  const operator = `import-operator-${randomUUID()}`;
  await pool.query("INSERT INTO organizations (id, name, parent_org_id) VALUES ($1, 'Operator', NULL)", [operator]);
  organizations = new PostgresOrganizationImportStore(pool, ORGANIZATION_PARITY_REVISION, operator);
  catalogue = new PostgresCatalogueImportStore(pool, ACTOR);
  stores = new PostgresStoreImportStore(pool, ACTOR);
});
after(async () => pool.end());

let next = Math.floor(Date.now() / 1000) * 1000 + 500 + Math.floor(Math.random() * 400);
const ids = () => { next += 10; return next; };
const company = (id: number) => ({ company_id: id, parent_company_id: null, company_name: `Company ${id}`, company_approved_to_hire: 1 });
const brand = (uuid: string, companyId: number, name = uuid) => ({ brand_uuid: uuid, company_id: companyId, brand_name_en: `Brand ${name}` });
const store = (id: number, companyId: number, extra: Record<string, unknown> = {}) => ({
  store_id: id, company_id: companyId, brand_uuid: null, mall_uuid: null, store_name: `Store ${id}`, store_location: "Block 3",
  store_created_at: "2024-03-01 22:15:00", store_updated_at: "2024-03-02 08:00:00", deleted: 0, ...extra,
});

/** Imports companies, brands (catalogue items) and malls, as the importer does before stores. */
async function seed(companies: number[], brands: ReturnType<typeof brand>[], malls: string[] = []) {
  await organizations.importOrganizations(mapLegacyCompanies(companies.map(company)).organizations);
  await catalogue.importItems(mapLegacyCatalogue("brand", brands).items, NOW);
  await catalogue.importItems(mapLegacyCatalogue("mall", malls.map((m) => ({ mall_uuid: m, mall_name_en: `Mall ${m}` }))).items, NOW);
  return { org: await organizations.idMap(), brand: await catalogue.idMap("brand"), mall: await catalogue.idMap("mall") };
}

test("brand links and stores import once with their brand, mall and times; a re-run is unchanged", async () => {
  const c = ids(), s = ids(), run = randomUUID().slice(0, 8);
  const brands = [brand(`${run}-b`, c)];
  const maps = await seed([c], brands, [`${run}-m`]);
  const links = mapLegacyBrandLinks(brands).links;
  assert.deepEqual(await stores.importBrandLinks(links), { inserted: 1, adopted: 0, unchanged: 0, conflicts: [], refused: [] });
  assert.deepEqual(await stores.importBrandLinks(links), { inserted: 0, adopted: 0, unchanged: 1, conflicts: [], refused: [] });
  const orgId = maps.org.get(String(c))!;
  const { rows: linked } = await pool.query("SELECT org_id, linked_by_ref FROM organization_brands WHERE brand_id = $1", [maps.brand.get(`${run}-b`)]);
  assert.deepEqual(linked, [{ org_id: orgId, linked_by_ref: ACTOR }]);

  const mapped = mapLegacyStores([store(s, c, { brand_uuid: `${run}-b`, mall_uuid: `${run}-m` }), store(s + 1, c, { deleted: 1, store_updated_at: null })], brands).stores;
  assert.deepEqual(await stores.importStores(mapped, NOW), { inserted: 2, adopted: 0, unchanged: 0, conflicts: [], refused: [] });
  assert.deepEqual(await stores.importStores(mapped, NOW), { inserted: 0, adopted: 0, unchanged: 2, conflicts: [], refused: [] });
  const storeIds = await stores.storeIdMap();
  const { rows } = await pool.query(
    "SELECT id::text, org_id, name, location, brand_id::text, mall_id::text, status, created_at, updated_at, deleted_at, created_by_ref FROM organization_stores WHERE id = ANY($1::uuid[]) ORDER BY name",
    [[storeIds.get(String(s)), storeIds.get(String(s + 1))]]);
  assert.equal(rows.length, 2);
  const [active, removed] = rows;
  assert.equal(active.org_id, orgId);
  assert.equal(active.location, "Block 3");
  assert.equal(active.brand_id, maps.brand.get(`${run}-b`));
  assert.equal(active.mall_id, maps.mall.get(`${run}-m`));
  assert.equal(active.status, "active");
  assert.equal(active.created_at.toISOString(), "2024-03-01T19:15:00.000Z");
  assert.equal(active.updated_at.toISOString(), "2024-03-02T05:00:00.000Z");
  assert.equal(active.deleted_at, null);
  assert.equal(active.created_by_ref, ACTOR);
  assert.equal(removed.status, "deleted");
  assert.equal(removed.deleted_at.toISOString(), "2024-03-01T19:15:00.000Z");
});

test("a changed store or link is a conflict and is never overwritten", async () => {
  const c = ids(), other = ids(), s = ids(), run = randomUUID().slice(0, 8);
  const brands = [brand(`${run}-b`, c)];
  const maps = await seed([c, other], brands);
  const first = mapLegacyBrandLinks(brands).links;
  await stores.importBrandLinks(first);
  const moved = mapLegacyBrandLinks([brand(`${run}-b`, other)]).links;
  assert.deepEqual((await stores.importBrandLinks(moved)).conflicts,
    [{ legacyId: `${run}-b`, existingDigest: first[0]!.digest, incomingDigest: moved[0]!.digest }]);
  const { rows: link } = await pool.query("SELECT org_id FROM organization_brands WHERE brand_id = $1", [maps.brand.get(`${run}-b`)]);
  assert.equal(link[0].org_id, maps.org.get(String(c)));

  const before = mapLegacyStores([store(s, c)], brands).stores;
  await stores.importStores(before, NOW);
  const renamed = mapLegacyStores([store(s, c, { store_name: "Renamed" })], brands).stores;
  assert.deepEqual((await stores.importStores(renamed, NOW)).conflicts,
    [{ legacyId: String(s), existingDigest: before[0]!.digest, incomingDigest: renamed[0]!.digest }]);
  const { rows } = await pool.query("SELECT name FROM organization_stores WHERE id = $1", [(await stores.storeIdMap()).get(String(s))]);
  assert.equal(rows[0].name, `Store ${s}`);
});

test("rows whose company, brand or mall is not imported are refused, and the batch goes on", async () => {
  const c = ids(), missing = ids(), s = ids(), run = randomUUID().slice(0, 8);
  const brands = [brand(`${run}-b`, c), brand(`${run}-nobrand`, c), brand(`${run}-noorg`, missing)];
  await seed([c], [brands[0]!, brands[2]!]);
  const links = await stores.importBrandLinks(mapLegacyBrandLinks(brands).links);
  assert.deepEqual(links.refused, [{ legacyId: `${run}-noorg`, code: "no_organization" }, { legacyId: `${run}-nobrand`, code: "no_brand" }]
    .sort((a, b) => (a.legacyId < b.legacyId ? -1 : 1)));
  assert.equal(links.inserted, 1);

  const result = await stores.importStores(mapLegacyStores([
    store(s, missing), store(s + 1, c, { brand_uuid: `${run}-nobrand` }), store(s + 2, c, { mall_uuid: `${run}-nomall` }), store(s + 3, c),
  ], brands).stores, NOW);
  assert.deepEqual(result.refused, [
    { legacyId: String(s), code: "no_organization" }, { legacyId: String(s + 1), code: "no_brand" }, { legacyId: String(s + 2), code: "no_mall" },
  ]);
  assert.equal(result.inserted, 1);
});

test("two legacy brands that share a catalogue item: the first company keeps it, the second is refused", async () => {
  const a = ids(), b = ids(), run = randomUUID().slice(0, 8);
  // Same name, so the catalogue maps the second brand to the first one's item.
  const brands = [brand(`${run}-1`, a, run), brand(`${run}-2`, b, run), brand(`${run}-3`, a, run)];
  const maps = await seed([a, b], brands);
  assert.equal(maps.brand.get(`${run}-1`), maps.brand.get(`${run}-2`));
  const result = await stores.importBrandLinks(mapLegacyBrandLinks(brands).links);
  assert.deepEqual([result.inserted, result.adopted, result.refused], [1, 1, [{ legacyId: `${run}-2`, code: "brand_taken" }]]);
});

test("a store whose brand is not linked to the store's organization is refused", async () => {
  const a = ids(), b = ids(), s = ids(), run = randomUUID().slice(0, 8);
  const brands = [brand(`${run}-b`, b)];
  await seed([a, b], brands);
  await stores.importBrandLinks(mapLegacyBrandLinks(brands).links);
  // The mapper drops another company's brand; a row that still names one is refused at write time.
  const [row] = mapLegacyStores([store(s, a, { brand_uuid: `${run}-b` })], [brand(`${run}-b`, a)]).stores;
  assert.deepEqual((await stores.importStores([row!], NOW)).refused, [{ legacyId: String(s), code: "brand_not_linked" }]);
});

test("reconciliation lists reported skips apart from unexplained gaps", async () => {
  const c = ids(), s = ids();
  await seed([c], []);
  await stores.importStores(mapLegacyStores([store(s, c)], []).stores, NOW);
  const report = await stores.reconcile("store", [String(s), String(s + 1), String(s + 2)], [String(s + 1)]);
  assert.deepEqual([report.legacy, report.imported, report.skipped, report.missing], [3, 1, [String(s + 1)], [String(s + 2)]]);
});

test("two import runs at once are serialized: one inserts, the other finds the stores unchanged", async () => {
  const c = ids(), base = ids(); next += 200;
  await seed([c], []);
  const mapped = mapLegacyStores(Array.from({ length: 20 }, (_, i) => store(base + i, c)), []).stores;
  const other = new PostgresStoreImportStore({ connectionString: URL }, ACTOR);
  try {
    const [x, y] = await Promise.all([stores.importStores(mapped, NOW), other.importStores(mapped, NOW)]);
    assert.deepEqual([x.inserted + y.inserted, x.unchanged + y.unchanged, x.refused, y.refused], [20, 20, [], []]);
  } finally {
    await other.close();
  }
});
