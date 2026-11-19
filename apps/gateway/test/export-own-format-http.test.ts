import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import type { BrowserLoginApplication } from "../src/web-ui.js";
import { ExportService, type ExportStore, type StoredExport } from "../../../packages/exports/src/exports.js";
import { createExportsHttp } from "../src/exports-http.js";

const STAFF = "s".repeat(43), OTHER = "o".repeat(43), XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
class Memory implements ExportStore { rows = new Map<string, StoredExport>(); async save(r: StoredExport) { this.rows.set(r.id, r); } async find(id: string) { return this.rows.get(id) ?? null; } async cleanExpired() { return 0; } }

test("REPORTS_EXPORT_OWN_FORMAT_HTTP a binary export downloads byte for byte under its own content type and file name, to its requester only", async t => {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: STAFF, personId: "staff-1" }); await rig.sessions.put({ id: OTHER, personId: "person-1" });
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe]);
  const kind = { id: "pay-bank-file", filterKeys: [], columns: ["Beneficiary"], authorize: async (id: string) => id === "staff-1",
    async *rows() { yield ["A"]; }, serialize: () => ({ bytes, contentType: XLSX, fileName: "abk-2026-11-19.xlsx" }) };
  const service = new ExportService(new Memory, [kind as never]);
  const made = await service.request("staff-1", "pay-bank-file", {});
  assert.ok(made.ok);
  const login = { ...rig.app, exports: createExportsHttp(rig.sessions, service), web: { origin: "https://studenthub.example.invalid", profiles: { readOwn: async () => ({ kind: "not_found" }) } } } as unknown as BrowserLoginApplication;
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}${made.downloadUrl}`;
  const file = await fetch(url, { headers: { cookie: `__Host-studenthub_session=${STAFF}` } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), XLSX);
  assert.equal(file.headers.get("content-disposition"), 'attachment; filename="abk-2026-11-19.xlsx"');
  assert.equal(file.headers.get("cache-control"), "no-store");
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  assert.equal((await fetch(url, { headers: { cookie: `__Host-studenthub_session=${OTHER}` } })).status, 404);
  assert.equal((await fetch(url)).status, 404);
});
