import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { CertificatesService, type CertificateFacts, type CertificatesStore } from "../../../packages/reports/src/index.js";
import { handleIdCards, type IdCardsHttpService } from "../src/reports/id-cards-http.js";

const OWN = "11111111-1111-4111-8111-111111111111", FINISHED = "33333333-3333-4333-8333-333333333333";
const OTHER = "22222222-2222-4222-8222-222222222222", UNKNOWN = "44444444-4444-4444-8444-444444444444";
const FACTS: Record<string, CertificateFacts> = {
  [OWN]: { assignmentId: OWN, personId: "alia", name: "Alia", company: "Sultan <script>& Co", store: `Avenues "West"`, startDate: "2026-03-01", endDate: null },
  [FINISHED]: { assignmentId: FINISHED, personId: "alia", name: "Alia", company: "Old Company", store: "Old Store", startDate: "2025-01-10", endDate: "2025-06-30" },
  [OTHER]: { assignmentId: OTHER, personId: "omar", name: "Omar", company: "Other Company", store: "Marina", startDate: "2025-02-01", endDate: null },
};

async function rig(t: TestContext, options: { configured?: boolean; ownThrows?: boolean } = {}) {
  const calls = { own: [] as string[], pdf: [] as string[], staffList: [] as string[], isStaff: [] as string[] };
  const store: CertificatesStore = {
    async workHistory(personId) {
      const rows = Object.values(FACTS).filter(r => r.personId === personId).map(({ personId: _person, name: _name, ...row }) => row);
      return rows.length ? { name: personId, rows } : undefined;
    },
    async assignment(id) { return FACTS[id]; },
  };
  const authority = { async isStaff(id: string) { calls.isStaff.push(id); return id === "staff"; } };
  const certificates = new CertificatesService(store, authority, () => new Date("2026-11-20T06:00:00Z"));
  const certificateHttp = options.configured === false ? undefined : {
    async own(person: string) { calls.own.push(person); if (options.ownThrows) throw new Error("private failure"); return certificates.own(person); },
    async staffList(viewer: string, person: string) { calls.staffList.push(`${viewer}:${person}`); return certificates.staffList(viewer, person); },
    async pdf(viewer: string, assignment: string) { calls.pdf.push(`${viewer}:${assignment}`); return certificates.pdf(viewer, assignment); },
  };
  const service = { isStaff: authority.isStaff, certificates: certificateHttp } as unknown as IdCardsHttpService;
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, service, "https://studenthub.example", async session => ({ "s-alia": "alia", "s-omar": "omar", "s-staff": "staff" } as Record<string, string>)[session])) { res.writeHead(418); res.end("fallthrough"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "application/json", method = "GET") => fetch(base + path, { method, headers: { accept, ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}) } });
  return { call, calls };
}

test("CERTDET_SHOW renders one escaped certificate and returns its list-shaped JSON row", async t => {
  const x = await rig(t);
  const response = await x.call(`/profile/certificates/${OWN}`, "s-alia", "text/html");
  const html = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /^text\/html/); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(html, /Sultan &lt;script&gt;&amp; Co/, "CERTDET_SHOW company is escaped");
  assert.match(html, /Avenues &quot;West&quot;/); assert.doesNotMatch(html, /Sultan <script>/);
  assert.match(html, /1 March 2026/); assert.match(html, /Still working/);
  assert.ok(html.includes(`href="/profile/certificates/${OWN}.pdf"`)); assert.match(html, /href="\/profile\/certificates"/);
  const finished = await (await x.call(`/profile/certificates/${FINISHED}`, "s-alia", "text/html")).text();
  assert.match(finished, /10 January 2025/); assert.match(finished, /30 June 2025/);
  const json = await x.call(`/profile/certificates/${OWN}`, "s-alia");
  assert.match(json.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await json.json(), { status: "ok", row: { assignmentId: OWN, company: "Sultan <script>& Co", store: `Avenues "West"`, startDate: "2026-03-01", endDate: null, until: "2026-11-20", ongoing: true } });
  assert.deepEqual(x.calls.own, ["alia", "alia", "alia"]);
});

