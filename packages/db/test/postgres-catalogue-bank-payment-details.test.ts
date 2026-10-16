import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { PostgresCatalogueStore, runMigrations } from "@studenthub/db";
import { ReferenceCatalogue, type CatalogueActor } from "@studenthub/reference-catalogue";

const DB_URL = process.env.DATABASE_URL ?? "";
const firstActor: CatalogueActor = { principalRef: "a".repeat(64), orgId: "00000000-0000-4000-8000-000000000001", role: "admin" };
const secondActor: CatalogueActor = { ...firstActor, principalRef: "b".repeat(64) };
let pool: pg.Pool;

before(async () => {
  if (!DB_URL) throw new Error("DATABASE_URL is required for PostgreSQL bank payment-detail tests");
  pool = new pg.Pool({ connectionString: DB_URL });
  await runMigrations(pool);
});
beforeEach(async () => { await pool.query("TRUNCATE catalogue_items CASCADE"); });
after(async () => { await pool.end(); });

test("PostgreSQL catalogue bank payment details preserve creator and guard bank rows", async () => {
  const store = new PostgresCatalogueStore(pool);
  const service = new ReferenceCatalogue(store, () => new Date("2026-10-15T10:00:00.000Z"));
  const bank = await service.create(firstActor, "bank", { name: "Synthetic Bank" });
  const currency = await service.create(firstActor, "currency", { name: "Synthetic Currency" });
  const initial = { swiftCode: "DEUTDEFF", ibanBankCode: "BKME", abkCode: "7", transferType: "local" as const };
  await store.writeBankPaymentDetails(bank.id, { ...initial, actorRef: firstActor.principalRef, now: "2026-10-15T10:01:00.000Z" });
  const overwritten = await store.writeBankPaymentDetails(bank.id, { ...initial, swiftCode: "DEUTDEFF500", transferType: "international", actorRef: secondActor.principalRef, now: "2026-10-15T10:02:00.000Z" });
  assert.deepEqual(overwritten, await store.readBankPaymentDetails(bank.id));
  const provenance = await pool.query<{ created_by_ref: string; updated_by_ref: string }>("SELECT created_by_ref,updated_by_ref FROM catalogue_bank_payment_details WHERE bank_id=$1", [bank.id]);
  assert.equal(provenance.rows[0]?.created_by_ref, firstActor.principalRef);
  assert.equal(provenance.rows[0]?.updated_by_ref, secondActor.principalRef);

  await service.remove(firstActor, "bank", bank.id);
  assert.equal(await store.writeBankPaymentDetails(bank.id, { ...initial, actorRef: firstActor.principalRef, now: "2026-10-15T10:03:00.000Z" }), undefined);
  assert.equal(await store.writeBankPaymentDetails(currency.id, { ...initial, actorRef: firstActor.principalRef, now: "2026-10-15T10:03:00.000Z" }), undefined);

  await assert.rejects(() => pool.query(
    `INSERT INTO catalogue_bank_payment_details(bank_id,swift_code,iban_bank_code,abk_code,transfer_type,created_by_ref,updated_by_ref,created_at,updated_at)
     VALUES ($1,'DEUTDEFF','BKME','7','local',$2,$2,now(),now())`, [currency.id, firstActor.principalRef]));
  const activeBank = await service.create(firstActor, "bank", { name: "Second Bank" });
  await assert.rejects(() => pool.query(
    `INSERT INTO catalogue_bank_payment_details(bank_id,swift_code,iban_bank_code,abk_code,transfer_type,created_by_ref,updated_by_ref,created_at,updated_at)
     VALUES ($1,'DEUTDEFF5','BKME','7','local',$2,$2,now(),now())`, [activeBank.id, firstActor.principalRef]));
});
