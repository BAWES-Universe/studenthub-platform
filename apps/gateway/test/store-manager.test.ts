import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import type { StoreManagerPorts } from "../src/access/store-manager.js";
import type { ManagedStoreRow } from "../../../packages/access/src/index.js";

const SESSIONS: Record<string, string> = { ["m".repeat(43)]: "manager-1", ["r".repeat(43)]: "recruiter-1" };
const session = (principalId: string) => Object.entries(SESSIONS).find(([, id]) => id === principalId)![0];
const AVENUES = "11111111-1111-4111-8111-111111111111", MARINA = "22222222-2222-4222-8222-222222222222", SUB = "33333333-3333-4333-8333-333333333333";
const row = (over: Partial<ManagedStoreRow>): ManagedStoreRow => ({
  principalId: "manager-1", storeId: AVENUES, orgId: "acme", orgName: "Acme <Trading>", name: "Avenues", location: "Hall 2", brand: "Brand", mall: "The Avenues",
  revokedAt: null, storeStatus: "active", orgLive: true, ...over,
});

async function serve(t: TestContext, rows: Record<string, ManagedStoreRow[]>) {
  const reads: string[] = [];
  const ports: StoreManagerPorts = {
    sessions: { get: async (id: string) => (SESSIONS[id] ? { id, personId: SESSIONS[id]! } : undefined) } as StoreManagerPorts["sessions"],
    // The only port: the person's own grant rows. No grants reader exists here, by construction.
    stores: { rows: async (principalId) => { reads.push(principalId); return rows[principalId] ?? []; } },
  };
  const server = createGatewayServer(undefined, undefined, undefined, { storeManager: ports, web: { origin: "https://x.invalid" } } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const get = (path: string, principalId?: string) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: { accept: "text/html", ...(principalId ? { cookie: `__Host-studenthub_session=${session(principalId)}` } : {}) }, redirect: "manual" });
  return { get, reads };
}
async function sameAsUnknown(actual: Response, unknown: Response, message: string) {
  assert.equal(actual.status, unknown.status, `${message} status`);
  assert.equal(await actual.text(), await unknown.text(), `${message} body`);
}

test("A4_NO_LEAK My stores lists only managed stores; a sibling, a sub-company store and the company answer the unknown-path 404", async (t) => {
  const http = await serve(t, { "manager-1": [row({}), row({ storeId: MARINA, name: "Marina", revokedAt: "2026-11-17T10:00:00.000Z" })] });
  const list = await http.get("/workspace/my-stores", "manager-1");
  assert.equal(list.status, 200);
  const html = await list.text();
  assert.match(html, /Avenues/);
  assert.match(html, /Acme &lt;Trading&gt;/);
  assert.doesNotMatch(html, /Marina/, "a revoked grant is not listed");
  const one = await http.get(`/workspace/stores/${AVENUES}`, "manager-1");
  assert.equal(one.status, 200);
  const page = await one.text();
  assert.match(page, /Hall 2/);
  assert.match(page, /The Avenues/);
  for (const storeId of [MARINA, SUB]) {
    await sameAsUnknown(await http.get(`/workspace/stores/${storeId}`, "manager-1"), await http.get("/definitely-unknown", "manager-1"), `store ${storeId}`);
  }
  await sameAsUnknown(await http.get(`/workspace/stores/${AVENUES}`), await http.get("/definitely-unknown"), "signed out");
  await sameAsUnknown(await http.get("/workspace/my-stores"), await http.get("/definitely-unknown"), "signed out list");
});

test("A4_INDEPENDENT a company role opens no store; the store pages read only the person's own grant rows", async (t) => {
  const http = await serve(t, { "manager-1": [row({})] });
  await sameAsUnknown(await http.get(`/workspace/stores/${AVENUES}`, "recruiter-1"), await http.get("/definitely-unknown", "recruiter-1"), "recruiter");
  const empty = await (await http.get("/workspace/my-stores", "recruiter-1")).text();
  assert.match(empty, /You don’t manage a store/);
  assert.deepEqual([...new Set(http.reads)].sort(), ["manager-1", "recruiter-1"].filter((id) => http.reads.includes(id)).sort());
  assert.ok(http.reads.every((id) => id === "recruiter-1"), "each request reads the signed-in person's own rows only");
});
