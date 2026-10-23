import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createOrganizationCreation, handleOrganizationCreation, type OrganizationCreationStore } from "../src/organization-creation.js";
const SESSION = "s".repeat(43), calls: string[] = [];
const store: OrganizationCreationStore = { async create(_principal, parent, name) { calls.push(`${parent}:${name}`); if (parent === "missing") return { kind: "not_found" }; if (parent === "deep") return { kind: "hierarchy" }; if (name === "Taken") return { kind: "name_taken" }; return { kind: "created", orgId: "new-org" }; } };
const service = createOrganizationCreation({ sessions: { async get(id: string) { return id === SESSION ? { personId: "person" } as never : undefined; } }, store });
async function call(body: unknown, method = "POST", headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as never;
  Object.assign(req, { url: "/organization/create", method, headers: { origin: "https://hub.test", "content-type": "application/json", cookie: `__Host-studenthub_session=${SESSION}`, ...headers } });
  let status = 0, response = "";
  const res = { headersSent: false, writeHead(s: number) { status = s; res.headersSent = true; }, end(s: string) { response = s; }, destroy() {} };
  assert.equal(await handleOrganizationCreation(req, res as never, service, "https://hub.test"), true);
  return { status, body: JSON.parse(response) as unknown };
}
test("SHU333_HTTP creation route validates boundaries and maps every result", async () => {
  calls.length = 0;
  assert.deepEqual(await call({ parentOrgId: "root", name: " Acme " }), { status: 200, body: { orgId: "new-org", changed: true } });
  assert.deepEqual(await call({ parentOrgId: "missing", name: "A" }), { status: 404, body: { error: "not_found" } });
  assert.deepEqual(await call({ parentOrgId: "deep", name: "A" }), { status: 409, body: { error: "hierarchy_too_deep" } });
  assert.deepEqual(await call({ parentOrgId: "root", name: "Taken" }), { status: 409, body: { error: "name_taken" } });
  assert.deepEqual(await call({ parentOrgId: "root", name: "A", extra: true }), { status: 400, body: { error: "invalid_request" } });
  const before = calls.length;
  assert.deepEqual(await call({ parentOrgId: "root", name: "A" }, "POST", { origin: "https://evil.test" }), { status: 403, body: { error: "origin_rejected" } });
  assert.deepEqual(await call({ parentOrgId: "root", name: "A" }, "POST", { cookie: "" }), { status: 401, body: { error: "unauthorized" } });
  assert.deepEqual(await call(undefined, "GET"), { status: 404, body: { error: "not_found" } });
  assert.equal(calls.length, before, "origin, session and method refusals reach no store call");
});
