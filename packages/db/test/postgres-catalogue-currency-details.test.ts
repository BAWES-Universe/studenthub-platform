import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { PostgresCatalogueStore, runMigrations } from "@studenthub/db";
import { CatalogueError, ReferenceCatalogue, type CatalogueActor } from "@studenthub/reference-catalogue";
const DB_URL = process.env.DATABASE_URL ?? ""; const actor: CatalogueActor = { principalRef: "a".repeat(64), orgId: "00000000-0000-4000-8000-000000000001", role: "admin" }; let pool: pg.Pool;
before(async () => { if (!DB_URL) throw new Error("DATABASE_URL is required for PostgreSQL currency-detail tests"); pool = new pg.Pool({ connectionString: DB_URL }); await runMigrations(pool); }); beforeEach(async () => { await pool.query("TRUNCATE catalogue_items CASCADE"); }); after(async () => { await pool.end(); });
const notFound = (value: unknown) => value instanceof CatalogueError && value.code === "catalogue_item_not_found";
test("SHU344_PG_DETAILS persists, updates, and guards currency details", async () => {
  const store = new PostgresCatalogueStore(pool); let now = "2026-10-15T10:00:00.000Z"; const service = new ReferenceCatalogue(store, () => new Date(now)); const currency = await service.create(actor, "currency", { name: "Kuwaiti Dinar", code: "KWD" });
  await service.setCurrencyDetails(actor, currency.id, { symbol: "KD", decimalPlaces: 3 }); const second = new PostgresCatalogueStore(pool); assert.equal((await second.readCurrencyDetails(currency.id))?.symbol, "KD"); now = "2026-10-15T10:01:00.000Z"; const updated = await service.setCurrencyDetails(actor, currency.id, { symbol: "د.ك", decimalPlaces: 3 }); assert.equal(updated.updatedAt, now); assert.equal((await pool.query("SELECT count(*)::int AS count FROM catalogue_currency_details")).rows[0].count, 1);
  await service.remove(actor, "currency", currency.id); await assert.rejects(() => service.setCurrencyDetails(actor, currency.id, { symbol: "KD", decimalPlaces: 3 }), notFound); const bank = await service.create(actor, "bank", { name: "Bank" }); await assert.rejects(() => service.setCurrencyDetails(actor, bank.id, { symbol: "B", decimalPlaces: 2 }), notFound);
});
test("SHU344_PG_CHECKS database constraints and trigger reject invalid rows", async () => {
  const service = new ReferenceCatalogue(new PostgresCatalogueStore(pool)); const currency = await service.create(actor, "currency", { name: "Currency" }); const bank = await service.create(actor, "bank", { name: "Bank" });
  for (const [id, symbol, decimals] of [[currency.id, "KD", 5], [currency.id, " KD", 3], [currency.id, "123456789", 3], [bank.id, "B", 2]] as const) await assert.rejects(async () => { try { await pool.query(`INSERT INTO catalogue_currency_details(currency_id,symbol,decimal_places,created_by_ref,updated_by_ref,created_at,updated_at) VALUES ($1,$2,$3,$4,$4,now(),now())`, [id, symbol, decimals, actor.principalRef]); } catch (error) { assert.equal((error as { code?: string }).code, "23514"); throw error; } });
});
