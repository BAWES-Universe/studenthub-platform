import assert from "node:assert/strict";
import test from "node:test";
import {
  BANK_TRANSFER_TYPES, CatalogueError, InMemoryCatalogueStore, ReferenceCatalogue,
  normalizeBankPaymentDetails, type CatalogueActor,
} from "@studenthub/reference-catalogue";
import type { Role } from "@studenthub/contracts";

const ADMIN: CatalogueActor = { principalRef: "a".repeat(64), orgId: "00000000-0000-4000-8000-000000000001", role: "admin" };
const VALID = { swiftCode: "DEUTDEFF", ibanBankCode: "BKME", abkCode: "7", transferType: "local" };

async function fixture() {
  const store = new InMemoryCatalogueStore();
  const service = new ReferenceCatalogue(store, () => new Date("2026-10-15T10:00:00.000Z"));
  const bank = await service.create(ADMIN, "bank", { name: "Synthetic Bank" });
  return { service, bank };
}

test("SHU-320/AC-01 swift-shape validates the structural SWIFT segments", () => {
  assert.equal(normalizeBankPaymentDetails(VALID).swiftCode, "DEUTDEFF");
  assert.equal(normalizeBankPaymentDetails({ ...VALID, swiftCode: " deutdeff500 " }).swiftCode, "DEUTDEFF500");
  for (const swiftCode of ["DEUTDEFF5", "1EUTDEFF", "DEUT12FF"]) {
    assert.throws(() => normalizeBankPaymentDetails({ ...VALID, swiftCode }), catalogueError("invalid_swift_code"));
  }
});

test("SHU-320/AC-02 transfer-type-closed accepts only the three contract values", () => {
  for (const transferType of BANK_TRANSFER_TYPES) assert.equal(normalizeBankPaymentDetails({ ...VALID, transferType }).transferType, transferType);
  for (const transferType of ["within-bank", "LOCAL", ""]) {
    assert.throws(() => normalizeBankPaymentDetails({ ...VALID, transferType }), catalogueError("invalid_transfer_type"));
  }
});

test("SHU-320/AC-03 admin-only refuses every other signed-in role", async () => {
  const { service, bank } = await fixture();
  for (const role of ["staff", "recruiter", "org-owner", "finance", "candidate"] satisfies Role[]) {
    await assert.rejects(() => service.setBankPaymentDetails({ ...ADMIN, role }, bank.id, VALID), catalogueError("catalogue_write_forbidden"));
  }
  assert.equal((await service.setBankPaymentDetails(ADMIN, bank.id, VALID)).bankId, bank.id);
});

test("SHU-320/AC-04 active-bank-only refuses deleted, wrong-type, and unknown ids", async () => {
  const { service, bank } = await fixture();
  await service.remove(ADMIN, "bank", bank.id);
  await assert.rejects(() => service.setBankPaymentDetails(ADMIN, bank.id, VALID), catalogueError("catalogue_item_not_found"));
  const currency = await service.create(ADMIN, "currency", { name: "Kuwaiti dinar" });
  await assert.rejects(() => service.setBankPaymentDetails(ADMIN, currency.id, VALID), catalogueError("catalogue_item_not_found"));
  await assert.rejects(() => service.setBankPaymentDetails(ADMIN, "00000000-0000-4000-8000-000000000099", VALID), catalogueError("catalogue_item_not_found"));
});

test("SHU-320/AC-05 closed-input rejects extra, missing, and non-string fields", () => {
  assert.throws(() => normalizeBankPaymentDetails({ ...VALID, extra: true }), catalogueError("invalid_bank_payment_details"));
  const { swiftCode: _swiftCode, ...missing } = VALID;
  assert.throws(() => normalizeBankPaymentDetails(missing), catalogueError("invalid_bank_payment_details"));
  assert.throws(() => normalizeBankPaymentDetails({ ...VALID, abkCode: 7 }), catalogueError("invalid_bank_payment_details"));
});

test("bank payment details normalize codes, overwrite values, and remain readable after soft deletion", async () => {
  const { service, bank } = await fixture();
  const written = await service.setBankPaymentDetails(ADMIN, bank.id, { ...VALID, ibanBankCode: " bkme ", abkCode: " 100 " });
  assert.deepEqual(written, { bankId: bank.id, swiftCode: "DEUTDEFF", ibanBankCode: "BKME", abkCode: "100", transferType: "local", updatedAt: "2026-10-15T10:00:00.000Z" });
  await service.remove(ADMIN, "bank", bank.id);
  assert.deepEqual(await service.bankPaymentDetails({ ...ADMIN, role: "candidate" }, bank.id), written);
});

function catalogueError(code: string) {
  return (value: unknown) => value instanceof CatalogueError && value.code === code;
}
