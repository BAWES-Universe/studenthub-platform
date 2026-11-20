import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresCatalogueImportStore } from "@studenthub/db/import";
import { mapLegacyCatalogue } from "../../../tools/legacy-import/src/m4-catalogue.js";

// Synthetic rows only. Every run uses fresh ids and names, so it can share a database with other suites.

const URL = process.env.DATABASE_URL ?? "";
const ACTOR = createHash("sha256").update("legacy-import:test").digest("hex");
const NOW = "2026-11-20T12:00:00.000Z";
let pool: pg.Pool, store: PostgresCatalogueImportStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  store = new PostgresCatalogueImportStore(pool, ACTOR);
});
after(async () => pool.end());

const tag = () => `t${randomUUID().slice(0, 8)}`;

test("catalogue import writes items and id maps once; a re-run is unchanged", async () => {
  const run = tag();
  const { items } = mapLegacyCatalogue("mall", [
    { mall_uuid: `${run}-1`, mall_name_en: `${run} Avenues`, mall_created_datetime: "2020-01-01 22:30:00", mall_updated_datetime: "2020-02-01 10:00:00" },
    { mall_uuid: `${run}-2`, mall_name_en: `${run} Marina`, mall_created_datetime: null },
  ]);
  const first = await store.importItems(items, NOW);
  assert.deepEqual(first, { inserted: 2, merged: 0, adopted: 0, unchanged: 0, conflicts: [], refused: [] });
  const again = await store.importItems(items, NOW);
  assert.deepEqual(again, { inserted: 0, merged: 0, adopted: 0, unchanged: 2, conflicts: [], refused: [] });

  const map = await store.idMap("mall");
  const id = map.get(`${run}-1`)!;
  const { rows } = await pool.query("SELECT catalogue_type, name, status, created_at, updated_at, created_by_ref FROM catalogue_items WHERE id = $1", [id]);
  assert.equal(rows[0].catalogue_type, "mall");
  assert.equal(rows[0].name, `${run} Avenues`);
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].created_at.toISOString(), "2020-01-01T19:30:00.000Z");
  assert.equal(rows[0].updated_at.toISOString(), "2020-02-01T07:00:00.000Z");
  assert.equal(rows[0].created_by_ref, ACTOR);
  const { rows: noDates } = await pool.query("SELECT created_at FROM catalogue_items WHERE id = $1", [map.get(`${run}-2`)]);
  assert.equal(noDates[0].created_at.toISOString(), NOW);
});

test("a changed legacy row is a conflict with both digests, never an overwrite", async () => {
  const run = tag();
  const before = mapLegacyCatalogue("tag", [{ tag_id: `${run}`, tag: `${run} old` }]).items;
  await store.importItems(before, NOW);
  const changed = mapLegacyCatalogue("tag", [{ tag_id: `${run}`, tag: `${run} new` }]).items;
  const result = await store.importItems(changed, NOW);
  assert.deepEqual(result.conflicts, [{ legacyTable: "tag", legacyId: run, existingDigest: before[0]!.digest, incomingDigest: changed[0]!.digest }]);
  const { rows } = await pool.query("SELECT name FROM catalogue_items WHERE id = $1", [(await store.idMap("tag")).get(run)]);
  assert.equal(rows[0].name, `${run} old`);
});

test("same-name active rows map to one item; deleted rows get their own deleted item", async () => {
  const run = tag();
  const { items } = mapLegacyCatalogue("university", [
    { university_id: `${run}2`, university_name_en: `${run} Uni`, deleted: 0 },
    { university_id: `${run}1`, university_name_en: `${run}  UNI`, deleted: 0 },
    { university_id: `${run}3`, university_name_en: `${run} Uni`, deleted: 1 },
  ]);
  const result = await store.importItems(items, NOW);
  assert.deepEqual({ ...result }, { inserted: 2, merged: 1, adopted: 0, unchanged: 0, conflicts: [], refused: [] });
  const map = await store.idMap("university");
  assert.equal(map.get(`${run}2`), map.get(`${run}1`));
  assert.notEqual(map.get(`${run}3`), map.get(`${run}1`));
  const { rows } = await pool.query("SELECT status, deleted_at IS NOT NULL AS gone FROM catalogue_items WHERE id = $1", [map.get(`${run}3`)]);
  assert.deepEqual({ ...rows[0] }, { status: "deleted", gone: true });
});