test("CERTDET_MINE reveals only a row in the signed-in person's own list", async t => {
  const x = await rig(t);
  const paths = [OTHER, UNKNOWN, "NOT-a-lowercase-uuid"];
  const json = await Promise.all(paths.map(id => x.call(`/profile/certificates/${id}`, "s-alia")));
  const jsonBodies = await Promise.all(json.map(r => r.text()));
  assert.deepEqual(json.map(r => r.status), [404, 404, 404], "CERTDET_MINE other, unknown and malformed are 404");
  assert.equal(new Set(jsonBodies).size, 1); assert.equal(jsonBodies[0], JSON.stringify({ status: "not_found" }));
  const pages = await Promise.all(paths.map(id => x.call(`/profile/certificates/${id}`, "s-alia", "text/html")));
  const pageBodies = await Promise.all(pages.map(r => r.text()));
  assert.deepEqual(pages.map(r => r.status), [404, 404, 404]); assert.equal(new Set(pageBodies).size, 1);
  assert.deepEqual(x.calls.own, ["alia", "alia", "alia", "alia"], "CERTDET_MINE own is the only certificate read");
  assert.deepEqual(x.calls.pdf, []); assert.deepEqual(x.calls.staffList, []); assert.deepEqual(x.calls.isStaff, []);
});

test("CERTDET_DENY applies the existing authentication and method answers before own", async t => {
  const x = await rig(t);
  const json = await x.call(`/profile/certificates/${OWN}`);
  assert.equal(json.status, 401); assert.deepEqual(await json.json(), { status: "unauthenticated" });
  const page = await x.call(`/profile/certificates/${OWN}`, undefined, "text/html");
  assert.equal(page.status, 401); assert.match(await page.text(), /Sign in/);
  const post = await x.call(`/profile/certificates/${OWN}`, "s-alia", "application/json", "POST");
  assert.equal(post.status, 405); assert.equal(post.headers.get("allow"), "GET");
  assert.deepEqual(x.calls.own, [], "CERTDET_DENY own is not called without a permitted GET session");
});

test("CERTDET_PASSTHROUGH preserves list, PDF, staff, fall-through and unconfigured behavior", async t => {
  const x = await rig(t);
  assert.equal((await x.call("/profile/certificates", "s-alia")).status, 200);
  assert.equal((await x.call("/profile/certificates", "s-alia", "text/html")).status, 200);
  assert.equal((await x.call(`/profile/certificates/${OWN}.pdf`, "s-alia", "*/*")).status, 200);
  assert.equal((await x.call("/workspace/certificates?person=alia", "s-staff")).status, 200);
  assert.equal((await x.call(`/workspace/certificates/${OWN}.pdf`, "s-staff", "*/*")).status, 200);
  assert.equal((await x.call("/profile/certificates/not-a-uuid.pdf", "s-alia")).status, 418);
  const absent = await rig(t, { configured: false });
  const detail = await absent.call(`/profile/certificates/${OWN}`, "s-alia");
  const list = await absent.call("/profile/certificates", "s-alia");
  assert.deepEqual([detail.status, await detail.text()], [list.status, await list.text()]);
});

test("CERTDET_UNAVAILABLE contains own read failures for HTML and JSON", async t => {
  const x = await rig(t, { ownThrows: true });
  const json = await x.call(`/profile/certificates/${OWN}`, "s-alia");
  assert.equal(json.status, 503); assert.deepEqual(await json.json(), { status: "unavailable" });
  const page = await x.call(`/profile/certificates/${OWN}`, "s-alia", "text/html");
  const body = await page.text();
  assert.equal(page.status, 503); assert.match(page.headers.get("content-type") ?? "", /^text\/html/); assert.doesNotMatch(body, /private failure|Error:/);
  assert.doesNotMatch(body, /Other Company|Marina/); assert.deepEqual(x.calls.pdf, []); assert.deepEqual(x.calls.staffList, []);
});
