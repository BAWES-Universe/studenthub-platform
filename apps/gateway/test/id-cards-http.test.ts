import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { IdCardsService } from "../../../packages/reports/src/index.js";
import type { IdCardAction, IdCardPhotoSource, IdCardsStore, IdCardView } from "../../../packages/reports/src/index.js";
import type { DocumentState, DocumentStore } from "../../../packages/private-documents/src/index.js";
import { personalPhotoSource, type PersonalPhotoAuditPort } from "../../../packages/private-documents/src/personal-photo-source.js";
import { handleIdCards } from "../src/reports/id-cards-http.js";

const ORIGIN = "https://studenthub.example", STAFF = "staff-1", PERSON = "person-1";

async function rig(t: TestContext, photos?: IdCardPhotoSource) {
  const writes: { action: IdCardAction; people: readonly string[] }[] = [];
  let refuse: { personId: string; code: "not_assigned" }[] = [];
  const store: IdCardsStore = {
    async list(view: IdCardView) {
      return view === "needs" ? { total: 1, rows: [{ personId: "p-<1>", name: "Alia <b>Badr</b>", employeeId: "C00042", cardNumber: null, expiresOn: null, placement: { company: "Sultan Center", store: "Avenues" } }] } : view === "issued" ? { total: 1, rows: [{ personId: PERSON, name: "Alia Badr", employeeId: "C00042", cardNumber: 17, expiresOn: "2099-01-01", placement: { company: "Sultan Center", store: "Avenues" } }] } : { total: 0, rows: [] };
    },
    async write(action, people) { if (refuse.length) return refuse; writes.push({ action, people }); return []; },
    async card(person) { return person === PERSON ? { name: "Alia Badr", arabicName: "علياء بدر", employeeId: "C00042", cardNumber: 17, expiresOn: "2099-01-01", issuedAt: new Date("2026-11-19T00:00:00Z"), placement: { company: "Sultan Center", store: "Avenues" } } : undefined; },
    async counts() { return { needs: 0, expired: 0 }; },
  };
  const authority = { async isStaff(id: string) { return id === STAFF; } };
  const service = new IdCardsService(store, authority, undefined, photos);
  const http = { isStaff: authority.isStaff, list: service.list.bind(service), write: service.write.bind(service), own: service.own.bind(service), ownPdf: service.ownPdf.bind(service), staffPdf: service.staffPdf.bind(service) };
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, http, ORIGIN, async s => s === "s-staff" ? STAFF : s === "s-person" ? PERSON : s === "s-other" ? "other" : undefined)) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, session?: string, accept = "application/json") => fetch(base + path, { headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  const post = (body: string, session = "s-staff", headers: Record<string, string> = {}, method = "POST") => fetch(base + "/workspace/id-cards", { method, redirect: "manual",
    headers: { cookie: `__Host-studenthub_session=${session}`, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers }, body });
  return { get, post, writes, base, refuseWith(r: typeof refuse) { refuse = r; } };
}

test("REPORTS_ID_CARDS_HTTP only staff reach the staff page; everyone else gets the same not found for every method", async (t) => {
  const x = await rig(t);
  const notFound = JSON.stringify({ status: "not_found" });
  for (const session of [undefined, "s-person", "s-bogus"]) {
    const res = await x.get("/workspace/id-cards", session);
    assert.equal(res.status, 404); assert.equal(await res.text(), notFound);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await x.post("action=issue&person=a", session ?? "", {}, method);
      assert.equal(r.status, 404, `${method} ${session}`); assert.equal(await r.text(), notFound);
    }
    const cross = await x.post("action=issue&person=a", session ?? "", { origin: "https://evil.example" });
    assert.equal(cross.status, 404, "cross-origin from a non-staff caller is still not found");
  }
  assert.equal(x.writes.length, 0);
  assert.equal((await x.get("/workspace/id-cards/other", "s-staff")).status, 418, "other paths are not this route's");
});

