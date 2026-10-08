import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runSafeWriteConformance, TEST_SECRET, type CommitInput, type SafeWriteStore,
} from "@studenthub/safe-write-contract";
import {
  acceptAnyBankDetailsValue, BANK_DETAILS_FIELD, bankDetailsRecordRef, bankDetailsValue,
  buildBankDetailsWrite, candidateBankOwnerDecision, catalogueBankDetailsCheck, InMemoryFinanceReferenceResolver,
  normalizeBeneficiaryName, parseBankDetailsValue,
} from "../src/index.js";

// Synthetic fixtures only; the catalogue ids are made up.
const PERSON = "principal-candidate-c";
const BANK = "33333333-3333-4333-8333-333333333333";
const OTHER_BANK = "5555abcd-5555-4555-8555-55555555abcd";
// The platform uses the SHU-59 audit reference here; any 64-hex reference serves this in-memory store.
const PRINCIPAL_REF = "c".repeat(64);
const IBAN = "KW81CBKU0000000000001234560101";
const DETAILS = { bankId: BANK, iban: IBAN, beneficiaryName: "Synthetic Person" };

function rig() {
  const banks = new InMemoryFinanceReferenceResolver();
  banks.set("bank", BANK);
  banks.set("bank", OTHER_BANK);
  let value: string | null = null;
  let roles = ["candidate"];
  const commits: CommitInput[] = [];
  const store: SafeWriteStore = {
    ownedRecord: (principalRef) => principalRef === PRINCIPAL_REF
      && candidateBankOwnerDecision(roles.map((role) => ({ role }))) ? bankDetailsRecordRef(PERSON) : null,
    readField: () => value,
    commit: (input) => {
      if (value !== input.expectedBefore) return { ok: false, reason: "state_changed" };
      commits.push(input);
      value = input.value;
      return { ok: true };
    },
  };
  const writer = buildBankDetailsWrite({ store, secret: TEST_SECRET, check: catalogueBankDetailsCheck(banks) });
  const change = (details = DETAILS) => ({
    personRef: bankDetailsRecordRef(PERSON), field: BANK_DETAILS_FIELD, value: bankDetailsValue(details),
  });
  return {
    banks, writer, change, commits, principalRef: PRINCIPAL_REF,
    value: () => value, setRoles: (next: string[]) => { roles = next; },
  };
}

test("SHU182_BANK_CONFORMANCE the bank-details builder passes the safe-write conformance suite", async () => {
  const report = await runSafeWriteConformance((input) => buildBankDetailsWrite({ ...input, check: acceptAnyBankDetailsValue }));
  assert.equal(report.ok, true, JSON.stringify(report.results.filter((result) => !result.ok), null, 2));
});

test("SHU182_BANK_WRITE preview shows the whole triple and confirm stores it with a field-only receipt", async () => {
  const x = rig();
  const preview = await x.writer.preview({ principalRef: x.principalRef, change: x.change() });
  assert.ok(preview.ok);
  assert.deepEqual(preview.changes, [{ field: BANK_DETAILS_FIELD, before: null, after: bankDetailsValue(DETAILS) }]);
  assert.equal(x.commits.length, 0, "a preview writes nothing");
  const done = await x.writer.confirm({ principalRef: x.principalRef, change: x.change(), token: preview.token });
  assert.ok(done.ok);
  assert.deepEqual(parseBankDetailsValue(x.value()!), DETAILS);
  assert.deepEqual(done.receipt.fields, [BANK_DETAILS_FIELD]);
  const receipt = JSON.stringify(done.receipt);
  for (const secret of [IBAN, BANK, "Synthetic Person"]) assert.ok(!receipt.includes(secret), `receipt carries ${secret}`);
});

test("SHU182_BANK_VALUE_CHECKED preview and confirm both refuse details the catalogue does not accept", async () => {
  const x = rig();
  for (const bad of [
    { ...DETAILS, bankId: "66666666-6666-4666-8666-666666666666" },
    { ...DETAILS, iban: "KW82CBKU0000000000001234560101" },
  ]) {
    const refused = await x.writer.preview({ principalRef: x.principalRef, change: x.change(bad) });
    assert.deepEqual(refused, { ok: false, reason: "invalid_value" });
  }
  // The bank is retired between preview and confirm: nothing is written.
  const preview = await x.writer.preview({ principalRef: x.principalRef, change: x.change() });
  assert.ok(preview.ok);
  x.banks.set("bank", BANK, "deleted");
  const done = await x.writer.confirm({ principalRef: x.principalRef, change: x.change(), token: preview.token });
  assert.deepEqual(done, { ok: false, reason: "invalid_value" });
  assert.equal(x.commits.length, 0);
  assert.equal(x.value(), null);
});

test("SHU182_BANK_CANONICAL only the canonical encoding of normalized details is a storable value", async () => {
  const check = catalogueBankDetailsCheck(rig().banks);
  assert.equal(await check(bankDetailsValue(DETAILS)), true);
  assert.equal(await check(bankDetailsValue({ ...DETAILS, bankId: OTHER_BANK })), true);
  for (const value of [
    JSON.stringify({ iban: IBAN, bankId: BANK, beneficiaryName: "Synthetic Person" }),
    JSON.stringify({ ...DETAILS, extra: 1 }),
    bankDetailsValue({ ...DETAILS, iban: IBAN.toLowerCase() }),
    bankDetailsValue({ ...DETAILS, beneficiaryName: "Synthetic  Person" }),
    bankDetailsValue({ ...DETAILS, bankId: OTHER_BANK.toUpperCase() }),
    "not json",
  ]) assert.equal(await check(value), false, value);
  assert.equal(parseBankDetailsValue(JSON.stringify({ iban: IBAN, bankId: BANK, beneficiaryName: "Synthetic Person" })), undefined);
  // Name length is counted in code points, as the database column counts it.
  assert.equal(normalizeBeneficiaryName("\u{1F600}".repeat(70)), "\u{1F600}".repeat(70));
  assert.equal(normalizeBeneficiaryName("\u{1F600}".repeat(71)), undefined);
  assert.equal(normalizeBeneficiaryName("\u{1F600}"), undefined);
});

test("SHU182_BANK_OWNER only a person with a candidate grant may keep bank details", async () => {
  assert.equal(candidateBankOwnerDecision([{ role: "candidate" }]), true);
  for (const role of ["staff", "admin", "org-owner", "recruiter", "finance"]) {
    assert.equal(candidateBankOwnerDecision([{ role }]), false, role);
  }
  const x = rig();
  x.setRoles(["staff"]);
  assert.deepEqual(await x.writer.preview({ principalRef: x.principalRef, change: x.change() }), { ok: false, reason: "not_own_record" });
});