test("a merged row whose target is not imported is refused, not guessed", async () => {
  const run = tag();
  const { items } = mapLegacyCatalogue("brand", [
    { brand_uuid: `${run}-a`, brand_name_en: `${run} Brand` },
    { brand_uuid: `${run}-b`, brand_name_en: `${run} brand` },
  ]);
  const result = await store.importItems([items[1]!], NOW);
  assert.deepEqual(result.refused, [{ legacyTable: "brand", legacyId: `${run}-b`, code: "no_merge_target" }]);
  assert.equal((await store.idMap("brand")).has(`${run}-b`), false);
});

test("an active platform item with the same kind and name is adopted, not duplicated", async () => {
  const run = tag();
  const existing = randomUUID();
  await pool.query(
    `INSERT INTO catalogue_items (id, catalogue_type, name, normalized_name, status, created_by_ref, updated_by_ref, created_at, updated_at)
     VALUES ($1, 'country', $2, $3, 'active', $4, $4, now(), now())`, [existing, `${run} Land`, `${run} land`, ACTOR]);
  const { items } = mapLegacyCatalogue("country", [{ country_id: `${run}`, country_name_en: `${run} Land` }]);
  const result = await store.importItems(items, NOW);
  assert.equal(result.adopted, 1);
  assert.equal((await store.idMap("country")).get(run), existing);
});

