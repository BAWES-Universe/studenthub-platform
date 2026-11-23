import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { m4Writers } from "../../../tools/legacy-import/src/m4-cli.js";
import { M4_SOURCES, runM4, type M4Sources, type M4Table } from "../../../tools/legacy-import/src/m4-run.js";
import { fixtureIds } from "./legacy-fixture-ids.js";

// Synthetic legacy rows only; fresh legacy ids per run so the suite can share a database.

const URL = process.env.DATABASE_URL ?? "";
const ACTOR = createHash("sha256").update("legacy-import:test").digest("hex");
const NOW = "2026-11-23T00:00:00.000Z";
let pool: pg.Pool, operator: string;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  operator = `import-operator-${randomUUID()}`;
  await pool.query("INSERT INTO organizations (id, name, parent_org_id) VALUES ($1, 'Operator', NULL)", [operator]);
});
after(async () => pool.end());

function legacy(c: number, r: string): M4Sources {
  const empty = Object.fromEntries(Object.keys(M4_SOURCES).map((t) => [t, []])) as unknown as Record<M4Table, Record<string, unknown>[]>;
  return {
    ...empty,
    mall: [{ mall_uuid: `${r}-m`, mall_name_en: `Mall ${r}` }],
    brand: [{ brand_uuid: `${r}-b`, company_id: c, brand_name_en: `Brand ${r}` }],
    company: [{ company_id: c, parent_company_id: null, company_name: `Company ${c}`, deleted: 0 }, { company_id: c + 1, parent_company_id: c, company_name: `Sub ${c}`, deleted: 0 }],
    store: [{ store_id: c, company_id: c + 1, brand_uuid: null, mall_uuid: `${r}-m`, store_name: "Store A", deleted: 0 },
      { store_id: c + 1, company_id: c, brand_uuid: `${r}-b`, mall_uuid: null, store_name: "Store B", deleted: 0 }],
    contact: [{ contact_uuid: `${r}-p`, contact_name: "Person", contact_email: `${r}@example.com`, deleted: 0 }],
    company_contact: [{ company_contact_uuid: `${r}-l`, contact_uuid: `${r}-p`, company_id: c + 1, allow_access: 0 }],
  };
}

test("a write run imports every step in order through the real stores; a second run finds everything unchanged", async () => {
  const c = await fixtureIds(pool), r = randomUUID().slice(0, 8);
  const writers = m4Writers(pool, ACTOR, operator);
  const first = await runM4(legacy(c, r), writers, NOW);
  assert.equal(first.ok, true);
  const by = new Map(first.steps.map((s) => [s.step, s.write]));
  assert.deepEqual([by.get("company")!.inserted, by.get("brand_company")!.inserted, by.get("store")!.inserted, by.get("company_contact")!.inserted], [2, 1, 2, 1]);
  const second = await runM4(legacy(c, r), writers, NOW);
  assert.equal(second.ok, true);
  assert.ok(second.steps.every((s) => s.write!.inserted === 0 && s.write!.unchanged === s.mapped));

  const { rows } = await pool.query(
    `SELECT s.name AS store, o.name AS org, s.brand_id IS NOT NULL AS branded, s.mall_id IS NOT NULL AS in_mall
       FROM organization_stores s JOIN organizations o ON o.id = s.org_id
      WHERE s.id::text IN (SELECT platform_id FROM legacy_id_maps WHERE legacy_table = 'store' AND legacy_id = ANY($1::text[])) ORDER BY s.name`,
    [[String(c), String(c + 1)]]);
  assert.deepEqual(rows, [{ store: "Store A", org: `Sub ${c}`, branded: false, in_mall: true }, { store: "Store B", org: `Company ${c}`, branded: true, in_mall: false }]);
});
