import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { CertificatesService, type CertificateFacts, type CertificatesStore } from "../../../packages/reports/src/index.js";
import { handleIdCards, type IdCardsHttpService } from "../src/reports/id-cards-http.js";

const OWN = "11111111-1111-4111-8111-111111111111", FINISHED = "33333333-3333-4333-8333-333333333333", OTHER = "22222222-2222-4222-8222-222222222222";
const ROWS: Record<string, CertificateFacts> = {
  [OWN]: { assignmentId: OWN, personId: "alia", name: "Alia", company: "Sultan <Center> & Co", store: "Avenues 'West'", startDate: "2026-03-01", endDate: null },
  [FINISHED]: { assignmentId: FINISHED, personId: "alia", name: "Alia", company: "Acme", store: "Old Town", startDate: "2025-01-10", endDate: "2025-06-30" },
  [OTHER]: { assignmentId: OTHER, personId: "omar", name: "Omar", company: "Other Company", store: "Marina", startDate: "2025-01-10", endDate: "2025-06-30" },
};

async function rig(t: TestContext, options: { unavailable?: boolean; configured?: boolean } = {}) {
  const calls = { own: [] as string[], pdf: [] as string[], staffList: [] as string[], isStaff: [] as string[], workHistory: [] as string[] };
  const store: CertificatesStore = {
    async workHistory(personId) {
      calls.workHistory.push(personId);
      const rows = Object.values(ROWS).filter(r => r.personId === personId).map(({ personId: _p, name: _n, ...r }) => r);
      return rows.length || personId === "staff" ? { name: personId, rows } : undefined;
    },
    async assignment(id) { return ROWS[id]; },
  };
  const authority = { async isStaff(id: string) { calls.isStaff.push(id); return id === "staff"; } };
  const core = new CertificatesService(store, authority, () => new Date("2026-11-20T06:00:00Z"));
  const certificates = options.configured === false ? undefined : {
    async own(person: string) { calls.own.push(person); if (options.unavailable) throw new Error("private database detail"); return core.own(person); },
    async staffList(viewer: string, person: string) { calls.staffList.push(`${viewer}:${person}`); return core.staffList(viewer, person); },
    async pdf(viewer: string, assignment: string) { calls.pdf.push(`${viewer}:${assignment}`); return core.pdf(viewer, assignment); },
  };
  const service = { isStaff: authority.isStaff, certificates } as unknown as IdCardsHttpService;
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, service, "https://studenthub.example", async s => ({ "s-alia": "alia", "s-omar": "omar", "s-staff": "staff" } as Record<string, string>)[s])) { res.writeHead(418); res.end("fallthrough"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "application/json", method = "GET") => fetch(base + path, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  return { call, calls };
}

test("CERTDET_SHOW renders and returns exactly the signed-in person's certificate entry", async t => {
  const x = await rig(t);
  const response = await x.call(`/profile/certificates/${OWN}`, "s-alia", "text/html");
  const html = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /^text\/html/); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(html, /Sultan &lt;Center&gt; &amp; Co/, "CERTDET_SHOW company text is escaped");
  assert.match(html, /Avenues &#39;West&#39;/); assert.match(html, /1 March 2026/); assert.match(html, /Still working/);
  assert.ok(html.includes(`href="/profile/certificates/${OWN}.pdf"`)); assert.ok(html.includes('href="/profile/certificates"'));
  const finished = await (await x.call(`/profile/certificates/${FINISHED}`, "s-alia", "text/html")).text();
  assert.match(finished, /30 June 2025/);
  const json = await x.call(`/profile/certificates/${OWN}`, "s-alia");
  assert.match(json.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await json.json(), { status: "ok", row: { assignmentId: OWN, company: "Sultan <Center> & Co", store: "Avenues 'West'", startDate: "2026-03-01", endDate: null, until: "2026-11-20", ongoing: true } });
  assert.deepEqual(x.calls.own, ["alia", "alia", "alia"]);
});

test("CERTDET_MINE refuses another person's, unknown, and malformed assignments identically", async t => {
  const x = await rig(t);
  const paths = [OTHER, "44444444-4444-4444-8444-444444444444", "NOT-a-lower-uuid"];
  const replies = await Promise.all(paths.map(async id => { const r = await x.call(`/profile/certificates/${id}`, "s-alia"); return [r.status, await r.text()] as const; }));
  assert.equal(replies[0]![0], 404, "CERTDET_MINE another person's assignment is not served");
  assert.equal(replies[1]![0], 404, "CERTDET_MINE an unknown assignment is the same 404");
  assert.deepEqual(replies[1], replies[0], "CERTDET_MINE an unknown assignment is the same 404");
  assert.deepEqual(replies[2], replies[0], "CERTDET_MINE a malformed assignment is the same 404");
  assert.deepEqual(x.calls.own, ["alia", "alia"]); assert.deepEqual(x.calls.pdf, []); assert.deepEqual(x.calls.staffList, []); assert.deepEqual(x.calls.isStaff, []);
  const htmlReplies = await Promise.all(paths.map(async id => { const r = await x.call(`/profile/certificates/${id}`, "s-alia", "text/html"); return [r.status, await r.text()] as const; }));
  assert.deepEqual(htmlReplies[1], htmlReplies[0]); assert.deepEqual(htmlReplies[2], htmlReplies[0]);
});

test("CERTDET_DENY checks the session before reading and rejects non-GET methods", async t => {
  const x = await rig(t);
  const json = await x.call(`/profile/certificates/${OWN}`);
  assert.deepEqual([json.status, await json.text()], [401, JSON.stringify({ status: "unauthenticated" })]);
  const html = await x.call(`/profile/certificates/${OWN}`, undefined, "text/html");
  assert.equal(html.status, 401); assert.match(await html.text(), /Sign in/);
  assert.deepEqual(x.calls.own, [], "CERTDET_DENY own is not called without a session");
  const post = await x.call(`/profile/certificates/${OWN}`, "s-alia", "application/json", "POST");
  assert.equal(post.status, 405); assert.equal(post.headers.get("allow"), "GET"); assert.deepEqual(x.calls.own, []);
});

test("CERTDET_PASSTHROUGH preserves list, PDF, staff, malformed PDF, and missing-service behavior", async t => {
  const x = await rig(t);
  assert.equal((await x.call("/profile/certificates", "s-alia")).status, 200);
  assert.equal((await x.call("/profile/certificates", "s-alia", "text/html")).status, 200);
  assert.equal((await x.call(`/profile/certificates/${OWN}.pdf`, "s-alia", "*/*")).status, 200);
  assert.equal((await x.call("/workspace/certificates?person=omar", "s-staff")).status, 200);
  assert.equal((await x.call(`/workspace/certificates/${OTHER}.pdf`, "s-staff", "*/*")).status, 200);
  assert.deepEqual([ (await x.call("/profile/certificates/not-a-uuid.pdf", "s-alia")).status, x.calls.own.length ], [418, 2]);
  const missing = await rig(t, { configured: false });
  const detail = await missing.call(`/profile/certificates/${OWN}`, "s-alia"), list = await missing.call("/profile/certificates", "s-alia");
  assert.deepEqual([detail.status, await detail.text()], [list.status, await list.text()]);
});

test("CERTDET_UNAVAILABLE hides failures from HTML and JSON detail responses", async t => {
  const x = await rig(t, { unavailable: true });
  const json = await x.call(`/profile/certificates/${OWN}`, "s-alia");
  assert.deepEqual([json.status, await json.text()], [503, JSON.stringify({ status: "unavailable" })]);
  const html = await x.call(`/profile/certificates/${OWN}`, "s-alia", "text/html"), body = await html.text();
  assert.equal(html.status, 503); assert.doesNotMatch(body, /private database detail|Other Company|Omar/);
  assert.deepEqual(x.calls.own, ["alia", "alia"]); assert.deepEqual(x.calls.pdf, []); assert.deepEqual(x.calls.staffList, []);
});
