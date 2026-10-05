import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { parseDecimalString, type DecimalString } from "../src/decimal-string.js";
import * as store from "../src/postgres-invoice-store.js";
import { canonicalInvoiceBody, captureInvoiceDocument, FixtureInvoiceBodyStore, type InvoiceContent, type InvoiceDocument } from "../src/document.js";

const content: InvoiceContent = { groupId: "group-a", orgId: "org-a", kind: "subtotal",
  issuedAt: "2026-09-30T12:00:00.000Z", amount: "12.345", scale: 3,
  capturedOrgName: "Synthetic Acme", capturedStoreNames: ["Synthetic Cafe"] };

// These checks must keep compiling only while the public surface is immutable.
function typeContract(document: InvoiceDocument, decimal: DecimalString): void {
  // @ts-expect-error a JS number cannot masquerade as an exact decimal
  const invalid: DecimalString = 12.345;
  // @ts-expect-error invoice fields are readonly
  document.amount = decimal;
  // @ts-expect-error captured names are readonly
  document.capturedStoreNames.push("changed");
  // @ts-expect-error the persistence module has no update path
  store.updateInvoice;
  void invalid;
}
void typeContract;

test("SHU-264/AC-04 document-immutable", () => {
  assert.deepEqual(Object.keys(store).sort(), ["issueInvoice", "resolveInvoice"]);
  const original = captureInvoiceDocument("ACME-2026-09-000001", content);
  assert.ok(Object.isFrozen(original));
  assert.ok(Object.isFrozen(original.capturedStoreNames));
});

test("SHU-264/AC-05 tax-shape-open", () => {
  assert.equal(captureInvoiceDocument("ACME-2026-09-000001", content).taxTotal, "0.000");
  assert.doesNotThrow(() => {
    assert.equal(captureInvoiceDocument("ACME-2026-09-000002", { ...content, taxTotal: "1.250" }).taxTotal, "1.250");
  });
});

test("SHU-264/AC-07 decimal-string-only", () => {
  for (const amount of [12.345, NaN, Infinity, null, undefined, "12.34", "12.3456", "1e3", "1.2.3", "", " 1.000", "+1.000", "01.000", "1.000\n"]) {
    assert.throws(() => captureInvoiceDocument("ACME-2026-09-000001", { ...content, amount }), TypeError, String(amount));
  }
  for (const scale of [-1, 1.5, NaN, Infinity, 19]) assert.throws(() => parseDecimalString("1.000", scale));
  for (const [amount, scale] of [["999999999999999999999.345", 3], ["-12.345", 3], ["0", 0], ["1.20", 2]] as const) {
    assert.equal(parseDecimalString(amount, scale), amount);
  }
  assert.throws(() => captureInvoiceDocument("ACME-2026-09-000001", { ...content, taxTotal: 1.25 }));
});

test("canonical bytes and fixture references are stable and defensively copied", async () => {
  const names = ["Synthetic Cafe", "متجر تجريبي"];
  const doc = captureInvoiceDocument("ACME-2026-09-000042", { ...content, capturedStoreNames: names });
  const expected = Buffer.from('{"invoiceNumber":"ACME-2026-09-000042","groupId":"group-a","orgId":"org-a","kind":"subtotal","issuedAt":"2026-09-30T12:00:00.000Z","amount":"12.345","taxTotal":"0.000","capturedOrgName":"Synthetic Acme","capturedStoreNames":["Synthetic Cafe","متجر تجريبي"]}');
  names[0] = "Changed";
  assert.deepEqual(canonicalInvoiceBody(doc), expected);
  assert.equal(doc.bodyHash, createHash("sha256").update(expected).digest("hex"));
  const bodies = new FixtureInvoiceBodyStore();
  const input = Uint8Array.from(expected);
  const ref = await bodies.put(input);
  input.fill(0);
  (await bodies.get(ref)).fill(0);
  assert.deepEqual(Buffer.from(await bodies.get(ref)), expected);
  assert.equal(await bodies.put(expected), ref);
  await assert.rejects(bodies.get("missing"));
});

test("document kind, date, captured fields and credit shape fail closed", () => {
  for (const change of [{ groupId: "" }, { orgId: "" }, { kind: "unknown" }, { issuedAt: "2026-02-30T00:00:00.000Z" },
    { capturedOrgName: " " }, { capturedStoreNames: [""] }, { kind: "credit" }, { creditOf: "original" }]) {
    assert.throws(() => captureInvoiceDocument("ACME-2026-09-000001", { ...content, ...change } as InvoiceContent));
  }
});