test("a same-name currency or bank is adopted only with the same code and details; otherwise it is a name conflict, again on a re-run", async () => {
  const run = tag();
  const item = async (type: string, name: string, code: string | null) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO catalogue_items (id, catalogue_type, name, normalized_name, code, status, created_by_ref, updated_by_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, now(), now())`, [id, type, name, name.toLowerCase(), code, ACTOR]);
    return id;
  };
  const currencyDetails = (id: string, symbol: string, places: number) => pool.query(
    `INSERT INTO catalogue_currency_details (currency_id, symbol, decimal_places, created_by_ref, updated_by_ref, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, now(), now())`, [id, symbol, places, ACTOR]);
  const same = await item("currency", `${run} Same`, "KWD"); await currencyDetails(same, "KD", 3);
  await item("currency", `${run} Bare`, "KWD"); // no typed details
  const coded = await item("currency", `${run} Coded`, "BHD"); await currencyDetails(coded, "KD", 3);
  const bank = await item("bank", `${run} Bank`, null);
  await pool.query(
    `INSERT INTO catalogue_bank_payment_details (bank_id, swift_code, iban_bank_code, abk_code, transfer_type, created_by_ref, updated_by_ref, created_at, updated_at)
     VALUES ($1, 'NBOKKWKW', 'NBOK', '12', 'local', $2, $2, now(), now())`, [bank, ACTOR]);

  const kwd = { code: "KWD", currency_symbol: "KD", decimal_place: 3, status: 1 };
  const currencies = mapLegacyCatalogue("currency", [
    { currency_id: `${run}1`, title: `${run} Same`, ...kwd },
    { currency_id: `${run}2`, title: `${run} Bare`, ...kwd },
    { currency_id: `${run}3`, title: `${run} Coded`, ...kwd },
  ]).items;
  const banks = mapLegacyCatalogue("bank", [
    { bank_id: `${run}`, bank_name: `${run} Bank`, bank_swift_code: "NBOKKWKW", bank_iban_code: "NBOK", bank_code_abk: 12, bank_transfer_type: "SWF", deleted: 0 },
  ]).items;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await store.importItems(currencies, NOW);
    assert.equal(result.adopted, attempt === 0 ? 1 : 0);
    assert.equal(result.unchanged, attempt === 0 ? 0 : 1);
    assert.equal(result.inserted, 0);
    assert.deepEqual(result.refused, [
      { legacyTable: "currency", legacyId: `${run}2`, code: "name_conflict" },
      { legacyTable: "currency", legacyId: `${run}3`, code: "name_conflict" },
    ]);
    assert.deepEqual((await store.importItems(banks, NOW)).refused, [{ legacyTable: "bank", legacyId: run, code: "name_conflict" }]);
  }
  const map = await store.idMap("currency");
  assert.equal(map.get(`${run}1`), same);
  assert.equal(map.has(`${run}2`) || map.has(`${run}3`) || (await store.idMap("bank")).has(run), false);
  const { rows } = await pool.query("SELECT symbol, decimal_places FROM catalogue_currency_details WHERE currency_id = $1", [coded]);
  assert.deepEqual({ ...rows[0] }, { symbol: "KD", decimal_places: 3 });
});

test("a later same-name alias is checked against the item, not just the target id: a changed target holds it, a matching one maps", async () => {
  const run = tag();
  const row = (id: string, places: number) => ({ currency_id: id, title: `${run} Dinar`, code: "KWD", currency_symbol: "KD", decimal_place: places, status: 1 });
  const first = mapLegacyCatalogue("currency", [row(`${run}1`, 3)]).items;
  assert.equal((await store.importItems(first, NOW)).inserted, 1);
  const item = (await store.idMap("currency")).get(`${run}1`);

  // Legacy now says 2 places for the first row and for a new same-name row.
  const changed = mapLegacyCatalogue("currency", [row(`${run}1`, 2), row(`${run}2`, 2)]).items;
  assert.equal(changed[1]!.mergedInto, `${run}1`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await store.importItems(changed, NOW);
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(result.refused, [{ legacyTable: "currency", legacyId: `${run}2`, code: "name_conflict" }]);
    assert.equal(result.merged, 0);
  }
  assert.equal((await store.idMap("currency")).has(`${run}2`), false);

  // Control: a later alias that matches the item still maps to it.
  const matching = mapLegacyCatalogue("currency", [row(`${run}1`, 3), row(`${run}3`, 3)]).items;
  const result = await store.importItems(matching, NOW);
  assert.deepEqual({ merged: result.merged, unchanged: result.unchanged, refused: result.refused }, { merged: 1, unchanged: 1, refused: [] });
  assert.equal((await store.idMap("currency")).get(`${run}3`), item);
});

test("bank and currency details are written with the item", async () => {
  const run = tag();
  const banks = mapLegacyCatalogue("bank", [
    { bank_id: `${run}`, bank_name: `${run} Bank`, bank_swift_code: "NBOKKWKW", bank_iban_code: "NBOK", bank_code_abk: 12, bank_transfer_type: "TRF", deleted: 0 },
  ]).items;
  const currencies = mapLegacyCatalogue("currency", [
    { currency_id: `${run}`, title: `${run} Dinar`, code: "KWD", currency_symbol: "KD", decimal_place: 3, status: 1, datetime: "2019-05-05 09:00:00" },
  ]).items;
  await store.importItems(banks, NOW);
  await store.importItems(currencies, NOW);
  const { rows: bank } = await pool.query("SELECT swift_code, iban_bank_code, abk_code, transfer_type FROM catalogue_bank_payment_details WHERE bank_id = $1", [(await store.idMap("bank")).get(run)]);
  assert.deepEqual({ ...bank[0] }, { swift_code: "NBOKKWKW", iban_bank_code: "NBOK", abk_code: "12", transfer_type: "within_bank" });
  const { rows: currency } = await pool.query("SELECT symbol, decimal_places FROM catalogue_currency_details WHERE currency_id = $1", [(await store.idMap("currency")).get(run)]);
  assert.deepEqual({ ...currency[0] }, { symbol: "KD", decimal_places: 3 });
});

test("a row the schema refuses is reported and the batch goes on", async () => {
  const run = tag();
  const { items } = mapLegacyCatalogue("tag", [{ tag_id: `${run}1`, tag: `${run} one` }, { tag_id: `${run}2`, tag: `${run} two` }]);
  const broken = { ...items[0]!, type: "not-a-kind" };
  const result = await store.importItems([broken, items[1]!], NOW);
  assert.deepEqual(result.refused, [{ legacyTable: "tag", legacyId: `${run}1`, code: "invalid" }]);
  assert.equal(result.inserted, 1);
});

test("reconciliation splits absent ids into reported skips and unexplained gaps, and lists extras", async () => {
  const run = tag();
  const { items } = mapLegacyCatalogue("area", [
    { area_uuid: `${run}-1`, area_name_en: `${run} One` },
    { area_uuid: `${run}-2`, area_name_en: `${run} one` },
  ]);
  await store.importItems(items, NOW);
  const report = await store.reconcile("area", [`${run}-1`, `${run}-2`, `${run}-3`, `${run}-4`], [`${run}-3`]);
  assert.equal(report.legacy, 4);
  assert.equal(report.mapped, 2);
  assert.equal(report.imported, 1);
  assert.equal(report.merged, 1);
  assert.deepEqual(report.skipped, [`${run}-3`]);
  assert.deepEqual(report.missing, [`${run}-4`]);
  assert.ok(report.extra.every((id) => !id.startsWith(run)));
});

test("adoption takes only unmapped active items: a deleted row and a second legacy row each stay apart", async () => {
  const run = tag();
  const existing = randomUUID();
  await pool.query(
    `INSERT INTO catalogue_items (id, catalogue_type, name, normalized_name, status, created_by_ref, updated_by_ref, created_at, updated_at)
     VALUES ($1, 'tag', $2, $3, 'active', $4, $4, now(), now())`, [existing, `${run} Same`, `${run} same`, ACTOR]);
  const deleted = mapLegacyCatalogue("university", [{ university_id: `${run}0`, university_name_en: `${run} Gone`, deleted: 1 }]).items;
  await pool.query(
    `INSERT INTO catalogue_items (id, catalogue_type, name, normalized_name, status, created_by_ref, updated_by_ref, created_at, updated_at)
     VALUES ($1, 'university', $2, $3, 'active', $4, $4, now(), now())`, [randomUUID(), `${run} Gone`, `${run} gone`, ACTOR]);
  assert.equal((await store.importItems(deleted, NOW)).inserted, 1);

  const first = mapLegacyCatalogue("tag", [{ tag_id: `${run}1`, tag: `${run} Same` }]).items;
  assert.equal((await store.importItems(first, NOW)).adopted, 1);
  // A later legacy row with the same name that the mapper did not merge must not take the item too.
  const second = mapLegacyCatalogue("tag", [{ tag_id: `${run}2`, tag: `${run} Same` }]).items;
  const result = await store.importItems(second, NOW);
  assert.equal(result.adopted, 0);
  assert.deepEqual(result.refused, [{ legacyTable: "tag", legacyId: `${run}2`, code: "invalid" }]);
  const map = await store.idMap("tag");
  assert.equal(map.get(`${run}1`), existing);
  assert.equal(map.has(`${run}2`), false);
});

test("two import runs at once are serialized: one inserts, the other finds the rows unchanged", async () => {
  const run = tag();
  const { items } = mapLegacyCatalogue("tag", Array.from({ length: 20 }, (_, i) => ({ tag_id: `${run}${String(i).padStart(2, "0")}`, tag: `${run} n${i}` })));
  const other = new PostgresCatalogueImportStore({ connectionString: URL }, ACTOR);
  try {
    const [a, b] = await Promise.all([store.importItems(items, NOW), other.importItems(items, NOW)]);
    assert.deepEqual([a.refused, b.refused], [[], []]);
    assert.deepEqual([a.inserted + b.inserted, a.unchanged + b.unchanged], [20, 20]);
  } finally {
    await other.close();
  }
});
