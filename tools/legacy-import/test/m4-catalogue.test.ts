import assert from "node:assert/strict";
import test from "node:test";

import { catalogueDigest, kuwaitInstant, mapLegacyCatalogue } from "../src/m4-catalogue.js";

// Synthetic rows shaped like the legacy tables; no real data.

test("legacy wall time is read as Asia/Kuwait (UTC+3), so a late-evening row keeps its own day", () => {
  assert.equal(kuwaitInstant("2024-03-05 23:30:00"), "2024-03-05T20:30:00.000Z");
  assert.equal(kuwaitInstant("2024-03-05 01:00:00"), "2024-03-04T22:00:00.000Z");
  assert.equal(kuwaitInstant("0000-00-00 00:00:00"), null);
  assert.equal(kuwaitInstant("2024-02-30 10:00:00"), null);
  assert.equal(kuwaitInstant(null), null);
  assert.equal(kuwaitInstant(""), null);
});

test("each legacy table maps to its catalogue kind with the platform's name normalization", () => {
  const { items, issues } = mapLegacyCatalogue("mall", [
    { mall_uuid: "m-2", mall_name_en: "  The   Avenues ", mall_created_datetime: "2020-01-01 10:00:00", mall_updated_datetime: "2021-01-01 10:00:00" },
  ]);
  assert.deepEqual(issues, []);
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item!.type, "mall");
  assert.equal(item!.name, "The Avenues");
  assert.equal(item!.normalizedName, "the avenues");
  assert.equal(item!.status, "active");
  assert.equal(item!.createdAt, "2020-01-01T07:00:00.000Z");
  assert.equal(item!.updatedAt, "2021-01-01T07:00:00.000Z");
  assert.equal(item!.mergedInto, null);
  const { digest, ...rest } = item!;
  assert.equal(digest, catalogueDigest(rest));
});

test("deleted and inactive legacy rows import as deleted items", () => {
  const universities = mapLegacyCatalogue("university", [
    { university_id: 1, university_name_en: "A", deleted: 1 },
    { university_id: 2, university_name_en: "B", deleted: 0 },
  ]).items;
  assert.deepEqual(universities.map((i) => i.status), ["deleted", "active"]);
  const banks = mapLegacyCatalogue("bank", [{ bank_id: 3, bank_name: "C", deleted: "1" }]).items;
  assert.equal(banks[0]!.status, "deleted");
  const currencies = mapLegacyCatalogue("currency", [
    { currency_id: 4, title: "Dinar", code: "kwd", currency_symbol: "KD", decimal_place: 3, status: 0 },
  ]).items;
  assert.equal(currencies[0]!.status, "deleted");
  assert.equal(currencies[0]!.code, "KWD");
});

test("active rows with the same name merge into the lowest legacy id; deleted rows never merge", () => {
  const { items, issues } = mapLegacyCatalogue("university", [
    { university_id: 10, university_name_en: "Kuwait University", deleted: 0 },
    { university_id: 9, university_name_en: "kuwait  university", deleted: 0 },
    { university_id: 11, university_name_en: "Kuwait University", deleted: 1 },
    { university_id: 100, university_name_en: "KUWAIT UNIVERSITY", deleted: 0 },
  ]);
  assert.deepEqual(items.map((i) => [i.legacyId, i.mergedInto]), [["9", null], ["10", "9"], ["11", null], ["100", "9"]]);
  assert.deepEqual(issues, [
    { rule: "catalogue.merged", legacyTable: "university", legacyId: "10", target: "9" },
    { rule: "catalogue.merged", legacyTable: "university", legacyId: "100", target: "9" },
  ]);
});

