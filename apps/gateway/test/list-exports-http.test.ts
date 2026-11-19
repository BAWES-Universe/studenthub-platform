import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import type { BrowserLoginApplication } from "../src/web-ui.js";
import { ExportService, type ExportStore, type StoredExport } from "../../../packages/exports/src/exports.js";
import { createCatalogueListExports } from "../../../packages/exports/src/catalogue-list-export.js";
import { createExportsHttp } from "../src/exports-http.js";

const ORIGIN = "https://studenthub.example.invalid", STAFF = "s".repeat(43), OTHER = "o".repeat(43);
class Memory implements ExportStore { rows = new Map<string, StoredExport>(); async save(r: StoredExport) { this.rows.set(r.id, r); } async find(id: string) { return this.rows.get(id) ?? null; } async cleanExpired() { return 0; } }

async function serve(t: test.TestContext) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: STAFF, personId: "staff-1" }); await rig.sessions.put({ id: OTHER, personId: "person-1" });
  const isStaff = async (id: string) => id === "staff-1";
  const store = new Memory, service = new ExportService(store, createCatalogueListExports({ isStaff,
    async list(type) { return type === "country" ? [{ id: "c1", name: "Kuwait", code: "KW", people: 3 }] : [{ id: "u1", name: "Kuwait University", code: null, people: 5 }, { id: "u2", name: "GUST", code: null, people: 1 }]; } }) as never);
  const login = { ...rig.app, exports: createExportsHttp(rig.sessions, service), staffMessages: { isStaff, send: async () => { throw Error("unused"); } },
    web: { origin: ORIGIN, profiles: { readOwn: async () => ({ kind: "not_found" }) } } } as unknown as BrowserLoginApplication;
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`, store };
}
const cookie = (s: string) => `__Host-studenthub_session=${s}`;
const post = (base: string, path: string, session: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { cookie: cookie(session), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...headers }, body: "" });

test("REPORTS_CATALOGUE_HTTP staff get the lists page and export countries and universities, each downloading under its own name", async t => {
  const { base } = await serve(t);
  const page = await fetch(`${base}/workspace/lists`, { headers: { cookie: cookie(STAFF), accept: "text/html" } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /action="\/exports\/catalogue-country"/); assert.match(html, /action="\/exports\/catalogue-university"/);
  const made = await post(base, "/exports/catalogue-university", STAFF);
  assert.equal(made.status, 200);
  const body = await made.json() as { downloadUrl: string; rowCount: number };
  assert.equal(body.rowCount, 2);
  const file = await fetch(`${base}${body.downloadUrl}`, { headers: { cookie: cookie(STAFF) } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-disposition"), 'attachment; filename="universities.csv"');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString("utf8"), "﻿ID,Name,Code,Total Candidate\r\nu1,Kuwait University,,5\r\nu2,GUST,,1\r\n");
  const countries = await post(base, "/exports/catalogue-country", STAFF, { accept: "text/html" });
  assert.equal(countries.status, 200);
  const link = (await countries.text()).match(/1 countries exported[\s\S]*href="(\/exports\/[^"]+)"/)?.[1];
  assert.ok(link);
  assert.equal((await fetch(`${base}${link}`, { headers: { cookie: cookie(STAFF) } })).headers.get("content-disposition"), 'attachment; filename="countries.csv"');
  assert.equal((await fetch(`${base}${link}`, { headers: { cookie: cookie(OTHER) } })).status, 404, "the link is the requester's only");
});

test("REPORTS_CATALOGUE_HTTP anyone else, a signed-out visitor and a cross-site post all get not found, and nothing is exported", async t => {
  const { base, store } = await serve(t);
  assert.equal((await fetch(`${base}/workspace/lists`, { headers: { cookie: cookie(OTHER) } })).status, 404);
  assert.equal((await fetch(`${base}/workspace/lists`)).status, 404);
  const refused = await post(base, "/exports/catalogue-country", OTHER);
  assert.equal(refused.status, 404);
  assert.equal([...store.rows.values()].every(r => r.outcome === "refused_authorization"), true);
  assert.equal((await post(base, "/exports/catalogue-country", STAFF, { origin: "https://evil.example.invalid" })).status, 404);
  assert.equal((await post(base, "/exports/catalogue-country", STAFF, { "sec-fetch-site": "cross-site" })).status, 404);
  assert.equal((await fetch(`${base}/exports/catalogue-country`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" } })).status, 404);
  assert.equal([...store.rows.values()].filter(r => r.outcome === "created").length, 0);
  assert.equal((await post(base, "/exports/catalogue-country?type=bank", STAFF)).status, 404, "a filter the kind does not take refuses the request");
  assert.equal((await post(base, "/exports/no-such-kind", STAFF)).status, 404);
  assert.equal([...store.rows.values()].filter(r => r.outcome === "created").length, 0);
});
