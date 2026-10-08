import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CommitInput, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { candidateProfileRecordRef, type SelfEditReferences } from "@studenthub/profile";
import { principalAuditRef } from "@studenthub/db";
import { createCandidateProfile, handleCandidateProfile, type CandidateProfileService } from "../src/candidate-profile.js";

// Synthetic fixtures only: a made-up person, country and phone number.
const ORIGIN = "https://studenthub.example.invalid";
const SESSION = "c".repeat(43);
const PERSON = "candidate-person";
const SECRET = "shu143-candidate-profile-http-secret-at-least-32-bytes";
const COUNTRY = "44444444-4444-4444-8444-44444444abcd";
const TAKEN_PHONE = "+96566660000";

function rig(options: { candidate?: boolean } = {}) {
  const values = new Map<string, string>();
  const receipts = new Map<string, Receipt>();
  const references: SelfEditReferences = {
    activeCatalogueItem: async (type, id) => type === "country" && id === COUNTRY,
    available: async (field, value) => !(field === "phone" && value === TAKEN_PHONE),
  };
  const store = {
    forPrincipal(principalId: string): SafeWriteStore {
      return {
        ownedRecord: (ref) => options.candidate !== false && principalId === PERSON && ref === principalAuditRef(PERSON)
          ? candidateProfileRecordRef(PERSON) : null,
        readField: (_record, field) => values.get(field) ?? null,
        commit: (input: CommitInput) => {
          if ((values.get(input.field) ?? null) !== input.expectedBefore) return { ok: false, reason: "state_changed" };
          values.set(input.field, input.value);
          receipts.set(input.receipt.receiptRef, input.receipt);
          return { ok: true };
        },
      };
    },
    referencesFor: () => references,
    readReceipt: async (principalId: string, ref: string) => principalId === PERSON ? receipts.get(ref) ?? null : null,
  };
  const sessions = { get: async (id: string) => id === SESSION ? { id: SESSION, personId: PERSON } : undefined };
  const service = createCandidateProfile({ sessions: sessions as never, store, secret: SECRET, today: () => "2026-10-08" });
  return { service, values };
}

async function call(service: CandidateProfileService | undefined, path: string, body: unknown, overrides: {
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
  assert.equal(await handleCandidateProfile(req, fake as unknown as ServerResponse, service, ORIGIN), true);
  return { status, headers, body: JSON.parse(payload) as Record<string, unknown>, raw: payload };
}

test("SHU143_HTTP_FLOW preview normalizes, confirm stores, and the receipt names the field only", async () => {
  const x = rig();
  const input = { field: "display_name", value: "  Synthetic   Person " };
  const preview = await call(x.service, "/candidate/profile/preview", input);
  assert.equal(preview.status, 200, preview.raw);
  assert.equal(preview.headers["cache-control"], "no-store");
  assert.deepEqual(preview.body.changes, [{ field: "display_name", before: null, after: "Synthetic Person" }]);
  assert.equal(x.values.size, 0, "a preview writes nothing");
  const done = await call(x.service, "/candidate/profile/confirm", { ...input, token: preview.body.token });
  assert.equal(done.status, 200, done.raw);
  assert.equal(x.values.get("display_name"), "Synthetic Person");
  const receiptRef = (done.body.receipt as Receipt).receiptRef;
  assert.deepEqual((done.body.receipt as Receipt).fields, ["display_name"]);
  const receipt = await call(x.service, `/candidate/profile/receipts/${receiptRef}`, "", { method: "GET" });
  assert.equal(receipt.status, 200);
  for (const response of [done.raw, receipt.raw]) assert.ok(!response.includes("Synthetic"), "a receipt carries the value");
  // Booleans arrive as JSON booleans and are stored canonically.
  const licence = await call(x.service, "/candidate/profile/preview", { field: "driving_licence", value: true });
  assert.deepEqual(licence.body.changes, [{ field: "driving_licence", before: null, after: "true" }]);
});

test("SHU143_HTTP_INPUT input errors are typed and never echo what was sent", async () => {
  const x = rig();
  const cases: Array<[unknown, number, string]> = [
    [{ field: "display_name", value: "Single" }, 400, "invalid_value"],
    [{ field: "birth_date", value: "1990-01-01" }, 400, "age_out_of_range"],
    [{ field: "nationality", value: "99999999-9999-4999-8999-999999999999" }, 400, "not_in_catalogue"],
    [{ field: "phone", value: "+965 6666 0000" }, 409, "already_taken"],
    [{ field: "civil_id", value: "123" }, 400, "invalid_request"],
    [{ field: "language", value: "en" }, 400, "invalid_request"],
    [{ field: "gender", value: "female", extra: true }, 400, "invalid_request"],
    [{ field: "gender" }, 400, "invalid_request"],
  ];
  for (const [body, status, error] of cases) {
    const result = await call(x.service, "/candidate/profile/preview", body);
    assert.deepEqual([result.status, result.body], [status, { error }], JSON.stringify(body));
    assert.ok(!result.raw.includes("6666") && !result.raw.includes("1990"), "an error body echoes the value");
  }
  assert.equal(x.values.size, 0);
  assert.equal((await call(x.service, "/candidate/profile/preview", { field: "nationality", value: COUNTRY.toUpperCase() })).status, 200);
});

test("SHU143_HTTP_BOUNDARY session, origin, content type, ownership and token binding are enforced", async () => {
  const x = rig();
  const input = { field: "gender", value: "female" };
  assert.equal((await call(x.service, "/candidate/profile/preview", input, { cookie: null })).status, 401);
  assert.deepEqual((await call(x.service, "/candidate/profile/preview", input, { origin: "https://evil.example.invalid" })).body, { error: "origin_rejected" });
  assert.equal((await call(x.service, "/candidate/profile/preview", input, { contentType: "text/plain" })).status, 400);
  assert.equal((await call(x.service, "/candidate/profile/preview", input, { method: "PUT" })).status, 404);
  assert.deepEqual((await call(undefined, "/candidate/profile/preview", input)).body, { error: "safe_write_unavailable" });
  const staff = rig({ candidate: false });
  assert.deepEqual(await call(staff.service, "/candidate/profile/preview", input).then((r) => [r.status, r.body]), [403, { error: "not_own_record" }]);
  // A token issued for one value, or one field, cannot confirm another.
  const preview = await call(x.service, "/candidate/profile/preview", input);
  for (const swapped of [{ field: "gender", value: "male" }, { field: "objective", value: "female" }]) {
    const result = await call(x.service, "/candidate/profile/confirm", { ...swapped, token: preview.body.token });
    assert.deepEqual([result.status, result.body], [409, { error: "token_change_set_mismatch" }], JSON.stringify(swapped));
  }
  assert.equal(x.values.size, 0);
  assert.equal((await call(x.service, `/candidate/profile/receipts/${"a".repeat(64)}`, "", { method: "GET" })).status, 404);
});