test("REPORTS_ID_CARDS_HTTP staff see who needs a card, escaped, and a form to issue", async (t) => {
  const x = await rig(t);
  const json = await (await x.get("/workspace/id-cards?view=needs&name=alia", "s-staff")).json() as { status: string; view: string; total: number; rows: { personId: string }[] };
  assert.equal(json.status, "ok"); assert.equal(json.view, "needs"); assert.equal(json.total, 1); assert.equal(json.rows[0]?.personId, "p-<1>");
  const html = await (await x.get("/workspace/id-cards", "s-staff", "text/html")).text();
  assert.match(html, /<h1>ID cards<\/h1>/);
  assert.match(html, /name="person" value="p-&lt;1&gt;"/);
  assert.match(html, /Alia &lt;b&gt;Badr&lt;\/b&gt;/);
  assert.match(html, /Sultan Center, Avenues/);
  assert.match(html, /<button type="submit" name="action" value="issue">Issue cards<\/button>/);
  assert.match(await (await x.get("/workspace/id-cards?view=expired", "s-staff", "text/html")).text(), /No assigned person has an expired card/);
  const issued = await (await x.get("/workspace/id-cards?view=issued", "s-staff", "text/html")).text();
  assert.match(issued, /<button type="submit" name="action" value="renew">Renew cards<\/button> <button type="submit" name="action" value="issue">Re-issue cards<\/button>/, "people with a card can be renewed or re-issued");
  assert.doesNotMatch(html, /Re-issue/, "the needs list only issues");
  for (const bad of ["?view=all", "?page=0", "?page=x", `?name=${"a".repeat(101)}`]) assert.equal((await x.get(`/workspace/id-cards${bad}`, "s-staff")).status, 400, bad);
});

test("REPORTS_ID_CARDS_HTTP staff issue and renew in batches; refusals and bad bodies write nothing", async (t) => {
  const x = await rig(t);
  const ok = await x.post("action=issue&person=a&person=b");
  assert.equal(ok.status, 200);
  const body = await ok.json() as { status: string; action: string; count: number; expiresOn: string };
  assert.equal(body.status, "ok"); assert.equal(body.count, 2); assert.match(body.expiresOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(x.writes, [{ action: "issue", people: ["a", "b"] }]);
  assert.equal((await x.post("action=renew&person=a")).status, 200);
  for (const bad of ["action=issue", "action=revoke&person=a", "person=a", "action=issue&action=renew&person=a", "action=issue&person=a&extra=1", "action=issue&person=a&person=a"])
    assert.equal((await x.post(bad)).status, 400, bad);
  assert.equal((await x.post("action=issue&person=a", "s-staff", { "content-type": "application/json" })).status, 400);
  assert.equal((await x.post("action=issue&person=a", "s-staff", { origin: "https://evil.example" })).status, 403);
  assert.equal((await x.post("action=issue&person=a", "s-staff", { "sec-fetch-site": "cross-site" })).status, 403);
  x.refuseWith([{ personId: "b", code: "not_assigned" }]);
  const refused = await x.post("action=issue&person=a&person=b");
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { status: "refused", refusals: [{ personId: "b", code: "not_assigned" }] });
  const html = await (await x.post("action=issue&person=a&person=b", "s-staff", { accept: "text/html" })).text();
  assert.match(html, /No card was issued, because:/); assert.match(html, /b is not assigned to a store/);
  assert.equal(x.writes.length, 2);
});

test("REPORTS_ID_CARDS_HTTP a person sees their own card, a note when they have none, and must be signed in", async (t) => {
  const x = await rig(t);
  const mine = await (await x.get("/profile/id-card", "s-person")).json() as { status: string; card: { cardNumber: number; valid: boolean; placement: unknown } };
  assert.equal(mine.status, "ok"); assert.equal(mine.card.cardNumber, 17); assert.equal(mine.card.valid, true);
  const html = await (await x.get("/profile/id-card", "s-person", "text/html")).text();
  assert.match(html, /This card is valid\./);
  assert.match(html, /<dt>Store<\/dt><dd>Avenues<\/dd>/);
  assert.match(html, /<dt>Arabic name<\/dt><dd>علياء بدر<\/dd>/);
  assert.match(html, /<dt>Employee ID<\/dt><dd>C00042<\/dd>/);
  assert.deepEqual(await (await x.get("/profile/id-card", "s-other")).json(), { status: "none" });
  assert.match(await (await x.get("/profile/id-card", "s-other", "text/html")).text(), /You do not have a StudentHub ID card yet/);
  assert.equal((await x.get("/profile/id-card")).status, 401);
  assert.equal((await fetch(x.base + "/profile/id-card", { method: "POST", headers: { cookie: "__Host-studenthub_session=s-person" } })).status, 405);
});

