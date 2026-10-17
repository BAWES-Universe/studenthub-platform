import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { CommitInput, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { organizationDeletionPrincipalRef, organizationDeletionRecordRef } from "@studenthub/organizations";
import { createOrganizationDeletion, handleOrganizationDeletion } from "../src/organization-deletion.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "a".repeat(43), PERSON = "admin", ORG = "org-a";
const SECRET = "shu326-http-secret-is-at-least-thirty-two-bytes";
function fixture(initial: readonly string[] | null = []) {
  let blockers = initial, committed = false, saved: Receipt | null = null;
  const store = {
    blockers: async () => blockers,
    counts: async () => ({ liveSubOrganizations: 0, livePayContracts: 0, memberGrants: 0 }),
    forPrincipal(): SafeWriteStore { return {
      ownedRecord: async p => p === organizationDeletionPrincipalRef(PERSON) ? organizationDeletionRecordRef(ORG) : null,
      readField: async () => null,
      commit: async (input: CommitInput) => { if (committed) return { ok: false, reason: "state_changed" as const }; committed = true; saved = input.receipt; return { ok: true as const }; },
    }; },
    readReceipt: async (_person: string, org: string, ref: string) => org === ORG && saved?.receiptRef === ref ? saved : null,
  };
  const sessions = { get: async (id: string) => id === SESSION ? { id, personId: PERSON } : undefined };
  return { service: createOrganizationDeletion({ sessions, store, secret: SECRET }), setBlockers(value: readonly string[] | null) { blockers = value; } };
}
async function call(service: ReturnType<typeof createOrganizationDeletion> | undefined, path: string, options: { method?: string; body?: unknown; origin?: string; contentType?: string; cookie?: string; secFetchSite?: string; raw?: string } = {}) {
  const raw = options.raw ?? (options.body === undefined ? "" : JSON.stringify(options.body));
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage; req.url = path; req.method = options.method ?? "POST";
  req.headers = { origin: options.origin ?? ORIGIN, "content-type": options.contentType ?? "application/json", cookie: options.cookie ?? `__Host-studenthub_session=${SESSION}`, ...(options.secFetchSite ? { "sec-fetch-site": options.secFetchSite } : {}) };
  let status = 0, payload = ""; let headers: Record<string, string> = {};
  const response = { headersSent: false, writeHead(code: number, next: Record<string, string>) { status = code; headers = next; response.headersSent = true; return response; }, end(chunk?: string) { payload = chunk ?? ""; return response; }, destroy() { return response; } };
  const handled = await handleOrganizationDeletion(req, response as unknown as ServerResponse, service, ORIGIN);
  return { handled, status, headers, body: payload ? JSON.parse(payload) as Record<string, unknown> : undefined };
}
test("SHU-326 HTTP real handler authenticates, checks origin and exposes the full write flow", async () => {
  const x = fixture(), change = { orgId: ORG, field: "deletion", value: "deleted" };
  assert.equal((await call(x.service, "/organization/deletion/preview", { body: change, cookie: "" })).status, 401);
  assert.equal((await call(x.service, "/organization/deletion/preview", { body: change, origin: "https://evil.invalid" })).status, 403);
  assert.equal((await call(x.service, "/organization/deletion/preview", { body: change, secFetchSite: "cross-site" })).status, 403);
  x.setBlockers(null); assert.equal((await call(x.service, "/organization/deletion/preview", { body: change })).status, 404);
  x.setBlockers(["member_grants"]); assert.deepEqual((await call(x.service, "/organization/deletion/preview", { body: change })).body, { error: "deletion_blocked", blockers: ["member_grants"] });
  x.setBlockers([]); const preview = await call(x.service, "/organization/deletion/preview", { body: change }); assert.equal(preview.status, 200); assert.equal(preview.headers["x-content-type-options"], "nosniff");
  const confirm = await call(x.service, "/organization/deletion/confirm", { body: { ...change, token: preview.body!.token } }); assert.equal(confirm.status, 200);
  const receipt = confirm.body!.receipt as Receipt; assert.equal(receipt.principalRef, organizationDeletionPrincipalRef(PERSON));
  assert.deepEqual((await call(x.service, `/organization/deletion/${ORG}/receipts/${receipt.receiptRef}`, { method: "GET" })).body, { receipt });
  assert.equal((await call(x.service, "/organization/deletion/confirm", { body: { ...change, token: preview.body!.token } })).status, 409);
});
test("SHU-326 HTTP a replayed confirm after the deletion is 409 token_already_used; any other token on the deleted organization is 404", async () => {
  let deleted = false; const spent = new Set<string>();
  const store = {
    blockers: async () => deleted ? null : [],
    counts: async () => ({ liveSubOrganizations: 0, livePayContracts: 0, memberGrants: 0 }),
    forPrincipal() { return {
      ownedRecord: async (p: string) => !deleted && p === organizationDeletionPrincipalRef(PERSON) ? organizationDeletionRecordRef(ORG) : null,
      readField: async () => null,
      commit: async (input: CommitInput) => { if (deleted) return { ok: false, reason: "not_own_record" as const }; deleted = true; spent.add(input.tokenId); return { ok: true as const }; },
      tokenSpent: async (id: string) => spent.has(id),
    }; },
    readReceipt: async () => null,
  };
  const sessions = { get: async (id: string) => id === SESSION ? { id, personId: PERSON } : undefined };
  const service = createOrganizationDeletion({ sessions, store, secret: SECRET }), change = { orgId: ORG, field: "deletion", value: "deleted" };
  const first = await call(service, "/organization/deletion/preview", { body: change }), second = await call(service, "/organization/deletion/preview", { body: change });
  assert.equal((await call(service, "/organization/deletion/confirm", { body: { ...change, token: first.body!.token } })).status, 200);
  const replay = await call(service, "/organization/deletion/confirm", { body: { ...change, token: first.body!.token } });
  assert.deepEqual([replay.status, replay.body], [409, { error: "token_already_used" }]);
  const other = await call(service, "/organization/deletion/confirm", { body: { ...change, token: second.body!.token } });
  assert.deepEqual([other.status, other.body], [404, { error: "not_own_record" }]);
  assert.equal((await call(service, "/organization/deletion/preview", { body: change })).status, 404);
});
test("SHU-326 HTTP real handler gates methods, content, size, receipt paths and configuration", async () => {
  const x = fixture(), change = { orgId: ORG, field: "deletion", value: "deleted" };
  assert.equal((await call(undefined, "/organization/deletion/preview", { body: change })).status, 503);
  assert.equal((await call(x.service, "/organization/deletion/preview", { method: "GET" })).status, 404);
  assert.equal((await call(x.service, "/organization/deletion/preview", { body: change, contentType: "text/plain" })).status, 400);
  assert.equal((await call(x.service, "/organization/deletion/preview", { raw: "x".repeat(8193) })).status, 400);
  assert.equal((await call(x.service, `/organization/deletion/${ORG}/receipts/not-a-hash`, { method: "GET" })).handled, false);
});
