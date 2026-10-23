import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createOrganizationStores, handleOrganizationStores } from "../src/organization-stores.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "d".repeat(43);
const STORE = "123e4567-e89b-42d3-a456-426614174000", BRAND = "223e4567-e89b-42d3-a456-426614174000";
const calls: string[] = [];
const service = createOrganizationStores({
  sessions: { get: async (id) => (id === SESSION ? { id, personId: "staff" } : undefined) },
  store: {
    create: async (_p, o, f) => { calls.push(`create:${o}:${f.name}`); return o === "refused" ? { kind: "not_found" } : f.brandId ? { kind: "brand_not_found" } : { kind: "created", storeId: STORE }; },
    update: async (_p, o, s, f) => { calls.push(`update:${o}:${s}`); return o === "missing" ? { kind: "store_not_found" } : f.name === "Same" ? { kind: "unchanged" } : { kind: "updated" }; },
    remove: async (_p, o, s) => { calls.push(`remove:${o}:${s}`); return o === "missing" ? { kind: "store_not_found" } : { kind: "removed" }; },
    list: async (_p, o) => {
      calls.push(`list:${o}`);
      return o === "refused" ? null : [{ store_id: STORE, org_id: "private", name: "Avenues", location: null, status: "active", brand_id: null, brand_name: null, brand_status: null, mall_id: null, mall_name: null, mall_status: null, created_by_ref: "f".repeat(64) }];
    },
    childOrganizations: async (o) => { calls.push(`children:${o}`); return o === "org" ? ["child", "refused"] : []; },
  },
});

async function call(path: string, body?: unknown, method = "POST", headers: Record<string, string> = {}) {
  const encoded = body === undefined ? "" : JSON.stringify(body), req = Readable.from(encoded ? [encoded] : []) as IncomingMessage;
  req.url = path; req.method = method;
  req.headers = { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-studenthub_session=${SESSION}`, ...headers };
  let status = 0, payload = "";
  const fake = { headersSent: false, writeHead(code: number) { status = code; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  assert.equal(await handleOrganizationStores(req, fake as unknown as ServerResponse, service, ORIGIN), true);
  return { status, body: JSON.parse(payload) };
}

test("SHU-165 organization stores HTTP validates, creates, updates, removes and lists", async () => {
  calls.length = 0;
  assert.deepEqual(await call("/organization/stores/create", { orgId: "org", store: { name: " Avenues " } }), { status: 200, body: { storeId: STORE, changed: true } });
  assert.deepEqual(await call("/organization/stores/create", { orgId: "org", store: { name: "A", brandId: BRAND } }), { status: 404, body: { error: "brand_not_found" } });
  assert.deepEqual(await call("/organization/stores/create", { orgId: "org", store: { name: "" } }), { status: 400, body: { error: "invalid_request" } });
  assert.deepEqual(await call("/organization/stores/create", { orgId: "org", store: { name: "A" }, extra: 1 }), { status: 400, body: { error: "invalid_request" } });
  assert.deepEqual(await call("/organization/stores/update", { orgId: "org", storeId: STORE.toUpperCase(), store: { name: "New" } }), { status: 200, body: { storeId: STORE, changed: true } });
  assert.deepEqual(await call("/organization/stores/update", { orgId: "org", storeId: STORE, store: { name: "Same" } }), { status: 200, body: { storeId: STORE, changed: false } });
  assert.deepEqual(await call("/organization/stores/update", { orgId: "missing", storeId: STORE, store: { name: "New" } }), { status: 404, body: { error: "store_not_found" } });
  assert.deepEqual(await call("/organization/stores/update", { orgId: "org", storeId: "bad", store: { name: "New" } }), { status: 400, body: { error: "invalid_request" } });
  assert.deepEqual(await call("/organization/stores/remove", { orgId: "org", storeId: STORE }), { status: 200, body: { storeId: STORE, changed: true } });
  assert.deepEqual(await call("/organization/stores/remove", { orgId: "missing", storeId: STORE }), { status: 404, body: { error: "store_not_found" } });
  assert.deepEqual(await call("/organization/stores/org", undefined, "GET"), { status: 200, body: { stores: [{ storeId: STORE, name: "Avenues", location: null, brand: null, mall: null }] } });
  assert.deepEqual(calls, ["create:org:Avenues", "create:org:A", `update:org:${STORE}`, `update:org:${STORE}`, `update:missing:${STORE}`, `remove:org:${STORE}`, `remove:missing:${STORE}`, "list:org"]);
});

test("SHU-165 organization stores HTTP refuses without exposing stores", async () => {
  calls.length = 0;
  assert.deepEqual(await call("/organization/stores/refused", undefined, "GET"), { status: 404, body: { error: "not_found" } });
  assert.deepEqual(await call("/organization/stores/create", { orgId: "refused", store: { name: "A" } }), { status: 404, body: { error: "not_found" } });
  assert.deepEqual(await call("/organization/stores/create", { orgId: "org", store: { name: "A" } }, "POST", { origin: "https://evil.invalid" }), { status: 403, body: { error: "origin_rejected" } });
  assert.deepEqual(await call("/organization/stores/create", { orgId: "org", store: { name: "A" } }, "POST", { cookie: "" }), { status: 401, body: { error: "unauthorized" } });
  assert.deepEqual(await call("/organization/stores/create", undefined, "GET"), { status: 404, body: { error: "not_found" } });
  assert.deepEqual(calls, ["list:refused", "create:refused:A"], "origin, session and method refusals reach no store operation");
});

test("SHU331_HTTP group lists authorized organizations and validates all request boundaries", async () => {
  calls.length = 0;
  assert.deepEqual(await call("/organization/stores/org/group", undefined, "GET"), {
    status: 200,
    body: { stores: [
      { orgId: "org", storeId: STORE, name: "Avenues", location: null, brand: null, mall: null },
      { orgId: "child", storeId: STORE, name: "Avenues", location: null, brand: null, mall: null },
    ] },
  });
  assert.deepEqual(calls, ["list:org", "children:org", "list:child", "list:refused"]);

  calls.length = 0;
  assert.deepEqual(await call("/organization/stores/refused/group", undefined, "GET"), { status: 404, body: { error: "not_found" } });
  assert.deepEqual(calls, ["list:refused"], "a refused parent does not load children");

  calls.length = 0;
  assert.deepEqual(await call("/organization/stores/org/group", undefined, "GET", { cookie: "" }), { status: 401, body: { error: "unauthorized" } });
  assert.deepEqual(await call("/organization/stores/org/group"), { status: 404, body: { error: "not_found" } });
  assert.deepEqual(await call("/organization/stores/%20/group", undefined, "GET"), { status: 400, body: { error: "invalid_request" } });
  assert.deepEqual(calls, [], "invalid requests reach no store operation");
});
