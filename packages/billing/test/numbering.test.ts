import assert from "node:assert/strict";
import { test } from "node:test";
import { validateNumberRequest } from "../src/numbering.js";

test("SHU-264/AC-06 legacy-namespace", () => {
  for (const accountPrefix of ["LEGACY", "LEGACY-", "LEGACY-ACME", "legacy", "Legacy-X", " LEGACY"]) {
    assert.throws(() => validateNumberRequest({ accountId: "a", accountPrefix, period: "2026-09" }));
  }
  for (const accountPrefix of ["ACME", "BETA", "LEGACYCO"]) {
    assert.doesNotThrow(() => validateNumberRequest({ accountId: "a", accountPrefix, period: "2026-09" }));
  }
});

test("numbering rejects malformed periods and account namespaces", () => {
  const valid = { accountId: "account-a", accountPrefix: "ACME", period: "2026-09" };
  for (const period of ["2026-00", "2026-13", "26-09", "2026-9", "2026-09\n"]) {
    assert.throws(() => validateNumberRequest({ ...valid, period }));
  }
  for (const accountId of ["", "a/b", "a".repeat(129)]) {
    assert.throws(() => validateNumberRequest({ ...valid, accountId }));
  }
});