test("bank payment details map the legacy transfer codes; bad details are reported and the bank still imports", () => {
  const { items, issues } = mapLegacyCatalogue("bank", [
    { bank_id: 1, bank_name: "One", bank_swift_code: "nbokkwkw", bank_iban_code: "nbok", bank_code_abk: 12, bank_transfer_type: "LCL", deleted: 0 },
    { bank_id: 2, bank_name: "Two", bank_swift_code: "GULBKWKW", bank_iban_code: "GULB", bank_code_abk: "3", bank_transfer_type: "SWF", deleted: 0 },
    { bank_id: 3, bank_name: "Three", bank_swift_code: "BADSWIFT1", bank_iban_code: "X", bank_code_abk: 999, bank_transfer_type: "TRF", deleted: 0 },
    { bank_id: 4, bank_name: "Four", bank_swift_code: "BOUBKWKW", bank_iban_code: "BOUB", bank_code_abk: 7, bank_transfer_type: "TRF", deleted: 0 },
  ]);
  assert.deepEqual(items.map((i) => i.bank?.transferType ?? null), ["local", "international", null, "within_bank"]);
  assert.deepEqual(items[0]!.bank, { swiftCode: "NBOKKWKW", ibanBankCode: "NBOK", abkCode: "12", transferType: "local" });
  assert.deepEqual(issues, [{ rule: "catalogue.bankDetailsInvalid", legacyTable: "bank", legacyId: "3" }]);
});

test("currency details are kept when valid and reported when not", () => {
  const { items, issues } = mapLegacyCatalogue("currency", [
    { currency_id: 1, title: "Kuwaiti Dinar", code: "KWD", currency_symbol: "KD", decimal_place: 3, status: 1 },
    { currency_id: 2, title: "Odd", code: "ODD", currency_symbol: "", decimal_place: 9, status: 1 },
  ]);
  assert.deepEqual(items[0]!.currency, { symbol: "KD", decimalPlaces: 3 });
  assert.equal(items[1]!.currency, null);
  assert.deepEqual(issues, [{ rule: "catalogue.currencyDetailsInvalid", legacyTable: "currency", legacyId: "2" }]);
});

test("rows the catalogue cannot hold are reported by legacy id and column, never by content", () => {
  const { items, issues } = mapLegacyCatalogue("tag", [
    { tag_id: 1, tag: "" },
    { tag_id: 2, tag: "x".repeat(161) },
    { tag_id: 3, tag: "bad\u0007name" },
    { tag_id: null, tag: "no id" },
    { tag_id: "a b", tag: "spaced id" },
    { tag_id: 4, tag: "ok" },
    { tag_id: 4, tag: "twice" },
  ]);
  assert.deepEqual(items.map((i) => i.legacyId), ["4"]);
  assert.deepEqual(issues, [
    { rule: "catalogue.invalidName", legacyTable: "tag", legacyId: "1", field: "tag" },
    { rule: "catalogue.invalidName", legacyTable: "tag", legacyId: "2", field: "tag" },
    { rule: "catalogue.invalidName", legacyTable: "tag", legacyId: "3", field: "tag" },
    { rule: "catalogue.badId", legacyTable: "tag", legacyId: "?" },
    { rule: "catalogue.badId", legacyTable: "tag", legacyId: "?" },
    { rule: "catalogue.duplicateId", legacyTable: "tag", legacyId: "4" },
  ]);
  assert.equal(JSON.stringify(issues).includes("spaced"), false);
});

test("an unusable currency code is dropped and reported; the currency still imports", () => {
  const { items, issues } = mapLegacyCatalogue("currency", [
    { currency_id: 1, title: "Thing", code: "not a code!", currency_symbol: "T", decimal_place: 2, status: 1 },
  ]);
  assert.equal(items[0]!.code, null);
  assert.deepEqual(issues, [{ rule: "catalogue.invalidCode", legacyTable: "currency", legacyId: "1", field: "code" }]);
});

test("areas import as catalogue items; their details are reported as skipped (legacy holds no governorate)", () => {
  const { items, issues } = mapLegacyCatalogue("area", [{ area_uuid: "a-1", area_name_en: "Salmiya", area_name_ar: "السالمية" }]);
  assert.equal(items[0]!.type, "area");
  assert.deepEqual(issues, [{ rule: "catalogue.areaDetailsSkipped", legacyTable: "area", legacyId: "a-1" }]);
});

test("the digest is stable across runs and changes when the legacy row changes", () => {
  const row = { country_id: 1, country_name_en: "Kuwait" };
  const a = mapLegacyCatalogue("country", [row]).items[0]!.digest;
  assert.equal(mapLegacyCatalogue("country", [{ ...row }]).items[0]!.digest, a);
  assert.notEqual(mapLegacyCatalogue("country", [{ ...row, country_name_en: "Kuwait State" }]).items[0]!.digest, a);
});