test("REPORTS_ID_CARDS_PDF_HTTP the person downloads their card; staff print a batch; others get not found", async (t) => {
  const x = await rig(t);
  const own = await x.get("/profile/id-card.pdf", "s-person", "*/*");
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("content-type"), "application/pdf");
  assert.equal(own.headers.get("content-disposition"), 'attachment; filename="studenthub-id-card.pdf"');
  assert.equal(own.headers.get("cache-control"), "no-store");
  assert.ok(Buffer.from(await own.arrayBuffer()).subarray(0, 5).equals(Buffer.from("%PDF-")));
  assert.equal((await x.get("/profile/id-card.pdf", "s-other")).status, 404, "no card, no PDF");
  assert.equal((await x.get("/profile/id-card.pdf")).status, 401);
  assert.match(await (await x.get("/profile/id-card", "s-person", "text/html")).text(), /href="\/profile\/id-card\.pdf"/);

  const print = await x.get(`/workspace/id-cards/print?person=${PERSON}`, "s-staff", "*/*");
  assert.equal(print.status, 200); assert.equal(print.headers.get("content-type"), "application/pdf");
  assert.equal(print.headers.get("content-disposition"), 'attachment; filename="id-cards.pdf"');
  assert.deepEqual(await (await x.get(`/workspace/id-cards/print?person=${PERSON}&person=nobody`, "s-staff")).json(), { status: "refused", refusals: [{ personId: "nobody", code: "no_card" }] });
  for (const bad of ["", "?person=a&person=a", "?person=a&other=1"]) assert.equal((await x.get(`/workspace/id-cards/print${bad}`, "s-staff")).status, 400, bad);
  for (const session of [undefined, "s-person"]) {
    const res = await x.get(`/workspace/id-cards/print?person=${PERSON}`, session);
    assert.equal(res.status, 404); assert.deepEqual(await res.json(), { status: "not_found" });
  }
  assert.equal((await fetch(`${x.base}/workspace/id-cards/print?person=${PERSON}`, { method: "POST", headers: { cookie: "__Host-studenthub_session=s-person" } })).status, 404, "non-staff: not found for any method");
  assert.equal((await fetch(`${x.base}/workspace/id-cards/print?person=${PERSON}`, { method: "POST", headers: { cookie: "__Host-studenthub_session=s-staff" } })).status, 405);
  const saved = await (await x.post(`action=issue&person=${PERSON}`, "s-staff", { accept: "text/html" })).text();
  assert.match(saved, new RegExp(`href="/workspace/id-cards/print\\?person=${PERSON}"`));
});

test("REPORTS_ID_CARDS_PHOTO_HTTP a real card render reads the photo once and audits it, for the person and for staff; refused callers read nothing", async (t) => {
  // A real personal-photo source over an in-memory document store: the same path production wires.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 17, 8, 0x00, 0x20, 0x00, 0x30, 3, ...Array(9).fill(0x11), 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  const version = randomUUID();
  const docs = [{ id: randomUUID(), version, type: "personal-photo", mime: "image/jpeg", size: jpeg.length, scope: { orgId: "org", personId: PERSON }, acl: "private", data: jpeg.toString("base64") }];
  let reads = 0;
  const documents = { async transaction<T>(fn: (state: DocumentState) => Promise<T>) { reads++; return fn({ format: 1, documents: structuredClone(docs), retired: [] } as unknown as DocumentState); } } as DocumentStore;
  const views: Parameters<PersonalPhotoAuditPort["recordView"]>[0][] = [];
  const x = await rig(t, personalPhotoSource({ store: documents, orgId: "org", audit: { async recordView(v) { views.push(v); } } }));
  const row = (viewer: string) => ({ viewerPrincipalId: viewer, subjectPrincipalId: PERSON, kind: "id_card_render", documentType: "personal-photo", documentVersion: version });
  const hasPhoto = async (res: Response) => /\/Subtype \/Image/.test(Buffer.from(await res.arrayBuffer()).toString("latin1"));

  const own = await x.get("/profile/id-card.pdf", "s-person", "*/*");
  assert.equal(own.status, 200); assert.equal(await hasPhoto(own), true, "the photo is on the person's own card");
  assert.deepEqual(views, [row(PERSON)], "one audit row, the person as viewer");
  const print = await x.get(`/workspace/id-cards/print?person=${PERSON}`, "s-staff", "*/*");
  assert.equal(print.status, 200); assert.equal(await hasPhoto(print), true, "the photo is on the staff print");
  assert.deepEqual(views, [row(PERSON), row(STAFF)], "one more audit row, the staff member as viewer");
  assert.equal(reads, 2);

  // Not staff, not signed in, no card, or a refused batch: no photo read and no audit row.
  for (const [path, session] of [[`/workspace/id-cards/print?person=${PERSON}`, "s-person"], [`/workspace/id-cards/print?person=${PERSON}`, "s-other"], [`/workspace/id-cards/print?person=${PERSON}`, undefined],
    ["/profile/id-card.pdf", "s-other"], ["/profile/id-card.pdf", undefined], [`/workspace/id-cards/print?person=${PERSON}&person=nobody`, "s-staff"]] as const)
    assert.notEqual((await x.get(path, session, "*/*")).status, 200, `${path} ${session}`);
  assert.equal(reads, 2, "refused callers never reach the document store");
  assert.equal(views.length, 2, "and write no audit rows");
});
