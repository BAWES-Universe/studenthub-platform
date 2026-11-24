import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { PayHistoryDetail, PayHistoryEntry } from "@studenthub/db/billing";
import { createPayHistoryHttp, handlePayHistory, type PayHistoryReads } from "../src/billing/pay-history-http.js";
import { createInvoicesHttp } from "../src/billing/invoices-http.js";

// Synthetic people, companies and amounts only.
const ME = "m".repeat(43), OTHER = "o".repeat(43);
const OCT: PayHistoryEntry = { lineId: "line-1", companyName: "Alpha <Trading>", storeName: "Mall shop", periodStart: "2026-10-01", periodEnd: "2026-10-31", currencyCode: "KWD", total: "120.500", status: "paid" };
const DETAIL: PayHistoryDetail = { ...OCT, worked: { hours: "73", minutes: 15, hourlyRate: "0.500" } };

async function rig(t: TestContext) {
  const calls: string[] = [];
  const reads: PayHistoryReads = {
    async list(person, page) { calls.push(`list:${person}:${page}`); return person === "me" ? { page, pageCount: 2, total: 11, entries: page === 1 ? [OCT] : [] } : { page, pageCount: 1, total: 0, entries: [] }; },
    async detail(person, lineId) { calls.push(`detail:${person}:${lineId}`); return person === "me" && lineId === "line-1" ? DETAIL : null; },
  };
  const service = createPayHistoryHttp({ sessions: { get: async (id: string) => ({ [ME]: { personId: "me" }, [OTHER]: { personId: "other" } } as Record<string, { personId: string }>)[id] as never }, reads });
  const server = createServer(async (req, res) => { if (!await handlePayHistory(req, res, service)) { res.writeHead(418); res.end(); } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "application/json", method = "GET") =>
    fetch(base + path, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  return { call, calls };
}

test("PAY_HISTORY_HTTP a person lists their own pay as JSON or a page, newest first, with paging and a details link", async (t) => {
  const x = await rig(t);
  const json = await (await x.call("/pay", ME)).json() as { page: number; entries: { total: string }[] };
  assert.deepEqual([json.page, json.entries.map(e => e.total)], [1, ["120.500"]]);
  const page = await x.call("/pay", ME, "text/html");
  assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  assert.match(html, /Alpha &lt;Trading&gt;/); assert.doesNotMatch(html, /<Trading>/);
  assert.match(html, /1 October 2026 to 31 October 2026/); assert.match(html, /KWD 120\.500/);
  assert.match(html, /href="\/pay\/line-1">Details/); assert.match(html, /Page 1 of 2/); assert.match(html, /href="\/pay\?page=2">Older/);
  await x.call("/pay?page=2", ME);
  assert.deepEqual(x.calls.filter(c => c.startsWith("list:")), ["list:me:1", "list:me:1", "list:me:2"]);
  assert.match(await (await x.call("/pay", OTHER, "text/html")).text(), /No pay has been received yet/);
  const past = await (await x.call("/pay?page=2", ME, "text/html")).text();
  assert.match(past, /There is no pay on page 2/); assert.match(past, /href="\/pay">Back to my pay/);
  assert.doesNotMatch(past, /No pay has been received yet/, "a page past the end is not an empty history");
});

test("PAY_HISTORY_HTTP one line shows its worked time and the candidate's rate", async (t) => {
  const x = await rig(t);
  const json = await (await x.call("/pay/line-1", ME)).json() as PayHistoryDetail;
  assert.deepEqual(json, DETAIL);
  const html = await (await x.call("/pay/line-1", ME, "text/html")).text();
  for (const text of ["Pay details", "73 h 15 min", "KWD 0.500", "KWD 120.500", 'href="/pay">Back to my pay']) assert.ok(html.includes(text), text);
});

test("PAY_HISTORY_HTTP sign in first; another person's line, a missing line and a malformed path are the same not found", async (t) => {
  const x = await rig(t);
  assert.equal((await x.call("/pay")).status, 401);
  assert.equal((await x.call("/pay/line-1", "x".repeat(43))).status, 401, "an unknown session");
  const theirs = await x.call("/pay/line-1", OTHER), none = await x.call("/pay/line-9", ME);
  assert.equal(theirs.status, 404); assert.deepEqual(await theirs.text(), await none.text());
  const before = x.calls.length;
  for (const bad of ["/pay/%E0%A4%A", "/pay/a%20b", `/pay/${"a".repeat(129)}`, "/pay?page=0", "/pay?page=-1", "/pay?page=x", "/pay?page=1000000"]) assert.equal((await x.call(bad, ME)).status, 404, bad);
  assert.equal(x.calls.length, before, "malformed paths never reach the store");
  assert.equal((await x.call("/pay", ME, "application/json", "POST")).status, 405);
  for (const other of ["/pay-contracts/mine", "/pay/line-1/extra", "/payroll"]) assert.equal((await x.call(other, ME)).status, 418, other);
});

test("PAY_HISTORY_HTTP unavailable without a service, and a store failure is a 503, not a leak", async (t) => {
  const failing = createPayHistoryHttp({ sessions: { get: async () => ({ personId: "me" }) as never },
    reads: { list: async () => { throw new Error("db down: secret"); }, detail: async () => null } });
  for (const service of [undefined, failing]) {
    const server = createServer(async (req, res) => { await handlePayHistory(req, res, service); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    t.after(() => new Promise<void>(r => server.close(() => r())));
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/pay`, { headers: { cookie: `__Host-studenthub_session=${ME}` } });
    assert.equal(r.status, 503); assert.doesNotMatch(await r.text(), /secret/);
  }
});

test("PAY_HISTORY_ROUTE the gateway's route table reaches the pay history handler next to invoices", async (t) => {
  const { ROUTES } = await import("../src/routes/index.js");
  const { runRoutes } = await import("../src/routes/context.js");
  const web = await import("../src/web-ui.js");
  const payHistory = createPayHistoryHttp({ sessions: { get: async () => ({ personId: "me" }) as never },
    reads: { list: async (_, page) => ({ page, pageCount: 1, total: 1, entries: [OCT] }), detail: async () => DETAIL } });
  const invoices = createInvoicesHttp({ sessions: { get: async () => ({ personId: "me" }) as never }, reads: { listForOrganization: async () => null, document: async () => null, statement: async () => null } });
  const server = createServer(async (request, response) => {
    const ctx = { request, response, login: { invoices, payHistory } as never, authz: undefined as never, documents: undefined, catalogue: undefined, profileRecords: undefined,
      organizationDocuments: undefined, writeHtml: web.writeHtml, pageDocument: web.pageDocument, renderError: web.renderError };
    if (!await runRoutes(ROUTES, ctx)) { response.writeHead(418); response.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers = { cookie: `__Host-studenthub_session=${ME}` };
  const list = await fetch(`${base}/pay`, { headers });
  assert.equal(list.status, 200); assert.equal(((await list.json()) as { entries: unknown[] }).entries.length, 1);
  const detail = await fetch(`${base}/pay/line-1`, { headers });
  assert.equal(detail.status, 200); assert.deepEqual(await detail.json(), DETAIL);
  assert.equal((await fetch(`${base}/organization/invoices/P`, { headers })).status, 404, "invoices still answer their own paths");
});
