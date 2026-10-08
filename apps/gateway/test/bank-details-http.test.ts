import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CommitInput, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { bankDetailsPrincipalRef, bankDetailsRecordRef, InMemoryFinanceReferenceResolver } from "@studenthub/pay-contracts";
import { createBankDetails, handleBankDetails, type BankDetailsService } from "../src/bank-details.js";

// Synthetic fixtures only: a made-up person, bank and checksum-valid test IBAN.
const ORIGIN = "https://studenthub.example.invalid";
const SESSION = "b".repeat(43);
const PERSON = "candidate-person";
const SECRET = "shu182-bank-details-http-secret-at-least-32-bytes";
const BANK = "3333abcd-3333-4333-8333-33333333abcd";
const IBAN = "KW81CBKU0000000000001234560101";

function rig(options: { candidate?: boolean } = {}) {
  let value: string | null = null;
  const receipts = new Map<string, Receipt>();
  const banks = new InMemoryFinanceReferenceResolver();
  banks.set("bank", BANK);
  const store = {
    forPrincipal(principalId: string): SafeWriteStore {
      return {
        ownedRecord: (ref) => options.candidate !== false && principalId === PERSON && ref === bankDetailsPrincipalRef(PERSON)
          ? bankDetailsRecordRef(PERSON) : null,
        readField: () => value,
        commit: (input: CommitInput) => {
          if (value !== input.expectedBefore) return { ok: false, reason: "state_changed" };
          value = input.value;
          receipts.set(input.receipt.receiptRef, input.receipt);
          return { ok: true };
        },
      };
    },
    readReceipt: async (principalId: string, ref: string) => principalId === PERSON ? receipts.get(ref) ?? null : null,
  };
  const sessions = { get: async (id: string) => id === SESSION ? { id: SESSION, personId: PERSON } : undefined };
  const service = createBankDetails({ sessions: sessions as never, store, banks, secret: SECRET });
  return { service, value: () => value };
}

async function call(service: BankDetailsService | undefined, path: string, body: unknown, overrides: {
  method?: string; origin?: string; contentType?: string; cookie?: string | null;
} = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from(overrides.method === "GET" ? [] : [raw]) as IncomingMessage;
  req.url = path;
  req.method = overrides.method ?? "POST";
  req.headers = {
    origin: overrides.origin ?? ORIGIN,
    "content-type": overrides.contentType ?? "application/json",
    ...(overrides.cookie === null ? {} : { cookie: overrides.cookie ?? `__Host-studenthub_session=${SESSION}` }),
  };
  let status = 0;
  let payload = "";
  let headers: Record<string, string> = {};
  const fake = {
    headersSent: false,
    writeHead(code: number, next: Record<string, string>) { status = code; headers = next; fake.headersSent = true; return fake; },
    end(chunk?: string) { payload = chunk ?? ""; return fake; },
    destroy() { return fake; },
  };
  assert.equal(await handleBankDetails(req, fake as unknown as ServerResponse, service, ORIGIN), true);
  return { status, headers, body: JSON.parse(payload) as Record<string, unknown>, raw: payload };
}

const input = { bankId: BANK.toUpperCase(), iban: "kw81 cbku 0000 0000 0000 1234 5601 01", beneficiaryName: "  Synthetic   Person " };
const normalized = { bankId: BANK, iban: IBAN, beneficiaryName: "Synthetic Person" };

test("SHU182_BANK_HTTP_FLOW preview normalizes, confirm stores, and the receipt carries no bank detail", async () => {
  const x = rig();
  const preview = await call(x.service, "/candidate/bank-details/preview", input);
  assert.equal(preview.status, 200, preview.raw);
  assert.equal(preview.headers["cache-control"], "no-store");
  assert.equal(preview.headers["x-content-type-options"], "nosniff");
  assert.equal(preview.headers["referrer-policy"], "no-referrer");
  assert.deepEqual(preview.body.before, null);
  assert.deepEqual(preview.body.after, normalized);
  assert.equal(x.value(), null, "a preview writes nothing");
  const done = await call(x.service, "/candidate/bank-details/confirm", { ...input, token: preview.body.token });
  assert.equal(done.status, 200, done.raw);
  assert.deepEqual(JSON.parse(x.value()!), normalized);
  const receiptRef = (done.body.receipt as Receipt).receiptRef;
  const receipt = await call(x.service, `/candidate/bank-details/receipts/${receiptRef}`, "", { method: "GET" });
  assert.equal(receipt.status, 200);
  for (const response of [done.raw, receipt.raw]) {
    for (const secret of [IBAN, BANK, "Synthetic Person"]) assert.ok(!response.includes(secret), `response carries ${secret}`);
  }
  // A second preview shows the stored details back to their owner as the before value.
  const next = await call(x.service, "/candidate/bank-details/preview", { ...normalized, iban: "GB82WEST12345698765432" });
  assert.deepEqual(next.body.before, normalized);
});

test("SHU182_BANK_HTTP_INPUT input errors are typed and never echo what was sent", async () => {
  const x = rig();
  const cases: Array<[unknown, number, string]> = [
    [{ ...input, iban: "KW82CBKU0000000000001234560101" }, 400, "invalid_iban"],
    [{ ...input, bankId: "not-a-uuid" }, 400, "invalid_bank"],
    [{ ...input, beneficiaryName: "x" }, 400, "invalid_beneficiary_name"],
    [{ ...input, bankId: "99999999-9999-4999-8999-999999999999" }, 400, "invalid_value"],
    [{ ...input, extra: true }, 400, "invalid_request"],
    [{ bankId: BANK, iban: IBAN }, 400, "invalid_request"],
  ];
  for (const [body, status, error] of cases) {
    const result = await call(x.service, "/candidate/bank-details/preview", body);
    assert.deepEqual([result.status, result.body], [status, { error }], JSON.stringify(body));
    assert.ok(!result.raw.includes("CBKU"), "an error body echoes the IBAN");
  }
  assert.equal(x.value(), null);
});

test("SHU182_BANK_HTTP_BOUNDARY session, origin, content type, ownership and token binding are enforced", async () => {
  const x = rig();
  assert.deepEqual((await call(x.service, "/candidate/bank-details/preview", input, { cookie: null })).status, 401);
  assert.deepEqual((await call(x.service, "/candidate/bank-details/preview", input, { origin: "https://evil.example.invalid" })).body, { error: "origin_rejected" });
  assert.deepEqual((await call(x.service, "/candidate/bank-details/preview", input, { contentType: "text/plain" })).status, 400);
  assert.deepEqual((await call(x.service, "/candidate/bank-details/preview", input, { method: "PUT" })).status, 404);
  assert.deepEqual((await call(undefined, "/candidate/bank-details/preview", input)).body, { error: "safe_write_unavailable" });
  const staff = rig({ candidate: false });
  assert.deepEqual(await call(staff.service, "/candidate/bank-details/preview", input).then((r) => [r.status, r.body]), [403, { error: "not_own_record" }]);
  // A token issued for one IBAN cannot confirm another.
  const preview = await call(x.service, "/candidate/bank-details/preview", input);
  const swapped = await call(x.service, "/candidate/bank-details/confirm", { ...input, iban: "GB82WEST12345698765432", token: preview.body.token });
  assert.deepEqual([swapped.status, swapped.body], [409, { error: "token_change_set_mismatch" }]);
  assert.equal(x.value(), null);
});
