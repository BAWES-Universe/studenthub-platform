import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { CertificatesService, type CertificateFacts, type CertificatesStore } from "../../../packages/reports/src/index.js";
import { handleIdCards, type IdCardsHttpService } from "../src/reports/id-cards-http.js";

const OWN = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const ROWS: Record<string, CertificateFacts> = {
  [OWN]: { assignmentId: OWN, personId: "alia", name: "Alia <b>Badr</b>", company: "Sultan <Center>", store: "Avenues", startDate: "2026-03-01", endDate: null },
  [OTHER]: { assignmentId: OTHER, personId: "omar", name: "Omar", company: "Alshaya", store: "Marina", startDate: "2025-01-10", endDate: "2025-06-30" },
};

async function rig(t: TestContext) {
  const reads: string[] = [];
  const store: CertificatesStore = {
    async workHistory(personId) { const rows = Object.values(ROWS).filter(r => r.personId === personId).map(({ personId: _p, name: _n, ...r }) => r); return rows.length || personId === "staff" ? { name: personId, rows } : undefined; },
    async assignment(id) { reads.push(id); return ROWS[id]; },
  };
  const isStaff = async (id: string) => id === "staff";
  const certificates = new CertificatesService(store, { isStaff }, () => new Date("2026-11-20T06:00:00Z"));
  const service = { isStaff, certificates: { own: (p: string) => certificates.own(p), staffList: (v: string, p: string) => certificates.staffList(v, p), pdf: (v: string, a: string) => certificates.pdf(v, a) } } as unknown as IdCardsHttpService;
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, service, "https://studenthub.example", async s => ({ "s-alia": "alia", "s-omar": "omar", "s-staff": "staff" } as Record<string, string>)[s])) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "application/json", method = "GET") => fetch(base + path, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  return { call, reads };
}

test("REPORTS_CERTIFICATES_HTTP a person lists and downloads their own certificates; someone else's is the same not found as none", async (t) => {
  const x = await rig(t);
  assert.equal((await x.call("/profile/certificates")).status, 401);
  const list = await (await x.call("/profile/certificates", "s-alia")).json() as { rows: { assignmentId: string; until: string; ongoing: boolean }[] };
  assert.deepEqual(list.rows.map(r => [r.assignmentId, r.until, r.ongoing]), [[OWN, "2026-11-20", true]]);
  const html = await (await x.call("/profile/certificates", "s-alia", "text/html")).text();
  assert.match(html, /Sultan &lt;Center&gt;/); assert.match(html, new RegExp(`href="/profile/certificates/${OWN}\\.pdf"`)); assert.match(html, /Still working/);
  const pdf = await x.call(`/profile/certificates/${OWN}.pdf`, "s-alia", "*/*");
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get("content-type"), "application/pdf"); assert.equal(pdf.headers.get("cache-control"), "no-store");
  assert.match(Buffer.from(await pdf.arrayBuffer()).toString("latin1"), /Certificate of Appreciation/);
  const theirs = await x.call(`/profile/certificates/${OTHER}.pdf`, "s-alia"), none = await x.call("/profile/certificates/33333333-3333-4333-8333-333333333333.pdf", "s-alia");
  assert.deepEqual([theirs.status, await theirs.text()], [none.status, await none.text()]);
  assert.equal(theirs.status, 404);
  assert.equal((await x.call(`/profile/certificates/${OWN}.pdf`, "s-alia", "*/*", "POST")).status, 405);
  assert.equal((await x.call("/profile/certificates/not-a-uuid.pdf", "s-alia")).status, 418, "not this route's path");
});

test("REPORTS_CERTIFICATES_HTTP only staff reach the staff paths; everyone else gets the same not found for every method, before any assignment is read", async (t) => {
  const x = await rig(t);
  const notFound = JSON.stringify({ status: "not_found" });
  for (const session of [undefined, "s-alia", "s-bogus"]) for (const method of ["GET", "POST", "DELETE"]) for (const path of [`/workspace/certificates?person=omar`, `/workspace/certificates/${OTHER}.pdf`]) {
    const r = await x.call(path, session, "application/json", method);
    assert.equal(r.status, 404, `${method} ${path} ${session}`); assert.equal(await r.text(), notFound);
  }
  assert.deepEqual(x.reads, [], "no assignment was read for a caller who is not staff");
  const list = await (await x.call("/workspace/certificates?person=omar", "s-staff")).json() as { rows: { assignmentId: string }[] };
  assert.deepEqual(list.rows.map(r => r.assignmentId), [OTHER]);
  const page = await (await x.call("/workspace/certificates?person=alia", "s-staff", "text/html")).text();
  assert.match(page, /Certificates of appreciation for alia/); assert.ok(page.includes(`href="/workspace/certificates/${OWN}.pdf"`));
  assert.equal((await x.call(`/workspace/certificates/${OTHER}.pdf`, "s-staff", "*/*")).status, 200);
  assert.equal((await x.call("/workspace/certificates?person=nobody", "s-staff")).status, 404);
  assert.equal((await x.call("/workspace/certificates", "s-staff")).status, 404, "no person named");
  assert.equal((await x.call(`/workspace/certificates/${OTHER}.pdf`, "s-staff", "*/*", "POST")).status, 405);
});
