import assert from "node:assert/strict";
import test from "node:test";
import { CatalogueError, InMemoryCatalogueStore, ReferenceCatalogue, normalizeCurrencyDetails, type CatalogueActor } from "@studenthub/reference-catalogue";
import type { Role } from "@studenthub/contracts";

const ADMIN: CatalogueActor = { principalRef: "a".repeat(64), orgId: "00000000-0000-4000-8000-000000000001", role: "admin" };
const VALID = { symbol: "KD", decimalPlaces: 3 };
const error = (code: string) => (value: unknown) => value instanceof CatalogueError && value.code === code;
async function fixture() { const store = new InMemoryCatalogueStore(); const service = new ReferenceCatalogue(store, () => new Date("2026-10-15T10:00:00.000Z")); const currency = await service.create(ADMIN, "currency", { name: "Kuwaiti Dinar", code: "KWD" }); return { store, service, currency }; }

test("SHU344_SYMBOL validates and normalizes currency symbols", () => {
  assert.equal(normalizeCurrencyDetails({ ...VALID, symbol: " KD " }).symbol, "KD");
  for (const symbol of ["د.ك", "$"]) assert.equal(normalizeCurrencyDetails({ ...VALID, symbol }).symbol, symbol);
  for (const symbol of ["", "   ", "123456789", "K\u200bD", 42, null, ["KD"]]) assert.throws(() => normalizeCurrencyDetails({ ...VALID, symbol }), error("invalid_currency_symbol"));
});
test("SHU344_DECIMALS accepts only integer minor-unit counts zero through four", () => {
  for (const decimalPlaces of [0, 3, 4]) assert.equal(normalizeCurrencyDetails({ ...VALID, decimalPlaces }).decimalPlaces, decimalPlaces);
  for (const decimalPlaces of [-1, 5, 2.5, "3", null]) assert.throws(() => normalizeCurrencyDetails({ ...VALID, decimalPlaces }), error("invalid_currency_decimal_places"));
});
test("SHU344_CLOSED_INPUT requires exactly symbol and decimalPlaces", () => {
  assert.throws(() => normalizeCurrencyDetails({ ...VALID, extra: true }), error("invalid_currency_details"));
  assert.throws(() => normalizeCurrencyDetails({ symbol: "KD" }), error("invalid_currency_details"));
  for (const value of [[], null]) assert.throws(() => normalizeCurrencyDetails(value), error("invalid_currency_details"));
});
test("SHU344_ADMIN_ONLY preserves details when non-admin roles are refused", async () => {
  const { service, currency } = await fixture(); const written = await service.setCurrencyDetails(ADMIN, currency.id, VALID);
  for (const role of ["staff", "recruiter", "org-owner", "candidate"] satisfies Role[]) await assert.rejects(() => service.setCurrencyDetails({ ...ADMIN, role }, currency.id, { symbol: "$", decimalPlaces: 2 }), error("catalogue_write_forbidden"));
  assert.deepEqual(await service.currencyDetails(ADMIN, currency.id), written);
});
test("SHU344_ACTIVE_ONLY refuses deleted, wrong-type, and unknown items", async () => {
  const { service, currency } = await fixture(); await service.remove(ADMIN, "currency", currency.id);
  await assert.rejects(() => service.setCurrencyDetails(ADMIN, currency.id, VALID), error("catalogue_item_not_found"));
  const bank = await service.create(ADMIN, "bank", { name: "Bank" });
  for (const id of [bank.id, "00000000-0000-4000-8000-000000000099"]) await assert.rejects(() => service.setCurrencyDetails(ADMIN, id, VALID), error("catalogue_item_not_found"));
});
test("SHU344_READ returns exact details, distinguishes absence, and retains history", async () => {
  const { service, currency } = await fixture(); const written = await service.setCurrencyDetails(ADMIN, currency.id, VALID);
  assert.deepEqual(written, { currencyId: currency.id, symbol: "KD", decimalPlaces: 3, updatedAt: "2026-10-15T10:00:00.000Z" });
  const other = await service.create(ADMIN, "currency", { name: "US Dollar", code: "USD" });
  await assert.rejects(() => service.currencyDetails(ADMIN, other.id), error("currency_details_not_found"));
  await assert.rejects(() => service.currencyDetails(ADMIN, "00000000-0000-4000-8000-000000000099"), error("catalogue_item_not_found"));
  await service.remove(ADMIN, "currency", currency.id); assert.deepEqual(await service.currencyDetails(ADMIN, currency.id), written);
});
